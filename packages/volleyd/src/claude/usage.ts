import { CONFIG_DEFAULTS } from "../config-defaults";
import { type DecisionInput, ID_RE } from "../decisions";
import type { JournalEvent } from "../types";
import { familyOf } from "./context-window";
import { PRIMARY_ACCOUNT } from "./profiles";

/**
 * Usage metering (SPEC §4.6.12). Each agent's statusLine publisher (volley-hooks) publishes a
 * retained `usage` sample: its context window and its Claude account's 5-hour and weekly windows.
 * The windows belong to the account, not the agent, so the daemon folds every agent's samples
 * into one record per account (the newest sample carrying a window wins) and publishes it
 * retained on `volley/_system/claude-accounts/<acct>`. When an account's 5-hour window reaches
 * `claude.warn_at_pct`, each wave with agents on it gets an `account_limit` decision suggesting
 * the account with the most headroom; only an answer moves the wave (`wave_account_moved`: its
 * new agents start under the other account, running ones finish where they are). Everything here
 * is pure; the daemon subscribes, publishes and journals.
 *
 * A remote host's agent runs under that host's own Claude login, not the supervisor's account of
 * the same name: its samples fold into `<acct>@<host>`, a record of its own that opens no
 * decision (a wave move cannot reach a remote host's agents). The book's account windows are kept
 * on disk (`bookState` / `restoreBook`), so a restart forgets none.
 *
 * Each machine's usage probe (volley-cli's `usage-probe.ts`, run by its doctor) reads every login
 * it holds from the usage endpoint and reports numbers only in its machine record's
 * `claude_logins`. `foldProbe` folds one login into its account: the 5-hour and weekly windows
 * against the statusLine samples (the freshest wins, both ways), the per-model weekly windows
 * (which only the probe knows), and `probe`, the newest attempt.
 */

export interface UsageWindow {
  pct: number;
  resets_at: string | null;
}

/** usage.schema.json payload. */
export interface UsagePayload {
  account: string | null;
  config_dir?: string;
  model: string | null;
  context_window: { used_percentage: number | null; used: number | null; size: number | null };
  rate_limits: { five_hour?: UsageWindow; weekly?: UsageWindow };
  captured_at: string;
}

export const usageAccountTopic = (acct: string) => `volley/_system/claude-accounts/${acct}`;
export const USAGE_FILTER = "volley/+/+/usage";

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const isPct = (v: unknown) => typeof v === "number" && v >= 0 && v <= 100;
const isDate = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const nullOr = (v: unknown, ok: (x: unknown) => boolean) => v === null || ok(v);

function parseWindow(v: unknown): UsageWindow | undefined | null {
  if (v === undefined) return undefined;
  const w = obj(v);
  if (w === null || !isPct(w.pct) || !nullOr(w.resets_at, isDate)) return null;
  return { pct: w.pct as number, resets_at: w.resets_at as string | null };
}

/** A usage payload as published, or null when it does not have the schema's shape. */
export function parseUsage(v: unknown): UsagePayload | null {
  const p = obj(v);
  const cw = obj(p?.context_window);
  const rl = obj(p?.rate_limits);
  if (p === null || cw === null || rl === null || !isDate(p.captured_at)) return null;
  // the account becomes a topic level (`volley/_system/claude-accounts/<acct>`)
  if (!nullOr(p.account, (x) => typeof x === "string" && ID_RE.test(x))) return null;
  if (!nullOr(p.model, (x) => typeof x === "string")) return null;
  const isNum = (x: unknown) => typeof x === "number";
  if (!nullOr(cw.used_percentage, isPct) || !nullOr(cw.used, isNum) || !nullOr(cw.size, isNum))
    return null;
  const fiveHour = parseWindow(rl.five_hour);
  const weekly = parseWindow(rl.weekly);
  if (fiveHour === null || weekly === null) return null;
  return {
    account: p.account as string | null,
    ...(typeof p.config_dir === "string" && p.config_dir !== ""
      ? { config_dir: p.config_dir }
      : {}),
    model: p.model as string | null,
    context_window: {
      used_percentage: cw.used_percentage as number | null,
      used: cw.used as number | null,
      size: cw.size as number | null,
    },
    rate_limits: {
      ...(fiveHour !== undefined ? { five_hour: fiveHour } : {}),
      ...(weekly !== undefined ? { weekly } : {}),
    },
    captured_at: p.captured_at as string,
  };
}

/** One window of an account as last seen, and which sample it came from. */
interface SeenWindow extends UsageWindow {
  at: string;
}

/** The model families a weekly window can be scoped to (context-window.ts's `FAMILY`). */
export const MODEL_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export type ProbeState = "ok" | "expired" | "no_credential" | "rate_limited" | "rejected" | "error";
const PROBE_STATES: readonly string[] = [
  "ok",
  "expired",
  "no_credential",
  "rate_limited",
  "rejected",
  "error",
];

/** One `claude_logins[]` entry of a machine record (machine.schema.json). */
export interface ProbeLogin {
  profile: string;
  state: ProbeState;
  attempted_at: string;
  reading?: {
    read_at: string;
    five_hour?: UsageWindow;
    weekly?: UsageWindow;
    model_weekly?: Partial<Record<ModelFamily, UsageWindow>>;
  };
}

/** An account's newest probe attempt: where, how it went, and when it last read. */
export interface ProbeSeen {
  machine: string;
  state: ProbeState;
  attempted_at: string;
  read_at?: string;
}

/** A rate a window's percentage is learned under: `five_hour`, `weekly`, `model_weekly.<family>`. */
export type RateKind = "five_hour" | "weekly" | `model_weekly.${ModelFamily}`;

/** An account's learned burn in one window kind: percentage points per agent-hour. */
export interface RateSeen {
  pct_per_agent_h: number;
  /** Observations folded in; the rank rule trusts the rate from `RATE_MIN_SAMPLES`. */
  samples: number;
  /** The newest observation's sample time. */
  at: string;
}

/** Observations a learned rate needs before the rank rule uses it over the tunable default. */
export const RATE_MIN_SAMPLES = 2;
/** The shortest interval between two samples that teaches a rate (a shorter one is noise). */
export const RATE_MIN_GAP_MS = 5 * 60_000;
/** The weight of a new observation in the learned rate (an exponential moving average). */
export const RATE_EMA_ALPHA = 0.3;
const RATE_MAX = 100;

/**
 * What the daemon knows: which account and wave each agent's latest sample was on, and each
 * account's windows (kept when its agents are gone: the limits are the account's), and the rate
 * at which its agents spend each window, learned from consecutive samples.
 */
