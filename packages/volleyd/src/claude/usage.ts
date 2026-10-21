import { type DecisionInput, ID_RE } from "../decisions";
import type { JournalEvent } from "../types";
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
  agents: Record<string, { account: string; wave: string | null }>;
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
    agents: { ...book.agents, [s.agent]: { account: s.account, wave: s.wave } },
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

/**
 * `most_headroom`: among `candidates` (accounts an agent could start under), the one with the
 * lowest 5-hour percentage (then the lowest weekly, then candidate order). Candidates without
 * usage data are not ranked (a primary that has not reported yet loses to a signed-in profile
 * at 80%); null when none has any.
 */
export function mostHeadroom(
  accounts: Record<string, AccountUsage>,
  candidates: readonly string[],
  now: number,
): string | null {
  let best: { id: string; five: number; week: number } | null = null;
  for (const id of candidates) {
    const a = accounts[id];
    const five = a !== undefined ? livePct(a.five_hour, now) : null;
    if (a === undefined || five === null) continue;
    const week = livePct(a.weekly, now) ?? 0;
    if (best === null || five < best.five || (five === best.five && week < best.week))
      best = { id, five, week };
  }
  return best?.id ?? null;
}

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
 * the candidate with the most known headroom, else one with no 5-hour usage yet (a newly
 * signed-in profile before `primary`), labelled so. Never a move.
 */
export function limitDecisions(o: {
  accounts: Record<string, AccountUsage>;
  warnAtPct: number;
  candidates: readonly string[];
  existing: readonly LimitSeen[];
  now: number;
}): LimitDecision[] {
  const out: LimitDecision[] = [];
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
    // Known headroom first; else an account with no 5-hour usage yet (offered, never taken).
    // Signed-in profiles come before primary: interactive sessions use the owner's own login
    // without reporting usage, so its lack of a sample says least about its headroom.
    const suggested =
      mostHeadroom(o.accounts, roomy, o.now) ??
      [
        ...roomy.filter((c) => c !== PRIMARY_ACCOUNT),
        ...roomy.filter((c) => c === PRIMARY_ACCOUNT),
      ].find((c) => (o.accounts[c]?.five_hour ?? null) === null) ??
      null;
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
