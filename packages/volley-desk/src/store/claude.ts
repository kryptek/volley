/**
 * Pure views over the Desk's Claude account slices (SPEC §4.6.11–12): the
 * account list the Settings section, the agent window's picker and the wave
 * window's account dropdown share, the open `account_limit` decisions, and the formatting of a
 * window's reset. Accounts come from two places: the supervisor's retained
 * usage records (`volley/_system/claude-accounts/+`, only accounts that have
 * reported usage) and, when the Desk can ask, the registry (`claude_accounts`
 * control op: profiles that have not reported yet, with their machine).
 */
import { maskEmail, normalizeEmail } from "../lib/email";
import type {
  ClaudeAccountPayload,
  DecisionPayload,
  Envelope,
  FeedEntry,
  MachinePayload,
  ModelFamily,
  ProbeState,
  UsageProbe,
  UsageWindow,
  WaveStatePayload,
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
  /** The model-scoped weekly windows its machine's usage probe last read (`{}` until one has). */
  modelWeekly: Partial<Record<ModelFamily, UsageWindow>>;
  /** Its machine's newest usage probe attempt; `null` until a probe has reported. */
  probe: UsageProbe | null;
  signedIn: boolean;
  agents: string[];
  waves: string[];
  /** Its row's place in the registry (`claude_accounts` order); absent: not a registry profile. */
  registryOrder?: number;
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
  /** `local` (volleyd's machine) or a remote host: an agent can only move to its own machine's. */
  machine: string;
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

/** A registry row's usage-record key: `<id>` here, `<id>@<machine>` on a paired machine. */
export const registryKey = (row: Pick<RegistryAccount, "id" | "machine">) =>
  row.machine === LOCAL_MACHINE ? row.id : `${row.id}@${row.machine}`;

/** How a duplicate sign-in names a machine's own login (`sameAccountOnMachine`). */
export const THE_DEFAULT_LOGIN = "the default login";

/**
 * A sign-in that finished on `email` duplicates an account already on `machine`: the label of
 * the profile there with that e-mail (`except` the new profile's own key), else the machine's
 * default login when its e-mail (`defaultEmail`) is that one; `null` when it is new there.
 */
export function sameAccountOnMachine(
  registry: readonly RegistryAccount[],
  machine: string,
  email: string,
  o: { except?: string; defaultEmail?: string | null } = {},
): string | null {
  const want = normalizeEmail(email);
  const row = registry.find(
    (r) =>
      r.machine === machine &&
      registryKey(r) !== o.except &&
      r.email !== undefined &&
      normalizeEmail(r.email) === want,
  );
  if (row !== undefined) return row.label;
  return o.defaultEmail && normalizeEmail(o.defaultEmail) === want ? THE_DEFAULT_LOGIN : null;
}

/**
 * The profiles waiting for sign-in: registry rows that never finished one and have no usage
 * record. Each is a row of its own, never a card.
 */
export function pendingProfiles(
  registry: readonly RegistryAccount[],
  records: Record<string, ClaudeAccountPayload> | undefined,
): RegistryAccount[] {
  return registry.filter((r) => r.signed_in_at === undefined && !records?.[registryKey(r)]);
}

/**
 * The usage records merged over the registry rows (each by its usage-record key, so a paired
 * machine's profile is one account): records first, then registry-only accounts; a profile
 * waiting for sign-in is left out (`pendingProfiles`).
 */
export function accountList(
  records: Record<string, ClaudeAccountPayload> | undefined,
  registry: readonly RegistryAccount[] = [],
): AccountInfo[] {
  const reg = new Map(registry.map((r, i) => [registryKey(r), { row: r, order: i }]));
  const out: AccountInfo[] = Object.values(records ?? {}).map((r) => {
    const { row, order } = reg.get(r.account) ?? {};
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
      modelWeekly: r.model_weekly ?? {},
      probe: r.probe ?? null,
      // Its agents are using it, unless the registry says it is signed out now.
      signedIn: row === undefined || row.signed_in_at !== undefined,
      agents: r.agents,
      waves: r.waves,
      ...(order !== undefined ? { registryOrder: order } : {}),
    };
  });
  const pending = new Set(pendingProfiles(registry, records));
  registry.forEach((row, order) => {
    if (records?.[registryKey(row)] || pending.has(row)) return;
    out.push({
      id: registryKey(row),
      label: row.label,
      machine: row.machine,
      plan: row.plan ?? null,
      email: row.email ?? null,
      org: row.org ?? null,
      fiveHour: null,
      weekly: null,
      sampledAt: null,
      modelWeekly: {},
      probe: null,
      signedIn: row.signed_in_at !== undefined,
      agents: [],
      waves: [],
      registryOrder: order,
    });
  });
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
  /** When this login's own latest sample or probe reading was taken; `null`: none yet. */
  sampledAt: string | null;
}

