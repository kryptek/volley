/**
 * Pure views over the Desk's Claude account slices (SPEC §4.6.11–12): the
 * account list the Settings section, the agent window's picker and the wave
 * modal share, the open `account_limit` decisions, and the formatting of a
 * window's reset. Accounts come from two places: the supervisor's retained
 * usage records (`volley/_system/claude-accounts/+`, only accounts that have
 * reported usage) and, when the Desk can ask, the registry (`claude_accounts`
 * control op: profiles that have not reported yet, with their machine).
 */
import { maskEmail, normalizeEmail } from "../lib/email";
import type {
  ClaudeAccountPayload,
  DecisionPayload,
  MachinePayload,
  UsageWindow,
  WaveView,
} from "./types";

/** volleyd's own machine (`LOCAL_MACHINE` in its profiles). */
export const LOCAL_MACHINE = "local";

/** A registry row from the `claude_accounts` control op (only the fields the Desk shows). */
export interface RegistryAccount {
  id: string;
  label: string;
  machine: string;
  plan?: string;
  email?: string;
  org?: string;
  signed_in_at?: string;
  signin?: { state: string; url?: string };
}

/** One Claude account as the Desk shows it. */
export interface AccountInfo {
  id: string;
  label: string;
  /** `local` (volleyd's machine) or a remote host. */
  machine: string;
  plan: string | null;
  /** The login's e-mail and organisation, as volleyd reported them; `null` while not known. */
  email: string | null;
  org: string | null;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  /** When its usage record was sampled; `null` for a profile that has not reported. */
  sampledAt: string | null;
  signedIn: boolean;
  agents: string[];
  waves: string[];
}

/**
 * How a picker or a suggestion labels an account that has not reported usage (a newly signed-in
 * profile): available, never a reason to leave it out (SPEC §4.6.12).
 */
export const NO_USAGE_YET = "no usage yet";

/** An account that reported weekly usage but no 5-hour window: "no usage yet" would be untrue. */
export const NO_FIVE_HOUR_YET = "no 5-hour usage yet";

/** `34%`, or why there is no 5-hour percentage: what a picker or a suggestion shows. */
export function fiveHourLabel(fivePct: number | null, weeklyPct: number | null): string {
  if (fivePct !== null) return `${Math.round(fivePct)}%`;
  return weeklyPct !== null ? NO_FIVE_HOUR_YET : NO_USAGE_YET;
}

/** What the agent window's picker lists. */
export interface AccountChoice {
  id: string;
  label: string;
  /** The 5-hour window's pct, or `null` until the account reports usage. */
  fivePct: number | null;
  /** The weekly window's pct, or `null` until the account reports it. */
  weeklyPct: number | null;
}

/** `primary@gpu-box` → `gpu-box`: a remote host's own login. */
function hostOf(account: string): string {
  const at = account.indexOf("@");
  return at < 0 ? LOCAL_MACHINE : account.slice(at + 1);
}

/** The usage records merged over the registry rows: records first, then registry-only accounts. */
export function accountList(
  records: Record<string, ClaudeAccountPayload> | undefined,
  registry: readonly RegistryAccount[] = [],
): AccountInfo[] {
  const reg = new Map(registry.map((r) => [r.id, r]));
  const out: AccountInfo[] = Object.values(records ?? {}).map((r) => {
    const row = reg.get(r.account);
    return {
      id: r.account,
      label: r.label ?? row?.label ?? r.account,
      machine: row?.machine ?? hostOf(r.account),
      plan: r.plan ?? row?.plan ?? null,
      email: r.email ?? row?.email ?? null,
      org: r.org ?? row?.org ?? null,
      fiveHour: r.five_hour,
      weekly: r.weekly,
      sampledAt: r.sampled_at,
      // Its agents are using it.
      signedIn: true,
      agents: r.agents,
      waves: r.waves,
    };
  });
  for (const row of registry) {
    if (records?.[row.id]) continue;
    out.push({
      id: row.id,
      label: row.label,
      machine: row.machine,
      plan: row.plan ?? null,
      email: row.email ?? null,
      org: row.org ?? null,
      fiveHour: null,
      weekly: null,
      sampledAt: null,
      signedIn: row.signed_in_at !== undefined,
      agents: [],
      waves: [],
    });
  }
  return out;
}

