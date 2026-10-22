import { maskEmail, normalizeEmail } from "volley-mcp/mask";

/**
 * `volley claude list` as the Desk's account cards show it: one group per Anthropic account (its
 * login e-mail), one member per machine holding it, and per usage window the freshest reading.
 * The grouping rule is the Desk's (`accountGroups` in `packages/volley-desk/src/store/claude.ts`):
 * key = the normalised e-mail, else the account id; per window the newest `sampled_at` wins, a
 * tie going to the reading with a known reset; a member's older reading that differs is stale.
 */

/** volleyd's own machine (`LOCAL_MACHINE` in its profiles). */
const LOCAL_MACHINE = "local";
/** Claude Code's default profile: `primary` here, `primary@<name>` on a paired machine. */
const PRIMARY = "primary";
const DEFAULT_LOGIN = "default login";
/** Two readings of one window agree within a point when their resets agree too. */
const STALE_PCT = 1;

export interface UsageWindow {
  pct: number;
  resets_at: string | null;
}

/** A retained `volley/_system/claude-accounts/<acct>` record's payload. */
export interface UsageRecord {
  account: string;
  label?: string;
  plan?: string;
  email?: string;
  org?: string;
  five_hour: UsageWindow | null;
  weekly: UsageWindow | null;
  agents: string[];
  waves: string[];
  sampled_at: string;
}

interface Identity {
  plan?: string;
  email?: string;
  org?: string;
}

/** volleyd's `claude_accounts` answer. */
export interface ListResult {
  root: string;
  accounts: ({
    id: string;
    label: string;
    machine: string;
    /** Absent for a profile on a paired machine until a sign-in there learned its HOME. */
    dir?: string;
    signin: { state: string; url?: string };
  } & Identity)[];
  primary?: Identity;
  machines?: ({ name: string; kind?: string; claude: string } & Identity)[];
  sharing: Record<string, string>;
}

type WindowKey = "five_hour" | "weekly";

export interface Reading extends UsageWindow {
  account: string;
  machine: string;
  window: WindowKey;
  sampledAt: string;
}

export interface Member {
  account: string;
  /** `local` (volleyd's machine) or a paired machine's name. */
  machine: string;
  /** The profile's id there, or `default login` for a machine's primary. */
  label: string;
  /** `signed_in`, `signed_out`, `pending`, or a machine record's own word. */
  state: string;
  url?: string;
  waves: string[];
}

export interface AccountGroup {
  /** The normalised e-mail, else the lone account's id. */
  key: string;
  email: string | null;
  org: string | null;
  label: string;
  plan: string | null;
  fiveHour: Reading | null;
  weekly: Reading | null;
  stale: Reading[];
  members: Member[];
  /** The configured machines with no login on the account: `local` first, then each peer. */
  missing: string[];
}

interface Login extends Member, Identity {
  /** A profile label (not a machine's default login), for the group's heading. */
  profileLabel?: string;
  record?: UsageRecord;
}

const isPrimary = (id: string) => id === PRIMARY || id.startsWith(`${PRIMARY}@`);
const hostOf = (id: string) => (id.includes("@") ? id.slice(id.indexOf("@") + 1) : LOCAL_MACHINE);
const time = (l: Login) => {
  const t = Date.parse(l.record?.sampled_at ?? "");
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};
const pick = <K extends keyof Identity>(a: Identity, b: Identity | undefined, k: K) =>
  a[k] !== undefined ? { [k]: a[k] } : b?.[k] !== undefined ? { [k]: b[k] } : {};
const identity = (a: Identity, b?: Identity): Identity => ({
  ...pick(a, b, "plan"),
  ...pick(a, b, "email"),
  ...pick(a, b, "org"),
});

