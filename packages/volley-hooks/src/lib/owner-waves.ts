import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VolleyBroker } from "volley-mcp/broker";
import { parseEnvelope } from "volley-mcp/envelope";
import { writeFileAtomic } from "./seq";

/**
 * Owner wake (SPEC §4.6.16): which waves this coordinator session owns while they run, the lock
 * its one waiter holds, and the line that wakes it. Pure helpers plus one retained read; the
 * waiter is `hooks/owner-wake.ts`, the backstop `hooks/stop.ts`.
 */

export const WAVE_STATE_FILTER = "volley/_waves/+/state";
export const WAVE_DIGEST_FILTER = "volley/_waves/+/digest";

/** The wave statuses an owner wake waits on: the wave still has work that ends in a digest. */
export const IN_FLIGHT = new Set(["running", "releasing"]);

/** What the hooks read from a retained wave state. */
export interface WaveStateView {
  wave: string;
  status: string;
  /** `coordinator.agent_id`: the agent the owner binds to (or the owner itself). */
  ownerAgent: string | null;
}

/** The wave of a `volley/_waves/<wave>/<leaf>` topic, or null. */
export function waveOfTopic(topic: string): string | null {
  const parts = topic.split("/");
  return parts.length === 4 && parts[0] === "volley" && parts[1] === "_waves"
    ? (parts[2] ?? null)
    : null;
}

/** A retained wave state's view, or null (cleared, malformed, not a state). */
export function parseWaveState(topic: string, raw: string): WaveStateView | null {
  const wave = waveOfTopic(topic);
  if (wave === null || raw === "") return null;
  const p = parseEnvelope(raw)?.payload as Record<string, unknown> | undefined;
  if (p === undefined || p === null || typeof p !== "object") return null;
  if (typeof p.status !== "string") return null;
  const coordinator = p.coordinator as { agent_id?: unknown } | undefined;
  const ownerAgent =
    typeof coordinator?.agent_id === "string"
      ? coordinator.agent_id
      : typeof p.owner === "string"
        ? p.owner
        : null;
  return { wave: typeof p.wave === "string" ? p.wave : wave, status: p.status, ownerAgent };
}

/** The waves `agentId` owns whose status is running or releasing, sorted. */
export function ownedWavesInFlight(states: readonly WaveStateView[], agentId: string): string[] {
  return states
    .filter((s) => s.ownerAgent === agentId && IN_FLIGHT.has(s.status))
    .map((s) => s.wave)
    .sort();
}

/** Every retained wave state, read until the topic goes quiet (one read, as the registry lookup). */
export async function readWaveStates(broker: VolleyBroker): Promise<WaveStateView[]> {
  const records = await broker.drainQueued(WAVE_STATE_FILTER, { idleMs: 150, maxWaitMs: 3000 });
  const latest = new Map<string, WaveStateView>();
  for (const r of records) {
    const v = parseWaveState(r.topic, r.payload);
    if (v !== null) latest.set(v.wave, v);
  }
  return [...latest.values()];
}

const VERB: Record<string, string> = {
  wave_complete: "complete",
  release_go: "ready to release",
  escalation: "needs you",
  stopped: "stopped",
};

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const len = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * The digest's one-line summary, as volleyd's `summaryLine` writes it (`w1 complete: 27 shipped,
 * 3 flakes fixed, 1 waiting for you (release_go)`), from an untrusted payload: a missing counter
 * is 0.
 */
export function summaryLineOf(d: Record<string, unknown>): string {
  const auto = (typeof d.auto === "object" && d.auto !== null ? d.auto : {}) as Record<
    string,
    unknown
  >;
  const parts = [`${len(d.shipped)} shipped`];
  const flakes = len(auto.flakes_fixed);
  if (flakes > 0) parts.push(`${count(flakes, "flake", "flakes")} fixed`);
  const conflicts = num(auto.conflicts_resolved);
  if (conflicts > 0) parts.push(`${count(conflicts, "conflict", "conflicts")} resolved`);
  const retries = num(auto.retries);
  if (retries > 0) parts.push(count(retries, "retry", "retries"));
  const c = (typeof auto.churn === "object" && auto.churn !== null ? auto.churn : {}) as Record<
    string,
    unknown
  >;
  const churn = num(c.branch_updates) + num(c.rereviews) + num(c.retries) + num(c.trains);
  if (churn > 0) parts.push(`${count(churn, "churn spawn", "churn spawns")} (no budget)`);
  const answered = num(auto.decisions_resolved);
  if (answered > 0) parts.push(`${count(answered, "decision", "decisions")} answered`);
  if (len(d.failures) > 0) parts.push(`${len(d.failures)} failed`);
  const waiting = Array.isArray(d.waiting) ? (d.waiting as { kind?: unknown }[]) : [];
  if (waiting.length > 0) {
    const kinds = [...new Set(waiting.map((w) => String(w?.kind)))].join(", ");
    parts.push(`${waiting.length} waiting for you (${kinds})`);
  }
  if (len(d.held) > 0) parts.push(`${len(d.held)} held`);
  const trigger = typeof d.trigger === "string" ? d.trigger : "";
  return `${String(d.wave)} ${VERB[trigger] ?? trigger}: ${parts.join(", ")}`;
}

