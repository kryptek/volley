import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { ID_PATTERN } from "volley-mcp/topics";
import { systemClock } from "../clock";
import { CONFIG_DEFAULTS } from "../config-defaults";
import { familyOf } from "./context-window";
import { type Ranked, untilLabel } from "./usage";

/**
 * Claude account profiles: one Claude Code profile per account, each its own
 * `CLAUDE_CONFIG_DIR` at `<root>/<acct>` (default root `~/.volley/claude`), listed in
 * `<root>/accounts.json`. A profile is signed in only through Claude Code's own flow
 * (signin.ts); volleyd never reads, stores or forwards a credential — the registry holds an id, a
 * label, the machine, a plan label and the login's e-mail and org, nothing else.
 *
 * `primary` is the user's own default profile (`~/.claude`, no `CLAUDE_CONFIG_DIR`): what an agent
 * runs under when nothing selects an account.
 */

export const PRIMARY_ACCOUNT = "primary";
/**
 * `claude.default_account` value that balances, as `null` does (D3): the legacy name for balancing,
 * kept as a synonym (the rule ranks by pace now, not by headroom alone).
 */
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
  /** The login's identity (identity.ts): what Claude Code records for it, never a credential. */
  email?: string;
  org?: string;
  signed_in_at?: string;
  /**
   * A profile on a paired machine: its `CLAUDE_CONFIG_DIR` there (`<home>/.volley/claude/<id>`),
   * recorded by its sign-in. The launch fence admits exactly this dir for that machine.
   */
  dir?: string;
}

export interface ClaudeRegistry {
  version: 1;
  accounts: ClaudeAccount[];
}

/** `$VOLLEY_CLAUDE_DIR`, else `~/.volley/claude` (`$HOME` as `env` has it, else the OS's). */
export function claudeRoot(env: Record<string, string | undefined> = process.env): string {
  const dir = env.VOLLEY_CLAUDE_DIR;
  if (dir !== undefined && dir !== "") return dir;
  return join(
    env.HOME !== undefined && env.HOME !== "" ? env.HOME : homedir(),
    ".volley",
    "claude",
  );
}

export const registryPath = (root: string) => join(root, "accounts.json");

/** The profiles root as one canonical absolute path: normalised, no trailing slash. */
export function canonicalRoot(root: string): string {
  if (!isAbsolute(root)) throw new ClaudeAccountError(`profile root ${root} is not absolute`);
  return normalize(root).replace(/(.)\/+$/, "$1");
}

/**
 * The profile's `CLAUDE_CONFIG_DIR`. Claude Code keys the profile's Keychain item to a hash of
 * this exact string, so it is always one canonical absolute path with no trailing slash. The one
 * definition of a profile dir: the launch fence admits exactly these.
 */
export function profileDir(root: string, id: string): string {
  const r = canonicalRoot(root);
  if (!isValidAccountId(id)) throw new ClaudeAccountError(`invalid Claude account id '${id}'`);
  return join(r, id);
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

/**
 * Create the profile directory (on this machine; a paired machine's is made there by its
 * sign-in) and its registry entry. Sign-in is a separate step.
 */
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
  const machine = input.machine ?? LOCAL_MACHINE;
  if (machine === LOCAL_MACHINE) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const acct: ClaudeAccount = { id, label, machine, created: now };
  writeRegistry(root, { version: 1, accounts: [...reg.accounts, acct] });
  return acct;
}

/**
 * Record a finished sign-in: when, the plan label `claude auth status` reported, and the login's
 * e-mail and org as the profile's `.claude.json` records them.
 */
export function markSignedIn(
  root: string,
  id: string,
  facts: { plan?: string; email?: string; org?: string; dir?: string },
  now: string,
): ClaudeAccount {
  const reg = readRegistry(root);
  const i = reg.accounts.findIndex((a) => a.id === id);
  const prev = reg.accounts[i];
  if (prev === undefined) throw new ClaudeAccountError(`unknown Claude account '${id}'`);
  const next: ClaudeAccount = {
    ...prev,
    ...(facts.plan !== undefined ? { plan: facts.plan } : {}),
    ...(facts.email !== undefined ? { email: facts.email } : {}),
    ...(facts.org !== undefined ? { org: facts.org } : {}),
    ...(facts.dir !== undefined && prev.machine !== LOCAL_MACHINE ? { dir: facts.dir } : {}),
    signed_in_at: now,
  };
  reg.accounts[i] = next;
  writeRegistry(root, reg);
  return next;
}

