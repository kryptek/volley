import { maskEmail, normalizeEmail } from "volley-mcp/mask";

/**
 * `volley claude list` as the Desk's account cards show it: one group per Anthropic account (its
 * login e-mail), one member per machine holding it, and per usage window the freshest reading.
 * The grouping rule is the Desk's (`accountGroups` in `packages/volley-desk/src/store/claude.ts`):
 * key = the normalised e-mail, else the account id; per window the newest `sampled_at` wins, a
 * tie going to the reading with a known reset; a member's older reading that differs is stale.
 * The Fable window and its probe come from one login: the one whose probe read last (else whose
 * probe attempted last), so the figure's age is its own and a failed probe says why there is none.
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
  /** Weekly windows scoped to one model family, as the machine's usage probe last read them. */
  model_weekly?: Partial<Record<"fable" | "opus" | "sonnet" | "haiku", UsageWindow>>;
  /** The newest usage probe attempt for this login; absent until a probe has reported. */
  probe?: {
    machine: string;
    state: ProbeState;
    attempted_at: string;
    read_at?: string;
  };
  agents: string[];
  waves: string[];
  sampled_at: string;
}

/** claude-account.schema.json `probe.state`. */
export type ProbeState = "ok" | "expired" | "no_credential" | "rate_limited" | "rejected" | "error";

/** A group's usage probe: the login whose probe read last, else whose probe attempted last. */
export interface Probe {
  /** The login's machine: `local` or a paired machine's name. */
  machine: string;
  state: ProbeState;
  attemptedAt: string;
  readAt: string | null;
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
  /** The Fable weekly window of the login whose probe `probe` reports; `null`: it read none. */
  fable: UsageWindow | null;
  probe: Probe | null;
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

/** An ISO time in ms; a missing or unreadable one sorts as the oldest. */
const ms = (iso: string | undefined) => {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};
/** A sort comparator, newest first, that never answers NaN for two missing times. */
const desc = (a: number, b: number) => (a === b ? 0 : b > a ? 1 : -1);

/** The login whose probe read last, else the one whose probe attempted last. */
function probeLogin(list: Login[]): Login | undefined {
  return list
    .filter((l) => l.record?.probe !== undefined)
    .sort(
      (a, b) =>
        desc(ms(a.record?.probe?.read_at), ms(b.record?.probe?.read_at)) ||
        desc(ms(a.record?.probe?.attempted_at), ms(b.record?.probe?.attempted_at)),
    )[0];
}

function toProbe(best: Login | undefined): Probe | null {
  const p = best?.record?.probe;
  if (best === undefined || p === undefined) return null;
  return {
    machine: best.machine,
    state: p.state,
    attemptedAt: p.attempted_at,
    readAt: p.read_at ?? null,
  };
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
      // The figure comes from the login whose probe it reports, so its age is that read's.
      fable: probeLogin(list)?.record?.model_weekly?.fable ?? null,
      probe: toProbe(probeLogin(list)),
      stale: [...five.stale, ...week.stale],
      members,
      missing: machines.filter((name) => !members.some((m) => m.machine === name)),
    };
  });
}

const WINDOW_NAME: Record<WindowKey, string> = { five_hour: "5-hour", weekly: "7-day" };
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

/** `2 min`, `3 h`, `1 d`: how old a reading is; `<1 min` under a minute, `?` when it does not parse. */
function age(at: string, now: number): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "?";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 1) return "<1 min";
  if (m < 60) return `${m} min`;
  if (m < 1440) return `${Math.floor(m / 60)} h`;
  return `${Math.floor(m / 1440)} d`;
}

/** `4 min ago`, `just now`. */
const ago = (at: string, now: number) => {
  const a = age(at, now);
  return a === "<1 min" ? "just now" : `${a} ago`;
};

/** A window's percentage; one whose reset has passed counts as 0 (the Desk's `windowPct`). */
function pct(w: UsageWindow, now: number): string {
  const t = w.resets_at !== null ? Date.parse(w.resets_at) : Number.NaN;
  return `${!Number.isNaN(t) && t <= now ? 0 : Math.round(w.pct)}%`;
}

function windowText(
  name: string,
  w: UsageWindow | null,
  now: number,
  extra: string[] = [],
): string {
  if (w === null) return `${name} —`;
  const reset = resetsIn(w.resets_at, now);
  const notes = [...(reset !== null ? [`resets in ${reset}`] : []), ...extra];
  return `${name} ${pct(w, now)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
}

const PROBE_HINT: Record<Exclude<ProbeState, "ok">, (machine: string) => string> = {
  expired: () => "login expired",
  no_credential: (m) => `no credential on ${where(m)}`,
  rate_limited: () => "rate limited, retrying",
  rejected: () => "probe failed",
  error: () => "probe failed",
};

/** `Fable 12% (resets in 4d 2h, read 4 min ago)`, or why there is no figure. */
function fableText(g: AccountGroup, now: number): string {
  const p = g.probe;
  if (p === null) return "Fable — (not read yet)";
  if (p.state === "ok")
    return g.fable === null
      ? "Fable — (no Fable window reported)"
      : windowText("Fable", g.fable, now, [`read ${ago(p.readAt ?? p.attemptedAt, now)}`]);
  const why = PROBE_HINT[p.state](p.machine);
  return `Fable — (${why}${p.readAt !== null ? `, last read ${ago(p.readAt, now)}` : ""})`;
}

/** The group's three windows on one line: `5-hour 37% (resets in 2h 14m) · 7-day … · Fable …`. */
function usageLine(g: AccountGroup, now: number): string {
  return [
    windowText(WINDOW_NAME.five_hour, g.fiveHour, now),
    windowText(WINDOW_NAME.weekly, g.weekly, now),
    fableText(g, now),
  ].join(" · ");
}

/** The 5-hour or 7-day reading sampled last: where the line's two figures come from. */
const freshest = (g: AccountGroup) =>
  [g.fiveHour, g.weekly]
    .filter((r): r is Reading => r !== null)
    .sort((a, b) => desc(ms(a.sampledAt), ms(b.sampledAt)))[0];

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
    out += `  ${usageLine(g, now)}\n`;
    const from = freshest(g);
    if (from !== undefined)
      out += `  freshest: ${where(from.machine)}, ${ago(from.sampledAt, now)}\n`;
    for (const m of g.members) {
      const cols = [
        where(m.machine).padEnd(machineW),
        m.label.padEnd(labelW),
        (STATE[m.state] ?? m.state).padEnd(stateW),
      ];
      if (m.waves.length > 0) cols.push(`waves: ${m.waves.join(", ")}`);
      for (const s of g.stale.filter((x) => x.account === m.account))
        cols.push(
          `${WINDOW_NAME[s.window]} ${Math.round(s.pct)}% ${age(s.sampledAt, now)} old (stale)`,
        );
      out += `  ${cols.join("   ").trimEnd()}\n`;
      if (m.url !== undefined) out += `    sign in: ${m.url}\n`;
    }
    if (g.missing.length > 0) out += `  not on: ${g.missing.map(where).join(", ")}\n`;
  }
  return out;
}