/** volleyd's id for Claude Code's default profile on its own machine (`primary@<host>` on a peer). */
const PRIMARY = "primary";
const isPrimary = (id: string) => id === PRIMARY || id.startsWith(`${PRIMARY}@`);
/** How a machine row names a machine's default profile. */
export const DEFAULT_LOGIN = "default login";

/** One machine's login in an account group. */
export interface Member {
  account: string;
  /** `local` (volleyd's machine) or a remote host. */
  machine: string;
  /** The profile's label there: `default login` for a machine's primary. */
  label: string;
  signedIn: boolean;
  agents: string[];
  waves: string[];
  isPrimary: boolean;
}

type WindowKey = "five_hour" | "weekly";

/** A member's reading not chosen for a window, because a fresher one disagrees with it. */
export interface StaleReading {
  machine: string;
  window: WindowKey;
  pct: number;
  sampledAt: string;
}

/** One Anthropic account: every login on it, on every machine, merged by e-mail. */
export interface AccountGroup {
  /** The normalised e-mail, else the lone account's id (its e-mail is not reported yet). */
  key: string;
  /** The address as first reported (the key is its normalised form). */
  email: string | null;
  org: string | null;
  label: string;
  plan: string | null;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  freshest: { machine: string; sampledAt: string } | null;
  members: Member[];
  stale: StaleReading[];
  agents: string[];
  waves: string[];
}

/** Two readings of one window agree within a point when their resets agree too. */
const STALE_PCT = 1;