/** A registry entry by id; throws for the primary (never in the registry) or an unknown id. */
function entryOf(reg: ClaudeRegistry, id: string, verb: string): number {
  if (id === PRIMARY_ACCOUNT || id === MOST_HEADROOM)
    throw new ClaudeAccountError(`'${id}' is not a profile Volley keeps; it cannot be ${verb}`);
  const i = reg.accounts.findIndex((a) => a.id === id);
  if (i === -1) throw new ClaudeAccountError(`unknown Claude account '${id}'`);
  return i;
}

/**
 * Relabel an account: every profile of its login (the same e-mail) on every machine, or the lone
 * profile while it has no e-mail yet. Validated as `addAccount` validates a label (non-empty, not
 * a reserved id); the ids stay. Returns the profiles relabelled.
 */
export function renameAccount(root: string, id: string, label: string): ClaudeAccount[] {
  const next = label.trim();
  if (next === "") throw new ClaudeAccountError("a Claude account's name cannot be empty");
  const asId = accountIdFor(next);
  if (asId === PRIMARY_ACCOUNT || asId === MOST_HEADROOM)
    throw new ClaudeAccountError(`'${asId}' is reserved; pick another name`);
  const reg = readRegistry(root);
  const target = reg.accounts[entryOf(reg, id, "renamed")] as ClaudeAccount;
  const email = target.email?.toLowerCase();
  const same = (a: ClaudeAccount) =>
    a.id === id || (email !== undefined && a.email?.toLowerCase() === email);
  const accounts = reg.accounts.map((a) => (same(a) ? { ...a, label: next } : a));
  writeRegistry(root, { version: 1, accounts });
  return accounts.filter(same);
}

/** Drop one profile's registry entry (its directory is the caller's, on its machine). */
export function removeAccount(root: string, id: string): ClaudeAccount {
  const reg = readRegistry(root);
  const i = entryOf(reg, id, "removed");
  const gone = reg.accounts[i] as ClaudeAccount;
  writeRegistry(root, { version: 1, accounts: reg.accounts.filter((_, j) => j !== i) });
  return gone;
}

/**
 * Where an agent's account came from: its task, its wave, the config default, the balancing rule
 * (`balance`), an account move (`move`), or nothing to choose from (`default`: the primary alone).
 */
export type AccountSource = "task" | "wave" | "config" | "balance" | "move" | "default";

export interface SelectedAccount {
  /** The account as the agent's `claude_account` names it: `primary` or a profile id. */
  id: string;
  /** The profile's `CLAUDE_CONFIG_DIR` (on `machine`); null for the primary (its default profile). */
  dir: string | null;
  source: AccountSource;
  /** Where the agent runs: `local` or a paired machine's name. */
  machine: string;
  /** One line volleyd writes about the pick (`account_chosen.why`); never an e-mail. */
  why: string;
  /** The candidates as ranked, for a balanced pick. */
  candidates?: Ranked[];
}

/** An account's usage record on `machine`: `<id>` here, `<id>@<machine>` on a paired machine. */
export const accountKey = (id: string, machine: string) =>
  machine === LOCAL_MACHINE ? id : `${id}@${machine}`;

/**
 * The accounts an agent on `machine` can start under, as usage-record keys: the primary, then
 * every signed-in profile kept for that machine (on a paired machine only those whose sign-in
 * recorded their dir there).
 */
export function machineCandidates(reg: ClaudeRegistry, machine: string): string[] {
  const local = machine === LOCAL_MACHINE;
  const ready = reg.accounts.filter(
    (a) => a.machine === machine && a.signed_in_at !== undefined && (local || a.dir !== undefined),
  );
  return [PRIMARY_ACCOUNT, ...ready.map((a) => a.id)].map((id) => accountKey(id, machine));
}

const bareId = (key: string) => key.replace(/@.*$/, "");