type WindowKey = "five_hour" | "weekly";

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
  /** The Fable weekly window of the member whose probe `probe` reports; `null`: it read none. */
  fable: UsageWindow | null;
  /** The usage probe the Fable meter reports: the freshest read first, else the newest attempt. */
  probe: ProbeInfo | null;
  freshest: { machine: string; sampledAt: string } | null;
  members: Member[];
  agents: string[];
  waves: string[];
}

/** A group's usage probe, as its Fable meter reports it. */
export interface ProbeInfo {
  /** The member's machine: `local` (volleyd's machine) or a remote host. */
  machine: string;
  state: ProbeState;
  attemptedAt: string;
  /** The last successful read; `null` while none has succeeded. */
  readAt: string | null;
}

/** A record's sample time; one with no (or an unreadable) sample sorts as the oldest. */
const sampledAt = (a: AccountInfo) => {
  const t = Date.parse(a.sampledAt ?? "");
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

const newestFirst = (a: AccountInfo, b: AccountInfo) => sampledAt(b) - sampledAt(a) || 0;

/**
 * Per window, the reading of the member whose record was sampled last among those carrying it
 * (volleyd's `foldUsage` rule); a tie goes to the one with a known reset.
 */
function pickWindow(accounts: AccountInfo[], key: WindowKey): UsageWindow | null {
  const of = (a: AccountInfo) => (key === "five_hour" ? a.fiveHour : a.weekly);
  const best = accounts
    .filter((a) => of(a) !== null && a.sampledAt !== null)
    .sort(
      (a, b) =>
        newestFirst(a, b) || Number(of(b)?.resets_at != null) - Number(of(a)?.resets_at != null),
    )[0];
  return best ? of(best) : null;
}

/** A profile label volleyd's Add suggests for a machine's own login: never a card's name. */
export const NEW_PROFILE = "Claude login";

/**
 * A group's name: the registry label of its profiles (this machine's, else the earliest in
 * registry order), less a trailing ` (<one of the group's machines>)`; `null` when none has
 * one of its own (only default logins, or Add's `Claude login`).
 */
function profileName(list: AccountInfo[], localName: string | undefined): string | null {
  const profiles = list.filter((a) => !isPrimary(a.id) && a.label !== a.id);
  const order = (a: AccountInfo) => a.registryOrder ?? Number.POSITIVE_INFINITY;
  const chosen = [...profiles].sort(
    (a, b) =>
      Number(b.machine === LOCAL_MACHINE) - Number(a.machine === LOCAL_MACHINE) ||
      (order(a) === order(b) ? 0 : order(a) < order(b) ? -1 : 1),
  )[0];
  if (chosen === undefined) return null;
  const hosts = new Set([...list.map((a) => a.machine), ...(localName ? [localName] : [])]);
  const suffix = / \(([^()]+)\)$/.exec(chosen.label);
  const name =
    suffix && hosts.has(suffix[1] as string) ? chosen.label.slice(0, suffix.index) : chosen.label;
  return name === "" || name === NEW_PROFILE ? null : name;
}

const union = (xs: string[][]) => [...new Set(xs.flat())];

/** An ISO time in ms; a missing or unreadable one sorts as the oldest. */
const ms = (iso: string | null | undefined) => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};
/** A sort comparator, newest first, that never answers NaN for two missing times. */
const desc = (a: number, b: number) => (a === b ? 0 : b > a ? 1 : -1);

