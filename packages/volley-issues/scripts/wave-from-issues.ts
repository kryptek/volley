import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isReservedChannel } from "volley-mcp/channels";
import {
  type Footprint,
  type FootprintOf,
  type Tree,
  footprintOf,
  footprintSummary,
  treeFromLsTree,
} from "volleyd/footprint";
import { sharedFiles } from "volleyd/overlap";
import { type PlanTask, explain, isSourceFile, planWave } from "volleyd/overlap-plan";

/** The wave file's `brief_preface:` unless told otherwise (relative to the repo). */
export const DEFAULT_BRIEF_PREFACE = ".volley/brief-preface.md";

/** The starting preface: public-repo hygiene rules plus a slot for the repo's own. */
export const BRIEF_PREFACE_TEMPLATE = fileURLToPath(
  new URL("../templates/brief-preface.md", import.meta.url),
);

/** One issue as `gh issue view <n> --json number,title,body` prints it. */
export interface IssueInput {
  number: number;
  title: string;
  body: string;
}

export interface WaveOptions {
  wave: string;
  repo: string;
  releaseBranch: string;
  model: string;
  /**
   * Wave pipeline; omitted means the helper's default
   * `[implement, [spec_review, quality_review], fixup, merge_ready]`.
   */
  pipeline?: unknown[];
  namespace?: string;
  /** `owner/repo` of the wave's repository: qualified references to it are accepted. */
  repoSlug?: string;
  /** Issues already merged: a dependency on one of them is dropped instead of rejected. */
  satisfied?: number[];
  /** The wave's `brief_preface:` (relative to the repo, or absolute); default `.volley/brief-preface.md`. */
  briefPreface?: string;
  /** Who merges a gated PR: `auto` (volleyd, the default) or `manual` (a human). */
  merge?: "auto" | "manual";
  /** `config: { autopilot: { enabled } }`; omitted, the wave inherits the supervisor's setting. */
  autopilot?: boolean;
  /** `config: { branch_update }`; `merge` is the recommended setting for autopilot waves. */
  branchUpdate?: "merge" | "rebase";
  /**
   * `placement:` pinned for this wave; omitted, the supervisor's `placement.default` decides
   * (`auto` once a machine is paired).
   */
  placement?: "local" | "auto";
  /**
   * The repository tree at the release branch (path → bytes) each issue's Files list resolves
   * against; omitted or null, no entry resolves (footprints `none`, their entries `unresolved`).
   */
  tree?: Tree | null;
  /** Footprints only: no bundle, no chain, no `plan:` (the escape hatch). */
  noPlan?: boolean;
}

export interface WaveResult {
  yaml: string;
  /** The overlap plan in words (`explain`), also the file's header comment; empty under noPlan. */
  explanation: string[];
  /** `footprints: 24 listed, 2 guessed (#333, #313); …`, counted per issue. */
  footprints: string;
  /** `unresolved: #104: helpers.ts`, one per issue with entries that matched no path. */
  unresolved: string[];
  /** Issues whose body has no `Depends on:`/`deps:` line: their order must come from the human. */
  undeclared: number[];
  /** Title tags dropped because two issues shared them; those issues fell back to `i<N>`. */
  warnings: string[];
}

/** Wave id grammar (SPEC §2.1), the same one the wave-file schema enforces. */
const WAVE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Optional markdown emphasis around the label (`**Depends on:**`, `_deps_:`). */
const EMPH = String.raw`(?:\*\*|__|[*_\`])?`;

/** A `Depends on:` / `deps:` line; group 1 is the text after the label. */
const DEPENDS_LINE = new RegExp(
  String.raw`^\s*(?:[-*+]\s+)?${EMPH}\s*(?:depends on|deps)\s*${EMPH}\s*:\s*${EMPH}(.*)$`,
  "i",
);

/** A markdown list item; group 1 is its text. */
const LIST_ITEM = /^\s*[-*+]\s+(.*)$/;

/**
 * An issue reference: a GitHub issue URL (`https://github.com/owner/repo/issues/N`), or `#N`
 * optionally repo-qualified (`owner/repo#N`).
 */