/**
 * The account an agent runs under: the task's `account:`, else the wave's, else
 * `claude.default_account`; when none names one (or it is `most_headroom`, or `null` — D3), the
 * candidate `rank` (usage metering's `rankAccounts`) puts first among the machine's signed-in
 * accounts, the primary alone being no choice (`default`). Throws for an unknown account, one not
 * signed in yet, or one whose profile lives on another machine. On a paired machine a config
 * default naming a profile kept elsewhere does not apply (it balances there).
 */
export function selectAccount(
  root: string,
  /** The registry, or how to read it: only read when a profile (not the primary) can be picked. */
  registry: ClaudeRegistry | (() => ClaudeRegistry),
  want: {
    task?: string;
    wave?: string;
    configDefault?: string | null;
    machine?: string;
    /** The agent's model: its family's weekly window counts (and is named in `why`). */
    model?: string | null;
    /** `claude.balance.cap_pct`, named in `why` (default: the tunable's default). */
    capPct?: number;
    /** The clock `why` measures resets against (default: now). */
    now?: number;
  },
  /** The candidates ranked (claude/usage.ts rankAccounts); absent: no usage data. */
  rank?: (candidates: readonly string[]) => Ranked[],
): SelectedAccount {
  const machine = want.machine ?? LOCAL_MACHINE;
  const local = machine === LOCAL_MACHINE;
  let reg: ClaudeRegistry | undefined;
  const read = () => {
    reg ??= typeof registry === "function" ? registry() : registry;
    return reg;
  };
  const pinned: [AccountSource, string | null | undefined][] = [
    ["task", want.task],
    ["wave", want.wave],
    ["config", want.configDefault],
  ];
  for (const [source, id] of pinned) {
    if (id === undefined || id === null || id === MOST_HEADROOM) continue;
    const named = source === "config" ? "claude.default_account" : source;
    const why = `${named} names ${id}`;
    if (id === PRIMARY_ACCOUNT) return { id, dir: null, source, machine, why };
    // A config default naming a profile kept on another machine does not apply on a peer.
    if (source === "config" && !local) {
      let elsewhere = true;
      try {
        elsewhere = !read().accounts.some((a) => a.id === id && a.machine === machine);
      } catch {}
      if (elsewhere) continue;
    }
    const acct = read().accounts.find((a) => a.id === id);
    if (acct === undefined) throw new ClaudeAccountError(`unknown Claude account '${id}'`);
    if (acct.machine !== machine)
      throw new ClaudeAccountError(
        local
          ? `Claude account '${id}' lives on machine '${acct.machine}', not this supervisor's`
          : `Claude account '${id}' is a profile on ${acct.machine === LOCAL_MACHINE ? "the supervisor's machine" : `machine '${acct.machine}'`}, not '${machine}'`,
      );
    if (acct.signed_in_at === undefined)
      throw new ClaudeAccountError(
        `Claude account '${id}' is not signed in yet (volley claude add finishes in the browser)`,
      );
    const dir = local ? profileDir(root, id) : acct.dir;
    if (dir === undefined)
      throw new ClaudeAccountError(
        `Claude account '${id}' on '${machine}' has no recorded profile dir yet (sign it in again)`,
      );
    return { id, dir, source, machine, why };
  }
  let cands: string[];
  try {
    cands = machineCandidates(read(), machine);
  } catch {
    cands = [accountKey(PRIMARY_ACCOUNT, machine)];
  }
  if (cands.length === 1)
    return {
      id: PRIMARY_ACCOUNT,
      dir: null,
      source: "default",
      machine,
      why: `${PRIMARY_ACCOUNT}: the only signed-in account on ${machine}`,
    };
  // No usage data at all: signed-in profiles before the primary, as rankAccounts orders them.
  const ranked = rank?.(cands) ?? [...cands.slice(1), cands[0] as string].map(unknownRank);
  const best = ranked[0]?.account ?? (cands[0] as string);
  const id = bareId(best);
  const dir =
    id === PRIMARY_ACCOUNT
      ? null
      : local
        ? profileDir(root, id)
        : (read().accounts.find((a) => a.id === id && a.machine === machine)?.dir ?? null);
  return {
    id,
    dir,
    source: "balance",
    machine,
    why: balanceLine(ranked, machine, familyOf(want.model), {
      cap: want.capPct ?? CONFIG_DEFAULTS.claude.balance.cap_pct,
      // real clock: the default when the caller injects no clock
      now: want.now ?? systemClock.now(),
    }),
    candidates: ranked,
  };
}