/** The member whose probe read last, else the one whose probe attempted last. */
function probeMember(accounts: AccountInfo[]): AccountInfo | undefined {
  return accounts
    .filter((a) => a.probe !== null)
    .sort(
      (a, b) =>
        desc(ms(a.probe?.read_at), ms(b.probe?.read_at)) ||
        desc(ms(a.probe?.attempted_at), ms(b.probe?.attempted_at)),
    )[0];
}

function toProbe(best: AccountInfo | undefined): ProbeInfo | null {
  if (!best?.probe) return null;
  const p = best.probe;
  return {
    machine: best.machine,
    state: p.state,
    attemptedAt: p.attempted_at,
    readAt: p.read_at ?? null,
  };
}

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
      modelWeekly: {},
      probe: null,
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
    const fresh = newest.find((a) => a.sampledAt !== null);
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
          sampledAt: a.sampledAt,
        }),
      );
    return {
      key,
      email,
      org: newest.find((a) => a.org)?.org ?? null,
      label:
        profileName(list, localName) ??
        (email ? maskEmail(email) : (localPrimary?.label ?? newest[0]?.label ?? key)),
      plan: newest.find((a) => a.plan)?.plan ?? null,
      fiveHour: pickWindow(list, "five_hour"),
      weekly: pickWindow(list, "weekly"),
      // The figure comes from the member whose probe it reports, so its label names the right read.
      fable: probeMember(list)?.modelWeekly.fable ?? null,
      probe: toProbe(probeMember(list)),
      freshest: fresh ? { machine: fresh.machine, sampledAt: fresh.sampledAt as string } : null,
      members,
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
          modelWeekly: {},
          probe: null,
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

/** A machine's sign-in state for one account: what a card's machine row says. */
export type MachineState = "signed_in" | "signed_out" | "missing";

/** One row of an account card's machine list. */
export interface MachineRow {
  name: string;
  op: string;
  up: boolean;
  /** Signed in when any of its logins there is; `missing`: none there. */
  state: MachineState;
  /** The labels of its logins there (`default login` for the machine's own), in member order. */
  labels: string[];
}

/**
 * An account's machine list: one row per configured machine, in configured order, however many
 * of its logins are there; then one per machine no longer configured that still holds one.
 */
export function machineRows(
  group: AccountGroup,
  configured: readonly MatrixMachine[],
): MachineRow[] {
  const row = (name: string, op: string, up: boolean): MachineRow => {
    const here = group.members.filter((m) => m.machine === op);
    return {
      name,
      op,
      up,
      state:
        here.length === 0 ? "missing" : here.some((m) => m.signedIn) ? "signed_in" : "signed_out",
      labels: here.map((m) => m.label),
    };
  };
  const ops = new Set(configured.map((m) => m.op));
  const rest = [...new Set(group.members.map((m) => m.machine))].filter((op) => !ops.has(op));
  return [
    ...configured.map((m) => row(m.name, m.op, m.up)),
    ...rest.map((op) => row(machineName(op), op, true)),
  ];
}

/** `4 min ago`, `just now`: how old the account's freshest reading is; `null` with none. */
export function lastUpdated(group: AccountGroup, now: number): string | null {
  return group.freshest ? agoText(group.freshest.sampledAt, now) : null;
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
    machine: a.machine,
    fivePct: a.fiveHour?.pct ?? null,
    weeklyPct: a.weekly?.pct ?? null,
  }));
}

