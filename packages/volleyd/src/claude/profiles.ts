import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { ID_PATTERN } from "volley-mcp/topics";

/**
 * Claude account profiles: one Claude Code profile per account, each its own
 * `CLAUDE_CONFIG_DIR` at `<root>/<acct>` (default root `~/.volley/claude`), listed in
 * `<root>/accounts.json`. A profile is signed in only through Claude Code's own flow
 * (signin.ts); volleyd never reads, stores or forwards a credential — the registry holds an id, a
 * label, the machine and a plan label, nothing else.
 *
 * `primary` is the user's own default profile (`~/.claude`, no `CLAUDE_CONFIG_DIR`): what an agent
 * runs under when nothing selects an account.
 */

export const PRIMARY_ACCOUNT = "primary";
/** `claude.default_account` value that picks the account with the most usage headroom (O8). */
export const MOST_HEADROOM = "most_headroom";
/** The machine a profile lives on when `--machine` names none: the supervisor's own. */
export const LOCAL_MACHINE = "local";

/** Account ids are topic segments (`volley/_system/claude/<acct>/signin`). */
export const isValidAccountId = (id: string) => ID_PATTERN.test(id);

export class ClaudeAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAccountError";
  }
}

export interface ClaudeAccount {
  id: string;
  label: string;
  machine: string;
  created: string;
  /** Claude Code's `subscriptionType` (`claude auth status`), once signed in. */
  plan?: string;
  signed_in_at?: string;
}

export interface ClaudeRegistry {
  version: 1;
  accounts: ClaudeAccount[];
}

/** `$VOLLEY_CLAUDE_DIR`, else `~/.volley/claude`. */
export function claudeRoot(env: Record<string, string | undefined> = process.env): string {
  const dir = env.VOLLEY_CLAUDE_DIR;
  return dir !== undefined && dir !== "" ? dir : join(homedir(), ".volley", "claude");
}

export const registryPath = (root: string) => join(root, "accounts.json");

/**
 * The profile's `CLAUDE_CONFIG_DIR`. Claude Code keys the profile's Keychain item to a hash of
 * this exact string, so it is always one canonical absolute path with no trailing slash.
 */
export function profileDir(root: string, id: string): string {
  if (!isAbsolute(root)) throw new ClaudeAccountError(`profile root ${root} is not absolute`);
  if (!isValidAccountId(id)) throw new ClaudeAccountError(`invalid Claude account id '${id}'`);
  return normalize(join(root, id)).replace(/\/+$/, "");
}

/** A label as an account id: lowercased, runs of anything else collapsed to `-`. */
export function accountIdFor(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}

export function readRegistry(root: string): ClaudeRegistry {
  let text: string;
  try {
    text = readFileSync(registryPath(root), "utf-8");
  } catch {
    return { version: 1, accounts: [] };
  }
  let raw: Partial<ClaudeRegistry>;
  try {
    raw = JSON.parse(text) as Partial<ClaudeRegistry>;
  } catch (e) {
    throw new ClaudeAccountError(
      `${registryPath(root)} is not valid JSON (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  return { version: 1, accounts: Array.isArray(raw.accounts) ? raw.accounts : [] };
}

function writeRegistry(root: string, reg: ClaudeRegistry): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = registryPath(root);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Create the profile directory and its registry entry. Sign-in is a separate step. */
export function addAccount(
  root: string,
  input: { label: string; machine?: string },
  now: string,
): ClaudeAccount {
  const label = input.label.trim();
  const id = accountIdFor(label);
  if (!isValidAccountId(id))
    throw new ClaudeAccountError(`label '${input.label}' gives no usable account id`);
  if (id === PRIMARY_ACCOUNT || id === MOST_HEADROOM)
    throw new ClaudeAccountError(`'${id}' is reserved; pick another label`);
  const reg = readRegistry(root);
  if (reg.accounts.some((a) => a.id === id))
    throw new ClaudeAccountError(`Claude account '${id}' already exists`);
  const dir = profileDir(root, id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const acct: ClaudeAccount = { id, label, machine: input.machine ?? LOCAL_MACHINE, created: now };
  writeRegistry(root, { version: 1, accounts: [...reg.accounts, acct] });
  return acct;
}

/** Record a finished sign-in: when, and the plan label `claude auth status` reported. */
export function markSignedIn(
  root: string,
  id: string,
  facts: { plan?: string },
  now: string,
): ClaudeAccount {
  const reg = readRegistry(root);
  const i = reg.accounts.findIndex((a) => a.id === id);
  const prev = reg.accounts[i];
  if (prev === undefined) throw new ClaudeAccountError(`unknown Claude account '${id}'`);
  const next: ClaudeAccount = {
    ...prev,
    ...(facts.plan !== undefined ? { plan: facts.plan } : {}),
    signed_in_at: now,
  };
  reg.accounts[i] = next;
  writeRegistry(root, reg);
  return next;
}

/** Where an agent's account came from: its task, its wave, the config default, or nothing. */
export type AccountSource = "task" | "wave" | "config" | "default";

export interface SelectedAccount {
  id: string;
  /** The profile's `CLAUDE_CONFIG_DIR`; null for the primary (Claude Code's default profile). */
  dir: string | null;
  source: AccountSource;
  /** Set when `most_headroom` could not be resolved and fell back to the primary. */
  fallback?: typeof MOST_HEADROOM;
}

/**
 * The account an agent runs under: the task's `account:`, else the wave's, else
 * `claude.default_account`, else the primary. `most_headroom` is the account `headroom` ranks
 * first (usage metering, claude/usage.ts), else the primary. Throws for an unknown account, one
 * not signed in yet, or one whose profile lives on another machine.
 */
export function selectAccount(
  root: string,
  /** The registry, or how to read it: only read when a profile (not the primary) is picked. */
  registry: ClaudeRegistry | (() => ClaudeRegistry),
  want: { task?: string; wave?: string; configDefault?: string | null },
  /** The account with the most usage headroom; null (or absent) when there is no usage data. */
  headroom?: () => string | null,
): SelectedAccount {
  const pick: [AccountSource, string | null | undefined][] = [
    ["task", want.task],
    ["wave", want.wave],
    ["config", want.configDefault],
  ];
  const [source, wanted] = pick.find(([, v]) => v !== undefined && v !== null) ?? ["default", null];
  let id = wanted;
  if (id === MOST_HEADROOM) {
    const best = headroom?.() ?? null;
    if (best === null || best === MOST_HEADROOM)
      return { id: PRIMARY_ACCOUNT, dir: null, source, fallback: MOST_HEADROOM };
    id = best;
  }
  if (id === null || id === undefined || id === PRIMARY_ACCOUNT)
    return { id: PRIMARY_ACCOUNT, dir: null, source };
  const reg = typeof registry === "function" ? registry() : registry;
  const acct = reg.accounts.find((a) => a.id === id);
  if (acct === undefined) throw new ClaudeAccountError(`unknown Claude account '${id}'`);
  if (acct.machine !== LOCAL_MACHINE)
    throw new ClaudeAccountError(
      `Claude account '${id}' lives on machine '${acct.machine}', not this supervisor's`,
    );
  if (acct.signed_in_at === undefined)
    throw new ClaudeAccountError(
      `Claude account '${id}' is not signed in yet (volley claude add finishes in the browser)`,
    );
  return { id, dir: profileDir(root, id), source };
}
