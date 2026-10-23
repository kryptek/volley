import { createHash } from "node:crypto";
import { constants, accessSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecFn } from "./exec";
import { mintScriptToken } from "./fence";
import { SpawnError } from "./spawn-error";
import { expandHome } from "./worktree";

/** The roles volleyd spawns; each has `briefs/<role>.md.tmpl`. */
export const ROLES = [
  "implementer",
  "spec_reviewer",
  "quality_reviewer",
  "fixup",
  "rebase",
  "release",
] as const;
export type Role = (typeof ROLES)[number];

export const isRole = (r: string): r is Role => (ROLES as readonly string[]).includes(r);

export const BRIEFS_DIR = fileURLToPath(new URL("../briefs/", import.meta.url));

/** Every placeholder a template may use. */
export interface BriefVars {
  agent_id: string;
  namespace: string;
  wave: string;
  task: string;
  role: Role;
  issue: number;
  issue_title: string;
  issue_url: string;
  /**
   * The bundle placeholders (issueVars): every issue of the task (`#310, #312`; one issue: `#42`)
   * and the rest of the set below. Absent: renderBrief fills them from `issue`, `issue_title` and
   * `issue_url` as a single issue's.
   */
  issues?: string;
  /** A bundle: one `- #<n> — <title>` line per issue; one issue: "". */
  issue_titles?: string;
  /** One `Closes #<n>` line per issue. */
  closes_lines?: string;
  /** `issue #42: <title>`; a bundle: `issues #310, #312`. */
  issue_heading?: string;
  /** What `ISSUE.md` holds: `the issue, <url>`; a bundle: every issue of it. */
  issue_source?: string;
  /** A bundle: the PR rule with its `Closes` lines, each on its own line; one issue: "". */
  closes_rule?: string;
  /** The changelog fragment(s) to add: one per issue. */
  fragments?: string;
  /** The issue-number rule's first sentence. */
  issue_rule?: string;
  model: string;
  repo: string;
  release_branch: string;
  branch: string;
  worktree: string;
  /** Repo-specific notes (`<repo>/.volley/brief-extra.md`), rendered as their own section. */
  extra: string;
  /** Reviewer briefs: the hygiene check line and its contract bullet (reviews.ts hygieneText). */
  hygiene_rule: string;
  hygiene_contract: string;
  /** The release role (autopilot/release-train.ts stageBriefVars): its playbook stage; else "". */
  stage: string;
  stage_brief: string;
  stage_commands: string;
  stage_verify: string;
}

/** The fields of an issue a brief names. */
export interface BriefIssue {
  number: number;
  title: string;
  url: string;
}

type IssueVars = Required<
  Pick<
    BriefVars,
    | "issue"
    | "issue_title"
    | "issue_url"
    | "issues"
    | "issue_titles"
    | "closes_lines"
    | "issue_heading"
    | "issue_source"
    | "closes_rule"
    | "fragments"
    | "issue_rule"
  >
>;

const fragment = (n: number) => `\`changes/${n}.<added|changed|fixed|removed|docs>.md\``;

/**
 * The issue placeholders of a task's brief from its issues (the task's `issue` first). One issue
 * fills them so every template renders exactly as before bundles; a bundle (several issues, one
 * agent, one PR) names them all, asks for one `Closes` line and one fragment per issue.
 */
export function issueVars(issues: readonly BriefIssue[]): IssueVars {
  const [first] = issues;
  if (first === undefined) throw new Error("issueVars: a task has at least one issue");
  const closes_lines = issues.map((i) => `Closes #${i.number}`).join("\n");
  const base = {
    issue: first.number,
    issue_title: first.title,
    issue_url: first.url,
    closes_lines,
  };
  if (issues.length === 1) {
    return {
      ...base,
      issues: `#${first.number}`,
      issue_titles: "",
      issue_heading: `issue #${first.number}: ${first.title}`,
      issue_source: `the issue, ${first.url}`,
      closes_rule: "",
      fragments: fragment(first.number),
      issue_rule: `The issue number is ${first.number}; \`ISSUE.md\` is the authoritative copy of the issue.`,
    };
  }
  const numbers = issues.map((i) => i.number);
  const listed = `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
  return {
    ...base,
    issues: numbers.map((n) => `#${n}`).join(", "),
    issue_titles: issues.map((i) => `- #${i.number} — ${i.title}`).join("\n"),
    issue_heading: `issues ${numbers.map((n) => `#${n}`).join(", ")}`,
    issue_source: "every issue of this bundle, one after another",
    closes_rule: `This task bundles ${issues.length} issues into one PR: put these lines, each on its own line, in the PR body (GitHub closes only the first issue of a shared line):\n\n${closes_lines}`,
    fragments: `one fragment per issue, ${numbers.map(fragment).join(" and ")}`,
    issue_rule: `The issue numbers are ${listed} (one bundle, one PR); \`ISSUE.md\` is the authoritative copy of every one of them.`,
  };
}

