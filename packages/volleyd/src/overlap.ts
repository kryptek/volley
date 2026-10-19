import { DAEMON_DEFAULTS } from "./config-defaults";
import { exec } from "./exec";
import type { NudgeOnMerge, TaskId, WaveId } from "./types";

/**
 * Overlap warning: at submit, compare each new task's file list (the wave file's `files` hints
 * plus the `Files` section of its issue body) with the tasks of every other running wave.
 * Advisory only — a shared path is journaled and printed, never refused.
 */

export interface TaskFiles {
  id: TaskId;
  files: string[];
}

export interface OverlapWarning {
  paths: string[];
  /** The new wave's task first, then the running wave's task it collides with. */
  tasks: [{ wave: WaveId; task: TaskId }, { wave: WaveId; task: TaskId }];
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FILES_HEADING = /^(\*\*)?files(\*\*)?\s*:?\s*$/i;
const FILES_LINE = /^\s*(\*\*)?files\s*:\s*(\*\*)?\s*(.*)$/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const PATHISH = /^[\w.@*?{}\-/,]+$/;

/**
 * The file paths an issue body lists under a `## Files` / `### Files` heading or a `Files:` line.
 * Handles the plan format's quirks: several comma-separated paths in one backtick span, later
 * items relative to the first one's package (`pkg/src/a.ts, src/b.ts`), brace expansion
 * (`src/{a,b}.ts`), `(notes)` and trailing prose. Returns [] when there is no Files section.
 */
export function parseFilesSection(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const heading = HEADING.exec(line);
    const inline = heading === null ? FILES_LINE.exec(line) : null;
    if (!(heading !== null && FILES_HEADING.test(heading[1] ?? "")) && inline === null) continue;
    if (inline?.[3]) out.push(...bulletPaths(inline[3]));
    let seen = false;
    for (i += 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (l.trim() === "") {
        if (seen) break;
        continue;
      }
      const b = BULLET.exec(l);
      if (b === null) break; // a heading or prose ends the list
      seen = true;
      out.push(...bulletPaths(b[1] ?? ""));
    }
  }
  return [...new Set(out)];
}

/** The paths in one bullet's text. */
function bulletPaths(text: string): string[] {
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
  const raw = spans.length > 0 ? spans.join(",") : text.replace(/\s+[—–-]\s+.*$/, "");
  const items = splitOutsideBraces(raw.replace(/\([^)]*\)/g, ""))
    .map((s) =>
      s
        .trim()
        .replace(/^\.\//, "")
        .replace(/[.;:]+$/, ""),
    )
    .filter((s) => s !== "" && PATHISH.test(s) && /[/.]/.test(s));
  const first = items[0];
  return items.flatMap((item, n) =>
    expandBraces(n === 0 || first === undefined ? item : rebase(item, first)),
  );
}

/** `src/b.ts` after `pkg/x/src/a.ts` → `pkg/x/src/b.ts` (relative to the first item's package). */
function rebase(item: string, first: string): string {
  const head = item.split("/")[0];
  const segs = first.split("/");
  const at = segs.indexOf(head ?? "");
  return at > 0 ? [...segs.slice(0, at), item].join("/") : item;
}

function splitOutsideBraces(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

function expandBraces(p: string): string[] {
  const m = /\{([^{}]*)\}/.exec(p);
  if (m === null) return [p];
  const pre = p.slice(0, m.index);
  const post = p.slice(m.index + m[0].length);
  return (m[1] ?? "").split(",").flatMap((alt) => expandBraces(`${pre}${alt.trim()}${post}`));
}

const isPattern = (p: string) => /[*?]/.test(p) || p.endsWith("/");

function globRe(p: string): RegExp {
  const src = p
    .split("**")
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]"),
    )
    .join(".*");
  return new RegExp(`^${src}${p.endsWith("/") ? ".*" : ""}$`);
}

/** The concrete path two entries share, or null. A glob or `dir/` matches the paths under it. */
function shared(a: string, b: string): string | null {
  if (a === b) return a;
  if (isPattern(a) && globRe(a).test(b)) return b;
  if (isPattern(b) && globRe(b).test(a)) return a;
  return null;
}

