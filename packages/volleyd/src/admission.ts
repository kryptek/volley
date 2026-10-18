import type { Admission } from "./scheduler";
import type { AdmissionConfig } from "./types";

/** One pressure measurement. `ok: false` means the signal could not be measured (unknown). */
export interface Sample {
  ok: boolean;
  value?: number;
  /** What the parser saw (trimmed and bounded), for logs and `volleyd admission --json`. */
  raw: string;
  error?: string;
}

/**
 * Load-aware spawn admission (SPEC §4.6.7), as a pure function. The daemon samples machine
 * pressure every tick (src/pressure/*), calls `decide` with the previous state and the current
 * `admission.*` tunables, hands the verdict to the scheduler's `admit` (which adds the hard
 * ceiling and spawn budget on top) and publishes `summaryPayload` retained.
 *
 * Rules: a signal over its threshold sets `allow` to 0 (throttle starts only — nothing running
 * is ever touched); after a breach the signal must be clear for `hysteresis_samples`
 * consecutive samples before the allowance rises; a signal that cannot be measured never
 * trips (on an already tripped signal it counts toward recovery); every verdict carries one
 * reason per signal holding starts back.
 */

export const SIGNALS = [
  "memory_pressure",
  "cmux_ping",
  "containers",
  "api_overload",
  "ci_queue",
] as const;

export type SignalName = (typeof SIGNALS)[number];

export type Samples = Partial<Record<SignalName, Sample | undefined>>;

/** Per-signal hysteresis memory. */
export interface SignalMemory {
  /** Breached, and not yet clear for `hysteresis_samples` consecutive samples. */
  tripped: boolean;
  clean: number;
}

export type AdmissionState = Partial<Record<SignalName, SignalMemory>>;

/** One signal in the published summary (admission.schema.json $defs/signal). */
export interface SignalReport {
  state: "clear" | "over" | "recovering" | "unknown";
  value?: number;
  max?: number;
  clean_samples?: number;
  error?: string;
}

export interface Verdict extends Admission {
  state: AdmissionState;
  signals: Record<SignalName, SignalReport>;
}

export const emptyAdmissionState = (): AdmissionState => ({});

const LABEL: Record<SignalName, string> = {
  memory_pressure: "memory pressure",
  cmux_ping: "cmux ping",
  containers: "containers",
  api_overload: "API overload",
  ci_queue: "CI queue",
};

const MEMORY_LEVEL: Record<number, string> = { 1: "normal", 2: "warn", 4: "critical" };

function threshold(name: SignalName, cfg: AdmissionConfig): number {
  switch (name) {
    case "memory_pressure":
      return cfg.memory_pressure_max_level;
    case "cmux_ping":
      return cfg.cmux_ping_max_ms;
    case "containers":
      return cfg.container_max;
    case "api_overload":
      return cfg.api_overload_max;
    case "ci_queue":
      return cfg.ci_queue_max;
  }
}

function overReason(name: SignalName, value: number, max: number, cfg: AdmissionConfig): string {
  switch (name) {
    case "memory_pressure":
      return `memory pressure ${MEMORY_LEVEL[value] ?? "high"} (level ${value} > max ${max})`;
    case "cmux_ping":
      return `cmux ping ${value} ms > ${max} ms`;
    case "containers":
      return `${value} containers running > max ${max}`;
    case "api_overload":
      return `${value} API overload signals in ${cfg.api_overload_window_s} s > max ${max}`;
    case "ci_queue":
      return `${value} queued CI runs > max ${max}`;
  }
}

/**
 * The admission verdict for one set of samples. Each signal's value is compared with its
 * `admission.*` maximum (`value > max` is over). Returns the next hysteresis state; the input
 * state is not modified.
 */
export function decide(samples: Samples, state: AdmissionState, cfg: AdmissionConfig): Verdict {
  const next: AdmissionState = {};
  const reasons: string[] = [];
  const signals = {} as Record<SignalName, SignalReport>;
  const need = cfg.hysteresis_samples;
  for (const name of SIGNALS) {
    const sample = samples[name];
    const prev = state[name] ?? { tripped: false, clean: 0 };
    const max = threshold(name, cfg);
    const measured = sample?.ok === true && typeof sample.value === "number";
    const value = measured ? (sample.value as number) : undefined;

    if (value !== undefined && value > max) {
      next[name] = { tripped: true, clean: 0 };
      reasons.push(overReason(name, value, max, cfg));
      signals[name] = { state: "over", value, max };
      continue;
    }
    // Clear, or unknown. An unknown sample never trips a signal; on a tripped one it counts
    // toward recovery like a clear sample (an unmeasurable signal must not hold starts back
    // forever), and the signal reports `recovering` until the count is reached.
    const clean = prev.tripped ? prev.clean + 1 : 0;
    const tripped = prev.tripped && clean < need;
    next[name] = { tripped, clean: tripped ? clean : 0 };
    const error = sample?.error !== undefined ? { error: sample.error } : {};
    if (tripped) {
      const why = value === undefined ? " (last sample unknown)" : "";
      reasons.push(`recovering: ${LABEL[name]} clear for ${clean}/${need} samples${why}`);
      signals[name] = {
        state: "recovering",
        ...(value !== undefined ? { value } : {}),
        max,
        clean_samples: clean,
        ...(value === undefined ? error : {}),
      };
    } else {
      signals[name] =
        value === undefined ? { state: "unknown", ...error } : { state: "clear", value, max };
    }
  }
  return {
    allow: reasons.length > 0 ? 0 : Number.POSITIVE_INFINITY,
    reasons,
    state: next,
    signals,
  };
}

/** A verdict as JSON: `allow` is null when pressure sets no limit. */
export interface AdmissionSummary {
  sampled_at: string;
  allow: number | null;
  throttled: boolean;
  reasons: string[];
  signals: Record<SignalName, SignalReport>;
  waves?: Record<string, { allow: number | null; reasons: string[] }>;
}

export const allowJson = (allow: number): number | null => (Number.isFinite(allow) ? allow : null);

/** The retained `volley/_system/admission` payload (admission.schema.json). */
export function summaryPayload(
  v: Verdict,
  sampledAt: Date,
  waves?: Record<string, { allow: number | null; reasons: string[] }>,
): AdmissionSummary {
  return {
    sampled_at: sampledAt.toISOString(),
    allow: allowJson(v.allow),
    throttled: v.allow === 0,
    reasons: [...v.reasons],
    signals: v.signals,
    ...(waves !== undefined ? { waves } : {}),
  };
}