const ISSUE_REF =
  /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)\b|(?:\b([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;

/** Dependency-line text that declares no dependencies (after parentheticals and punctuation). */
const NONE = new Set(["none", "n/a", "-", "—"]);

/**
 * A task tag at the start of an issue title (`O0: …`, `T3b — …`, `D10 - …`); group 1 is the tag.
 * Every tag it matches fits the wave-file task-id grammar.
 */
const TITLE_TAG = /^([A-Z]{1,3}\d{1,3}[a-z]?)\s*[:—–-]/;

/**
 * Product, format and numeronym names that fit the tag grammar but name a subject, not a task
 * (`S3: upload fails`). A title starting with one keeps the `i<N>` fallback id.
 */
const NOT_TAGS = new Set([
  "S3",
  "EC2",
  "K8s",
  "MP3",
  "MP4",
  "UTF8",
  "H264",
  "X11",
  "V8",
  "ES5",
  "ES6",
  "CSS3",
  "MD5",
  "I18n",
  "L10n",
  "A11y",
]);

/** The wave-file task id for an issue: its title's task tag, else `i<number>`. */
export function taskIdFor(issue: number, title?: string): string {
  const tag = typeof title === "string" ? TITLE_TAG.exec(title)?.[1] : undefined;
  return tag !== undefined && !NOT_TAGS.has(tag) ? tag : `i${issue}`;
}

/**
 * Task ids for a set of issues (unique numbers), never two that differ only in case (volleyd
 * rejects those). Issues whose tags collide, with each other or with a fallback id, fall back
 * to `i<N>`, which is unique, with a warning naming them.
 */
function assignTaskIds(issues: IssueInput[]): { ids: Map<number, string>; warnings: string[] } {
  const ids = new Map(issues.map((i) => [i.number, taskIdFor(i.number, i.title)]));
  const warnings: string[] = [];
  for (;;) {
    const owners = new Map<string, number[]>();
    for (const [n, id] of ids) {
      const key = id.toLowerCase();
      owners.set(key, [...(owners.get(key) ?? []), n]);
    }
    const clash = [...owners.values()].find((ns) => ns.length > 1);
    if (clash === undefined) return { ids, warnings };
    const tagged = clash.filter((n) => ids.get(n) !== `i${n}`);
    warnings.push(
      `title tag '${ids.get(tagged[0] ?? 0)}' would name more than one task (${clash.map((n) => `#${n}`).join(", ")}); using ${tagged.map((n) => `i${n}`).join(", ")} instead (give them distinct title tags to keep tag ids)`,
    );
    for (const n of tagged) ids.set(n, `i${n}`);
  }
}

/**
 * The issues named on the body's dependency lines. `declared: false` means there is no such
 * line at all (as opposed to `Depends on: none`). An empty label reads the list items on the
 * lines that follow. A reference to another repository is an error (a wave's tasks all live in
 * one repository; `repoSlug` names it), and so is any text that is neither a reference nor
 * `none`: a dependency is never silently dropped.
 */
export function parseDependsOn(
  body: string,
  repoSlug?: string,
): { declared: boolean; refs: number[] } {
  let declared = false;
  const refs: number[] = [];
  const unparseable = (line: string) =>
    new Error(
      `unparseable dependency line '${line.trim()}' (write it as 'Depends on: #N, #M' or 'Depends on: none')`,
    );
  /** Read the references in `text` (from `line`); anything else on it is an error. */
  const read = (text: string, line: string) => {
    let found = 0;
    for (const [ref, urlRepo, urlN, repo, n] of text.matchAll(ISSUE_REF)) {
      const slug = urlRepo ?? repo;
      if (slug !== undefined && slug.toLowerCase() !== repoSlug?.toLowerCase()) {
        throw new Error(
          `cross-repository dependency ${ref} is not supported${repoSlug === undefined ? " (pass the repository's owner/repo if it is this one)" : ""}`,
        );
      }
      const num = Number(urlN ?? n);
      if (!refs.includes(num)) refs.push(num);
      found++;
    }
    const rest = text
      .replace(ISSUE_REF, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\band\b|&/gi, " ")
      .replace(/[\s,;.*_`]+/g, "");
    if (rest !== "" || found === 0) throw unparseable(line);
  };
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const m = DEPENDS_LINE.exec(raw);
    if (m === null) continue;
    declared = true;
    const text = (m[1] ?? "").trim();
    const bare = text
      .replace(/\([^)]*\)/g, "")
      .replace(/[\s.,;:!*_`]+/g, "")
      .toLowerCase();
    if (NONE.has(bare)) continue;
    if (bare !== "") {
      read(text, raw);
      continue;
    }
    // Empty label: the references are the list items that follow (blank lines allowed before).
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").trim() === "") j++;
    let items = 0;
    for (; j < lines.length; j++) {
      const item = LIST_ITEM.exec(lines[j] ?? "");
      if (item === null) break;
      read(item[1] ?? "", lines[j] ?? "");
      items++;
    }
    if (items === 0) {
      throw new Error(
        `empty dependency line '${raw.trim()}' (list the issues on it or as '- #N' items below it, or write 'none')`,
      );
    }
    i = j - 1;
  }
  return { declared, refs };
}

/** JSON is valid YAML: a JSON string is a double-quoted scalar, a JSON array a flow sequence. */
const q = (v: unknown) => JSON.stringify(v);

/** The wave's `config:` line (per-wave tunables), when any option sets one. */
function waveConfigLine(opts: WaveOptions): string[] {
  const config = {
    ...(opts.autopilot !== undefined ? { autopilot: { enabled: opts.autopilot } } : {}),
    ...(opts.branchUpdate !== undefined ? { branch_update: opts.branchUpdate } : {}),
  };
  return Object.keys(config).length > 0 ? [`config: ${q(config)}`] : [];
}

/**
 * The lines printed after the wave file is written: how to submit it, owned by the stable
 * coordinator name (`VOLLEY_COORDINATOR`), and whose name that is.
 */
export function submitLines(file: string, coordinator: string | undefined): string[] {
  // The `<wave.yaml>` placeholder stays bare; a path the shell would split or expand is single-quoted.
  const arg =
    file === "<wave.yaml>" || /^[\w@%+=:,./-]+$/.test(file)
      ? file
      : `'${file.replaceAll("'", "'\\''")}'`;
  return [
    `submit: volleyd run ${arg} --owner "$VOLLEY_COORDINATOR"`,
    coordinator !== undefined && coordinator !== ""
      ? `owner: ${coordinator} (VOLLEY_COORDINATOR)`
      : "owner: VOLLEY_COORDINATOR is unset: export it in this shell (and set it in the volley MCP server's env), a stable name like coord-main, before submitting",
  ];
}

/** Turn a set of issues into a wave file. Pure; throws with the offending issue named. */
export function waveFromIssues(issues: IssueInput[], opts: WaveOptions): WaveResult {
  if (!WAVE_ID.test(opts.wave)) {
    throw new Error(`invalid wave id '${opts.wave}' (must match ${WAVE_ID.source})`);
  }
  // SPEC §4.6: a wave id is a topic segment that must not alias a per-agent channel.
  if (isReservedChannel(opts.wave)) {
    throw new Error(`invalid wave id '${opts.wave}': it is a reserved channel name`);
  }
  if (issues.length === 0) throw new Error("no issues given");
  const inSet = new Set<number>();
  for (const [idx, i] of issues.entries()) {
    if (typeof i !== "object" || i === null || Array.isArray(i)) {
      throw new Error(`issue at index ${idx} is not a { number, title, body } object`);
    }
    if (!Number.isInteger(i.number) || i.number < 1) {
      throw new Error(`invalid issue number ${q(i.number)}`);
    }
    if (inSet.has(i.number)) throw new Error(`duplicate issue #${i.number}`);
    inSet.add(i.number);
  }
  const { ids, warnings } = assignTaskIds(issues);
  const idOf = (n: number) => ids.get(n) ?? `i${n}`;
  const satisfied = new Set(opts.satisfied ?? []);
  for (const n of satisfied) {
    // Dropping it would silently cut the edge to a task that is actually in the wave.
    if (inSet.has(n)) throw new Error(`#${n} is in this wave and also listed as satisfied`);
  }

  const undeclared: number[] = [];
  const header = [
    `# Generated by volley-issues scripts/wave-from-issues.ts from ${issues.length} issue(s).`,
    `wave: ${q(opts.wave)}`,
    `repo: ${q(opts.repo)}`,
    `release_branch: ${q(opts.releaseBranch)}`,
    `model: ${q(opts.model)}`,
    ...(opts.namespace !== undefined ? [`namespace: ${q(opts.namespace)}`] : []),
    `brief_preface: ${q(opts.briefPreface ?? DEFAULT_BRIEF_PREFACE)}`,
    `pipeline: ${opts.pipeline !== undefined ? q(opts.pipeline) : "[implement, [spec_review, quality_review], fixup, merge_ready]"}`,
    `merge: ${q(opts.merge ?? "auto")}`,
    ...(opts.placement !== undefined ? [`placement: ${q(opts.placement)}`] : []),
    ...waveConfigLine(opts),
    "tasks:",
  ];
  const tree = opts.tree ?? {};
  const tasks: (PlanTask & { counted: FootprintOf })[] = [];
  for (const issue of issues) {
    let deps: { declared: boolean; refs: number[] };
    try {
      deps = parseDependsOn(issue.body ?? "", opts.repoSlug);
    } catch (e) {
      throw new Error(`#${issue.number}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!deps.declared) undeclared.push(issue.number);
    const after: string[] = [];
    for (const ref of deps.refs) {
      if (ref === issue.number) throw new Error(`#${issue.number} depends on itself`);
      if (satisfied.has(ref)) continue;
      if (!inSet.has(ref)) {
        throw new Error(
          `#${issue.number} depends on #${ref}, which is not in this wave (add it, or pass it as satisfied if it is already merged)`,
        );
      }
      after.push(idOf(ref));
    }
    const fp = footprintOf(issue.body ?? "", tree);
    const footprint: Footprint = {
      confidence: fp.confidence,
      ...(fp.unresolved.length > 0 ? { unresolved: fp.unresolved } : {}),
    };
    const id = idOf(issue.number);
    tasks.push({
      id,
      issue: issue.number,
      ...(typeof issue.title === "string" && issue.title !== "" ? { title: issue.title } : {}),
      files: fp.files,
      footprint,
      after,
      counted: { id: `#${issue.number}`, issues: [issue.number], footprint },
    });
  }
  const footprints = footprintSummary(
    tasks.map((t) => t.counted),
    { hint: "run with --verbose to list" },
  );
  const unresolved = tasks.flatMap((t) =>
    (t.footprint.unresolved ?? []).length > 0
      ? [`unresolved: #${t.issue}: ${(t.footprint.unresolved ?? []).join(", ")}`]
      : [],
  );
  const lines: string[] = [];
  /** A task's lines; `chained`: the `after` entries the planner added, with the files they share. */
  const taskLines = (
    t: { id: string; issue: number; title?: string; after: string[]; files: string[] },
    extra: { issues?: number[]; footprint: Footprint; plan?: unknown; chained?: string[][] },
  ) => {
    lines.push(`  ${t.id}:`, `    issue: ${t.issue}`);
    if (extra.issues !== undefined) lines.push(`    issues: ${q(extra.issues)}`);
    if (t.title !== undefined) lines.push(`    title: ${q(t.title)}`);
    if (t.after.length > 0) {
      const chained = extra.chained ?? [];
      const why = chained
        .map(([dep, files]) =>
          t.after.length === 1 ? `shares ${files}` : `${dep} shares ${files}`,
        )
        .join("; ");
      lines.push(
        `    after: [${t.after.join(", ")}]${chained.length > 0 ? `  # chained by the planner: ${why}` : ""}`,
      );
    }
    if (t.files.length > 0) lines.push(`    files: ${q(t.files)}`);
    lines.push(`    footprint: ${q(extra.footprint)}`);
    if (extra.plan !== undefined) lines.push(`    plan: ${q(extra.plan)}`);
  };

  if (opts.noPlan === true) {
    for (const t of tasks) taskLines(t, { footprint: t.footprint });
    return {
      yaml: `${[...header, ...lines].join("\n")}\n`,
      undeclared,
      warnings,
      explanation: [],
      footprints,
      unresolved,
    };
  }
  // The planner's collapse and chains are written as is; the owner edits the file to differ.
  const plan = planWave({ tasks: tasks.map(({ counted: _c, ...t }) => t), tree });
  const explanation = explain(plan);
  const unitOf = new Map(plan.tasks.flatMap((p) => p.issues.map((i) => [i, p.id] as const)));
  const declaredOf = new Map(tasks.map((t) => [t.issue, t.after]));
  const byId = new Map(plan.tasks.map((p) => [p.id, p]));
  const idToIssue = new Map(tasks.map((t) => [t.id, t.issue]));
  for (const p of plan.tasks) {
    const declared = new Set(
      p.issues.flatMap((i) =>
        (declaredOf.get(i) ?? []).map((d) => unitOf.get(idToIssue.get(d) ?? 0) ?? d),
      ),
    );
    const chained = p.after
      .filter((d) => !declared.has(d))
      .map((d) => [d, sharedWords(p.files, byId.get(d)?.files ?? [], tree)]);
    taskLines(p, {
      ...(p.issues.length > 1 ? { issues: p.issues } : {}),
      footprint: p.footprint,
      plan: p.plan,
      chained,
    });
  }
  const yaml = [
    ...header.slice(0, 1),
    ...explanation.map((l) => `# plan: ${l}`),
    ...header.slice(1),
    ...lines,
  ];
  return {
    yaml: `${yaml.join("\n")}\n`,
    undeclared,
    warnings,
    explanation,
    footprints,
    unresolved,
  };
}

/** `src/a.ts, src/b.ts +2 more`: the source files two footprints share, biggest first. */
function sharedWords(a: string[], b: string[], tree: Tree): string {
  const files = sharedFiles(a, b, tree)
    .filter(isSourceFile)
    .sort((x, y) => (tree[y] ?? 0) - (tree[x] ?? 0) || x.localeCompare(y));
  const more = files.length > 2 ? ` +${files.length - 2} more` : "";
  return `${files.slice(0, 2).join(", ")}${more}`;
}

/**
 * The repository tree at the release branch: `origin/<branch>`, else the local branch, read with
 * `git ls-tree` in `repo` (`~` is the home directory); null when neither reads (not a checkout).
 */
export function readRepoTree(repo: string, branch: string, home: string = homedir()): Tree | null {
  const dir = repo === "~" ? home : repo.startsWith("~/") ? join(home, repo.slice(2)) : repo;
  if (!existsSync(dir)) return null;
  for (const ref of [`origin/${branch}`, branch]) {
    const r = spawnSync("git", ["-C", dir, "ls-tree", "-r", "-l", "--full-tree", ref], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60_000, // a hung git reads as no tree, not a hung script
    });
    if (r.status === 0) return treeFromLsTree(r.stdout);
  }
  return null;
}

/**
 * Create the preface at `file` (relative to `repo`, or absolute) from the template when there
 * is none. An existing file is never touched: it is the repo's own rules.
 */
export function ensureBriefPreface(
  repo: string,
  file: string = DEFAULT_BRIEF_PREFACE,
  home: string = homedir(),
): { path: string; created: boolean } {
  // `~` / `~/…` is the home directory, as volleyd reads it.
  const tilde = (p: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);
  const path = isAbsolute(tilde(file)) ? tilde(file) : join(tilde(repo), file);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  try {
    // `wx`: a file that appeared meanwhile is kept, not overwritten.
    writeFileSync(path, readFileSync(BRIEF_PREFACE_TEMPLATE), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return { path, created: false };
    throw e;
  }
  return { path, created: true };
}

const HELP = `Usage: bun run scripts/wave-from-issues.ts <issues.json> --wave <id> --repo <path>
         --release-branch <branch> --model <model> [--pipeline <json>] [--namespace <ns>]
         [--repo-slug <owner/repo>] [--satisfied <n,n,...>] [--brief-preface <path>]
         [--merge auto|manual] [--autopilot on|off] [--branch-update merge|rebase]
         [--placement local|auto] [--no-plan | --plan-only] [--verbose] [--out <wave.yaml>]

<issues.json> is a JSON array of { number, title, body } ("-" reads stdin), e.g.
  for n in 101 102 103; do gh issue view $n --json number,title,body; done | jq -s . > issues.json
Each issue becomes a task named by its title's task tag ("O0: ...", "T3b - ..." -> O0, T3b),
or i<number> when the title has none or starts with a product name ("S3: ..."); issues that
share a tag fall back to i<number>, with a warning. A "Depends on: #N" or "deps: #N" line in
its body becomes after: [<id of #N>] (also "owner/repo#N" and issue URLs when --repo-slug
names this repository, and "- #N" list items under an empty label). A dependency outside the
set is an error unless listed in --satisfied; so is a dependency line it cannot read.
Writes the wave YAML to --out (default stdout). Issues with no dependency line are listed on
stderr: confirm their order with the human before submitting.
The wave file names a brief preface (--brief-preface, default .volley/brief-preface.md in the
repo) that volleyd puts at the top of every agent's brief. When --repo is a directory on this
machine and that file does not exist, it is written from templates/brief-preface.md (public-repo
hygiene rules); an existing one is never changed.
--merge writes merge: (default auto: volleyd squash-merges each gated PR; manual: a human does).
--autopilot writes config: { autopilot: { enabled } } (omitted: the supervisor's setting, on by
default). --branch-update writes config: { branch_update } (merge is recommended for autopilot
waves: no force-push). --placement writes placement: to pin where the wave's tasks run (omitted:
the supervisor's placement.default, auto once a machine is paired). The last lines on stderr are
the submit command, owned by the stable coordinator name in VOLLEY_COORDINATOR, and that name.
Each issue's Files list is resolved against the --repo tree at origin/<release branch> (else
the local branch; else "no tree: footprints unresolved") into the task's files: and footprint:.
The overlap planner then bundles strongly coupled issues into one task (issues:), chains the
ones that cannot bundle (an after: marked "# chained by the planner"), and writes each task's
plan:; the plan in words heads the file and stderr, with the footprint counts (--verbose lists
the entries that matched no path). --no-plan writes footprints only (no bundle, chain or plan);
--plan-only prints the plan on stdout and writes nothing. Edit the file to plan differently.
`;

function main(argv: string[]): number {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    process.stderr.write(
      `wave-from-issues: ${e instanceof Error ? e.message : String(e)}\n${HELP}`,
    );
    return 2;
  }
  const v = parsed.values;
  if (v.help === true) {
    process.stdout.write(HELP);
    return 0;
  }
  const [input, ...extra] = parsed.positionals;
  const missing = (["wave", "repo", "release-branch", "model"] as const).filter(
    (k) => typeof v[k] !== "string",
  );
  if (input === undefined || extra.length > 0 || missing.length > 0) {
    const why =
      missing.length > 0 ? `missing --${missing.join(", --")}` : "expected one issues file";
    process.stderr.write(`wave-from-issues: ${why}\n${HELP}`);
    return 2;
  }
  if (v["no-plan"] === true && v["plan-only"] === true) {
    process.stderr.write("wave-from-issues: --no-plan and --plan-only exclude each other\n");
    return 2;
  }
  const satisfiedRaw = (v.satisfied ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^#/, ""))
    .filter((s) => s !== "");
  const notNumbers = satisfiedRaw.filter((s) => !/^[1-9]\d*$/.test(s));
  if (notNumbers.length > 0) {
    process.stderr.write(
      `wave-from-issues: --satisfied takes issue numbers, got ${notNumbers.join(", ")}\n`,
    );
    return 2;
  }
  const satisfied = satisfiedRaw.map(Number);
  const choice = <T extends string>(flag: string, value: string | undefined, allowed: T[]) => {
    if (value === undefined || (allowed as string[]).includes(value)) return value as T | undefined;
    throw new Error(`--${flag} must be ${allowed.join(" or ")}, got ${value}`);
  };
  let merge: "auto" | "manual" | undefined;
  let autopilot: "on" | "off" | undefined;
  let branchUpdate: "merge" | "rebase" | undefined;
  let placement: "local" | "auto" | undefined;
  try {
    merge = choice("merge", v.merge, ["auto", "manual"]);
    autopilot = choice("autopilot", v.autopilot, ["on", "off"]);
    branchUpdate = choice("branch-update", v["branch-update"], ["merge", "rebase"]);
    placement = choice("placement", v.placement, ["local", "auto"]);
  } catch (e) {
    process.stderr.write(`wave-from-issues: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  let pipeline: unknown[] | undefined;
  if (v.pipeline !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(v.pipeline);
    } catch {
      value = undefined;
    }
    if (Array.isArray(value)) pipeline = value;
    else {
      process.stderr.write(
        `wave-from-issues: --pipeline must be a JSON array, got ${v.pipeline}\n`,
      );
      return 2;
    }
  }
  try {
    const issues = JSON.parse(readFileSync(input === "-" ? 0 : input, "utf-8")) as IssueInput[];
    if (!Array.isArray(issues)) throw new Error("issues file must hold a JSON array");
    const repoArg = v.repo as string;
    const tree = readRepoTree(repoArg, v["release-branch"] as string);
    const noTree =
      tree === null
        ? `no tree: footprints unresolved (${repoArg} has no origin/${v["release-branch"]} or ${v["release-branch"]})\n`
        : "";
    const result = waveFromIssues(issues, {
      wave: v.wave as string,
      repo: v.repo as string,
      releaseBranch: v["release-branch"] as string,
      model: v.model as string,
      ...(pipeline !== undefined ? { pipeline } : {}),
      ...(v.namespace !== undefined ? { namespace: v.namespace } : {}),
      ...(v["repo-slug"] !== undefined ? { repoSlug: v["repo-slug"] } : {}),
      ...(v["brief-preface"] !== undefined ? { briefPreface: v["brief-preface"] } : {}),
      satisfied,
      ...(merge !== undefined ? { merge } : {}),
      ...(autopilot !== undefined ? { autopilot: autopilot === "on" } : {}),
      ...(branchUpdate !== undefined ? { branchUpdate } : {}),
      ...(placement !== undefined ? { placement } : {}),
      tree,
      ...(v["no-plan"] === true ? { noPlan: true } : {}),
    });
    const { yaml, undeclared, warnings } = result;
    const planBlock = [
      ...result.explanation,
      result.footprints,
      ...(v.verbose === true ? result.unresolved : []),
    ]
      .map((l) => `${l}\n`)
      .join("");
    if (v["plan-only"] === true) {
      // The explanation only: no wave file, no preface, nothing to submit.
      process.stderr.write(noTree);
      process.stdout.write(planBlock);
      return 0;
    }
    if (v.out !== undefined) writeFileSync(v.out, yaml);
    else process.stdout.write(yaml);
    const repo = v.repo as string;
    if (existsSync(repo) && statSync(repo).isDirectory()) {
      const p = ensureBriefPreface(repo, v["brief-preface"]);
      process.stderr.write(
        p.created
          ? `wrote ${p.path} from the template: add this repository's rules to it\n`
          : `brief preface: ${p.path} (kept)\n`,
      );
    }
    for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
    if (undeclared.length > 0) {
      process.stderr.write(
        `note: no Depends on:/deps: line in ${undeclared.map((n) => `#${n}`).join(", ")}; confirm their order before submitting\n`,
      );
    }
    process.stderr.write(`${noTree}${planBlock}`);
    for (const line of submitLines(v.out ?? "<wave.yaml>", process.env.VOLLEY_COORDINATOR)) {
      process.stderr.write(`${line}\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(`wave-from-issues: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      wave: { type: "string" },
      repo: { type: "string" },
      "release-branch": { type: "string" },
      model: { type: "string" },
      pipeline: { type: "string" },
      namespace: { type: "string" },
      "repo-slug": { type: "string" },
      satisfied: { type: "string" },
      "brief-preface": { type: "string" },
      merge: { type: "string" },
      autopilot: { type: "string" },
      "branch-update": { type: "string" },
      placement: { type: "string" },
      out: { type: "string" },
      "no-plan": { type: "boolean" },
      "plan-only": { type: "boolean" },
      verbose: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
