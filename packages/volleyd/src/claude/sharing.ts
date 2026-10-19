import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { systemClock } from "../clock";
import { DAEMON_DEFAULTS } from "../config-defaults";

/**
 * What a Claude account profile shares with the primary profile (`~/.claude`), per item, from
 * `<root>/sharing.yaml`:
 *
 *   linked — a symlink to `~/.claude/<item>`. Claude Code reads AND writes through it (the
 *            accounts spike, section (c)), so a write in any profile lands in the primary.
 *   copy   — copied once, when the profile has none; from then on it is the profile's own.
 *   own    — never touched (a link volleyd made earlier is removed).
 *
 * `mcp` is the `mcpServers` section of `.claude.json`: `copy` re-syncs it from the primary's
 * `~/.claude.json` on `volley claude sync` and at every spawn under the profile; it can never be
 * `linked`. `.claude.json` itself holds the profile's own account (`oauthAccount`, `userID`) and is
 * never linked or copied whole, and `.credentials.json` (Claude Code's fallback when the Keychain
 * is locked) is never touched at all: only the items below are.
 */

export const SHARE_ITEMS = [
  "settings.json",
  "CLAUDE.md",
  "skills",
  "agents",
  "commands",
  "plugins",
  "mcp",
] as const;
export type ShareItem = (typeof SHARE_ITEMS)[number];
export type ShareMode = "linked" | "copy" | "own";
export type Sharing = Record<ShareItem, ShareMode>;

/**
 * The defaults, from the spike's findings: `CLAUDE.md`, `agents`, `commands` are read-only in
 * practice; `skills` and `plugins` take account-synced content in per-account buckets, so they
 * share without colliding; `settings.json` takes `/model` writes from every profile, so it is
 * copied, never linked; `mcp` is copied (its entries can hold third-party secrets, which a copy
 * spreads no further than the profiles on this machine).
 */
export const DEFAULT_SHARING: Sharing = {
  "settings.json": "copy",
  "CLAUDE.md": "linked",
  skills: "linked",
  agents: "linked",
  commands: "linked",
  plugins: "linked",
  mcp: "copy",
};

const MODES: readonly ShareMode[] = ["linked", "copy", "own"];

export class SharingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharingError";
  }
}

export const sharingPath = (root: string) => join(root, "sharing.yaml");

/** `sharing.yaml` text over the defaults. Throws for an unknown item or mode. */
export function parseSharing(text: string): Sharing {
  const raw = (parse(text) ?? {}) as unknown;
  if (typeof raw !== "object" || Array.isArray(raw))
    throw new SharingError("sharing.yaml must be a mapping of item: mode");
  const out: Sharing = { ...DEFAULT_SHARING };
  for (const [item, mode] of Object.entries(raw as Record<string, unknown>)) {
    if (item === ".claude.json")
      throw new SharingError(
        ".claude.json holds the profile's own account: it is never shared (use `mcp` for its MCP servers)",
      );
    if (!(SHARE_ITEMS as readonly string[]).includes(item))
      throw new SharingError(`unknown item '${item}' (one of ${SHARE_ITEMS.join(", ")})`);
    if (!MODES.includes(mode as ShareMode))
      throw new SharingError(`${item}: mode must be linked | copy | own`);
    if (item === "mcp" && mode === "linked")
      throw new SharingError("mcp: the MCP servers are copied or own, never linked");
    out[item as ShareItem] = mode as ShareMode;
  }
  return out;
}

export function readSharing(root: string): Sharing {
  let text: string;
  try {
    text = readFileSync(sharingPath(root), "utf-8");
  } catch {
    return { ...DEFAULT_SHARING };
  }
  return parseSharing(text);
}

/** One file-level step for one item (`mcp` is syncMcp's, not a step). */
export interface ShareStep {
  item: Exclude<ShareItem, "mcp">;
  mode: ShareMode;
  src: string;
  dst: string;
}

/** The steps that bring `profile` in line with `sharing` (pure). */
export function planSharing(sharing: Sharing, primary: string, profile: string): ShareStep[] {
  return SHARE_ITEMS.filter((i): i is ShareStep["item"] => i !== "mcp").map((item) => ({
    item,
    mode: sharing[item],
    src: join(primary, item),
    dst: join(profile, item),
  }));
}

export interface ShareResult {
  item: ShareItem;
  mode: ShareMode;
  result: string;
}