/** An account's usage-record key: a profile kept for a paired machine is `<id>@<machine>`. */
const recordKey = (c: Pick<AccountChoice, "id" | "machine">) =>
  c.machine === LOCAL_MACHINE || c.id.includes("@") ? c.id : `${c.id}@${c.machine}`;

/**
 * The choices an agent on `machine` can move to (`agent_move_account` refuses any other): that
 * machine's logins, each once, by its usage-record key.
 */
export function choicesFor(choices: readonly AccountChoice[], machine: string): AccountChoice[] {
  const seen = new Set<string>();
  return choices
    .filter((c) => c.machine === machine)
    .map((c) => ({ ...c, id: recordKey(c) }))
    .filter((c) => !seen.has(c.id) && seen.add(c.id) !== undefined);
}

/** A usage-record key's profile id: `team@box-a` → `team`. */
const profileId = (key: string) => key.replace(/@.*$/, "");

/** The machines a wave's tasks run on: volleyd's own, then each paired machine a task names. */
export function waveMachines(s: WaveStatePayload | null): string[] {
  const hosts = (s?.tasks ?? []).map((t) => t.host).filter((h): h is string => !!h);
  return [...new Set([LOCAL_MACHINE, ...hosts])];
}

/**
 * An account's name, as the wave window and the agent window show it: its registry label
 * (this machine's row first, then any machine's), else the id itself.
 */
export function accountName(
  accounts: readonly Pick<AccountInfo, "id" | "label" | "machine">[],
  id: string,
): string {
  const same = accounts.filter((a) => a.id === id || profileId(a.id) === profileId(id));
  const exact = same.find((a) => a.id === id);
  return (exact ?? same.find((a) => a.machine === LOCAL_MACHINE) ?? same[0])?.label ?? id;
}

/**
 * What the wave window's account dropdown lists after `Balanced (default)`: each signed-in
 * account on the wave's machines once, by the profile id `wave_account_set` takes, named by its
 * registry label (`accountName`).
 */
export function waveAccountChoices(
  accounts: readonly AccountInfo[],
  machines: readonly string[],
): { id: string; label: string }[] {
  const ids = accounts
    .filter((a) => a.signedIn && machines.includes(a.machine))
    .map((a) => profileId(a.id));
  return [...new Set(ids)].map((id) => ({ id, label: accountName(accounts, id) }));
}

/** One candidate in a `claude_balance` answer, as volleyd ranked it. */
export interface BalanceCandidate {
  account: string;
  headroom: number | null;
  five_hour_pct: number | null;
  weekly_pct: number | null;
  model_weekly_pct?: number;
  agents: number;
  /** The rank rule's pace, its binding window and the cap (SPEC §4.6.12); absent from an older volleyd. */
  score?: number | null;
  binding?: "five_hour" | "weekly" | "model_weekly" | null;
  eligible?: boolean;
  binding_left?: number | null;
  binding_resets_at?: string | null;
}

/** volleyd's `claude_balance` answer (SPEC §4.6.11): per machine, its ranking and the picks. */
export interface BalanceAnswer {
  model?: string;
  machines: {
    name: string;
    candidates: BalanceCandidate[];
    /** The pick per model family (or `model`, when one was asked for); `null`: no candidate. */
    picks: Record<string, string | null>;
  }[];
}

const FAMILIES: readonly ModelFamily[] = ["fable", "opus", "sonnet", "haiku"];

/** The model families whose next spawn `answer` puts on `account` (a usage-record key). */
export function nextPicks(answer: BalanceAnswer | null, account: string): ModelFamily[] {
  const picks = answer?.machines.map((m) => m.picks) ?? [];
  return FAMILIES.filter((f) => picks.some((p) => p[f] === account));
}

