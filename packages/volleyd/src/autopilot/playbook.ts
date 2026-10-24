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

/** One stage (release-playbook.schema.json $defs/stage), normalised: `run` and `gate` defaulted. */
export interface PlaybookStage {
  name: string;
  brief: string;
  run: string[][];
  gate: "auto" | "owner";
  verify?: {
    commits_on_release?: boolean;
    tag?: string;
    files?: string[];
    result?: Record<string, string | number | boolean>;
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
  const validate = validator("release-playbook.schema.json");
  if (!validate(raw)) fail(toPathErrors(validate.errors));
  const p = raw as {
    version: 1;
    stages: (Omit<PlaybookStage, "run" | "gate"> & Partial<PlaybookStage>)[];
  };
  const seen = new Set<string>();
  const dups: PathError[] = [];
  p.stages.forEach((s, i) => {
    if (seen.has(s.name))
      dups.push({ path: `stages[${i}].name`, reason: `duplicate stage '${s.name}'` });
    seen.add(s.name);
  });
  if (dups.length > 0) fail(dups);
  return {
    version: 1,
    stages: p.stages.map((s) => ({ ...s, run: s.run ?? [], gate: s.gate ?? "auto" })),
  };
}

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

/** `release playbook: <path> (N stages, M owner-gated)`, or `release playbook: none`. */
export function formatPlaybook(path: string | null, p: Playbook | null): string {
  if (path === null || p === null) return "release playbook: none";
  const n = p.stages.length;
  const owner = p.stages.filter((s) => s.gate === "owner").length;
  return `release playbook: ${path} (${n} stage${n === 1 ? "" : "s"}, ${owner} owner-gated)`;
}

/**
 * One journal event folded into the train's state (null until `release_started`). A stage is
 * `pending` until it is entered (`running`) or a `stage_go` decision asks about it
 * (`awaiting_go`); `release_stage_verified` / `release_stage_failed` settle it. `stage` is the
 * stage running or awaiting its go, else null.
 */
export function stepRelease(prev: ReleaseState | null, ev: JournalEvent): ReleaseState | null {
  if (ev.type === "release_started") {
    const stages = ((ev.data.playbook as { stages?: { name: string }[] } | undefined)?.stages ??
      []) as { name: string }[];
    return { stage: null, stages: stages.map((s) => ({ name: s.name, state: "pending" })) };
  }
  if (prev === null) return null;
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
  return { stage: current?.name ?? null, stages };
}

/** The train's state over a wave's journal: null when no release started. */
export function trainState(events: Iterable<JournalEvent>): ReleaseState | null {
  let s: ReleaseState | null = null;
  for (const ev of events) s = stepRelease(s, ev);
  return s;
}

/** Whether every stage of the train is verified or skipped (the `release_go` question may be asked). */
export const allVerified = (r: ReleaseState): boolean =>
  r.stages.length > 0 && r.stages.every((s) => s.state === "verified" || s.state === "skipped");

/** A `release_go` decision's answers: `go` completes the wave; `hold` keeps it releasing. */
export const RELEASE_GO_OPTIONS = ["go", "hold"];

/**
 * The wave-level `release_go` decision once every stage is verified (pure): the question, and
 * each stage with where its evidence lives (`evidence`: stage name → path, from
 * `release_stage_verified`).
 */
export function releaseGoInput(
  wave: WaveId,
  r: ReleaseState,
  evidence: ReadonlyMap<string, string>,
): { input: DecisionInput; stages: { name: string; evidence?: string }[] } {
  const stages = r.stages.map((s) => {
    const e = evidence.get(s.name);
    return { name: s.name, ...(e !== undefined ? { evidence: e } : {}) };
  });
  const skipped = r.stages.filter((s) => s.state === "skipped").map((s) => s.name);
  const verified = r.stages.filter((s) => s.state !== "skipped").map((s) => s.name);
  const question = `Wave ${wave}'s release train is verified: ${verified.join(", ") || "no stage"}${skipped.length > 0 ? ` (skipped: ${skipped.join(", ")})` : ""}. Release it? go: the wave is complete (volleyd deploys nothing itself); hold: it stays releasing and this question is asked again.`;
  return {
    input: { kind: "release_go", task: null, question, options: [...RELEASE_GO_OPTIONS] },
    stages,
  };
}
