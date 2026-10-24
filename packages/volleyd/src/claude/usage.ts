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

/**
 * What the daemon knows: which account and wave each agent's latest sample was on, and each
 * account's windows (kept when its agents are gone: the limits are the account's).
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
    }
  >;
}

export const emptyBook = (): UsageBook => ({ agents: {}, accounts: {} });

const newer = (a: string, b: string) => Date.parse(a) > Date.parse(b);

function pickWindow(prev: SeenWindow | null, w: UsageWindow | undefined, at: string) {
  if (w === undefined) return prev;
  return prev !== null && !newer(at, prev.at) ? prev : { ...w, at };
}

/** Fold one sample of `agent` (resolved to `account`, in `wave`) into the book. */
export function foldUsage(
  book: UsageBook,
  s: { agent: string; wave: string | null; account: string; payload: UsagePayload },
): UsageBook {
  const at = s.payload.captured_at;
  const prev = book.accounts[s.account];
  const latest = prev === undefined || newer(at, prev.sampled_at);
  return {
    agents: {
      ...book.agents,
      [s.agent]: { account: s.account, wave: s.wave, model: s.payload.model },
    },
    accounts: {
      ...book.accounts,
      [s.account]: {
        ...prev,
        five_hour: pickWindow(prev?.five_hour ?? null, s.payload.rate_limits.five_hour, at),
        weekly: pickWindow(prev?.weekly ?? null, s.payload.rate_limits.weekly, at),
        sampled_at: latest ? at : (prev?.sampled_at ?? at),
        sampled_by: latest ? s.agent : (prev?.sampled_by ?? s.agent),
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
        five_hour: pickWindow(prev?.five_hour ?? null, r?.five_hour, at),
        weekly: pickWindow(prev?.weekly ?? null, r?.weekly, at),
        ...(Object.keys(families).length > 0 ? { model_weekly: families } : {}),
        probe,
        sampled_at: sampledAt,
        ...(prev?.sampled_by !== undefined ? { sampled_by: prev.sampled_by } : {}),
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
    accounts[id] = {
      five_hour: five,
      weekly,
      ...(Object.keys(families).length > 0 ? { model_weekly: families } : {}),
      ...(probe !== undefined ? { probe } : {}),
      sampled_at: a.sampled_at as string,
      ...(typeof a.sampled_by === "string" ? { sampled_by: a.sampled_by } : {}),
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
    };
  }
  return out;
}

/** A window's percentage now: 0 once its reset has passed. */
function livePct(w: UsageWindow | null, now: number): number | null {
  if (w === null) return null;
  return w.resets_at !== null && Date.parse(w.resets_at) <= now ? 0 : w.pct;
}

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
}

/** A window's live percentage per window that counts for `family`; unreported ones left out. */
function liveWindows(a: AccountUsage | undefined, family: ModelFamily | null, now: number) {
  const five = livePct(a?.five_hour ?? null, now);
  const weekly = livePct(a?.weekly ?? null, now);
  const fw = family !== null ? (a?.model_weekly?.[family] ?? null) : null;
  const model = livePct(fw, now);
  return { five, weekly, model };
}

/**
 * The balancing rule (SPEC §4.6.12): `candidates` ranked by headroom, the smallest of
 * `100 − five_hour`, `100 − weekly` and, when the model's family has a window on the record,
 * `100 − model_weekly[family]`. A window whose reset passed counts as empty; one not reported is
 * left out (a stale probe reading counts until its `resets_at` passes). An account with no usage
 * at all ranks after every known one, signed-in profiles before the primary (interactive
 * sessions use the owner's own login without reporting usage, so its lack of a sample says least
 * about its headroom). Ties go to fewer agents, then candidate order.
 */
export function rankAccounts(
  accounts: Record<string, AccountUsage>,
  candidates: readonly string[],
  o: { model?: string | null; now: number },
): Ranked[] {
  const family = familyOf(o.model);
  const rows = candidates.map((account, i) => {
    const a = accounts[account];
    const w = liveWindows(a, family, o.now);
    const known = [w.five, w.weekly, w.model].filter((x): x is number => x !== null);
    const r: Ranked = {
      account,
      headroom: known.length > 0 ? 100 - Math.max(...known) : null,
      five_hour_pct: w.five,
      weekly_pct: w.weekly,
      ...(w.model !== null ? { model_weekly_pct: w.model } : {}),
      agents: a?.agents.length ?? 0,
    };
    // `primary@<name>` is a paired machine's own login: last there too
    const primaryLast = account.split("@")[0] === PRIMARY_ACCOUNT ? 1 : 0;
    return { r, i, primaryLast };
  });
  rows.sort((x, y) => {
    const hx = x.r.headroom;
    const hy = y.r.headroom;
    if (hx === null || hy === null) {
      if (hx !== hy) return hx === null ? 1 : -1;
      if (x.primaryLast !== y.primaryLast) return x.primaryLast - y.primaryLast;
    } else if (hx !== hy) return hy - hx;
    return x.r.agents - y.r.agents || x.i - y.i;
  });
  return rows.map((x) => x.r);
}

/** The account `rankAccounts` puts first, or null for no candidates. */
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
 * the candidate `rankAccounts` puts first among those with room in both windows (a newly
 * signed-in profile with no usage yet is offered, before `primary`), labelled so. Never a move.
 *
 * A balanced wave (`balanced`: its spawns pick per machine, D3) gets no `move wave` decision:
 * its new agents already avoid a hot account, and its running ones get their own
 * `agent_account_limit`. Only when every candidate of a machine it uses (`candidates` here,
 * `peers[<name>]` on a paired machine) is at or over the level in its 5-hour window does it get
 * one, with no suggestion: new agents take the one with the most room until the window resets.
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
    // Known headroom first; else an account with no usage yet (offered, never taken).
    const suggested = rankAccounts(o.accounts, roomy, { now: o.now })[0]?.account ?? null;
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
  const best = rankAccounts(o.accounts, cands, { now: o.now })[0];
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
        question: `Needs you: every signed-in account on ${machine} is at or over ${o.warnAtPct}% of its 5-hour window; new agents start on the one with the most room (${best.account}, ${Math.round(best.five_hour_pct ?? w.pct)}%) and${resets}.`,
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
    const roomy = o
      .candidates(ag.machine)
      .filter(
        (c) =>
          c !== ag.acct && agentWindows(o.accounts[c], family, o.now).every((w) => w.pct < warn),
      );
    const best = rankAccounts(o.accounts, roomy, { model: ag.model, now: o.now })[0];
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

/** A wave's account moves (`wave_account_moved`), in journal order. */
export function waveAccountMoves(events: readonly JournalEvent[]): { from: string; to: string }[] {
  return events.flatMap((e) => {
    if (e.type !== "wave_account_moved") return [];
    const { from, to } = e.data as { from?: unknown; to?: unknown };
    return typeof from === "string" && typeof to === "string" ? [{ from, to }] : [];
  });
}

/** The account a new agent of the wave starts under, given the account it would have used. */
export function waveAccount(acct: string, moves: readonly { from: string; to: string }[]): string {
  let out = acct;
  for (const m of moves) if (m.from === out) out = m.to;
  return out;
}
