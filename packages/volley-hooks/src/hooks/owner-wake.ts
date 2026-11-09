#!/usr/bin/env bun
/**
 * Stop, `async` + `asyncRewake` (SPEC §4.6.16, owner wake): the waiter that wakes the coordinator
 * session that owns a wave when the wave needs it. In agent mode, or when this session owns no
 * wave that is `running` / `releasing`, it exits 0 at once. Otherwise it takes
 * `<stateDir>/owner-wake.lock` (a live holder: exit 0, so however many Stops there are one
 * waiter runs; a dead holder's lock is taken over), holds one subscription on the waves' digests
 * (MQTT 5 retain handling 2: an old digest is never replayed, and `generated_at` before the arm
 * is dropped on MQTT 3.1.1 too) and on their states, and:
 *
 * - on the first digest of a wave it owns: writes `owner-wake.json`, prints the wake line to
 *   stderr, releases the lock and exits 2 — Claude Code wakes the session with that line;
 * - when every owned wave has left running/releasing with no digest (archived, owner changed):
 *   exits 0 after a short settle (a wave's state goes out just before its digest);
 * - at `armed_at + VOLLEY_OWNER_WAKE_MAX_S` (default 14400) with a wave still in flight: exits 2
 *   with the still-in-flight line (the template's `timeout` is above it; a hook killed at its
 *   timeout would wake nobody), and the Stop after that turn re-arms;
 * - when its session goes away (its parent process changes): exits 0, waking nothing.
 *
 * Never a credential in its output; any error is a silent exit 0.
 */
import { readFileSync } from "node:fs";
import { parseEnvelope } from "volley-mcp/envelope";
import { type HookContext, invokeHook, readStdin } from "../lib/hook-io";
import {
  IN_FLIGHT,
  WAVE_DIGEST_FILTER,
  WAVE_STATE_FILTER,
  type WakeRecord,
  type WaveStateView,
  ownedWavesInFlight,
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

const DEFAULT_MAX_S = 14_400;
const DEFAULT_SETTLE_MS = 10_000;
const PARENT_CHECK_MS = 5_000;

function positive(v: string | undefined, fallback: number): number {
  const n = v === undefined ? Number.NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function handle(ctx: HookContext): Promise<WakeOutcome> {
  if (ctx.identity.mode !== "coordinator") return { code: 0 };
  const { stateDir, agentId } = ctx.identity;
  const env = ctx.env;
  const broker = await connectBroker(ctx.identity, env, { protocolVersion: mqttVersion(env) });
  try {
    const states = await readWaveStates(broker);
    if (ownedWavesInFlight(states, agentId).length === 0) return { code: 0 };
    const lock = takeLock(stateDir, process.pid);
    if (lock === null) return { code: 0 };
    try {
      const maxS = positive(env.VOLLEY_OWNER_WAKE_MAX_S, DEFAULT_MAX_S);
      const settleMs = positive(env.VOLLEY_OWNER_WAKE_SETTLE_MS, DEFAULT_SETTLE_MS);
      const armedMs = Date.parse(lock.armed_at);
      const status = new Map<string, WaveStateView>(states.map((s) => [s.wave, s]));
      // Every wave this waiter has seen this session own: its digest wakes, even just after its
      // state left running (the state goes out before the digest).
      const mine = new Set(ownedWavesInFlight(states, agentId));
      const inFlight = () =>
        [...mine].filter((w) => {
          const s = status.get(w);
          return s !== undefined && s.ownerAgent === agentId && IN_FLIGHT.has(s.status);
        });

      return await new Promise<WakeOutcome>((resolve) => {
        let settled = false;
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        const stops: (() => Promise<void>)[] = [];
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
          void Promise.all(stops.map((s) => s().catch(() => {}))).finally(() => resolve(o));
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
            if (v.ownerAgent === agentId && IN_FLIGHT.has(v.status)) mine.add(v.wave);
            else if (v.ownerAgent !== agentId) mine.delete(v.wave);
          }
          recheck();
        };
        const onDigest = (m: { topic: string; payload: string }) => {
          const wave = waveOfTopic(m.topic);
          if (wave === null || !mine.has(wave) || m.payload === "") return;
          const p = parseEnvelope(m.payload)?.payload as Record<string, unknown> | undefined;
          if (p === undefined || p === null || typeof p !== "object") return;
          const generatedAt = typeof p.generated_at === "string" ? p.generated_at : "";
          // A retained or redelivered digest from before the arm is not a wake.
          if (!(Date.parse(generatedAt) >= armedMs)) return;
          const trigger = typeof p.trigger === "string" ? p.trigger : "digest";
          finish(
            { code: 2, line: wakeLine(wave, trigger, summaryLineOf({ ...p, wave })) },
            { wave, trigger, generated_at: generatedAt, woke_at: new Date().toISOString() },
          );
        };
        const maxTimer = setTimeout(() => {
          const waves = inFlight();
          finish(
            waves.length > 0 ? { code: 2, line: stillInFlightLine(waves, maxS) } : { code: 0 },
          );
        }, maxS * 1000);
        const parentTimer = setInterval(() => {
          if (process.ppid !== ppid || (gpid !== null && !alive(gpid))) finish({ code: 0 });
        }, PARENT_CHECK_MS);
        parentTimer.unref?.();
        Promise.all([
          broker.subscribeStream(WAVE_DIGEST_FILTER, onDigest, { retainHandling: 2 }),
          broker.subscribeStream(WAVE_STATE_FILTER, onState),
        ])
          .then((s) => {
            stops.push(...s);
            if (settled) for (const stop of s) void stop().catch(() => {});
          })
          .catch(() => finish({ code: 0 }));
        recheck();
      });
    } finally {
      releaseLock(stateDir, process.pid);
    }
  } finally {
    await broker.disconnect().catch(() => {});
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