/** `Fable, others`, `Fable`, `others`; `null` when no family picks the account next. */
export function picksLine(families: readonly ModelFamily[]): string | null {
  const parts = [
    ...(families.includes("fable") ? ["Fable"] : []),
    ...(families.some((f) => f !== "fable") ? ["others"] : []),
  ];
  return parts.length ? parts.join(", ") : null;
}

const LIMIT_KINDS: ReadonlySet<string> = new Set(["account_limit", "agent_account_limit"]);

/**
 * Every unresolved account-limit decision, oldest first: the wave-level `account_limit` and the
 * agent-level `agent_account_limit` (SPEC §4.6.12).
 */
export function openLimitDecisions(waves: Record<string, WaveView>): DecisionPayload[] {
  return Object.values(waves)
    .flatMap((w) => Object.values(w.decisions))
    .filter((d) => LIMIT_KINDS.has(d.kind) && !d.resolved && typeof d.acct === "string")
    .sort((a, b) => a.opened_at.localeCompare(b.opened_at));
}

/** A wave-level `account_limit`: the only kind a `move wave` answers. */
export const isWaveLimit = (d: DecisionPayload) => d.kind === "account_limit";

/** The agent's open `agent_account_limit` decision, if any. */
export function agentLimitFor(
  waves: Record<string, WaveView>,
  agentId: string,
): DecisionPayload | null {
  return (
    openLimitDecisions(waves).find(
      (d) => d.kind === "agent_account_limit" && d.agent_id === agentId,
    ) ?? null
  );
}

/** The decision's own `move <agent> to <acct>` option: the card never composes one. */
export const moveOption = (d: DecisionPayload): string | null =>
  d.options?.find((o) => /^move /.test(o)) ?? null;

/** `5h 12%, 7d 40%`: what a decision card says of the account it suggests; `no usage yet` without. */
export function accountFigures(a: AccountInfo | undefined): string {
  const bits = [
    ...(a?.fiveHour ? [`5h ${Math.round(a.fiveHour.pct)}%`] : []),
    ...(a?.weekly ? [`7d ${Math.round(a.weekly.pct)}%`] : []),
  ];
  return bits.length ? bits.join(", ") : NO_USAGE_YET;
}

/** The journal events that say which account an agent runs under (SPEC §4.6.11). */
export const ACCOUNT_EVENTS: ReadonlySet<string> = new Set([
  "account_chosen",
  "agent_account_moved",
]);

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const dataOf = (env: Envelope): Record<string, unknown> =>
  (env.payload as { data?: Record<string, unknown> } | null)?.data ?? {};

/**
 * `Account · <why>` for an `account_chosen`, `Account · moved off <from> to <to> by <by>: <why>`
 * for an `agent_account_moved`; `null` for any other envelope.
 */
export function accountLine(env: Envelope): string | null {
  if (!ACCOUNT_EVENTS.has(env.type)) return null;
  const d = dataOf(env);
  if (env.type === "account_chosen") return `Account · ${text(d.why) ?? text(d.account) ?? "?"}`;
  const why = text(d.why);
  return `Account · moved off ${text(d.from) ?? "?"} to ${text(d.to) ?? "?"} by ${text(d.by) ?? "?"}${why ? `: ${why}` : ""}`;
}

/** The account events of one task's role, oldest first. */
export function accountEventsFor(
  feed: readonly FeedEntry[] | undefined,
  task: string | null,
  role: string | null,
): FeedEntry[] {
  if (!task) return [];
  return (feed ?? []).filter((e) => {
    const p = e.envelope.payload as { task?: unknown } | null;
    const d = dataOf(e.envelope);
    return (
      ACCOUNT_EVENTS.has(e.envelope.type) &&
      (p?.task ?? d.task) === task &&
      (role === null || d.role === role)
    );
  });
}

/**
 * Why the agent of a task's role runs under its account: the latest `account_chosen` line, or,
 * after a move (the respawn's own choice says `source: move`), the move's
 * (`moved off primary by autopilot: <why>`, `moved by <person>`). `null`: none seen.
 */
