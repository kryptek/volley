import type { Sample } from "../admission";

/**
 * API overload / credit signals, observed from the hooks' progress events (volley-hooks):
 * `awaiting_input` with a `quota_auto_resume_*` notification, or `idle` whose text says the
 * provider is overloaded or a rate / usage limit was hit. The daemon timestamps each one as it
 * arrives; `countApiSignals` turns the log into a sample over the configured window.
 */
const OVERLOAD_TEXT = /overloaded|rate limit|usage limit/i;

export function isApiSignal(env: { type: string; payload: unknown }): boolean {
  const p = (typeof env.payload === "object" && env.payload !== null ? env.payload : {}) as {
    notification_type?: unknown;
    text?: unknown;
  };
  if (env.type === "awaiting_input") {
    return (
      typeof p.notification_type === "string" && p.notification_type.startsWith("quota_auto_resume")
    );
  }
  return env.type === "idle" && typeof p.text === "string" && OVERLOAD_TEXT.test(p.text);
}

/** How many signal timestamps (ms) fall within the last `windowS` seconds. */
export function countApiSignals(times: readonly number[], nowMs: number, windowS: number): Sample {
  const from = nowMs - windowS * 1000;
  const n = times.filter((t) => t > from && t <= nowMs).length;
  return { ok: true, value: n, raw: `${n} in the last ${windowS} s` };
}