const isLinkTo = (path: string, target: string) => {
  try {
    return lstatSync(path).isSymbolicLink() && readlinkSync(path) === target;
  } catch {
    return false;
  }
};
const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Apply the steps. Never replaces something of the profile's own; reports what it did. */
export function applySharing(steps: readonly ShareStep[]): ShareResult[] {
  return steps.map(({ item, mode, src, dst }) => {
    const done = (result: string): ShareResult => ({ item, mode, result });
    if (mode === "own") {
      if (!isLinkTo(dst, src)) return done("own");
      unlinkSync(dst);
      return done("unlinked");
    }
    if (mode === "linked") {
      if (isLinkTo(dst, src)) return done("linked");
      if (!existsSync(src)) return done("skipped: not in the primary");
      if (present(dst)) return done("conflict: the profile has its own; left as is");
      symlinkSync(src, dst);
      return done("linked");
    }
    if (present(dst)) return done("kept");
    if (!existsSync(src)) return done("skipped: not in the primary");
    cpSync(src, dst, { recursive: true, dereference: false, preserveTimestamps: true });
    return done("copied");
  });
}

/** Synchronous wait (Claude Code's `.claude.json.lock` is held for milliseconds). */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A JSON file's object, or null (absent or unreadable). */
const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/**
 * Edit a profile's `.claude.json` under the same mkdir lock Claude Code takes (`<file>.lock/`):
 * read → `edit` (null: nothing to change) → write a temp file (0600) → rename. A lock older than
 * `claude_json_lock_stale_ms` was left by a process that died holding it, and is taken over.
 */
function editClaudeJson(
  profileJson: string,
  edit: (cur: Record<string, unknown>) => Record<string, unknown> | null,
  opts: { lockAttempts?: number; lockWaitMs?: number; lockStaleMs?: number } = {},
): boolean {
  if (present(profileJson) && lstatSync(profileJson).isSymbolicLink())
    throw new SharingError(`${profileJson} is a symlink: a profile's .claude.json is never linked`);
  const lock = `${profileJson}.lock`;
  const attempts = opts.lockAttempts ?? DAEMON_DEFAULTS.claude_json_lock_attempts;
  const staleMs = opts.lockStaleMs ?? DAEMON_DEFAULTS.claude_json_lock_stale_ms;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        // real clock: compared with a lock file's mtime, which the filesystem stamps
        if (systemClock.now() - statSync(lock).mtimeMs > staleMs) {
          rmdirSync(lock);
          continue;
        }
      } catch {}
      if (i + 1 >= attempts)
        throw new SharingError(
          `${lock} is held; if no Claude Code session of this profile is running, remove it`,
        );
      pause(opts.lockWaitMs ?? DAEMON_DEFAULTS.claude_json_lock_wait_ms);
    }
  }
  try {
    const next = edit(readJson(profileJson) ?? {});
    if (next === null) return false;
    mkdirSync(dirname(profileJson), { recursive: true });
    const tmp = `${profileJson}.volleyd.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, profileJson);
    return true;
  } finally {
    rmdirSync(lock);
  }
}

/**
 * Copy the primary's `mcpServers` into a profile's `.claude.json`, keeping every other key of the
 * profile's own (editClaudeJson). The result names the servers only: their entries (`env`,
 * `headers`) can hold third-party secrets, so they are never logged or published.
 */
export function syncMcp(
  primaryJson: string,
  profileJson: string,
  opts: { lockAttempts?: number; lockWaitMs?: number; lockStaleMs?: number } = {},
): { servers: string[]; changed: boolean } {
  const servers = (readJson(primaryJson)?.mcpServers ?? {}) as Record<string, unknown>;
  const changed = editClaudeJson(
    profileJson,
    (cur) =>
      JSON.stringify(cur.mcpServers ?? null) !== JSON.stringify(servers)
        ? { ...cur, mcpServers: servers }
        : null,
    opts,
  );
  return { servers: Object.keys(servers), changed };
}

/**
 * Mark a profile's onboarding done (`hasCompletedOnboarding: true`) unless it already is: a fresh
 * profile has a sign-in but not this, and an agent's first session would stop at onboarding.
 */
export function seedOnboarding(
  profileJson: string,
  opts: { lockAttempts?: number; lockWaitMs?: number; lockStaleMs?: number } = {},
): boolean {
  return editClaudeJson(
    profileJson,
    (cur) =>
      cur.hasCompletedOnboarding === true ? null : { ...cur, hasCompletedOnboarding: true },
    opts,
  );
}