/** The system reminder the woken turn begins with. */
export function wakeLine(wave: string, trigger: string, summary: string): string {
  return `[volley owner-wake] wave ${wave}: ${trigger} — ${summary}. Run \`volleyd digest ${wave}\` (and \`volleyd inbox\` when it says waiting for you) and carry the wave on; the next Stop re-arms this wake.`;
}

/** `4 h`, `90 s`: how long the fallback wake waited. */
export function durationText(seconds: number): string {
  return seconds % 3600 === 0 ? `${seconds / 3600} h` : `${seconds} s`;
}

/** The fallback wake's line (D6): the waiter's own deadline passed with the wave still running. */
export function stillInFlightLine(waves: readonly string[], seconds: number): string {
  const which = waves.length === 1 ? `wave ${waves[0]}` : `waves ${waves.join(", ")}`;
  return `[volley owner-wake] ${which} still in flight after ${durationText(seconds)}; re-armed. Run \`volleyd status\` if you want to look; otherwise end your turn and the next Stop re-arms this wake.`;
}

/** The fallback command the Stop block names: one `volley sub` on the wave's digest. */
export function fallbackCommand(waves: readonly string[]): string {
  const pattern = waves.length === 1 ? `volley/_waves/${waves[0]}/digest` : WAVE_DIGEST_FILTER;
  return `volley sub --pattern "${pattern}" --max-messages 1 --timeout 14400`;
}

/** Where the Stop block points for making the wake automatic. */
export const HOOKS_INSTALL_URL =
  "https://github.com/kryptek/volley/blob/main/packages/volley-hooks/README.md#install";

/** The Stop block's `reason` (D5): one line, naming the wave and the command that arms a wait. */
export function blockReason(waves: readonly string[]): string {
  const which = waves.length === 1 ? `wave ${waves[0]} is` : `waves ${waves.join(", ")} are`;
  return `${which} in flight and nothing will wake this session when it ends. Run in the background now: ${fallbackCommand(waves)} (then end your turn); install the Volley hooks to make this automatic: ${HOOKS_INSTALL_URL}`;
}

// ---- the waiter's lock ----------------------------------------------------------------------

export const LOCK_FILE = "owner-wake.lock";
/** The waiter's longest wait (`VOLLEY_OWNER_WAKE_MAX_S` is clamped to it; template timeout 14700). */
export const MAX_WAKE_S = 14_400;
/** A lock armed longer ago than any waiter lives is stale whatever its pid (a recycled pid). */
const LOCK_MAX_AGE_MS = (MAX_WAKE_S + 600) * 1000;
export const WAKE_FILE = "owner-wake.json";

export interface WakeLock {
  pid: number;
  armed_at: string;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the pid exists under another user.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The lock in `stateDir` when its holder is alive and it was armed less than `MAX_WAKE_S` + 10
 * min ago, else null (none, unreadable or stale).
 */
export function liveLock(stateDir: string): WakeLock | null {
  try {
    const l = JSON.parse(readFileSync(join(stateDir, LOCK_FILE), "utf-8")) as WakeLock;
    const age = Date.now() - Date.parse(l.armed_at);
    if (!(age < LOCK_MAX_AGE_MS)) return null;
    return Number.isSafeInteger(l.pid) && l.pid > 0 && pidAlive(l.pid) ? l : null;
  } catch {
    return null;
  }
}

/**
 * Take the waiter's lock for `pid`: null when a live holder has it. A lock whose pid is dead
 * (its session ended) is taken over.
 */
export function takeLock(stateDir: string, pid: number, now: Date = new Date()): WakeLock | null {
  const path = join(stateDir, LOCK_FILE);
  const lock: WakeLock = { pid, armed_at: now.toISOString() };
  mkdirSync(stateDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify(lock)}\n`, { flag: "wx" });
      return lock;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (liveLock(stateDir) !== null) return null;
      rmSync(path, { force: true });
    }
  }
  return null;
}

/** Release the lock when `pid` still holds it. */
export function releaseLock(stateDir: string, pid: number): void {
  const path = join(stateDir, LOCK_FILE);
  try {
    if (!existsSync(path)) return;
    const l = JSON.parse(readFileSync(path, "utf-8")) as WakeLock;
    if (l.pid === pid) rmSync(path, { force: true });
  } catch {
    rmSync(path, { force: true });
  }
}

/** `<stateDir>/owner-wake.json`: the last wake (what woke the session, and when). */
export interface WakeRecord {
  wave: string;
  trigger: string;
  generated_at: string;
  woke_at: string;
}

export function writeWakeRecord(stateDir: string, record: WakeRecord): void {
  writeFileAtomic(join(stateDir, WAKE_FILE), `${JSON.stringify(record)}\n`);
}

/** Wait up to `ms` for a live lock (the two Stop hooks run in parallel). */
export async function awaitLiveLock(stateDir: string, ms: number, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (liveLock(stateDir) !== null) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
