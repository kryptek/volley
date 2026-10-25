import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isMap, parseDocument } from "yaml";
import type { DecisionInput } from "../decisions";
import { isSlug } from "../repos";
import { type PathError, toPathErrors, validator } from "../schemas";
import type { JournalEvent, ReleaseStageState, ReleaseState, WaveId } from "../types";
import { expandHome } from "../worktree";

/**
 * The release train's playbook (SPEC §4.6.19): `<repo>/.volley/release.yaml`, the stages volleyd
 * runs once a wave's tasks are all merged, before it asks the owner `release_go`. Pure apart from
 * `readPlaybook`'s one file read. Running a stage is A8's; this is the file and the train's state.
 */

/** Where a wave's playbook is looked for when its wave file has no `playbook:`. */
export const DEFAULT_PLAYBOOK = ".volley/release.yaml";

/** `playbook: none` in a wave file: the wave has no release train, whatever its repo ships. */
export const NO_PLAYBOOK = "none";

/**
 * A stage's phase: `prepare` stages run before the owner's `release_go`, `ship` stages after its
 * `go`, once volleyd merged the release PR (at the merge commit, the release branch gone).
 */
export type StagePhase = "prepare" | "ship";

/**
 * One stage (release-playbook.schema.json $defs/stage), normalised: `run`, `gate` and `phase`
 * defaulted.
 */
export interface PlaybookStage {
  name: string;
  brief: string;
  run: string[][];
  gate: "auto" | "owner";
  phase: StagePhase;
  verify?: {
    commits_on_release?: boolean;
    tag?: string;
    files?: string[];
    result?: Record<string, string | number | boolean>;
    release_pr?: boolean;
  };
  timeout_s?: number;
  heavy?: string;
}

export interface Playbook {
  version: 1;
  stages: PlaybookStage[];
}

/** A playbook as read from disk: what `release_started` journals beside its path. */
export interface ReadPlaybook {
  playbook: Playbook;
  sha256: string;
  bytes: number;
}

/** The refusal code of a wave whose playbook is invalid (or configured and missing). */
export const PLAYBOOK_INVALID = "RELEASE_PLAYBOOK_INVALID";

/**
 * A playbook failed to parse or validate (`errors` path-qualified, `stages[1].name`), or a
 * configured one does not exist. The message starts with `RELEASE_PLAYBOOK_INVALID: <source>: `.
 */
export class PlaybookError extends Error {
  readonly errors: PathError[];
  constructor(errors: PathError[], source?: string, summary = "invalid release playbook:") {
    const where = source !== undefined ? `${source}: ` : "";
    super(
      `${PLAYBOOK_INVALID}: ${where}${summary}${errors.map((e) => `\n  ${e.path}: ${e.reason}`).join("")}`,
    );
    this.name = "PlaybookError";
    this.errors = errors;
  }
}

/** Parse playbook YAML, validate it (schema + unique stage names) and normalise it. */
export function parsePlaybook(text: string, source?: string): Playbook {
  const fail = (errors: PathError[]): never => {
    throw new PlaybookError(errors, source);
  };
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    fail(doc.errors.map((e) => ({ path: "(root)", reason: `invalid YAML: ${e.message}` })));
  }
  if (!isMap(doc.contents)) fail([{ path: "(root)", reason: "must be a mapping" }]);
  const raw = doc.toJS() as unknown;
  // An unknown `{{name}}` and the phases' rules are named first, path-qualified (the schema's
  // pattern and `contains` say less).
  const loose = looseStages(raw);
  const early = [...unknownVariables(loose), ...phaseErrors(loose)];
  if (early.length > 0) fail(early);
  const validate = validator("release-playbook.schema.json");
  if (!validate(raw)) fail(toPathErrors(validate.errors));
  const p = raw as {
    version: 1;
    stages: (Omit<PlaybookStage, "run" | "gate" | "phase"> & Partial<PlaybookStage>)[];
  };
  const seen = new Set<string>();
  const dups: PathError[] = [];
  p.stages.forEach((s, i) => {
    if (seen.has(s.name))
      dups.push({ path: `stages[${i}].name`, reason: `duplicate stage '${s.name}'` });
    seen.add(s.name);
  });
  if (dups.length > 0) fail(dups);
  const stages = p.stages.map((s) => ({
    ...s,
    run: s.run ?? [],
    gate: s.gate ?? "auto",
    phase: s.phase ?? "prepare",
  }));
  return { version: 1, stages };
}