const unknownRank = (account: string): Ranked => ({
  account,
  headroom: null,
  five_hour_pct: null,
  weekly_pct: null,
  agents: 0,
  score: null,
  binding: null,
  eligible: true,
  binding_left: null,
  binding_resets_at: null,
  in_flight: 0,
  projected_pct: null,
});

const capitalized = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/**
 * `work: 18% left, resets in 52m (use it or lose it) on peer-a; primary@peer-a 7d 72% left,
 * resets in 2d 4h; spare over the 97% cap (5h 98%)`: the pick's binding window (named unless it
 * is the 5-hour one), then each other candidate's; with agents in flight its projection too
 * (`18% left (8% after 1 in flight)`). Ids and record keys only, never an e-mail.
 */
function balanceLine(
  ranked: readonly Ranked[],
  machine: string,
  family: string | null,
  o: { cap: number; now: number },
): string {
  const [best, ...rest] = ranked;
  if (best === undefined) return `no candidate account on ${machine}`;
  const pct = (n: number) => `${Math.round(n)}%`;
  const label = (kind: Ranked["binding"]) =>
    kind === "weekly"
      ? "7d"
      : kind === "model_weekly" && family !== null
        ? capitalized(family)
        : "5h";
  // `(8% after 1 in flight)`: the binding window's projection, when agents in flight move it
  const projected = (r: Ranked) =>
    r.in_flight > 0 &&
    r.projected_pct !== null &&
    Math.abs(r.projected_pct - (100 - (r.binding_left ?? 0))) > 1e-9
      ? r.projected_pct
      : null;
  const after = (r: Ranked, p: number, used: boolean) =>
    `${pct(used ? p : 100 - p)} after ${r.in_flight} in flight`;
  const left = (r: Ranked) => {
    const p = projected(r);
    return `${r.binding === "five_hour" ? "" : `${label(r.binding)} `}${pct(r.binding_left ?? 0)} left${p !== null ? ` (${after(r, p, false)})` : ""}, resets in ${untilLabel(r.binding_resets_at, o.now)}`;
  };
  // the first window at or over the cap, with its reset when it is the binding one (the only
  // reset a ranked row carries)
  const overWindow = (r: Ranked, withReset: boolean) => {
    const windows: [Ranked["binding"], number | null | undefined][] = [
      ["five_hour", r.five_hour_pct],
      ["weekly", r.weekly_pct],
      ["model_weekly", r.model_weekly_pct],
    ];
    const [kind, p] = windows.find(([, p]) => p != null && p >= o.cap) ?? [r.binding, null];
    // under the cap as sampled, over it with the agents in flight: the binding window's figures
    const proj = projected(r);
    if (p == null && proj !== null && r.binding_left !== null)
      return ` (${label(r.binding)} ${pct(100 - r.binding_left)}, ${after(r, proj, true)}${withReset ? `, resets in ${untilLabel(r.binding_resets_at, o.now)}` : ""})`;
    if (p == null) return "";
    const reset =
      withReset && kind === r.binding
        ? `, resets in ${untilLabel(r.binding_resets_at, o.now)}`
        : "";
    return ` (${label(kind)} ${pct(p)}${reset})`;
  };
  const overCap = (r: Ranked) => `over the ${o.cap}% cap${overWindow(r, false)}`;
  const other = (r: Ranked) =>
    r.binding === null
      ? `${r.account} no usage yet`
      : r.eligible
        ? `${r.account} ${left(r)}`
        : `${r.account} ${overCap(r)}`;
  const id = bareId(best.account);
  const head =
    best.binding === null
      ? `${id}: no usage yet (balanced) on ${machine}`
      : best.eligible
        ? `${id}: ${left(best)} (use it or lose it) on ${machine}`
        : `${id}: over the ${o.cap}% cap, least over on ${machine}${overWindow(best, true)}`;
  return [head, ...rest.map(other)].join("; ");
}