/** One warning per (new task, running task) pair that shares at least one path. */
export function findOverlaps(
  incoming: { wave: WaveId; tasks: TaskFiles[] },
  running: { wave: WaveId; tasks: TaskFiles[] }[],
): OverlapWarning[] {
  const out: OverlapWarning[] = [];
  for (const t of incoming.tasks) {
    for (const other of running) {
      for (const u of other.tasks) {
        const paths = new Set<string>();
        for (const a of t.files) {
          for (const b of u.files) {
            const p = shared(a, b);
            if (p !== null) paths.add(p);
          }
        }
        if (paths.size > 0) {
          out.push({
            paths: [...paths],
            tasks: [
              { wave: incoming.wave, task: t.id },
              { wave: other.wave, task: u.id },
            ],
          });
        }
      }
    }
  }
  return out;
}

export function formatOverlap(w: OverlapWarning): string {
  const [a, b] = w.tasks;
  return `overlap: ${a.wave}/${a.task} and ${b.wave}/${b.task} both touch ${w.paths.join(", ")}`;
}

/** A running implementer a merged PR may nudge: its task's wave-file `files` hints. */
export interface RunningImplementer {
  task: TaskId;
  agent_id: string;
  files: string[];
}

/** One merge nudge to send: `files` are the merged PR's paths it touches (empty under `all`). */
export interface NudgeTarget {
  task: TaskId;
  agent_id: string;
  files: string[];
}

/**
 * Who a merged PR nudges (`placement.nudge_on_merge`): under `files`, each running implementer
 * whose task's files hints share a path with the PR's changed files (a task with no hints is
 * never nudged); under `all`, every one of them; under `off`, none. Pure.
 */
export function nudgeTargets(
  running: RunningImplementer[],
  mergedFiles: string[],
  mode: NudgeOnMerge,
): NudgeTarget[] {
  if (mode === "off") return [];
  if (mode === "all")
    return running.map((r) => ({ task: r.task, agent_id: r.agent_id, files: [] }));
  return running.flatMap((r) => {
    const files = mergedFiles.filter((m) => r.files.some((f) => shared(f, m) !== null));
    return files.length > 0 ? [{ task: r.task, agent_id: r.agent_id, files }] : [];
  });
}

/** The steering text of one merge nudge. volleyd never rebases: the agent does, in its session. */
export function nudgeText(o: {
  release_branch: string;
  /** The commit the release branch moved to (the merge), when known. */
  sha: string | null;
  pr: number;
  files: string[];
}): string {
  const moved = `origin/${o.release_branch} moved${o.sha !== null ? ` to ${o.sha.slice(0, 7)}` : ""} with #${o.pr}`;
  const touches =
    o.files.length > 0 ? ` (touches ${o.files.length} of your files: ${o.files.join(", ")})` : "";
  return `${moved}${touches}; rebase when convenient, before you push again.`;
}

/** The changed paths in `gh pr view <n> --json files` output; null when it does not parse. */
export function parsePrFiles(stdout: string): string[] | null {
  try {
    const files = (JSON.parse(stdout) as { files?: unknown }).files;
    if (!Array.isArray(files)) return null;
    return files.flatMap((f) =>
      typeof (f as { path?: unknown })?.path === "string" ? [(f as { path: string }).path] : [],
    );
  } catch {
    return null;
  }
}

/** Signature of the issue-body fetcher the daemon uses at submit (injected in tests). */
export type IssueBodyFn = (repo: string, issue: number) => Promise<string | null>;

/** Fetch an issue body with `gh issue view` (read-only, through the fence); null on failure. */
export const ghIssueBody: IssueBodyFn = async (repo, issue) => {
  const r = await exec(
    ["gh", "issue", "view", String(issue), "--repo", repo, "--json", "body", "--jq", ".body"],
    {
      timeoutMs: DAEMON_DEFAULTS.issue_fetch_ms,
    },
  );
  return r.code === 0 && !r.timedOut ? r.stdout : null;
};