/** Every login volleyd knows of: registry rows, this machine's primary, paired machines' primaries. */
function logins(r: ListResult, records: UsageRecord[]): Login[] {
  const byId = new Map(records.map((x) => [x.account, x]));
  const out: Login[] = [];
  const add = (l: Omit<Login, "record" | "waves">) => {
    const record = byId.get(l.account);
    byId.delete(l.account);
    out.push({
      ...l,
      ...identity(record ?? {}, l),
      ...(record !== undefined ? { record } : {}),
      waves: record?.waves ?? [],
    });
  };
  for (const a of r.accounts) {
    const account = a.machine === LOCAL_MACHINE ? a.id : `${a.id}@${a.machine}`;
    add({
      account,
      machine: a.machine,
      label: a.id,
      profileLabel: a.label,
      state: a.signin.state,
      ...(a.signin.url !== undefined ? { url: a.signin.url } : {}),
      ...identity(a),
    });
  }
  const primary = r.primary ?? {};
  if (primary.email !== undefined || byId.has(PRIMARY))
    add({
      account: PRIMARY,
      machine: LOCAL_MACHINE,
      label: DEFAULT_LOGIN,
      state: primary.email !== undefined || primary.plan !== undefined ? "signed_in" : "unknown",
      ...identity(primary),
    });
  for (const m of r.machines ?? []) {
    if (m.kind === "supervisor") continue;
    const account = `${PRIMARY}@${m.name}`;
    if (m.claude !== "signed_in" && !byId.has(account)) continue;
    add({ account, machine: m.name, label: DEFAULT_LOGIN, state: m.claude, ...identity(m) });
  }
  // A record volleyd still retains for a login none of the above names.
  for (const rec of [...byId.values()])
    add({
      account: rec.account,
      machine: hostOf(rec.account),
      label: isPrimary(rec.account) ? DEFAULT_LOGIN : (rec.account.split("@")[0] ?? rec.account),
      ...(rec.label !== undefined && !isPrimary(rec.account) ? { profileLabel: rec.label } : {}),
      state: "signed_in",
    });
  return out;
}

function pickWindow(list: Login[], key: WindowKey): { w: Reading | null; stale: Reading[] } {
  const readings = list.flatMap((l): (Reading & { t: number })[] => {
    const w = l.record?.[key];
    if (l.record === undefined || w === null || w === undefined) return [];
    return [
      {
        ...w,
        account: l.account,
        machine: l.machine,
        window: key,
        sampledAt: l.record.sampled_at,
        t: time(l),
      },
    ];
  });
  readings.sort((a, b) => b.t - a.t || Number(b.resets_at !== null) - Number(a.resets_at !== null));
  const strip = ({ t: _t, ...r }: Reading & { t: number }): Reading => r;
  const best = readings[0];
  if (best === undefined) return { w: null, stale: [] };
  const stale = readings
    .slice(1)
    .filter((r) => Math.abs(r.pct - best.pct) > STALE_PCT || r.resets_at !== best.resets_at)
    .map(strip);
  return { w: strip(best), stale };
}

/** The machines volleyd knows of: its own, then every paired machine's record (T0's `machines[]`). */
const configured = (r: ListResult) => [
  LOCAL_MACHINE,
  ...(r.machines ?? []).filter((m) => m.kind !== "supervisor").map((m) => m.name),
];

export function groupAccounts(r: ListResult, records: UsageRecord[]): AccountGroup[] {
  const machines = configured(r);
  const byKey = new Map<string, Login[]>();
  for (const l of logins(r, records)) {
    const key = l.email !== undefined ? normalizeEmail(l.email) : l.account;
    byKey.set(key, [...(byKey.get(key) ?? []), l]);
  }
  return [...byKey].map(([key, list]) => {
    const newest = [...list].sort((a, b) => time(b) - time(a));
    const email = list.find((l) => l.email !== undefined)?.email?.trim() ?? null;
    const five = pickWindow(list, "five_hour");
    const week = pickWindow(list, "weekly");
    const members = [...list]
      .sort(
        (a, b) =>
          Number(b.machine === LOCAL_MACHINE) - Number(a.machine === LOCAL_MACHINE) ||
          (a.machine === b.machine ? 0 : a.machine.localeCompare(b.machine)),
      )
      .map(
        ({ account, machine, label, state, url, waves }): Member => ({
          account,
          machine,
          label,
          state,
          ...(url !== undefined ? { url } : {}),
          waves,
        }),
      );
    return {
      key,
      email,
      org: newest.find((l) => l.org !== undefined)?.org ?? null,
      // Never the key: for a group of default logins it is the e-mail, which must stay masked.
      label:
        newest.find((l) => l.profileLabel !== undefined)?.profileLabel ??
        (email !== null ? DEFAULT_LOGIN : key),
      plan: newest.find((l) => l.plan !== undefined)?.plan ?? null,
      fiveHour: five.w,
      weekly: week.w,
      stale: [...five.stale, ...week.stale],
      members,
      missing: machines.filter((name) => !members.some((m) => m.machine === name)),
    };
  });
}