export interface UsageBook {
  /** Each agent's account, wave and the model of its latest sample. */
  agents: Record<string, { account: string; wave: string | null; model?: string | null }>;
  accounts: Record<
    string,
    {
      five_hour: SeenWindow | null;
      weekly: SeenWindow | null;
      /** Per-model weekly windows: only a usage probe reports them. */
      model_weekly?: Partial<Record<ModelFamily, SeenWindow>>;
      probe?: ProbeSeen;
      sampled_at: string;
      /** The agent of the newest statusLine sample; absent while only probes reported. */
      sampled_by?: string;
      /** Each window kind's learned rate (the account's burn: kept across a window's reset). */
      rates?: Partial<Record<RateKind, RateSeen>>;
      /** Each window kind's comparison point: the sample the next observation is measured from. */
      rate_base?: Partial<Record<RateKind, SeenWindow>>;
    }
  >;
}

export const emptyBook = (): UsageBook => ({ agents: {}, accounts: {} });

const newer = (a: string, b: string) => Date.parse(a) > Date.parse(b);

function pickWindow(prev: SeenWindow | null, w: UsageWindow | undefined, at: string) {
  if (w === undefined) return prev;
  return prev !== null && !newer(at, prev.at) ? prev : { ...w, at };
}

type Learned = Pick<UsageBook["accounts"][string], "rates" | "rate_base">;

/**
 * Learn from one newer window of `kind` (SPEC §4.6.12): against the kept comparison point with
 * the same `resets_at`, at least `RATE_MIN_GAP_MS` later and not lower, with `agents` on the
 * account, the observation `Δpct / (Δhours × agents)` (capped) blends into the rate by EMA. A
 * different window, a fall or no agents moves the comparison point without teaching; a short gap
 * keeps it (statusLine samples arrive every message). The rate is never reset: it is the
 * account's burn, not the window's.
 */
export function learnRate(l: Learned, kind: RateKind, next: SeenWindow, agents: number): Learned {
  const base = l.rate_base?.[kind];
  if (base !== undefined && !newer(next.at, base.at)) return l;
  const moved = (rates = l.rates): Learned => ({
    ...(rates !== undefined ? { rates } : {}),
    rate_base: { ...l.rate_base, [kind]: next },
  });
  if (base === undefined || base.resets_at !== next.resets_at || next.pct < base.pct || agents < 1)
    return moved();
  const ms = Date.parse(next.at) - Date.parse(base.at);
  if (ms < RATE_MIN_GAP_MS) return l;
  const obs = Math.min(RATE_MAX, (next.pct - base.pct) / ((ms / 3.6e6) * agents));
  const prev = l.rates?.[kind];
  const rate: RateSeen = {
    pct_per_agent_h:
      prev === undefined ? obs : prev.pct_per_agent_h * (1 - RATE_EMA_ALPHA) + obs * RATE_EMA_ALPHA,
    samples: (prev?.samples ?? 0) + 1,
    at: next.at,
  };
  return moved({ ...l.rates, [kind]: rate });
}

const learnedOf = (a: Learned | undefined): Learned => ({
  ...(a?.rates !== undefined ? { rates: a.rates } : {}),
  ...(a?.rate_base !== undefined ? { rate_base: a.rate_base } : {}),
});

/** `learnRate` over each window a fold took (`[kind, before, after]`): the ones that changed. */
function learnAll(
  l: Learned,
  windows: readonly (readonly [
    RateKind,
    SeenWindow | null | undefined,
    SeenWindow | null | undefined,
  ])[],
  agents: number,
): Learned {
  let out = l;
  for (const [kind, before, after] of windows)
    if (after !== null && after !== undefined && after !== before)
      out = learnRate(out, kind, after, agents);
  return out;
}

/**
 * Fold one sample of `agent` (resolved to `account`, in `wave`) into the book; `agents` is how
 * many agents run on the account now (the rates' denominator; 0 teaches nothing).
 */
export function foldUsage(
  book: UsageBook,
  s: { agent: string; wave: string | null; account: string; payload: UsagePayload },
  agents = 0,
): UsageBook {
  const at = s.payload.captured_at;
  const prev = book.accounts[s.account];
  const latest = prev === undefined || newer(at, prev.sampled_at);
  const five = pickWindow(prev?.five_hour ?? null, s.payload.rate_limits.five_hour, at);
  const weekly = pickWindow(prev?.weekly ?? null, s.payload.rate_limits.weekly, at);
  const learned = learnAll(
    learnedOf(prev),
    [
      ["five_hour", prev?.five_hour, five],
      ["weekly", prev?.weekly, weekly],
    ],
    agents,
  );
  return {
    agents: {
      ...book.agents,
      [s.agent]: { account: s.account, wave: s.wave, model: s.payload.model },
    },
    accounts: {
      ...book.accounts,
      [s.account]: {
        ...prev,
        five_hour: five,
        weekly,
        sampled_at: latest ? at : (prev?.sampled_at ?? at),
        sampled_by: latest ? s.agent : (prev?.sampled_by ?? s.agent),
        ...learned,
      },
    },
  };
}

/**
 * Fold one login of a machine's usage probe into `account`'s record: each window of its reading
 * against what the book has (the freshest wins), and `probe`, the newest attempt (a failed one
 * included). `sampled_at` is the newest of sample and reading (the attempt, while there is
 * neither); `sampled_by` stays a statusLine sample's.
 */
export function foldProbe(
  book: UsageBook,
  p: { account: string; machine: string; login: ProbeLogin },
  agents = 0,
): UsageBook {
  const prev = book.accounts[p.account];
  const r = p.login.reading;
  const at = r?.read_at ?? p.login.attempted_at;
  const families: Partial<Record<ModelFamily, SeenWindow>> = { ...prev?.model_weekly };
  for (const f of MODEL_FAMILIES) {
    const w = pickWindow(families[f] ?? null, r?.model_weekly?.[f], at);
    if (w !== null) families[f] = w;
  }
  const probe: ProbeSeen =
    prev?.probe !== undefined && newer(prev.probe.attempted_at, p.login.attempted_at)
      ? prev.probe
      : {
          machine: p.machine,
          state: p.login.state,
          attempted_at: p.login.attempted_at,
          ...(r !== undefined ? { read_at: r.read_at } : {}),
        };
  const five = pickWindow(prev?.five_hour ?? null, r?.five_hour, at);
  const weekly = pickWindow(prev?.weekly ?? null, r?.weekly, at);
  const learned = learnAll(
    learnedOf(prev),
    [
      ["five_hour", prev?.five_hour, five],
      ["weekly", prev?.weekly, weekly],
      ...MODEL_FAMILIES.map(
        (f) => [`model_weekly.${f}`, prev?.model_weekly?.[f], families[f]] as const,
      ),
    ],
    agents,
  );
  const sampledAt =
    prev === undefined
      ? at
      : r !== undefined && newer(r.read_at, prev.sampled_at)
        ? r.read_at
        : prev.sampled_at;
  return {
    ...book,
    accounts: {
      ...book.accounts,
      [p.account]: {
        five_hour: five,
        weekly,
        ...(Object.keys(families).length > 0 ? { model_weekly: families } : {}),
        probe,
        sampled_at: sampledAt,
        ...(prev?.sampled_by !== undefined ? { sampled_by: prev.sampled_by } : {}),
        ...learned,
      },
    },
  };
}

