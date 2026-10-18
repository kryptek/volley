import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isReservedChannel } from "volley-mcp/channels";

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
}

export interface WaveResult {
  yaml: string;
  /** Issues whose body has no `Depends on:`/`deps:` line: their order must come from the human. */
  undeclared: number[];
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

/** The wave-file task id for an issue. */
export const taskIdFor = (issue: number) => `i${issue}`;

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
  const satisfied = new Set(opts.satisfied ?? []);
  for (const n of satisfied) {
    // Dropping it would silently cut the edge to a task that is actually in the wave.
    if (inSet.has(n)) throw new Error(`#${n} is in this wave and also listed as satisfied`);
  }

  const undeclared: number[] = [];
  const lines = [
    `# Generated by volley-issues scripts/wave-from-issues.ts from ${issues.length} issue(s).`,
    `wave: ${q(opts.wave)}`,
    `repo: ${q(opts.repo)}`,
    `release_branch: ${q(opts.releaseBranch)}`,
    `model: ${q(opts.model)}`,
    ...(opts.namespace !== undefined ? [`namespace: ${q(opts.namespace)}`] : []),
    `pipeline: ${opts.pipeline !== undefined ? q(opts.pipeline) : "[implement, [spec_review, quality_review], fixup, merge_ready]"}`,
    "tasks:",
  ];
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
      after.push(taskIdFor(ref));
    }
    lines.push(`  ${taskIdFor(issue.number)}:`, `    issue: ${issue.number}`);
    if (typeof issue.title === "string" && issue.title !== "") {
      lines.push(`    title: ${q(issue.title)}`);
    }
    if (after.length > 0) lines.push(`    after: [${after.join(", ")}]`);
  }
  return { yaml: `${lines.join("\n")}\n`, undeclared };
}

const HELP = `Usage: bun run scripts/wave-from-issues.ts <issues.json> --wave <id> --repo <path>
         --release-branch <branch> --model <model> [--pipeline <json>] [--namespace <ns>]
         [--repo-slug <owner/repo>] [--satisfied <n,n,...>] [--out <wave.yaml>]

<issues.json> is a JSON array of { number, title, body } ("-" reads stdin), e.g.
  for n in 101 102 103; do gh issue view $n --json number,title,body; done | jq -s . > issues.json
Each issue becomes task i<number>; a "Depends on: #N" or "deps: #N" line in its body becomes
after: [i<N>] (also "owner/repo#N" and issue URLs when --repo-slug names this repository,
and "- #N" list items under an empty label). A dependency outside the set is an error unless
listed in --satisfied; so is a dependency line it cannot read.
Writes the wave YAML to --out (default stdout). Issues with no dependency line are listed on
stderr: confirm their order with the human before submitting.
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
    const { yaml, undeclared } = waveFromIssues(issues, {
      wave: v.wave as string,
      repo: v.repo as string,
      releaseBranch: v["release-branch"] as string,
      model: v.model as string,
      ...(pipeline !== undefined ? { pipeline } : {}),
      ...(v.namespace !== undefined ? { namespace: v.namespace } : {}),
      ...(v["repo-slug"] !== undefined ? { repoSlug: v["repo-slug"] } : {}),
      satisfied,
    });
    if (v.out !== undefined) writeFileSync(v.out, yaml);
    else process.stdout.write(yaml);
    if (undeclared.length > 0) {
      process.stderr.write(
        `note: no Depends on:/deps: line in ${undeclared.map((n) => `#${n}`).join(", ")}; confirm their order before submitting\n`,
      );
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
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