const WINDOW_NAME: Record<WindowKey, string> = { five_hour: "5-hour", weekly: "week" };
const where = (machine: string) => (machine === LOCAL_MACHINE ? "this machine" : machine);

/** `4h 2m`, `38m`, `2d 18h`; `null` when the reset is unknown or has passed (the Desk's `resetsIn`). */
export function resetsIn(resetsAt: string | null, now: number): string | null {
  const t = resetsAt !== null ? Date.parse(resetsAt) : Number.NaN;
  if (Number.isNaN(t) || t <= now) return null;
  const m = Math.floor((t - now) / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/** `2 m`, `3 h`, `1 d`: how long ago a reading was sampled; `?` when it does not parse. */
function age(sampledAt: string, now: number): string {
  const t = Date.parse(sampledAt);
  if (Number.isNaN(t)) return "?";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 60) return `${m} m`;
  if (m < 1440) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} d`;
}

const pct = (n: number) => `${Math.round(n)}%`;

function windowText(key: WindowKey, w: Reading | null, now: number): string {
  if (w === null) return `${WINDOW_NAME[key]} —`;
  const reset = resetsIn(w.resets_at, now);
  const from = `from ${where(w.machine)} ${age(w.sampledAt, now)} ago`;
  return `${WINDOW_NAME[key]} ${pct(w.pct)} (${reset !== null ? `resets in ${reset}, ` : ""}${from})`;
}

const STATE: Record<string, string> = {
  signed_in: "signed in",
  signed_out: "signed out",
  not_signed_in: "signed out",
};

/** The groups as `volley claude list` prints them; e-mails masked unless `showEmail`. */
export function renderGroups(
  groups: AccountGroup[],
  { now, showEmail }: { now: number; showEmail: boolean },
): string {
  const rows = groups.flatMap((g) => g.members);
  const machineW = Math.max(0, ...rows.map((m) => where(m.machine).length));
  const labelW = Math.max(0, ...rows.map((m) => m.label.length));
  const stateW = Math.max(0, ...rows.map((m) => (STATE[m.state] ?? m.state).length));
  let out = "";
  for (const g of groups) {
    const head =
      g.email === null
        ? [g.key, g.plan]
        : [g.label, g.plan, g.org, showEmail ? g.email : maskEmail(g.email)];
    const note = g.email === null ? " (e-mail not reported yet)" : "";
    out += `${head.filter((x) => x !== null).join(" · ")}${note}\n`;
    out +=
      g.fiveHour === null && g.weekly === null
        ? "  5-hour —   week —   (no usage yet)\n"
        : `  ${windowText("five_hour", g.fiveHour, now)}   ${windowText("weekly", g.weekly, now)}\n`;
    for (const m of g.members) {
      const cols = [
        where(m.machine).padEnd(machineW),
        m.label.padEnd(labelW),
        (STATE[m.state] ?? m.state).padEnd(stateW),
      ];
      if (m.waves.length > 0) cols.push(`waves: ${m.waves.join(", ")}`);
      for (const s of g.stale.filter((x) => x.account === m.account))
        cols.push(`${WINDOW_NAME[s.window]} ${pct(s.pct)} ${age(s.sampledAt, now)} old (stale)`);
      out += `  ${cols.join("   ").trimEnd()}\n`;
      if (m.url !== undefined) out += `    sign in: ${m.url}\n`;
    }
    if (g.missing.length > 0) out += `  not on: ${g.missing.map(where).join(", ")}\n`;
  }
  return out;
}
