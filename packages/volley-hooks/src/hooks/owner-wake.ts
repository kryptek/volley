#!/usr/bin/env bun
/**
 * Stop, `async` + `asyncRewake` (SPEC §4.6.16, owner wake): the waiter that wakes the coordinator
 * session that owns a wave when the wave needs it. In agent mode it exits 0 at once. Otherwise it
 * takes `<stateDir>/owner-wake.lock` first (a live holder: exit 0, so however many Stops there are
 * one waiter runs; a dead holder's lock, or one armed longer ago than any waiter lives, is taken
 * over), subscribes to the waves' digests, then reads their states (so a digest published while
 * it arms is seen); owning no wave, it exits 0. A live digest wakes with no clock compare; a
 * retained one only when it is new (generated at most `RETAINED_GRACE_MS` before the start, and
 * not the digest that last woke the session). Then, on the digests and the states:
 *
 * - on the first digest of a wave it owns: writes `owner-wake.json`, prints the wake line to
 *   stderr, releases the lock and exits 2 — Claude Code wakes the session with that line;
 * - when every owned wave has left running/releasing with no digest (archived, owner changed):
 *   exits 0 after a short settle (a wave's state goes out just before its digest);
 * - at `armed_at + VOLLEY_OWNER_WAKE_MAX_S` (default and cap 14400) with a wave still in flight:
 *   exits 2 with the still-in-flight line (the template's `timeout` is above it; a hook killed at its
 *   timeout would wake nobody), and the Stop after that turn re-arms;
 * - when its session goes away (its parent process changes): exits 0, waking nothing.
 *
 * Never a credential in its output; any error is a silent exit 0.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrokerMessage, VolleyBroker } from "volley-mcp/broker";
import { parseEnvelope } from "volley-mcp/envelope";
import { type HookContext, invokeHook, readStdin } from "../lib/hook-io";
import {
  IN_FLIGHT,
  MAX_WAKE_S,
  WAKE_FILE,
  WAVE_DIGEST_FILTER,
  WAVE_STATE_FILTER,
  type WakeRecord,
  type WaveStateView,
  pidAlive as alive,
  parseWaveState,
  readWaveStates,
  releaseLock,
  stillInFlightLine,
  summaryLineOf,
  takeLock,
  wakeLine,
  waveOfTopic,
  writeWakeRecord,
} from "../lib/owner-waves";
import { connectBroker, mqttVersion } from "../lib/session";

export interface WakeOutcome {
  /** 2 wakes the session with `line`; 0 wakes nothing. */
  code: 0 | 2;
  line?: string;
}

const DEFAULT_SETTLE_MS = 10_000;
const PARENT_CHECK_MS = 5_000;
/**
 * A retained digest generated this long before the waiter started still wakes: it went out
 * between the turn's end and the subscription (the digest that last woke the session excepted).
 */
const RETAINED_GRACE_MS = 30_000;