/** An account record's id: a local account, or `<acct>@<host>` for a remote host's login. */
export const ACCOUNT_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}(@[a-z0-9][a-z0-9_.-]{0,62})?$/;
export const isRemoteAccount = (acct: string) => acct.includes("@");

/**
 * The account record a sample of an agent on `host` folds into. A local agent's is the account
 * it names, else the profile its `config_dir` belongs to (`profileOf`); a remote host's agent's
 * is `<acct>@<host>` (its `config_dir`, a directory on that host, maps to no local profile).
 */
export function sampleAccount(
  p: UsagePayload,
  host: string,
  profileOf: (dir: string) => string | null,
): string | null {
  if (host !== "local") return p.account !== null ? `${p.account}@${host}` : null;
  return p.account ?? (p.config_dir !== undefined ? profileOf(p.config_dir) : null);
}

/** The book's account windows, as kept on disk (agents come back from their retained samples). */
export function bookState(book: UsageBook): string {
  return `${JSON.stringify({ version: 1, accounts: book.accounts })}\n`;
}

function restoreWindow(v: unknown): SeenWindow | null | undefined {
  if (v === null) return null;
  const w = obj(v);
  if (w === null || !isPct(w.pct) || !nullOr(w.resets_at, isDate) || !isDate(w.at)) return;
  return { pct: w.pct as number, resets_at: w.resets_at as string | null, at: w.at as string };
}

function restoreProbe(v: unknown): ProbeSeen | undefined {
  const p = obj(v);
  if (p === null || typeof p.machine !== "string" || !PROBE_STATES.includes(p.state as string))
    return;
  if (!isDate(p.attempted_at) || !(p.read_at === undefined || isDate(p.read_at))) return;
  return {
    machine: p.machine,
    state: p.state as ProbeState,
    attempted_at: p.attempted_at as string,
    ...(p.read_at !== undefined ? { read_at: p.read_at as string } : {}),
  };
}

const RATE_KINDS: readonly RateKind[] = [
  "five_hour",
  "weekly",
  ...MODEL_FAMILIES.map((f) => `model_weekly.${f}` as const),
];

function restoreRate(v: unknown): RateSeen | undefined {
  const r = obj(v);
  if (r === null || typeof r.pct_per_agent_h !== "number" || !isDate(r.at)) return;
  if (!(r.pct_per_agent_h >= 0 && r.pct_per_agent_h <= RATE_MAX)) return;
  if (!Number.isInteger(r.samples) || (r.samples as number) < 1) return;
  return { pct_per_agent_h: r.pct_per_agent_h, samples: r.samples as number, at: r.at as string };
}