/** A record's sample time; one with no (or an unreadable) sample sorts as the oldest. */
const sampledAt = (a: AccountInfo) => {
  const t = Date.parse(a.sampledAt ?? "");
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

const newestFirst = (a: AccountInfo, b: AccountInfo) => sampledAt(b) - sampledAt(a) || 0;

/**
 * Per window, the member whose record was sampled last among those carrying it (volleyd's
 * `foldUsage` rule); a tie goes to the one with a known reset. The others that disagree with it
 * are stale.
 */
function pickWindow(accounts: AccountInfo[], key: WindowKey) {
  const of = (a: AccountInfo) => (key === "five_hour" ? a.fiveHour : a.weekly);
  const carrying = accounts.filter((a) => of(a) !== null && a.sampledAt !== null);
  const best = [...carrying].sort(
    (a, b) =>
      newestFirst(a, b) || Number(of(b)?.resets_at != null) - Number(of(a)?.resets_at != null),
  )[0];
  const w = best ? of(best) : null;
  const stale: StaleReading[] = [];
  for (const a of carrying) {
    const r = of(a);
    if (a === best || r === null || w === null) continue;
    if (Math.abs(r.pct - w.pct) > STALE_PCT || r.resets_at !== w.resets_at)
      stale.push({ machine: a.machine, window: key, pct: r.pct, sampledAt: a.sampledAt as string });
  }
  return { w, stale };
}

const union = (xs: string[][]) => [...new Set(xs.flat())];

/**
 * The accounts as Anthropic sees them: one group per login e-mail (an account whose e-mail is not
 * reported yet keeps its own group, keyed by its id). A peer's default login takes its e-mail from
 * its machine record (`auth.claude_email`); a peer signed in there with no usage record yet joins
 * as a member with no readings. `localName` is the supervisor's own machine record, never a peer.
 */
export function accountGroups(
  accounts: AccountInfo[],
  machines: Record<string, MachinePayload> = {},
  localName?: string,
): AccountGroup[] {
  const known = new Set(accounts.map((a) => a.id));
  const peers: AccountInfo[] = Object.values(machines)
    .filter(
      (m) =>
        m.name !== localName &&
        m.kind !== "supervisor" &&
        m.auth?.claude === "signed_in" &&
        !known.has(`${PRIMARY}@${m.name}`),
    )
    .map((m) => ({
      id: `${PRIMARY}@${m.name}`,
      label: `${PRIMARY}@${m.name}`,
      machine: m.name,
      plan: m.auth?.claude_plan ?? null,
      email: null,
      org: null,
      fiveHour: null,
      weekly: null,
      sampledAt: null,
      signedIn: true,
      agents: [],
      waves: [],
    }));
  const own = (machine: string) =>
    machine === LOCAL_MACHINE ? (localName ? machines[localName] : undefined) : machines[machine];

  const byKey = new Map<string, AccountInfo[]>();
  for (const a0 of [...accounts, ...peers]) {
    const rec = isPrimary(a0.id) ? own(a0.machine) : undefined;
    const email = a0.email ?? rec?.auth?.claude_email ?? null;
    const a: AccountInfo = {
      ...a0,
      email,
      org: a0.org ?? (rec?.auth?.claude_email ? (rec.auth.claude_org ?? null) : null),
      signedIn: rec?.auth ? rec.auth.claude === "signed_in" : a0.signedIn,
    };
    const key = email ? normalizeEmail(email) : a.id;
    byKey.set(key, [...(byKey.get(key) ?? []), a]);
  }

  return [...byKey].map(([key, list]) => {
    const email = list.find((a) => a.email)?.email?.trim() ?? null;
    const newest = [...list].sort(newestFirst);
    const five = pickWindow(list, "five_hour");
    const week = pickWindow(list, "weekly");
    const fresh = newest.find((a) => a.sampledAt !== null);
    const profile = newest.find((a) => !isPrimary(a.id) && a.label !== a.id);
    const localPrimary = list.find((a) => a.id === PRIMARY);
    const members = [...list]
      .sort(
        (a, b) =>
          Number(b.machine === LOCAL_MACHINE) - Number(a.machine === LOCAL_MACHINE) ||
          a.machine.localeCompare(b.machine),
      )
      .map(
        (a): Member => ({
          account: a.id,
          machine: a.machine,
          label: isPrimary(a.id) ? DEFAULT_LOGIN : a.label,
          signedIn: a.signedIn,
          agents: a.agents,
          waves: a.waves,
          isPrimary: isPrimary(a.id),
        }),
      );
    return {
      key,
      email,
      org: newest.find((a) => a.org)?.org ?? null,
      label:
        profile?.label ??
        localPrimary?.label ??
        (email ? maskEmail(email) : (newest[0]?.label ?? key)),
      plan: newest.find((a) => a.plan)?.plan ?? null,
      fiveHour: five.w,
      weekly: week.w,
      freshest: fresh ? { machine: fresh.machine, sampledAt: fresh.sampledAt as string } : null,
      members,
      stale: [...five.stale, ...week.stale],
      agents: union(list.map((a) => a.agents)),
      waves: union(list.map((a) => a.waves)),
    };
  });
}

/** How the primary's card names it: never just "primary", which reads as one more profile. */
export const PRIMARY_LABEL = "This machine's Claude login";

/**
 * The list with this machine's own login first. It is always there (agents run on it by
 * default), but it has a usage record only once it reports usage, so until then one is made up
 * for it: an owner who adds a profile must not read the missing card as their login gone. Its
 * plan is the one volleyd reports (its record's, else `claude_accounts`'s), never a guess.
 */
export function withPrimary(list: AccountInfo[], plan: string | undefined): AccountInfo[] {
  const own = list.find((a) => a.id === PRIMARY);
  const primary: AccountInfo =
    own === undefined
      ? {
          id: PRIMARY,
          label: PRIMARY_LABEL,
          machine: LOCAL_MACHINE,
          plan: plan ?? null,
          email: null,
          org: null,
          fiveHour: null,
          weekly: null,
          sampledAt: null,
          signedIn: true,
          agents: [],
          waves: [],
        }
      : {
          ...own,
          label: own.label === PRIMARY ? PRIMARY_LABEL : own.label,
          plan: own.plan ?? plan ?? null,
        };
  return [primary, ...list.filter((a) => a !== own)];
}

/**
 * The Desk's account groups, the one grouping Settings › Claude accounts and Settings › Machines
 * share: the usage records merged over the registry, this machine's own login first, grouped by
 * e-mail.
 */
export function deskAccountGroups(
  records: Record<string, ClaudeAccountPayload> | undefined,
  registry: readonly RegistryAccount[],
  primaryPlan: string | undefined,
  machines: Record<string, MachinePayload> | undefined,
  localName: string | undefined,
): AccountGroup[] {
  return accountGroups(
    withPrimary(accountList(records, registry), primaryPlan),
    machines,
    localName,
  );
}

/** How a row names a machine: volleyd's own is "this machine". */
export const machineName = (m: string) => (m === LOCAL_MACHINE ? "this machine" : m);

/** A configured machine: one an account can be signed in on. */
export interface MatrixMachine {
  /** How a row names it ("this machine" for volleyd's own). */
  name: string;
  /** Its host name, when known: what a suggested label names it by (`name` otherwise). */
  host?: string;
  /** `claude_account_add`'s `machine`: `LOCAL_MACHINE` or the peer's host name. */
  op: string;
  /** Its tunnel is up (this machine always is). */
  up: boolean;
  /** A paired host that has published no machine record yet: offered, but its state is unknown. */
  unknown?: boolean;
}

/** The configured machines: volleyd's own first, then each paired host (`_config` `hosts`). */
export function configuredMachines(
  hosts: readonly string[],
  machines: Record<string, MachinePayload> | undefined,
  localName: string | undefined,
): MatrixMachine[] {
  return [
    {
      name: machineName(LOCAL_MACHINE),
      ...(localName ? { host: localName } : {}),
      op: LOCAL_MACHINE,
      up: true,
    },
    ...hosts
      .filter((h) => h !== localName)
      .map((h) => ({
        name: h,
        op: h,
        up: machines?.[h]?.tunnel !== "down",
        ...(machines?.[h] === undefined ? { unknown: true } : {}),
      })),
  ];
}

/** One row of an account's machine list: a login there, or a configured machine without one. */
export interface MatrixCell {
  name: string;
  op: string;
  up: boolean;
  member: Member | null;
}

/** One account across the configured machines. */
export interface AccountMatrixRow {
  group: AccountGroup;
  /** Every login on the account (on a configured machine or not). */
  present: Member[];
  /** The configured machines holding none, in configured order. */
  missing: MatrixMachine[];
  /** How many configured machines hold it. */
  coverage: { held: number; total: number };
  /** One row per configured machine (each of its logins, else one empty row), in configured
   *  order, then the logins on machines no longer configured. */
  rows: MatrixCell[];
}

/** A pure view over `accountGroups`: per account, which configured machines hold it. */
export function accountMatrix(
  groups: readonly AccountGroup[],
  machines: readonly MatrixMachine[],
): AccountMatrixRow[] {
  return groups.map((group) => {
    const on = (op: string) => group.members.filter((m) => m.machine === op);
    const missing = machines.filter((m) => on(m.op).length === 0);
    const ops = new Set(machines.map((m) => m.op));
    const rows: MatrixCell[] = [
      ...machines.flatMap((m): MatrixCell[] => {
        const here = on(m.op);
        const cell = { name: m.name, op: m.op, up: m.up };
        return here.length
          ? here.map((member) => ({ ...cell, member }))
          : [{ ...cell, member: null }];
      }),
      ...group.members
        .filter((m) => !ops.has(m.machine))
        .map((member) => ({
          name: machineName(member.machine),
          op: member.machine,
          up: true,
          member,
        })),
    ];
    return {
      group,
      present: group.members,
      missing,
      coverage: { held: machines.length - missing.length, total: machines.length },
      rows,
    };
  });
}

/** The account a group's Use-for answers with: its login on volleyd's own machine, if any. */
export function moveTargetOf(g: AccountGroup): string | null {
  return (
    g.members.find((m) => m.machine === LOCAL_MACHINE && !m.account.includes("@"))?.account ?? null
  );
}

export function accountChoices(accounts: readonly AccountInfo[]): AccountChoice[] {
  return accounts.map((a) => ({
    id: a.id,
    label: a.label,
    fivePct: a.fiveHour?.pct ?? null,
    weeklyPct: a.weekly?.pct ?? null,
  }));
}

/** Every unresolved `account_limit` decision, oldest first. */
export function openLimitDecisions(waves: Record<string, WaveView>): DecisionPayload[] {
  return Object.values(waves)
    .flatMap((w) => Object.values(w.decisions))
    .filter((d) => d.kind === "account_limit" && !d.resolved && typeof d.acct === "string")
    .sort((a, b) => a.opened_at.localeCompare(b.opened_at));
}

/** volleyd's answer that moves a wave (`moveAnswer` in its usage module). */
export const moveAnswer = (wave: string, to: string) => `move wave ${wave} to ${to}`;

/** The decision's "not now" option (volleyd always offers it). */
export function notNowAnswer(d: DecisionPayload): string {
  return d.options?.find((o) => /^not now$/i.test(o)) ?? "not now";
}

/** The `resolve` control fields that answer `d`. */
export function resolveFields(d: DecisionPayload, answer: string) {
  return { wave: d.wave, decision_id: d.decision_id, answer };
}

/** `4h 4m`, `38m`, `2d 18h`; `null` when the reset is unknown or has passed. */
export function resetsIn(resetsAt: string | null | undefined, now: number): string | null {
  const t = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (Number.isNaN(t) || t <= now) return null;
  const m = Math.floor((t - now) / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}
