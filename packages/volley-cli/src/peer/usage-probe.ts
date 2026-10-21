import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, normalize } from "node:path";
import type { PeerExec } from "../commands/peer";

/**
 * The per-machine Claude usage probe (SPEC §4.6.12, the one exception of §4.6.11). For each
 * Claude Code login this machine holds, it reads the login's stored OAuth access token, in
 * memory, makes exactly one read-only request to the usage endpoint Claude Code's own `/usage`
 * calls, and keeps only percentages and reset times. It never refreshes or writes a credential,
 * never runs `claude`, and skips an expired token (Claude Code renews it on its next request).
 * The token never leaves this process: `withRedacted` covers the call and its error path, the
 * response body is never kept on a failure, and the on-disk memo (which throttles the calls, as
 * the supervisor's own doctor is a fresh process every heartbeat) holds numbers only.
 */

export const PROBE_DEFAULTS = {
  /** At most one call per login this often (the doctor may run more often). */
  usage_probe_min_interval_s: 300,
  /** 429 / 5xx / timeout back off 10 → 20 → 40 → 60 min. */
  usage_probe_backoff_min_s: 600,
  usage_probe_backoff_max_s: 3600,
  usage_probe_timeout_ms: 10_000,
  /** The most logins one machine record carries. */
  usage_probe_max_logins: 16,
} as const;

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** The model families a weekly window can be scoped to (volleyd's `FAMILY`). */
export const PROBE_FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;
export type ProbeFamily = (typeof PROBE_FAMILIES)[number];

export type ProbeState = "ok" | "expired" | "no_credential" | "rate_limited" | "rejected" | "error";

export interface UsageWindow {
  pct: number;
  resets_at: string | null;
}

export interface UsageReading {
  read_at: string;
  five_hour?: UsageWindow;
  weekly?: UsageWindow;
  model_weekly?: Partial<Record<ProbeFamily, UsageWindow>>;
}

/** One login as the machine record carries it (`machine.schema.json` `claude_logins[]`). */
export interface ClaudeLogin {
  profile: string;
  state: ProbeState;
  attempted_at: string;
  reading?: UsageReading;
}

export interface Login {
  /** `default`, or the profile's id. */
  profile: string;
  /** The profile's config dir (`~/.claude` for the default). */
  dir: string;
  isDefault: boolean;
}

/** The one request: a status and, on a 200, its JSON. Never follows a redirect. */
export type UsageFetch = (
  url: string,
  init: { headers: Record<string, string>; timeoutMs: number },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface ProbeDeps {
  exec: PeerExec;
  fetch: UsageFetch;
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  /** The installed Claude Code's version (its User-Agent); null when unknown. */
  claudeVersion: string | null;
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

// ---------------------------------------------------------------------------------------------
// Logins and their credentials
// ---------------------------------------------------------------------------------------------

/**
 * The default profile, then every `<root>/<id>` with a `.claude.json` (the root: volleyd's
 * `claudeRoot`, `$VOLLEY_CLAUDE_DIR` else `~/.volley/claude`), at most 16.
 */
export function findLogins(home: string, env: Record<string, string | undefined>): Login[] {
  const set = env.VOLLEY_CLAUDE_DIR;
  // The canonical root of volleyd's `profileDir`: Claude Code keys a profile to that exact string.
  const root = normalize(
    set !== undefined && set !== "" ? set : join(home, ".volley", "claude"),
  ).replace(/(.)\/+$/, "$1");
  let ids: string[] = [];
  try {
    ids = readdirSync(root).sort();
  } catch {}
  const profiles = ids
    .filter((id) => ID_RE.test(id) && id !== "default")
    .filter((id) => existsSync(join(root, id, ".claude.json")))
    .map((id) => ({ profile: id, dir: join(root, id), isDefault: false }));
  return [{ profile: "default", dir: join(home, ".claude"), isDefault: true }, ...profiles].slice(
    0,
    PROBE_DEFAULTS.usage_probe_max_logins,
  );
}

/** The Keychain service Claude Code keeps a login in: suffixed by its config dir's hash. */
export function keychainService(dir: string | null): string {
  if (dir === null) return "Claude Code-credentials";
  const h = createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${h}`;
}

/** Read one Keychain item's secret: the only command the probe runs. */
export const credentialArgv = (service: string, account: string) => [
  "security",
  "find-generic-password",
  "-s",
  service,
  "-a",
  account,
  "-w",
];

type Credential = { token: string; expiresAt: number } | { state: "expired" | "no_credential" };

/** Exactly `claudeAiOauth.accessToken` and `.expiresAt`; everything else is discarded unread. */
function credentialOf(text: string, now: Date): Credential {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: "no_credential" };
  }
  const oauth = obj(obj(raw)?.claudeAiOauth);
  const token = oauth?.accessToken;
  if (typeof token !== "string" || token === "") return { state: "no_credential" };
  const expiresAt = oauth?.expiresAt;
  if (typeof expiresAt !== "number" || expiresAt <= now.getTime()) return { state: "expired" };
  return { token, expiresAt };
}

/**
 * A login's token, read once: macOS's Keychain item (a miss falls back to the file Claude Code
 * writes when the Keychain refuses), Linux's `<dir>/.credentials.json`. Never printed or logged.
 */
export async function readCredential(
  deps: Pick<ProbeDeps, "exec" | "platform" | "env">,
  login: Login,
  now: Date,
): Promise<Credential> {
  if (deps.platform === "darwin") {
    const user = deps.env.USER;
    const argv = credentialArgv(
      keychainService(login.isDefault ? null : login.dir),
      user !== undefined && user !== "" ? user : "claude-code-user",
    );
    const r = await deps
      .exec(argv, { timeoutMs: PROBE_DEFAULTS.usage_probe_timeout_ms })
      .catch(() => null);
    if (r !== null && r.code === 0 && r.stdout.trim() !== "") return credentialOf(r.stdout, now);
  }
  let text: string;
  try {
    text = readFileSync(join(login.dir, ".credentials.json"), "utf-8");
  } catch {
    return { state: "no_credential" };
  }
  return credentialOf(text, now);
}

// ---------------------------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------------------------

const clampPct = (n: number) => Math.min(100, Math.max(0, n));

/** Any parseable date as ISO (sub-millisecond digits cut first), else null. */
function isoOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = Date.parse(v.replace(/(\.\d{3})\d+/, "$1"));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** `{ <key>: number, resets_at }` as a window: the value is already a percent. */
function windowOf(v: unknown, key: "utilization" | "percent"): UsageWindow | undefined {
  const w = obj(v);
  const n = w?.[key];
  if (w === null || typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return { pct: clampPct(n), resets_at: isoOf(w.resets_at) };
}

/** The family a `weekly_scoped` limit's model names, by display name or model id. */
function familyOf(scope: unknown): ProbeFamily | null {
  const model = obj(obj(scope)?.model);
  const name = model?.display_name;
  const id = model?.id;
  for (const f of PROBE_FAMILIES) {
    if (typeof name === "string" && new RegExp(`\\b${f}\\b`, "i").test(name)) return f;
    if (typeof id === "string" && new RegExp(`claude-${f}-\\d`).test(id.toLowerCase())) return f;
  }
  return null;
}

/**
 * The usage endpoint's JSON as windows. Undocumented, so tolerant: `utilization` / `percent` are
 * already percents (clamped 0–100), a family window comes from `seven_day_<family>` or a
 * `limits[]` `weekly_scoped` entry (which wins), and every other key is ignored. No `five_hour`
 * object at all is an unexpected shape.
 */
export function parseUsageResponse(
  json: unknown,
): Omit<UsageReading, "read_at"> | { state: "error" } {
  const r = obj(json);
  if (r === null || obj(r.five_hour) === null) return { state: "error" };
  const five = windowOf(r.five_hour, "utilization");
  const weekly = windowOf(r.seven_day, "utilization");
  const families: Partial<Record<ProbeFamily, UsageWindow>> = {};
  for (const f of PROBE_FAMILIES) {
    const w = windowOf(r[`seven_day_${f}`], "utilization");
    if (w !== undefined) families[f] = w;
  }
  for (const l of Array.isArray(r.limits) ? r.limits : []) {
    const entry = obj(l);
    if (entry?.kind !== "weekly_scoped") continue;
    const f = familyOf(entry.scope);
    const w = windowOf(entry, "percent");
    if (f !== null && w !== undefined) families[f] = w;
  }
  return {
    ...(five !== undefined ? { five_hour: five } : {}),
    ...(weekly !== undefined ? { weekly } : {}),
    ...(Object.keys(families).length > 0 ? { model_weekly: families } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The call, redacted
// ---------------------------------------------------------------------------------------------

/** Run `fn`; anything it throws is re-thrown with the exact token replaced by `[redacted]`. */
export async function withRedacted<T>(token: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    throw new Error(text.split(token).join("[redacted]"));
  }
}

type Outcome =
  | { state: "ok"; reading: Omit<UsageReading, "read_at"> }
  | { state: "rate_limited" | "error"; backoff: boolean }
  | { state: "rejected" };

async function call(deps: ProbeDeps, token: string): Promise<Outcome> {
  return withRedacted(token, async () => {
    const res = await deps.fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": `claude-code/${deps.claudeVersion ?? "unknown"}`,
        Accept: "application/json",
      },
      timeoutMs: PROBE_DEFAULTS.usage_probe_timeout_ms,
    });
    // A failure's body is never read: it may echo what was sent.
    if (res.status === 401 || res.status === 403) return { state: "rejected" };
    if (res.status === 429) return { state: "rate_limited", backoff: true };
    if (res.status !== 200) return { state: "error", backoff: true };
    const parsed = parseUsageResponse(await res.json().catch(() => null));
    return "state" in parsed
      ? { state: "error", backoff: false }
      : { state: "ok", reading: parsed };
  });
}

// ---------------------------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------------------------

interface Memo {
  version: 1;
  profile: string;
  attempted_at: string;
  state: ProbeState;
  backoff_until?: string;
  reading?: UsageReading;
}

const STATES: readonly ProbeState[] = [
  "ok",
  "expired",
  "no_credential",
  "rate_limited",
  "rejected",
  "error",
];

export const memoPath = (home: string, profile: string) =>
  join(home, ".volley", "claude-usage", `${profile}.json`);

const isDate = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

function readingOf(v: unknown): UsageReading | undefined {
  const r = obj(v);
  if (r === null || !isDate(r.read_at)) return undefined;
  const w = (x: unknown): UsageWindow | undefined => {
    const o = obj(x);
    return o !== null && typeof o.pct === "number" && (o.resets_at === null || isDate(o.resets_at))
      ? { pct: clampPct(o.pct), resets_at: o.resets_at as string | null }
      : undefined;
  };
  const five = w(r.five_hour);
  const weekly = w(r.weekly);
  const families: Partial<Record<ProbeFamily, UsageWindow>> = {};
  for (const f of PROBE_FAMILIES) {
    const fw = w(obj(r.model_weekly)?.[f]);
    if (fw !== undefined) families[f] = fw;
  }
  return {
    read_at: r.read_at,
    ...(five !== undefined ? { five_hour: five } : {}),
    ...(weekly !== undefined ? { weekly } : {}),
    ...(Object.keys(families).length > 0 ? { model_weekly: families } : {}),
  };
}

function readMemo(home: string, profile: string): Memo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(memoPath(home, profile), "utf-8"));
  } catch {
    return null;
  }
  const m = obj(raw);
  if (m === null || m.version !== 1 || m.profile !== profile || !isDate(m.attempted_at))
    return null;
  if (!STATES.includes(m.state as ProbeState)) return null;
  const reading = readingOf(m.reading);
  return {
    version: 1,
    profile,
    attempted_at: m.attempted_at,
    state: m.state as ProbeState,
    ...(isDate(m.backoff_until) ? { backoff_until: m.backoff_until } : {}),
    ...(reading !== undefined ? { reading } : {}),
  };
}

function writeMemo(home: string, memo: Memo): void {
  const dir = join(home, ".volley", "claude-usage");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = memoPath(home, memo.profile);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(memo)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {}
}

const loginOf = (m: Memo): ClaudeLogin => ({
  profile: m.profile,
  state: m.state,
  attempted_at: m.attempted_at,
  ...(m.reading !== undefined ? { reading: m.reading } : {}),
});

/** The next backoff: 10 min, then double the last one, at most 60 min. */
function nextBackoffS(prev: Memo | null): number {
  const min = PROBE_DEFAULTS.usage_probe_backoff_min_s;
  if (prev?.backoff_until === undefined) return min;
  const last = (Date.parse(prev.backoff_until) - Date.parse(prev.attempted_at)) / 1000;
  return Math.min(PROBE_DEFAULTS.usage_probe_backoff_max_s, Math.max(min, last * 2));
}

/**
 * One login's state now: the memo again within the interval (or before its backoff), else a
 * fresh read and at most one call. The last good reading survives every failure.
 */
export async function probeLogin(deps: ProbeDeps, login: Login, now: Date): Promise<ClaudeLogin> {
  const prev = readMemo(deps.home, login.profile);
  const t = now.getTime();
  if (
    prev !== null &&
    (t - Date.parse(prev.attempted_at) < PROBE_DEFAULTS.usage_probe_min_interval_s * 1000 ||
      (prev.backoff_until !== undefined && t < Date.parse(prev.backoff_until)))
  ) {
    return loginOf(prev);
  }
  const attempted_at = now.toISOString();
  const memo: Memo = {
    version: 1,
    profile: login.profile,
    attempted_at,
    state: "error",
    ...(prev?.reading !== undefined ? { reading: prev.reading } : {}),
  };
  const cred = await readCredential(deps, login, now);
  if ("state" in cred) {
    memo.state = cred.state;
  } else {
    const out = await call(deps, cred.token).catch(
      (): Outcome => ({ state: "error", backoff: true }),
    );
    memo.state = out.state;
    if (out.state === "ok") memo.reading = { read_at: attempted_at, ...out.reading };
    if ((out.state === "rate_limited" || out.state === "error") && out.backoff) {
      memo.backoff_until = new Date(t + nextBackoffS(prev) * 1000).toISOString();
    }
  }
  writeMemo(deps.home, memo);
  return loginOf(memo);
}

/** Every login this machine holds, probed in turn. */
export async function probeLogins(deps: ProbeDeps, now: Date): Promise<ClaudeLogin[]> {
  const out: ClaudeLogin[] = [];
  for (const login of findLogins(deps.home, deps.env)) out.push(await probeLogin(deps, login, now));
  return out;
}

/** The real request: fetch with a timeout and no redirects. */
export const realUsageFetch: UsageFetch = async (url, init) => {
  const res = await fetch(url, {
    method: "GET",
    headers: init.headers,
    redirect: "manual",
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  return { status: res.status, json: () => res.json() };
};