/** The readable entries of a kept `rates` / `rate_base` map (absent: none readable). */
function restoreKinds<T>(v: unknown, one: (x: unknown) => T | null | undefined) {
  const out: Partial<Record<RateKind, T>> = {};
  for (const k of RATE_KINDS) {
    const x = one(obj(v)?.[k]);
    if (x !== undefined && x !== null) out[k] = x;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** A book from `bookState` text, no agents; an unreadable file or entry is left out. */
export function restoreBook(text: string): UsageBook {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return emptyBook();
  }
  const accounts: UsageBook["accounts"] = {};
  for (const [id, v] of Object.entries(obj(obj(raw)?.accounts) ?? {})) {
    const a = obj(v);
    if (a === null || !ACCOUNT_KEY_RE.test(id)) continue;
    const five = restoreWindow(a.five_hour);
    const weekly = restoreWindow(a.weekly);
    if (five === undefined || weekly === undefined) continue;
    if (!isDate(a.sampled_at) || !(a.sampled_by === undefined || typeof a.sampled_by === "string"))
      continue;
    const families: Partial<Record<ModelFamily, SeenWindow>> = {};
    for (const f of MODEL_FAMILIES) {
      const w = restoreWindow(obj(a.model_weekly)?.[f]);
      if (w !== undefined && w !== null) families[f] = w;
    }
    const probe = restoreProbe(a.probe);
    const rates = restoreKinds(a.rates, restoreRate);
    const base = restoreKinds(a.rate_base, restoreWindow);
    accounts[id] = {
      five_hour: five,
      weekly,
      ...(Object.keys(families).length > 0 ? { model_weekly: families } : {}),
      ...(probe !== undefined ? { probe } : {}),
      sampled_at: a.sampled_at as string,
      ...(typeof a.sampled_by === "string" ? { sampled_by: a.sampled_by } : {}),
      ...(rates !== undefined ? { rates } : {}),
      ...(base !== undefined ? { rate_base: base } : {}),
    };
  }
  return { agents: {}, accounts };
}

/** Drop an agent (retired, or its usage topic cleared); its account keeps its windows. */
export function forgetAgent(book: UsageBook, agent: string): UsageBook {
  if (book.agents[agent] === undefined) return book;
  const { [agent]: _gone, ...agents } = book.agents;
  return { ...book, agents };
}

/** An account every machine has whatever the registry says: its own login, `primary[@<name>]`. */
export const isMachineLogin = (acct: string) =>
  acct === PRIMARY_ACCOUNT || acct.startsWith(`${PRIMARY_ACCOUNT}@`);

/**
 * The book without the accounts the registry no longer has (`known`: its profiles' record keys,
 * `<id>` and `<id>@<name>`); `primary` and `primary@<name>` always stay, and so do the agents of
 * the accounts that stay. The same book when nothing goes.
 */
export function pruneBook(book: UsageBook, known: ReadonlySet<string>): UsageBook {
  const keep = (acct: string) => isMachineLogin(acct) || known.has(acct);
  const gone = Object.keys(book.accounts).filter((a) => !keep(a));
  const strays = Object.values(book.agents).some((a) => !keep(a.account));
  if (gone.length === 0 && !strays) return book;
  return {
    agents: Object.fromEntries(Object.entries(book.agents).filter(([, a]) => keep(a.account))),
    accounts: Object.fromEntries(Object.entries(book.accounts).filter(([a]) => keep(a))),
  };
}

/** claude-account.schema.json payload, without the registry's label and plan. */
export interface AccountUsage {
  account: string;
  five_hour: UsageWindow | null;
  weekly: UsageWindow | null;
  model_weekly?: Partial<Record<ModelFamily, UsageWindow>>;
  probe?: ProbeSeen;
  agents: string[];
  waves: string[];
  sampled_at: string;
  sampled_by?: string;
  /** The learned rates (internal: `publishedRecord` leaves them off the retained record). */
  rates?: Partial<Record<RateKind, RateSeen>>;
}

/** The retained `claude_account` payload of a record: without the internal `rates`. */
export function publishedRecord(r: AccountUsage): Omit<AccountUsage, "rates"> {
  const { rates: _internal, ...rest } = r;
  return rest;
}

const bare = (w: SeenWindow | null): UsageWindow | null =>
  w === null ? null : { pct: w.pct, resets_at: w.resets_at };

/** One record per account the book has seen, agents and waves sorted. */
export function accountRecords(book: UsageBook): Record<string, AccountUsage> {
  const out: Record<string, AccountUsage> = {};
  for (const [account, a] of Object.entries(book.accounts)) {
    const mine = Object.entries(book.agents).filter(([, x]) => x.account === account);
    const families = Object.entries(a.model_weekly ?? {}).map(([f, w]) => [f, bare(w)] as const);
    out[account] = {
      account,
      five_hour: bare(a.five_hour),
      weekly: bare(a.weekly),
      ...(families.length > 0 ? { model_weekly: Object.fromEntries(families) } : {}),
      ...(a.probe !== undefined ? { probe: a.probe } : {}),
      agents: mine.map(([id]) => id).sort(),
      waves: [...new Set(mine.flatMap(([, x]) => (x.wave !== null ? [x.wave] : [])))].sort(),
      sampled_at: a.sampled_at,
      ...(a.sampled_by !== undefined ? { sampled_by: a.sampled_by } : {}),
      ...(a.rates !== undefined ? { rates: a.rates } : {}),
    };
  }
  return out;
}

/** A window's percentage now: 0 once its reset has passed. */
function livePct(w: UsageWindow | null, now: number): number | null {
  if (w === null) return null;
  return w.resets_at !== null && Date.parse(w.resets_at) <= now ? 0 : w.pct;
}

/** A window kind the rank rule scores (`model_weekly`: the model family's weekly window). */
export type WindowKind = "five_hour" | "weekly" | "model_weekly";

/** Each window kind's length in hours: pace compares windows in units of their own length. */
const WINDOW_HOURS: Record<WindowKind, number> = { five_hour: 5, weekly: 168, model_weekly: 168 };

/** One candidate account as `rankAccounts` sees it (the `claude_balance` op, `account_chosen`). */
export interface Ranked {
  account: string;
  /** The smallest room left in its windows that count; null: it reported none. */
  headroom: number | null;
  five_hour_pct: number | null;
  weekly_pct: number | null;
  /** The model family's weekly window, when the model has a family and the account reported it. */
  model_weekly_pct?: number;
  agents: number;
  /** Its pace: the smallest over its windows (1 is on pace); null: it reported no window. */
  score: number | null;
  /** The window that sets `score`; null with no window. */
  binding: WindowKind | null;
  /** Every window it reported is under `claude.balance.cap_pct`. */
  eligible: boolean;
  /** The binding window's room left (percent) and its reset: what `why` and the CLI print. */
  binding_left: number | null;
  binding_resets_at: string | null;
  /** Agents counted against it: running, or picked earlier in the same spawn pass. */
  in_flight: number;
  /** The binding window's projected usage with `in_flight` reserved; null with no window. */
  projected_pct: number | null;
}

interface LiveWindow {
  kind: WindowKind;
  pct: number;
  resets_at: string | null;
}

/** The windows that count for `family`, each with its live percentage; unreported ones left out. */
function liveWindows(
  a: AccountUsage | undefined,
  family: ModelFamily | null,
  now: number,
): LiveWindow[] {
  const fw = family !== null ? (a?.model_weekly?.[family] ?? null) : null;
  const all: [WindowKind, UsageWindow | null][] = [
    ["five_hour", a?.five_hour ?? null],
    ["weekly", a?.weekly ?? null],
    ["model_weekly", fw],
  ];
  return all.flatMap(([kind, w]) => {
    const pct = livePct(w, now);
    return w === null || pct === null ? [] : [{ kind, pct, resets_at: w.resets_at }];
  });
}

/**
 * Hours until a window of `lengthHours` resets, floored at one minute. Unknown (`null`) or passed
 * (the window restarted and its next reset is not known yet): a full window away.
 */
export function hoursUntil(resetsAt: string | null, now: number, lengthHours: number): number {
  const at = resetsAt === null ? Number.NaN : Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return lengthHours;
  return Math.max((at - now) / 3.6e6, 1 / 60);
}

/**
 * A window's pace: its room left against the time to its reset, in units of the window's own
 * length. 1 is on pace to use the window exactly as it resets; above 1 its room expires unused
 * (spend it); below 1 it is on course to hit the limit first (spare it).
 */
export function paceOf(
  pct: number,
  resetsAt: string | null,
  now: number,
  kind: WindowKind,
): number {
  const length = WINDOW_HOURS[kind];
  return ((100 - pct) * length) / (100 * hoursUntil(resetsAt, now, length));
}

/** `52m`, `4h 10m`, `4h`, `2d 4h`, `3d`; `now` once it has passed; `unknown` for no reset time. */
export function untilLabel(resetsAt: string | null, now: number): string {
  if (resetsAt === null) return "unknown";
  const ms = Date.parse(resetsAt) - now;
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 0) return "now";
  const m = Math.ceil(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const two = (a: string, b: number, unit: string) => (b > 0 ? `${a} ${b}${unit}` : a);
  if (d > 0) return two(`${d}d`, h, "h");
  return h > 0 ? two(`${h}h`, m % 60, "m") : `${m % 60}m`;
}

/**
 * The balancing rule (SPEC §4.6.12): spend the room that expires first, without hitting a limit.
 * Each window that counts (the 5-hour, the 7-day and, when the model's family has one on the
 * record, `model_weekly[family]`) gets a pace, `(left / 100) / (hours to reset / window length)`;
 * the account's `score` is the smallest, and the window attaining it is `binding` (the tightest
 * window decides). A window whose reset passed counts as empty and a full window away from its
 * next reset, as does one whose `resets_at` is null; one not reported is left out. Each window
 * is scored on its projection (`projectedPct`): the live percentage plus each of the account's
 * `in_flight` agents' rate (learned, else the tunable default) over the look-ahead, so a pass's
 * picks see each other before a sample lands; with nothing in flight it is the live percentage.
 * An account is `eligible` while every window it reported projects under `cap_pct`. Eligible accounts come first,
 * then the rest (the cap orders, it never refuses); each group by score, highest first (so an
 * over-cap account goes by pace too, not by how far over it is), an account with no usage data
 * counting as on pace (1). Scores within `tie_band_pct` percent of a band's leader form a band,
 * ordered by fewer agents (sampled or in flight, the more), then signed-in profiles before the primary (interactive sessions use
 * the owner's own login without reporting usage, so its silence says least), then candidate
 * order. Every candidate is returned.
 */
/**
 * `claude.balance` (CONFIG_DEFAULTS when absent): the rank rule's cap and tie band, the look-ahead
 * each agent in flight reserves, and the default per-agent cost of the 5-hour and weekly windows.
 */
export interface RankBalance {
  cap_pct?: number;
  tie_band_pct?: number;
  reserve_h?: number;
  agent_cost_pct_h?: number;
  agent_cost_weekly_pct_h?: number;
  /** Agents in flight on an account (running and reserved); default: its sampled agents. */
  in_flight?: (account: string) => number;
}

/**
 * A window's projected usage with `n` agents in flight: its live percentage plus each agent's
 * rate over the look-ahead, capped by the time to reset (a passed or unknown reset: a full
 * window), at most 100.
 */
export function projectedPct(
  w: { pct: number; resets_at: string | null; kind: WindowKind },
  n: number,
  rate: number,
  o: { now: number; reserve_h: number },
): number {
  const horizon = Math.min(o.reserve_h, hoursUntil(w.resets_at, o.now, WINDOW_HOURS[w.kind]));
  return Math.min(100, w.pct + n * rate * horizon);
}

/** The per-agent rate a window reserves: the account's learned one once trusted, else `fallback`. */
function rateFor(a: AccountUsage | undefined, kind: RateKind, fallback: number): number {
  const r = a?.rates?.[kind];
  return r !== undefined && r.samples >= RATE_MIN_SAMPLES ? r.pct_per_agent_h : fallback;
}

export function rankAccounts(
  accounts: Record<string, AccountUsage>,
  candidates: readonly string[],
  o: RankBalance & { model?: string | null; now: number },
): Ranked[] {
  const family = familyOf(o.model);
  const d = CONFIG_DEFAULTS.claude.balance;
  const cap = o.cap_pct ?? d.cap_pct;
  const band = o.tie_band_pct ?? d.tie_band_pct;
  const reserve = { now: o.now, reserve_h: o.reserve_h ?? d.reserve_h };
  const cost: Record<WindowKind, number> = {
    five_hour: o.agent_cost_pct_h ?? d.agent_cost_pct_h,
    weekly: o.agent_cost_weekly_pct_h ?? d.agent_cost_weekly_pct_h,
    model_weekly: o.agent_cost_weekly_pct_h ?? d.agent_cost_weekly_pct_h,
  };
  const rows = candidates.map((account, i) => {
    const a = accounts[account];
    const n = o.in_flight?.(account) ?? a?.agents.length ?? 0;
    const kindOf = (k: WindowKind): RateKind =>
      k === "model_weekly" ? `model_weekly.${family as ModelFamily}` : k;
    const ws = liveWindows(a, family, o.now).map((w) => ({
      ...w,
      projected: projectedPct(w, n, rateFor(a, kindOf(w.kind), cost[w.kind]), reserve),
    }));
    const pctOf = (k: WindowKind) => ws.find((w) => w.kind === k)?.pct ?? null;
    let bind: ((typeof ws)[number] & { score: number }) | null = null;
    for (const w of ws) {
      const score = paceOf(w.projected, w.resets_at, o.now, w.kind);
      if (bind === null || score < bind.score) bind = { ...w, score };
    }
    const model = pctOf("model_weekly");
    const r: Ranked = {
      account,
      headroom: ws.length > 0 ? 100 - Math.max(...ws.map((w) => w.pct)) : null,
      five_hour_pct: pctOf("five_hour"),
      weekly_pct: pctOf("weekly"),
      ...(model !== null ? { model_weekly_pct: model } : {}),
      agents: a?.agents.length ?? 0,
      score: bind?.score ?? null,
      binding: bind?.kind ?? null,
      eligible: ws.every((w) => w.projected < cap),
      binding_left: bind !== null ? 100 - bind.pct : null,
      binding_resets_at: bind?.resets_at ?? null,
      in_flight: n,
      projected_pct: bind?.projected ?? null,
    };
    // `primary@<name>` is a paired machine's own login: last there too
    const primaryLast = account.split("@")[0] === PRIMARY_ACCOUNT ? 1 : 0;
    // fewer agents: its sampled ones, or its agents in flight when more (a same-pass pick)
    return { r, i, primaryLast, s: r.score ?? 1, load: Math.max(r.agents, n) };
  });
  type Row = (typeof rows)[number];
  const ordered = (group: Row[]): Row[] => {
    group.sort((x, y) => y.s - x.s || x.i - y.i);
    const out: Row[] = [];
    for (let at = 0; at < group.length; ) {
      const leader = (group[at] as Row).s;
      let end = at + 1;
      while (end < group.length && leader - (group[end] as Row).s <= (leader * band) / 100) end++;
      const members = group.slice(at, end);
      members.sort((x, y) => x.load - y.load || x.primaryLast - y.primaryLast || x.i - y.i);
      out.push(...members);
      at = end;
    }
    return out;
  };
  return [
    ...ordered(rows.filter((x) => x.r.eligible)),
    ...ordered(rows.filter((x) => !x.r.eligible)),
  ].map((x) => x.r);
}

/**
 * The account `rankAccounts` puts first, or null for no candidates. The name is historical: the
 * rule ranks by pace, not by headroom alone.
 */
export function mostHeadroom(
  accounts: Record<string, AccountUsage>,
  candidates: readonly string[],
  now: number,
): string | null {
  return rankAccounts(accounts, candidates, { now })[0]?.account ?? null;
}

const round = (n: number) => Math.round(n);

/** `5h 12%, 7d 40%` (and the family's `Fable 30%`); `no usage yet` for an account with none. */
export function usageLabel(r: Ranked, family: ModelFamily | null = null): string {
  const bits = [
    ...(r.five_hour_pct !== null ? [`5h ${round(r.five_hour_pct)}%`] : []),
    ...(r.weekly_pct !== null ? [`7d ${round(r.weekly_pct)}%`] : []),
    ...(r.model_weekly_pct !== undefined && family !== null
      ? [`${familyLabel(family)} ${round(r.model_weekly_pct)}%`]
      : []),
  ];
  return bits.length > 0 ? bits.join(", ") : "no usage yet";
}

const familyLabel = (f: ModelFamily) => `${f.charAt(0).toUpperCase()}${f.slice(1)}`;

/** An `account_limit` decision a wave already has (open, or answered). */
export interface LimitSeen {
  wave: string;
  acct: string;
  resets_at: string | null;
  open: boolean;
}

export interface LimitDecision {
  wave: string;
  input: DecisionInput;
  /** Facts kept on the decision (decision.schema.json `acct`, `pct`, `resets_at`, `suggested`). */
  extra: { acct: string; pct: number; resets_at: string | null; suggested: string | null };
}

const NOT_NOW = "not now";
export const moveAnswer = (wave: string, to: string) => `move wave ${wave} to ${to}`;

/** `move wave <w> to <acct>` → the move; anything else (`not now`, free text) is no move. */
export function parseMoveAnswer(answer: string): { wave: string; to: string } | null {
  const m = /^move wave (\S+) to (\S+)$/i.exec(answer.trim());
  return m?.[1] !== undefined && m[2] !== undefined ? { wave: m[1], to: m[2] } : null;
}

/**
 * The `account_limit` decisions to open: for each account whose 5-hour window is at or over
 * `warnAtPct` (and has not reset), each wave with agents on it, unless that wave has one open
 * for the account or already answered one for this window (same `resets_at`). The suggestion is
 * the candidate `rankAccounts` puts first among those with room in both windows (one with no
 * usage yet ranks as on pace among them, a profile before `primary`), labelled so. Never a move.
 *
 * A balanced wave (`balanced`: its spawns pick per machine, D3) gets no `move wave` decision:
 * its new agents already avoid a hot account, and its running ones get their own
 * `agent_account_limit`. Only when every candidate of a machine it uses (`candidates` here,
 * `peers[<name>]` on a paired machine) is at or over the level in its 5-hour window does it get
 * one, with no suggestion: new agents take the one the balance puts first until the window
 * resets. `balance` is the supervisor's `claude.balance` (the spawns' own rank options).
 */
export function limitDecisions(o: {
  accounts: Record<string, AccountUsage>;
  warnAtPct: number;
  candidates: readonly string[];
  existing: readonly LimitSeen[];
  now: number;
  balanced?: (wave: string) => boolean;
  /** Each paired machine's candidates (`<acct>@<name>`), for the balanced all-hot rule. */
  peers?: Record<string, readonly string[]>;
  balance?: RankBalance;
}): LimitDecision[] {
  const out: LimitDecision[] = [];
  const balanced = o.balanced ?? (() => false);
  for (const a of Object.values(o.accounts)) {
    // a remote host's login: no wave move reaches its agents (the record is informational)
    if (isRemoteAccount(a.account)) continue;
    const w = a.five_hour;
    const pct = livePct(w, o.now);
    if (w === null || pct === null || pct < o.warnAtPct) continue;
    // only an account with room in both windows is worth moving to
    const roomy = o.candidates.filter((c) => {
      const r = o.accounts[c];
      return (
        c !== a.account &&
        (livePct(r?.five_hour ?? null, o.now) ?? 0) < o.warnAtPct &&
        (livePct(r?.weekly ?? null, o.now) ?? 0) < o.warnAtPct
      );
    });
    // The rank rule's first; an account with no usage yet ranks as on pace (offered, never taken).
    const suggested =
      rankAccounts(o.accounts, roomy, { ...o.balance, now: o.now })[0]?.account ?? null;
    const target = suggested === null ? undefined : o.accounts[suggested];
    const used = livePct(target?.five_hour ?? null, o.now);
    // "no usage yet" only for an account that reported none; a weekly-only sample is usage
    const label =
      used !== null
        ? `${Math.round(used)}%`
        : (target?.weekly ?? null) !== null
          ? "no 5-hour usage yet"
          : "no usage yet";
    for (const wave of a.waves) {
      if (balanced(wave)) continue;
      const seen = o.existing.filter((e) => e.wave === wave && e.acct === a.account);
      if (seen.some((e) => e.open || e.resets_at === w.resets_at)) continue;
      const resets = w.resets_at !== null ? ` (resets ${w.resets_at})` : "";
      const ask =
        suggested !== null
          ? ` Move wave ${wave} to ${suggested} (${label})? New agents would start there; running agents finish where they are.`
          : " No other signed-in account has room to suggest; nothing moves unless you move the wave.";
      out.push({
        wave,
        input: {
          kind: "account_limit",
          task: null,
          question: `Needs you: Claude account ${a.account} is at ${Math.round(pct)}% of its 5-hour window${resets}.${ask}`,
          options: suggested !== null ? [moveAnswer(wave, suggested), NOT_NOW] : [NOT_NOW],
        },
        extra: { acct: a.account, pct: w.pct, resets_at: w.resets_at, suggested },
      });
    }
  }
  const machines: [string, readonly string[]][] = [
    ["local", o.candidates],
    ...Object.entries(o.peers ?? {}),
  ];
  for (const [machine, cands] of machines) out.push(...allHot(o, machine, cands, balanced));
  return out;
}

/** The balanced all-hot rule of `limitDecisions` for one machine's candidates. */
function allHot(
  o: Parameters<typeof limitDecisions>[0],
  machine: string,
  cands: readonly string[],
  balanced: (wave: string) => boolean,
): LimitDecision[] {
  const hot = (c: string) => {
    const p = livePct(o.accounts[c]?.five_hour ?? null, o.now);
    return p !== null && p >= o.warnAtPct;
  };
  if (cands.length === 0 || !cands.every(hot)) return [];
  const best = rankAccounts(o.accounts, cands, { ...o.balance, now: o.now })[0];
  const w = best !== undefined ? o.accounts[best.account]?.five_hour : undefined;
  if (best === undefined || w === undefined || w === null) return [];
  const waves = [...new Set(cands.flatMap((c) => o.accounts[c]?.waves ?? []))].sort();
  const out: LimitDecision[] = [];
  for (const wave of waves) {
    if (!balanced(wave)) continue;
    const seen = o.existing.filter((e) => e.wave === wave && cands.includes(e.acct));
    if (seen.some((e) => e.open || (e.acct === best.account && e.resets_at === w.resets_at)))
      continue;
    const resets =
      w.resets_at !== null ? ` the window resets at ${w.resets_at}` : " the window resets";
    out.push({
      wave,
      input: {
        kind: "account_limit",
        task: null,
        question: `Needs you: every signed-in account on ${machine} is at or over ${o.warnAtPct}% of its 5-hour window; new agents start on the one the balance puts first (${best.account}, ${Math.round(best.five_hour_pct ?? w.pct)}%) and${resets}.`,
        options: [NOT_NOW],
      },
      extra: { acct: best.account, pct: w.pct, resets_at: w.resets_at, suggested: null },
    });
  }
  return out;
}

/** The window of an account that triggers an agent move: `five_hour`, `weekly`, `model_weekly:<f>`. */
export type LimitWindow = "five_hour" | "weekly" | `model_weekly:${ModelFamily}`;

/** One supervised agent as `agentLimitDecisions` sees it. */
export interface AgentOnAccount {
  agent_id: string;
  wave: string;
  task: string;
  role: string;
  /** Its account record (`<acct>` here, `<acct>@<name>` on a paired machine). */
  acct: string;
  /** Its model: the latest usage sample's, else its spawn's. */
  model: string | null;
  /** `local` or a paired machine's name. */
  machine: string;
  /** Its task or wave names an account: it gets no agent-level decision. */
  pinned: boolean;
  /** An `agent_move_account` is moving it now. */
  moving: boolean;
}

/** An `agent_account_limit` decision a wave already has (open or answered). */
export interface AgentLimitSeen {
  wave: string;
  task: string;
  role: string;
  acct: string;
  window: string;
  resets_at: string | null;
}

export interface AgentLimitDecision {
  wave: string;
  input: DecisionInput;
  /** decision.schema.json `agent_account_limit` extras. */
  extra: {
    agent_id: string;
    role: string;
    acct: string;
    window: LimitWindow;
    pct: number;
    resets_at: string | null;
    suggested: string | null;
  };
}

export const agentMoveAnswer = (agent: string, to: string) => `move ${agent} to ${to}`;

/** `move <agent> to <acct>` → the move; anything else (`not now`, free text) is no move. */
export function parseAgentMoveAnswer(answer: string): { agent: string; to: string } | null {
  const m = /^move (\S+) to (\S+)$/i.exec(answer.trim());
  if (m?.[1] === undefined || m[2] === undefined || m[1].toLowerCase() === "wave") return null;
  return { agent: m[1], to: m[2] };
}

const WINDOW_NAME: Record<string, string> = {
  five_hour: "5-hour window",
  weekly: "7-day window",
};
const windowName = (w: LimitWindow) =>
  WINDOW_NAME[w] ?? `${familyLabel(w.slice("model_weekly:".length) as ModelFamily)} weekly window`;

/**
 * The windows of `a` that count for an agent of `family`, in order: 5-hour, 7-day, the family's
 * weekly window (each live: a passed reset is empty; an unreported one is absent).
 */
function agentWindows(
  a: AccountUsage | undefined,
  family: ModelFamily | null,
  now: number,
): { window: LimitWindow; pct: number; resets_at: string | null }[] {
  const out: { window: LimitWindow; pct: number; resets_at: string | null }[] = [];
  const add = (window: LimitWindow, w: UsageWindow | null | undefined) => {
    const p = livePct(w ?? null, now);
    if (w !== null && w !== undefined && p !== null)
      out.push({ window, pct: p, resets_at: w.resets_at });
  };
  add("five_hour", a?.five_hour);
  add("weekly", a?.weekly);
  if (family !== null) add(`model_weekly:${family}`, a?.model_weekly?.[family]);
  return out;
}

/**
 * Where an agent on `acct` would move: `rankAccounts`' first pick among the machine's other
 * `candidates` under `warnAtPct` in every window that counts for `model` (an unreported one counts
 * as room), else undefined. No ranking of its own.
 */
export function suggestedMove(o: {
  accounts: Record<string, AccountUsage>;
  acct: string;
  candidates: readonly string[];
  model: string | null;
  warnAtPct: number;
  now: number;
  balance?: RankBalance;
}): Ranked | undefined {
  const family = familyOf(o.model);
  const roomy = o.candidates.filter(
    (c) =>
      c !== o.acct && agentWindows(o.accounts[c], family, o.now).every((w) => w.pct < o.warnAtPct),
  );
  return rankAccounts(o.accounts, roomy, { ...o.balance, model: o.model, now: o.now })[0];
}

/** `alarm_raised.alarm` journaled when an agent hits its account's usage limit. */
export const LIMIT_HIT_ALARM = "account_limit_hit";

const FIVE_HOURS_MS = 5 * 3_600_000;

/**
 * The reset of `account`'s 5-hour window when an agent hits its limit at `at`: the book's, if
 * still ahead, else 5 hours on.
 */
export function limitHitResetsAt(book: UsageBook, o: { account: string; at: string }): string {
  const known = book.accounts[o.account]?.five_hour?.resets_at ?? null;
  return known !== null && Date.parse(known) > Date.parse(o.at)
    ? known
    : new Date(Date.parse(o.at) + FIVE_HOURS_MS).toISOString();
}

/**
 * An agent hit `account`'s usage limit at `at`: its 5-hour window reads 100% until
 * `limitHitResetsAt`. Always applied: stamped no older than the window it replaces (a sample from a
 * machine whose clock runs ahead of ours can carry a later `at`), so only a later sample or probe
 * reading replaces it; `bookState` keeps it.
 */
export function markLimitHit(book: UsageBook, o: { account: string; at: string }): UsageBook {
  const prev = book.accounts[o.account];
  const seen = prev?.five_hour?.at;
  const at = seen !== undefined && newer(seen, o.at) ? seen : o.at;
  return {
    ...book,
    accounts: {
      ...book.accounts,
      [o.account]: {
        ...prev,
        five_hour: { pct: 100, resets_at: limitHitResetsAt(book, o), at },
        weekly: prev?.weekly ?? null,
        sampled_at: prev?.sampled_at ?? o.at,
      },
    },
  };
}

/** The question's pin note for a pinned agent moved off an account at its limit. */
export const pinNote = (acct: string) => `pinned to ${acct}, which is at its limit`;

/**
 * The `agent_account_limit` decision (`class: credit_exhausted`) for an agent that hit its
 * account's usage limit: move it to `suggestedMove`'s pick, or `not now` (Claude Code resumes it
 * by itself at the reset). A pinned agent gets it too: the pin cannot be honoured. Null when no
 * other account on its machine has room (the caller opens `model_switch`). Never parks.
 */
export function limitHitDecision(o: {
  accounts: Record<string, AccountUsage>;
  agent: AgentOnAccount;
  candidates: readonly string[];
  warnAtPct: number;
  resets_at: string;
  source: "hook" | "screen";
  text: string | null;
  screen?: string;
  now: number;
  balance?: RankBalance;
}): { input: DecisionInput; extra: LimitHitExtra } | null {
  const ag = o.agent;
  const best = suggestedMove({
    accounts: o.accounts,
    acct: ag.acct,
    candidates: o.candidates,
    model: ag.model,
    warnAtPct: o.warnAtPct,
    now: o.now,
    ...(o.balance !== undefined ? { balance: o.balance } : {}),
  });
  if (best === undefined) return null;
  const how =
    o.source === "hook"
      ? "the hooks reported a usage-limit prompt"
      : "a usage-limit prompt is on its screen";
  const pin = ag.pinned ? ` Its task is ${pinNote(ag.acct)}: the pin cannot be honoured.` : "";
  return {
    input: {
      kind: "agent_account_limit",
      task: ag.task,
      question: `Needs you: ${ag.agent_id} (${ag.task}/${ag.role}) hit the usage limit of Claude account ${ag.acct} (${how}). Move it to ${best.account} (${usageLabel(best, familyOf(ag.model))})? The session restarts with a resume note. not now: it waits at the prompt and resumes by itself when the window resets at ${o.resets_at}.${pin}`,
      options: [agentMoveAnswer(ag.agent_id, best.account), NOT_NOW],
      park: false,
      pointers: o.screen !== undefined ? { screen: o.screen } : {},
    },
    extra: {
      agent_id: ag.agent_id,
      role: ag.role,
      acct: ag.acct,
      window: "five_hour",
      pct: 100,
      resets_at: o.resets_at,
      suggested: best.account,
      class: LIMIT_HIT_CLASS,
      source: o.source,
      ...(o.text !== null ? { text: o.text } : {}),
    },
  };
}

/** `class` of the limit-hit `agent_account_limit` (recovery.ts CREDIT_CLASS: the same signal). */
export const LIMIT_HIT_CLASS = "credit_exhausted";

export type LimitHitExtra = AgentLimitDecision["extra"] & {
  class: typeof LIMIT_HIT_CLASS;
  source: "hook" | "screen";
  text?: string;
};

/**
 * The `agent_account_limit` decisions to open (D2): for each supervised agent whose account's
 * live 5-hour, 7-day or model-family weekly window is at or over its wave's `warnAtPct`, unless
 * its task or wave pins an account, it is already moving, or a decision for the same task, role,
 * account, window and `resets_at` exists (open or answered: a `not now` waits for the reset). The
 * suggestion is `rankAccounts` over the machine's other candidates under the level in every
 * window that counts for the agent (an unreported one counts as room), else none. Never parks.
 */
export function agentLimitDecisions(o: {
  accounts: Record<string, AccountUsage>;
  agents: readonly AgentOnAccount[];
  candidates: (machine: string) => readonly string[];
  warnAtPct: (wave: string) => number;
  existing: readonly AgentLimitSeen[];
  now: number;
  balance?: RankBalance;
}): AgentLimitDecision[] {
  const out: AgentLimitDecision[] = [];
  for (const ag of o.agents) {
    if (ag.pinned || ag.moving) continue;
    const warn = o.warnAtPct(ag.wave);
    const family = familyOf(ag.model);
    const hit = agentWindows(o.accounts[ag.acct], family, o.now).find((w) => w.pct >= warn);
    if (hit === undefined) continue;
    const seen = o.existing.some(
      (e) =>
        e.wave === ag.wave &&
        e.task === ag.task &&
        e.role === ag.role &&
        e.acct === ag.acct &&
        e.window === hit.window &&
        e.resets_at === hit.resets_at,
    );
    if (seen) continue;
    const best = suggestedMove({
      accounts: o.accounts,
      acct: ag.acct,
      candidates: o.candidates(ag.machine),
      model: ag.model,
      warnAtPct: warn,
      now: o.now,
      ...(o.balance !== undefined ? { balance: o.balance } : {}),
    });
    const suggested = best?.account ?? null;
    const resets = hit.resets_at !== null ? ` (resets ${hit.resets_at})` : "";
    const at = hit.resets_at !== null ? ` at ${hit.resets_at}` : "";
    const head = `Needs you: ${ag.agent_id} (${ag.task}/${ag.role}) runs on Claude account ${ag.acct}, at ${Math.round(hit.pct)}% of its ${windowName(hit.window)}${resets}.`;
    const ask =
      best !== undefined
        ? ` Move it to ${best.account} (${usageLabel(best, family)})? The session restarts with a resume note; the account's window resets${at}.`
        : ` No other signed-in account on ${ag.machine} has room; it finishes where it is and the window resets${at}.`;
    out.push({
      wave: ag.wave,
      input: {
        kind: "agent_account_limit",
        task: ag.task,
        question: head + ask,
        options:
          suggested !== null ? [agentMoveAnswer(ag.agent_id, suggested), NOT_NOW] : [NOT_NOW],
        park: false,
      },
      extra: {
        agent_id: ag.agent_id,
        role: ag.role,
        acct: ag.acct,
        window: hit.window,
        pct: hit.pct,
        resets_at: hit.resets_at,
        suggested,
      },
    });
  }
  return out;
}

/** A wave's account_limit answers (`wave_account_moved` with a `decision_id`), in journal order. */
export function waveAccountMoves(events: readonly JournalEvent[]): { from: string; to: string }[] {
  return events.flatMap((e) => {
    if (e.type !== "wave_account_moved") return [];
    const { from, to, decision_id } = e.data as {
      from?: unknown;
      to?: unknown;
      decision_id?: unknown;
    };
    // Only an account_limit answer moves a task naming `from`; a `wave_account_set` leaves it.
    if (typeof decision_id !== "string") return [];
    return typeof from === "string" && typeof to === "string" ? [{ from, to }] : [];
  });
}

/** The account a new agent of the wave starts under, given the account it would have used. */
export function waveAccount(acct: string, moves: readonly { from: string; to: string }[]): string {
  let out = acct;
  for (const m of moves) if (m.from === out) out = m.to;
  return out;
}
