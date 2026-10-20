/**
 * What an agent window says the agent is for (pure). An agent id says nothing
 * about purpose (an ad-hoc agent's is its MCP prefix plus a random suffix), so
 * every window leads with a purpose, picked from the first source that applies:
 *
 * 1. `wave` — a wave task's title (`spec.tasks.<id>.title`): `<task> · <title>`,
 *    its issue (and open PR) linked through the wave state's `repo`.
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
import { UNASSIGNED } from "../../store/reducer";
import type { AgentView, WaveView } from "../../store/types";

export type PurposeSource = "wave" | "registered" | "session" | "cwd" | "narration" | "id";

export interface PurposeLink {
  text: string;
  /** Opens in a new tab; `null` for a bare number with no repo to resolve it in. */
  href: string | null;
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

/** `#42` / `PR #57` for a number (linked when `repo` is known), the URL's own number for a URL. */
function link(kind: "issue" | "pr", ref: unknown, repo: string | null): PurposeLink | null {
  const prefix = kind === "pr" ? "PR #" : "#";
  if (typeof ref === "number" && Number.isSafeInteger(ref) && ref > 0) {
    const path = kind === "pr" ? "pull" : "issues";
    return {
      text: `${prefix}${ref}`,
      href: repo ? `https://github.com/${repo}/${path}/${ref}` : null,
    };
  }
  if (typeof ref === "string" && /^https?:\/\//i.test(ref) && URL.canParse(ref)) {
    const n = /\/(\d+)\/?(?:[?#].*)?$/.exec(ref)?.[1];
    return { text: n ? `${prefix}${n}` : kind === "pr" ? "PR" : "issue", href: ref };
  }
  return null;
}

/** The basename of a path, or null for `/` or nothing. */
export function basename(p: unknown): string | null {
  if (typeof p !== "string") return null;
  const parts = p.split(/[/\\]/).filter((x) => x !== "");
  return oneLine(parts[parts.length - 1]);
}

/** Registry entries the harness hooks wrote: `model_source` is theirs (SPEC §4.3). */
const HOOK_SOURCES = new Set(["harness-hook", "unknown"]);

/**
 * An interactive Claude Code session rather than a dispatched agent: the hooks
 * registered it (`model_source`), nobody launched it (no `parent_id`) and no
 * wave runs it (SPEC §4.3).
 */
export function isSession(a: Pick<AgentView, "registry" | "parentId" | "wave" | "task">): boolean {
  const src = a.registry?.model_source;
  return (
    typeof src === "string" &&
    HOOK_SOURCES.has(src) &&
    a.parentId === null &&
    a.wave === UNASSIGNED &&
    a.task === null
  );
}

/** The earliest `progress` message the agent itself sent (not its hooks). */
function firstNarration(a: Pick<AgentView, "feed">): string | null {
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
      const repo = repoOf(s.repo);
      const issue = task?.issue ?? s.spec?.tasks[a.task]?.issue;
      const pr = task?.pr?.number;
      const links = [link("issue", issue, repo), link("pr", pr, repo)].filter(
        (l): l is PurposeLink => l !== null,
      );
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