/** The stage placeholders of a brief that is not a release stage's: all empty. */
export const NO_STAGE = {
  stage: "",
  stage_brief: "",
  stage_commands: "",
  stage_verify: "",
} as const;

/**
 * `<role>.md.tmpl`, or `<role>-<variant>.md.tmpl` (the rebase role's `merge` brief, under
 * `branch_update: merge`); the implementer's `flake` variant is `flake-fixer.md.tmpl` (a flake's
 * fixer, SPEC §4.6.16).
 */
export function loadTemplate(
  role: Role,
  dir: string = BRIEFS_DIR,
  variant?: "merge" | "flake",
): string {
  const name =
    variant === "flake" ? "flake-fixer" : `${role}${variant !== undefined ? `-${variant}` : ""}`;
  return readFileSync(join(dir, `${name}.md.tmpl`), "utf-8");
}

/**
 * Fill `{{name}}` placeholders in one pass, so text substituted in (an issue title that itself
 * contains `{{…}}`) is never expanded again. An unknown placeholder is an error: a template and
 * this module never silently drift apart. A placeholder alone on its line that fills to "" drops
 * the line (and, between two blank lines, one of them), so it leaves no gap behind. That holds
 * for every placeholder in every template, e.g. an empty `{{extra}}` (no repo notes) as well as
 * `{{hygiene_rule}}` / `{{hygiene_contract}}` under `off`.
 */
export function renderBrief(template: string, vars: BriefVars): string {
  const single = issueVars([{ number: vars.issue, title: vars.issue_title, url: vars.issue_url }]);
  const table = { ...single, ...vars } as unknown as Record<string, string | number>;
  const lines: string[] = [];
  let dropped = false;
  for (const line of template.split("\n")) {
    const only = /^\s*\{\{\s*([a-z_]+)\s*\}\}\s*$/.exec(line)?.[1];
    if (only !== undefined && Object.hasOwn(table, only) && String(table[only]) === "") {
      dropped = lines.at(-1) === "";
      continue;
    }
    if (dropped && line === "") {
      dropped = false;
      continue;
    }
    dropped = false;
    lines.push(line);
  }
  return lines.join("\n").replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, name: string) => {
    if (!Object.hasOwn(table, name)) throw new Error(`brief template: unknown {{${name}}}`);
    return String(table[name]);
  });
}

/** `<repoRoot>/.volley/brief-extra.md`: repository notes for every brief (kept out of git). */
export const briefExtraPath = (repoRoot: string) => join(repoRoot, ".volley", "brief-extra.md");

/** The `extra` section from the local `<repoRoot>/.volley/brief-extra.md`, or "". */
export function briefExtra(repoRoot: string): string {
  const file = briefExtraPath(repoRoot);
  return briefExtraFrom(existsSync(file) ? readFileSync(file, "utf-8") : null);
}

/** The `extra` section from the notes file's text (null: no file), or "". */
export function briefExtraFrom(content: string | null): string {
  const text = (content ?? "").trim();
  return text === "" ? "" : `\n## Repository notes\n\n${text}\n`;
}

/** The preface file when the wave file names none: `<repo>/.volley/brief-preface.md`. */
export const DEFAULT_BRIEF_PREFACE = join(".volley", "brief-preface.md");

/** Between the preface and the role template (blank lines first: never a setext heading). */
export const BRIEF_PREFACE_RULE = "\n\n---\n\n";