export function accountWhy(
  feed: readonly FeedEntry[] | undefined,
  task: string | null,
  role: string | null,
): string | null {
  const events = accountEventsFor(feed, task, role);
  const last = (type: string) => events.map((e) => e.envelope.type).lastIndexOf(type);
  const m = last("agent_account_moved");
  const c = last("account_chosen");
  const chosen = c < 0 ? null : dataOf((events[c] as FeedEntry).envelope);
  // A move not seen since the Desk loaded: the respawn's own line is all there is.
  if (chosen && c > m && (chosen.source !== "move" || m < 0))
    return text(chosen.why) ?? text(chosen.account);
  if (m < 0) return null;
  const d = dataOf((events[m] as FeedEntry).envelope);
  const by = text(d.by) ?? "?";
  if (by !== "autopilot") return `moved by ${by}`;
  const why = text(d.why);
  return `moved off ${text(d.from) ?? "?"} by autopilot${why ? `: ${why}` : ""}`;
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

/** `3 h`, `12 min`, `2 d`: how old a reading is; `null` under a minute. */
export function readingAge(at: string, now: number): string | null {
  const m = Math.floor((now - Date.parse(at)) / 60_000);
  if (!(m >= 1)) return null;
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/** `4 min ago`, or `just now` under a minute. */
export function agoText(at: string, now: number): string {
  const a = readingAge(at, now);
  return a ? `${a} ago` : "just now";
}

/** A window's percentage as shown, rounded; one whose reset has passed counts as 0. */
export function windowPct(w: UsageWindow | null, now: number): number | null {
  if (w === null) return null;
  const t = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
  return !Number.isNaN(t) && t <= now ? 0 : Math.round(w.pct);
}

/** The Fable window a group shows: only while its probe's last attempt succeeded. */
export const fableShown = (g: AccountGroup): UsageWindow | null =>
  g.probe?.state === "ok" ? g.fable : null;

const PROBE_HINT: Record<Exclude<ProbeState, "ok">, (machine: string) => string> = {
  expired: () => "login expired — Claude Code renews it on its next request",
  no_credential: (m) => `no credential on ${machineName(m)}`,
  rate_limited: () => "rate limited, retrying",
  rejected: () => "probe failed",
  error: () => "probe failed",
};

/**
 * What the Fable meter says of its reading: `read 4 min ago on peer-a`; while the last attempt
 * failed, why (`rate limited, retrying; last read 25 min ago`); before any probe, `not read yet`.
 */
export function fableHint(probe: ProbeInfo | null, now: number): string {
  if (probe === null) return "not read yet";
  if (probe.state === "ok")
    return `read ${agoText(probe.readAt ?? probe.attemptedAt, now)} on ${machineName(probe.machine)}`;
  const why = PROBE_HINT[probe.state](probe.machine);
  return probe.readAt ? `${why}; last read ${agoText(probe.readAt, now)}` : why;
}

/**
 * A machine row's compact usage: the account's three figures (`5h 37% · 7d 56% · Fable 12%`) and,
 * when this login's own latest reading is older than the account's freshest, its age.
 */
export function usageTriple(
  g: AccountGroup,
  member: Pick<Member, "sampledAt">,
  now: number,
): { text: string; sampled: string | null } {
  const show = (w: UsageWindow | null) => {
    const pct = windowPct(w, now);
    return pct === null ? "—" : `${pct}%`;
  };
  const text = `5h ${show(g.fiveHour)} · 7d ${show(g.weekly)} · Fable ${show(fableShown(g))}`;
  const own = member.sampledAt;
  const older =
    own !== null &&
    g.freshest !== null &&
    ms(own) < ms(g.freshest.sampledAt) &&
    readingAge(own, now) !== null;
  return { text, sampled: older ? `sampled ${agoText(own, now)}` : null };
}