/** A not-yet-validated document's stages, as far as their variable sites go (indexes kept). */
function looseStages(raw: unknown): PlaybookStage[] {
  const stages = (raw as { stages?: unknown } | null)?.stages;
  if (!Array.isArray(stages)) return [];
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  return stages.map((s: unknown) => {
    const o = (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
    const v = (typeof o.verify === "object" && o.verify !== null ? o.verify : {}) as Record<
      string,
      unknown
    >;
    const result =
      typeof v.result === "object" && v.result !== null
        ? (v.result as Record<string, string | number | boolean>)
        : undefined;
    return {
      name: str(o.name),
      brief: str(o.brief),
      run: Array.isArray(o.run) ? o.run.map((a) => (Array.isArray(a) ? a.map(str) : [])) : [],
      gate: "auto",
      phase: o.phase === "ship" ? "ship" : "prepare",
      verify: {
        ...(typeof v.tag === "string" ? { tag: v.tag } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(v.commits_on_release === true ? { commits_on_release: true } : {}),
        ...(v.release_pr === true ? { release_pr: true } : {}),
      },
    };
  });
}

/**
 * The two phases' structural rules: prepare stages come first; a ship stage pushes nothing but a
 * tag (no `commits_on_release`); ship stages need a prepare stage that verifies the release PR
 * (`release_pr`: the PR volleyd merges on the go); `release_pr` is a prepare stage's fact.
 */
function phaseErrors(stages: readonly PlaybookStage[]): PathError[] {
  const errors: PathError[] = [];
  const hasPr = stages.some((s) => s.phase === "prepare" && s.verify?.release_pr === true);
  let shipSeen = false;
  stages.forEach((s, i) => {
    if (s.phase === "ship") {
      shipSeen = true;
      if (s.verify?.commits_on_release === true)
        errors.push({
          path: `stages[${i}].verify.commits_on_release`,
          reason: "a ship stage pushes nothing but a tag (the release branch is merged and gone)",
        });
      if (s.verify?.release_pr === true)
        errors.push({
          path: `stages[${i}].verify.release_pr`,
          reason: "release_pr is a prepare stage's fact (the PR is merged before ship stages run)",
        });
      if (!hasPr)
        errors.push({
          path: `stages[${i}].phase`,
          reason:
            "a ship stage needs a prepare stage that verifies release_pr (the PR volleyd merges on the go)",
        });
    } else if (shipSeen)
      errors.push({ path: `stages[${i}].phase`, reason: "a prepare stage after a ship stage" });
  });
  return errors;
}

// ---------------------------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------------------------

/**
 * The variables a stage may name as `{{name}}` (SPEC §4.6.19), in its brief, each `run` argv
 * element, `verify.tag` and `verify.result` values. `merged_sha` is a ship stage's only.
 */
export const PLAYBOOK_VARS = [
  "version",
  "date",
  "wave",
  "release_branch",
  "default_branch",
  "merged_sha",
] as const;
export type PlaybookVar = (typeof PLAYBOOK_VARS)[number];
export type PlaybookVars = Partial<Record<PlaybookVar, string>>;

const VAR_RE = /\{\{([^{}]*)\}\}/g;

/** Each place a stage may name a variable: its path and its text. */
function variableSites(s: PlaybookStage, i: number): { path: string; text: string }[] {
  const at = `stages[${i}]`;
  return [
    { path: `${at}.brief`, text: s.brief },
    ...s.run.flatMap((argv, j) => argv.map((w, k) => ({ path: `${at}.run[${j}][${k}]`, text: w }))),
    ...(s.verify?.tag !== undefined ? [{ path: `${at}.verify.tag`, text: s.verify.tag }] : []),
    ...Object.entries(s.verify?.result ?? {}).flatMap(([k, v]) =>
      typeof v === "string" ? [{ path: `${at}.verify.result.${k}`, text: v }] : [],
    ),
  ];
}

/**
 * Every `{{name}}` that is no playbook variable, path-qualified (`stages[0].run[1][4]: unknown
 * variable {{ver}}`), and every `{{merged_sha}}` outside a ship stage.
 */
export function unknownVariables(stages: readonly PlaybookStage[]): PathError[] {
  const errors: PathError[] = [];
  stages.forEach((s, i) => {
    for (const { path, text } of variableSites(s, i)) {
      for (const m of text.matchAll(VAR_RE)) {
        const name = m[1] ?? "";
        if (!(PLAYBOOK_VARS as readonly string[]).includes(name))
          errors.push({ path, reason: `unknown variable {{${m[1]}}}` });
        else if (name === "merged_sha" && s.phase !== "ship")
          errors.push({ path, reason: "{{merged_sha}} is known in a ship stage only" });
      }
    }
  });
  return errors;
}

/** `text` with each `{{name}}` that `vars` carries replaced (any other left as written). */
export function substitute(text: string, vars: PlaybookVars): string {
  return text.replace(VAR_RE, (whole, name: string) => {
    const v = vars[name as PlaybookVar];
    return v === undefined ? whole : v;
  });
}

/** A stage with its variables substituted (brief, run argv elements, verify.tag, verify.result). */
export function substituteStage(stage: PlaybookStage, vars: PlaybookVars): PlaybookStage {
  const sub = (t: string) => substitute(t, vars);
  const v = stage.verify;
  return {
    ...stage,
    brief: sub(stage.brief),
    run: stage.run.map((argv) => argv.map(sub)),
    ...(v !== undefined
      ? {
          verify: {
            ...v,
            ...(v.tag !== undefined ? { tag: sub(v.tag) } : {}),
            ...(v.result !== undefined
              ? {
                  result: Object.fromEntries(
                    Object.entries(v.result).map(([k, x]) => [
                      k,
                      typeof x === "string" ? sub(x) : x,
                    ]),
                  ),
                }
              : {}),
          },
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The release version
// ---------------------------------------------------------------------------------------------

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Order of two `X.Y.Z` versions (`v` optional; release tags only, no prerelease). */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The kinds of change fragment that make a release minor (`changes/<n>.<kind>.md`). */
const MINOR_KINDS = new Set(["added", "removed"]);

/**
 * The release version (SPEC §4.6.19): the newest release tag (`vX.Y.Z`; a prerelease is never
 * the base) bumped minor when any change fragment is `added` or `removed`, else patch; `0.1.0`
 * with no tag. `override` (the wave file's `release_version:`) wins, and is refused unless it is
 * greater than the newest tag. `tags` are tag names (`v0.13.2`) or refs (`refs/tags/v0.13.2`);
 * `fragments` file names or paths (`changes/609.added.md`).
 */
export function nextVersion(
  tags: readonly string[],
  fragments: readonly string[],
  override?: string,
): { version: string; newest?: string } | { error: string } {
  const releases = tags
    .map((t) => t.replace(/^refs\/tags\//, ""))
    .filter((t) => RELEASE_TAG.test(t))
    .sort((a, b) => compareVersions(b, a));
  const newest = releases[0];
  const known = newest !== undefined ? { newest } : {};
  if (override !== undefined) {
    if (!VERSION.test(override)) return { error: `release_version ${override} is not X.Y.Z` };
    if (newest !== undefined && compareVersions(override, newest) <= 0)
      return {
        error: `release_version ${override} is not greater than the newest tag ${newest}`,
      };
    return { version: override, ...known };
  }
  if (newest === undefined) return { version: "0.1.0" };
  const [, major, minor, patch] = (RELEASE_TAG.exec(newest) as RegExpExecArray).map(Number);
  const kinds = fragments.map((f) => f.split("/").at(-1)?.split(".").at(-2) ?? "");
  return {
    version: kinds.some((k) => MINOR_KINDS.has(k))
      ? `${major}.${(minor as number) + 1}.0`
      : `${major}.${minor}.${(patch as number) + 1}`,
    ...known,
  };
}

/** The supervisor's UTC day (`YYYY-MM-DD`): a release's `{{date}}`. */
export const releaseDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Where a wave's playbook is: `configured` (the wave file's `playbook:`) relative to the repo or
 * absolute, else `.volley/release.yaml` in the repo; null for `playbook: none`.
 */
export function playbookPath(repo: string, configured: string | undefined): string | null {
  if (configured === NO_PLAYBOOK) return null;
  const file = configured ?? DEFAULT_PLAYBOOK;
  return isAbsolute(file) || file.startsWith("~") ? expandHome(file) : join(expandHome(repo), file);
}

/** Read the playbook at `path`: null when there is none; throws `PlaybookError` when invalid. */
export function readPlaybook(path: string): ReadPlaybook | null {
  if (!existsSync(path)) return null;
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    // A directory or an unreadable file is refused like an invalid one, not thrown raw.
    throw new PlaybookError([], path, `cannot read: ${(e as Error).message}`);
  }
  return {
    playbook: parsePlaybook(bytes.toString("utf-8"), path),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  };
}

/** A wave's playbook: where it is (`display` as the wave file names it), and what it holds. */
export interface WavePlaybook extends ReadPlaybook {
  display: string;
  path: string;
}

/**
 * The playbook of a wave (`repo` + `playbook:`), read on this machine: null for `playbook: none`,
 * no file at the default path, or a repo that is not on this machine. Throws `PlaybookError` when
 * it is invalid, or configured and missing from a repo that is here.
 */
export function wavePlaybook(wave: { repo: string; playbook?: string }): WavePlaybook | null {
  // A wave named by an `owner/name` the supervisor holds no clone of (#448) has no repo here to
  // look for the default in; one naming a playbook is refused at submit (resolveWaveRepo).
  if (wave.playbook === undefined && isSlug(wave.repo)) return null;
  const path = playbookPath(wave.repo, wave.playbook);
  if (path === null) return null;
  const read = readPlaybook(path);
  if (read === null) {
    // Only the default may be absent; a repo that is not on this machine is not checked here.
    if (wave.playbook === undefined || !existsSync(expandHome(wave.repo))) return null;
    throw new PlaybookError([], path, "no such file");
  }
  return { ...read, display: wave.playbook ?? DEFAULT_PLAYBOOK, path };
}

/**
 * `release playbook: <path> (N stages, M owner-gated)`, or `release playbook: none`; with
 * `phases`, `(N stages: P prepare, S ship, M owner-gated)`.
 */
export function formatPlaybook(
  path: string | null,
  p: Playbook | null,
  o: { phases?: boolean } = {},
): string {
  if (path === null || p === null) return "release playbook: none";
  const n = p.stages.length;
  const owner = p.stages.filter((s) => s.gate === "owner").length;
  const ship = p.stages.filter((s) => s.phase === "ship").length;
  const phases = o.phases === true ? `: ${n - ship} prepare, ${ship} ship` : "";
  return `release playbook: ${path} (${n} stage${n === 1 ? "" : "s"}${phases}, ${owner} owner-gated)`;
}

/**
 * One journal event folded into the train's state (null until `release_started`). A stage is
 * `pending` until it is entered (`running`) or a `stage_go` decision asks about it
 * (`awaiting_go`); `release_stage_verified` / `release_stage_failed` settle it. `stage` is the
 * stage running or awaiting its go, else null. The release's version and day come with
 * `release_started`, its PR with `release_pr_detected`, its merge commit with `release_merged`
 * (from which the train is in its `ship` phase).
 */
export function stepRelease(prev: ReleaseState | null, ev: JournalEvent): ReleaseState | null {
  if (ev.type === "release_started") {
    const stages = ((
      ev.data.playbook as { stages?: { name: string; phase?: unknown }[] } | undefined
    )?.stages ?? []) as { name: string; phase?: unknown }[];
    const str = (k: string) =>
      typeof ev.data[k] === "string" ? { [k]: ev.data[k] as string } : {};
    return {
      stage: null,
      stages: stages.map((s) => ({
        name: s.name,
        state: "pending",
        ...(s.phase === "ship" ? { phase: "ship" as const } : {}),
      })),
      phase: "prepare",
      ...str("version"),
      ...str("date"),
      ...str("default_branch"),
    };
  }
  if (prev === null) return null;
  if (ev.type === "release_pr_detected") {
    const { pr, head, title } = ev.data;
    if (typeof pr !== "number" || typeof head !== "string") return prev;
    return {
      ...prev,
      pr: { number: pr, head, ...(typeof title === "string" ? { title } : {}) },
    };
  }
  if (ev.type === "release_merged") {
    if (typeof ev.data.sha !== "string") return prev;
    return { ...prev, merged_sha: ev.data.sha, phase: "ship" };
  }
  const to: ReleaseStageState | undefined =
    ev.type === "release_stage_entered"
      ? "running"
      : ev.type === "release_stage_verified"
        ? "verified"
        : ev.type === "release_stage_failed"
          ? "failed"
          : ev.type === "release_stage_skipped"
            ? "skipped"
            : ev.type === "decision_opened" && ev.data.kind === "stage_go"
              ? "awaiting_go"
              : undefined;
  const name = ev.data.stage;
  if (to === undefined || typeof name !== "string") return prev;
  const stages = prev.stages.map((s) => (s.name === name ? { ...s, state: to } : s));
  const current = stages.find((s) => s.state === "running" || s.state === "awaiting_go");
  return { ...prev, stage: current?.name ?? null, stages };
}

/** The train's state over a wave's journal: null when no release started. */
export function trainState(events: Iterable<JournalEvent>): ReleaseState | null {
  let s: ReleaseState | null = null;
  for (const ev of events) s = stepRelease(s, ev);
  return s;
}

const settled = (s: { state: ReleaseStageState }) =>
  s.state === "verified" || s.state === "skipped";

/** Whether every stage of the train is verified or skipped (the train is done). */
export const allVerified = (r: ReleaseState): boolean =>
  r.stages.length > 0 && r.stages.every(settled);

/** Whether every prepare stage is verified or skipped (`release_go` may be asked). */
export const prepareVerified = (r: ReleaseState): boolean =>
  r.stages.some((s) => s.phase !== "ship") &&
  r.stages.filter((s) => s.phase !== "ship").every(settled);

/**
 * A `release_go` decision's answers: `go` merges the release PR (when a prepare stage verified
 * one) and runs the ship stages, then completes the wave; `hold` keeps it releasing.
 */
export const RELEASE_GO_OPTIONS = ["go", "hold"];

/**
 * The wave-level `release_go` decision once every prepare stage is verified (pure): the question,
 * and each stage with where its evidence lives (`evidence`: stage name → path, from
 * `release_stage_verified`). With a release PR it names the version, the PR, the changelog
 * section's first bullets (`excerpt`) and the ship stages the go runs; `retry` is why the last go
 * did not merge.
 */
export function releaseGoInput(
  wave: WaveId,
  r: ReleaseState,
  evidence: ReadonlyMap<string, string>,
  o: { excerpt?: readonly string[]; retry?: string } = {},
): { input: DecisionInput; stages: { name: string; evidence?: string }[] } {
  const stages = r.stages.map((s) => {
    const e = evidence.get(s.name);
    return { name: s.name, ...(e !== undefined ? { evidence: e } : {}) };
  });
  const prep = r.stages.filter((s) => s.phase !== "ship");
  const skipped = prep.filter((s) => s.state === "skipped").map((s) => s.name);
  const verified = prep.filter((s) => s.state !== "skipped").map((s) => s.name);
  const ship = r.stages.filter((s) => s.phase === "ship").map((s) => s.name);
  const stagesLine = `${verified.join(", ") || "no stage"}${skipped.length > 0 ? ` (skipped: ${skipped.join(", ")})` : ""}`;
  const v = r.version !== undefined ? ` v${r.version}` : "";
  let question: string;
  if (r.pr === undefined)
    question = `Wave ${wave}'s release${v} train is verified: ${stagesLine}. Release it? go: the wave is complete (volleyd deploys nothing itself); hold: it stays releasing and this question is asked again.`;
  else {
    const title = r.pr.title !== undefined ? ` "${r.pr.title}"` : "";
    const into = r.default_branch ?? "the default branch";
    const bullets =
      (o.excerpt ?? []).length > 0 ? ` Changelog: ${(o.excerpt ?? []).join(" ")}` : "";
    const retry = o.retry !== undefined ? ` The last go did not merge: ${o.retry}.` : "";
    const then = ship.length > 0 ? `, then runs ${ship.join(", ")} at the merge commit` : "";
    question = `Wave ${wave}'s release${v} is ready: PR #${r.pr.number}${title} into ${into} is CI-green at ${r.pr.head.slice(0, 7)}; verified: ${stagesLine}.${bullets}${retry} Release it? go: volleyd squash-merges PR #${r.pr.number} (deleting the release branch)${then}, and the wave completes; hold: it stays releasing and this question is asked again.`;
  }
  return {
    input: { kind: "release_go", task: null, question, options: [...RELEASE_GO_OPTIONS] },
    stages,
  };
}