/** What the wave state shows of a preface (wave-state `brief_preface`). */
export interface BriefPrefaceInfo {
  path: string;
  sha256: string;
  bytes: number;
}

/** A loaded preface: its info plus its text. */
export interface BriefPreface extends BriefPrefaceInfo {
  text: string;
}

/** A preface over `brief_preface_max_bytes`. */
export class BriefPrefaceTooLarge extends Error {
  readonly code = "BRIEF_PREFACE_TOO_LARGE";
  readonly detail: Record<string, unknown>;
  constructor(path: string, bytes: number, max: number) {
    super(
      `BRIEF_PREFACE_TOO_LARGE: ${path} is ${bytes} B; brief_preface_max_bytes is ${max} B (shorten it, or raise the tunable)`,
    );
    this.name = "BriefPrefaceTooLarge";
    this.detail = { path, bytes, max };
  }
}

/**
 * The preface file of a wave in `repo`: the wave file's `brief_preface:` (relative to the repo,
 * or absolute), else `<repo>/.volley/brief-preface.md`. Resolved on the supervisor's host.
 */
export function briefPrefacePath(repo: string, configured?: string): string {
  const file = configured ?? DEFAULT_BRIEF_PREFACE;
  return isAbsolute(file) || file.startsWith("~") ? expandHome(file) : join(expandHome(repo), file);
}

/**
 * Read the preface at `path`: null when there is no file, or a blank one (no agent would get
 * anything, so it is reported and journaled as missing). Over `maxBytes`, or not valid UTF-8 (the
 * brief carries the file's exact bytes), throws.
 */
export function readBriefPreface(path: string, maxBytes: number): BriefPreface | null {
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  if (bytes.length > maxBytes) throw new BriefPrefaceTooLarge(path, bytes.length, maxBytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`brief preface ${path} is not valid UTF-8`);
  }
  if (text.trim() === "") return null;
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    text,
  };
}

/** The wave-state shape of a preface (no text). */
export const prefaceInfo = (p: BriefPreface | null): BriefPrefaceInfo | null =>
  p === null ? null : { path: p.path, sha256: p.sha256, bytes: p.bytes };

/**
 * The brief an agent gets: the preface verbatim (no placeholder expansion), the rule, then the
 * rendered role template.
 */
export function withPreface(preface: BriefPreface | null, brief: string): string {
  if (preface === null) return brief;
  return `${preface.text}${BRIEF_PREFACE_RULE}${brief}`;
}

/** `brief preface: <path> (<bytes> B, sha256 <12 hex>)`, or `brief preface: none`. */
export function formatBriefPreface(p: BriefPrefaceInfo | null): string {
  return p === null
    ? "brief preface: none"
    : `brief preface: ${p.path} (${p.bytes} B, sha256 ${p.sha256.slice(0, 12)})`;
}

/**
 * The brief gate: `$VOLLEYD_HOME/brief-gate`, if present and executable. It is a local file on
 * purpose: a gate is a program, so it must not be settable over the broker (`config_set`).
 */
export function briefGatePath(home: string): string | null {
  const file = join(home, "brief-gate");
  try {
    accessSync(file, constants.X_OK);
    return file;
  } catch {
    return null;
  }
}

/**
 * Run the gate on the rendered brief: `<gate> <brief.md>` in the worktree. A non-zero exit (or
 * a gate that cannot run) refuses the spawn with SPAWN_BRIEF_REJECTED, before any launch.
 */
export async function runBriefGate(
  exec: ExecFn,
  gate: string,
  briefPath: string,
  cwd: string,
): Promise<void> {
  let r: Awaited<ReturnType<ExecFn>>;
  try {
    r = await exec([gate, briefPath], { cwd, script: mintScriptToken(gate) });
  } catch (e) {
    throw new SpawnError(
      "SPAWN_BRIEF_REJECTED",
      `brief gate did not run: ${e instanceof Error ? e.message : String(e)}`,
      { gate },
    );
  }
  if (r.code !== 0) {
    throw new SpawnError("SPAWN_BRIEF_REJECTED", `brief gate exited ${r.code}`, {
      gate,
      exit: r.code,
      stderr: r.stderr.trim(),
      stdout: r.stdout.trim(),
    });
  }
}