function positive(v: string | undefined, fallback: number): number {
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * `VOLLEY_OWNER_WAKE_MAX_S`, clamped to `MAX_WAKE_S`: above the template's `timeout` (14700)
 * Claude Code kills the waiter and nobody is woken, and far above it `setTimeout` overflows.
 */
export function maxWakeSeconds(env: NodeJS.ProcessEnv): number {
  return Math.min(positive(env.VOLLEY_OWNER_WAKE_MAX_S, MAX_WAKE_S), MAX_WAKE_S);
}

/** The parent's parent on Linux (`/proc`), else null: a session ending can leave a shell between. */
function grandparent(ppid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${ppid}/stat`, "utf-8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const n = Number(fields[1]);
    return Number.isSafeInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}

/** The `generated_at` of the digest that last woke this session, per wave. */
function lastWokenBy(stateDir: string): { wave: string; generated_at: string } | null {
  try {
    const r = JSON.parse(readFileSync(join(stateDir, WAKE_FILE), "utf-8")) as WakeRecord;
    return typeof r.wave === "string" && typeof r.generated_at === "string" ? r : null;
  } catch {
    return null;
  }
}

export async function handle(ctx: HookContext): Promise<WakeOutcome> {
  if (ctx.identity.mode !== "coordinator") return { code: 0 };
  const { stateDir, agentId } = ctx.identity;
  const env = ctx.env;
  const startedMs = Date.now();
  // The lock first: a parallel Stop's 2 s wait for it is not spent on this waiter's connect and
  // read, and a second waiter exits before opening a socket.
  const lock = takeLock(stateDir, process.pid);
  if (lock === null) return { code: 0 };
  try {
    const broker = await connectBroker(ctx.identity, env, { protocolVersion: mqttVersion(env) });
    try {
      return await watch(broker, stateDir, agentId, env, startedMs);
    } finally {
      await broker.disconnect().catch(() => {});
    }
  } finally {
    releaseLock(stateDir, process.pid);
  }
}

async function watch(
  broker: VolleyBroker,
  stateDir: string,
  agentId: string,
  env: NodeJS.ProcessEnv,
  startedMs: number,
): Promise<WakeOutcome> {
  const maxS = maxWakeSeconds(env);
  const settleMs = positive(env.VOLLEY_OWNER_WAKE_SETTLE_MS, DEFAULT_SETTLE_MS);
  const last = lastWokenBy(stateDir);
  const stops: (() => Promise<void>)[] = [];
  // The digests are subscribed before the states are read, so a digest that goes out meanwhile is
  // seen: held here until the states are known.
  let onDigest: ((m: BrokerMessage) => void) | null = null;
  const early: BrokerMessage[] = [];
  try {
    stops.push(
      await broker.subscribeStream(WAVE_DIGEST_FILTER, (m) => {
        if (onDigest === null) early.push(m);
        else onDigest(m);
      }),
    );
    const states = await readWaveStates(broker);
    const status = new Map<string, WaveStateView>(states.map((s) => [s.wave, s]));
    // Every wave this session owns: its digest wakes, even just after its state left running
    // (the state goes out before the digest).
    const mine = new Set(states.filter((s) => s.ownerAgent === agentId).map((s) => s.wave));
    const inFlight = () =>
      [...mine].filter((w) => {
        const s = status.get(w);
        return s !== undefined && s.ownerAgent === agentId && IN_FLIGHT.has(s.status);
      });
    // A digest replayed retained wakes only when it is new to this session; a live one always
    // does (no clock compare: volleyd's clock and this machine's may differ).
    const wakes = (m: BrokerMessage, wave: string, generatedAt: string): boolean => {
      if (m.retain !== true) return true;
      if (last !== null && last.wave === wave && last.generated_at === generatedAt) return false;
      return Date.parse(generatedAt) >= startedMs - RETAINED_GRACE_MS;
    };

    return await new Promise<WakeOutcome>((resolve) => {
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const ppid = process.ppid;
      const gpid = grandparent(ppid);
      const finish = (o: WakeOutcome, record?: WakeRecord) => {
        if (settled) return;
        settled = true;
        clearTimeout(maxTimer);
        clearTimeout(settleTimer);
        clearInterval(parentTimer);
        if (record !== undefined) {
          try {
            writeWakeRecord(stateDir, record);
          } catch {
            // the wake line still reaches the session
          }
        }
        resolve(o);
      };
      const recheck = () => {
        if (inFlight().length > 0) {
          clearTimeout(settleTimer);
          settleTimer = undefined;
        } else if (settleTimer === undefined) {
          settleTimer = setTimeout(() => finish({ code: 0 }), settleMs);
        }
      };
      const onState = (m: { topic: string; payload: string }) => {
        const wave = waveOfTopic(m.topic);
        if (wave === null) return;
        const v = parseWaveState(m.topic, m.payload);
        if (v === null) status.delete(wave);
        else {
          status.set(v.wave, v);
          if (v.ownerAgent === agentId) mine.add(v.wave);
          else mine.delete(v.wave);
        }
        recheck();
      };
      onDigest = (m: BrokerMessage) => {
        const wave = waveOfTopic(m.topic);
        if (wave === null || !mine.has(wave) || m.payload === "") return;
        const p = parseEnvelope(m.payload)?.payload as Record<string, unknown> | undefined;
        if (p === undefined || p === null || typeof p !== "object") return;
        const generatedAt = typeof p.generated_at === "string" ? p.generated_at : "";
        if (!wakes(m, wave, generatedAt)) return;
        const trigger = typeof p.trigger === "string" ? p.trigger : "digest";
        finish(
          { code: 2, line: wakeLine(wave, trigger, summaryLineOf({ ...p, wave })) },
          { wave, trigger, generated_at: generatedAt, woke_at: new Date().toISOString() },
        );
      };
      const maxTimer = setTimeout(() => {
        const waves = inFlight();
        finish(waves.length > 0 ? { code: 2, line: stillInFlightLine(waves, maxS) } : { code: 0 });
      }, maxS * 1000);
      const parentTimer = setInterval(() => {
        if (process.ppid !== ppid || (gpid !== null && !alive(gpid))) finish({ code: 0 });
      }, PARENT_CHECK_MS);
      parentTimer.unref?.();
      for (const m of early.splice(0)) onDigest(m);
      if (settled) return;
      if (mine.size === 0) {
        finish({ code: 0 });
        return;
      }
      broker
        .subscribeStream(WAVE_STATE_FILTER, onState)
        .then((stop) => {
          stops.push(stop);
          if (settled) void stop().catch(() => {});
        })
        .catch(() => finish({ code: 0 }));
      recheck();
    });
  } finally {
    await Promise.all(stops.map((s) => s().catch(() => {})));
  }
}

if (import.meta.main) {
  let outcome: WakeOutcome = { code: 0 };
  try {
    await invokeHook(
      "Stop",
      async (ctx) => {
        outcome = await handle(ctx);
        return null;
      },
      await readStdin(),
      process.env,
    );
  } catch (e) {
    // The sync Stop hook reports a refused login; the waiter only ever wakes or stays quiet.
    if (process.env.VOLLEY_HOOKS_DEBUG === "1")
      process.stderr.write(`volley-hooks owner-wake: ${e}\n`);
  }
  if (outcome.code === 2 && outcome.line !== undefined)
    process.stderr.write(`${outcome.line}\n`, () => process.exit(2));
  else process.exit(0);
}
