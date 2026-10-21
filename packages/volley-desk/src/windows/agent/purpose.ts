/**
 * What an agent window says the agent is for (pure). An agent id says nothing
 * about purpose (an ad-hoc agent's is its MCP prefix plus a random suffix), so
 * every window leads with a purpose, picked from the first source that applies:
 *
 * 1. `wave` — a wave task's title (`spec.tasks.<id>.title`): `<task> · <title>`,
 *    its issue linked through the wave state's `github`, its PR through `pr.url`.
 * 2. `registered` — the `title` the agent registered (SPEC §6.2), with its
 *    `links` (`#N` / `PR #N` in `links.repo`, or an http(s) URL).
 * 3. `session` — an interactive session (`isSession`): its terminal workspace
 *    title (`workspace_title`, from the hooks) and the basename of its `cwd`.
 * 4. `cwd` — the basename of the registry `cwd` (a worktree name).
 * 5. `narration` — the earliest progress message the agent itself sent (else
 *    its latest narration).
 * 6. `id` — the agent id. The label is never blank.
 *
 * The window, the steering panel, the unassigned / sessions cards and the
 * Needs-you notification all use the same `label`.
 */
import { isIssueNumber, issueHref, issueLabel, prHref, prLabel } from "../../lib/github";
import { isSession } from "../../store/reducer";
import type { AgentView, WaveView } from "../../store/types";

export type PurposeSource = "wave" | "registered" | "session" | "cwd" | "narration" | "id";

export interface PurposeLink {
  text: string;
  /** Opens in a new tab; `null` for a bare number with no repo to resolve it in. */
  href: string | null;
  /** The accessible name (`Issue #42 on GitHub`, `PR #7 on <host>`; `Issue #42` unlinked). */
  label: string;
}

export interface Purpose {
  label: string;
  /** The label and its links, for the hover / tap text. */
  full: string;
  source: PurposeSource;
  links: PurposeLink[];
}

/** One line: runs of whitespace (line breaks included) become one space. */
const oneLine = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};

const REPO = /^[^/\s]+\/[^/\s]+$/;

function repoOf(v: unknown): string | null {
  return typeof v === "string" && REPO.test(v) ? v : null;
}

/**
 * A purpose link's accessible name. One rule for every purpose link: `on GitHub` when the
 * link is known to open on GitHub, else `on <host>`; bare when unlinked. A wave's links are
 * known to be GitHub (`onGitHub`: the supervisor read the repository with gh, an Enterprise host included);
 * a registered URL is known to be GitHub only on github.com, so any other host is named.
 */
function labelOf(
  kind: "issue" | "pr",
  n: string | null,
  href: string | null,
  onGitHub = false,
): string {
  const what = kind === "pr" ? "PR" : "Issue";
  const name = n ? `${what} #${n}` : what;
  if (href === null) return name;
  const host = new URL(href).hostname;
  if (onGitHub || host === "github.com" || host.endsWith(".github.com"))
    return n ? (kind === "pr" ? prLabel(n) : issueLabel(n)) : `${name} on GitHub`;
  return `${name} on ${host}`;
}

/** `#42` / `PR #57` for a number (linked when `repo` is known), the URL's own number for a URL. */
function link(kind: "issue" | "pr", ref: unknown, repo: string | null): PurposeLink | null {
  const prefix = kind === "pr" ? "PR #" : "#";
  if (isIssueNumber(ref)) {
    const path = kind === "pr" ? "pull" : "issues";
    const href = repo ? `https://github.com/${repo}/${path}/${ref}` : null;
    return { text: `${prefix}${ref}`, href, label: labelOf(kind, String(ref), href) };
  }
  if (typeof ref === "string" && /^https?:\/\//i.test(ref) && URL.canParse(ref)) {
    const n = /\/(\d+)\/?(?:[?#].*)?$/.exec(ref)?.[1] ?? null;
    return {
      text: n ? `${prefix}${n}` : kind === "pr" ? "PR" : "issue",
      href: ref,
      label: labelOf(kind, n, ref),
    };
  }
  return null;
}

/** The basename of a path, or null for `/` or nothing. */
export function basename(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const parts = p.split(/[/\\]/).filter((x) => x !== "");
  return oneLine(parts[parts.length - 1]);
}

/** The earliest `progress` message the agent itself sent (not its hooks). */
function firstNarration(a: Pick<AgentView, "feed" | "firstSaid">): string | null {
  const kept = oneLine(a.firstSaid);
  if (kept) return kept;
  for (const e of a.feed) {
    if (e.envelope.channel !== "progress") continue;
    const p = e.envelope.payload as Record<string, unknown> | null;
    if (p && typeof p === "object" && p.source !== "harness-hook") {
      const msg = oneLine(p.msg);
      if (msg) return msg;
    }
  }
  return null;
}

function make(label: string, source: PurposeSource, links: PurposeLink[] = []): Purpose {
  const full = [label, ...links.map((l) => l.text)].join(" · ");
  return { label, full, source, links };
}

export function purposeOf(a: AgentView, wave: WaveView | undefined): Purpose {
  const s = wave?.state;
  if (a.task && s) {
    const title = oneLine(s.spec?.tasks[a.task]?.title);
    if (title) {
      const task = s.tasks.find((t) => t.id === a.task);
      const issue = task?.issue ?? s.spec?.tasks[a.task]?.issue;
      const links: PurposeLink[] = [];
      if (isIssueNumber(issue)) {
        const href = issueHref(s.github, issue);
        // The wave's own repository is on GitHub (an Enterprise host included).
        links.push({ text: `#${issue}`, href, label: labelOf("issue", String(issue), href, true) });
      }
      const pr = task?.pr?.number;
      const prUrl = prHref(task);
      if (isIssueNumber(pr))
        links.push({
          text: `PR #${pr}`,
          href: prUrl,
          label: labelOf("pr", String(pr), prUrl, true),
        });
      return make(`${a.task} · ${title}`, "wave", links);
    }
  }
  const reg = a.registry;
  const title = oneLine(reg?.title);
  if (title) {
    const raw = reg?.links;
    const l = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const repo = repoOf(l.repo);
    const links = [link("issue", l.issue, repo), link("pr", l.pr, repo)].filter(
      (x): x is PurposeLink => x !== null,
    );
    return make(title, "registered", links);
  }
  const dir = basename(reg?.cwd);
  if (isSession(a)) {
    const ws = oneLine(reg?.workspace_title);
    if (ws) return make(dir ? `${ws} · ${dir}` : ws, "session");
  }
  if (dir) return make(dir, "cwd");
  const said = firstNarration(a) ?? oneLine(a.narration);
  if (said) return make(said, "narration");
  return make(a.id, "id");
}

/** Sources that name the window: its header shows the label and the id moves to a line below. */
export function namesWindow(p: Purpose): boolean {
  return p.source === "wave" || p.source === "registered" || p.source === "session";
}

/**
 * The window's name: the purpose label when it names the window, else the task (or the id),
 * as the title bar shows it. The accessible name, the chat button and the steering panel add
 * the role chip's text.
 */
export function headlineOf(a: AgentView, wave: WaveView | undefined): string {
  const p = purposeOf(a, wave);
  return namesWindow(p) ? p.label : (a.task ?? a.id);
}
