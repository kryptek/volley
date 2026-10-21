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
  /** The reason each signal holding starts back gave (the same lines as `reasons`). */
  reasonOf: Partial<Record<SignalName, string>>;
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
  const reasonOf: Partial<Record<SignalName, string>> = {};
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
      reasonOf[name] = overReason(name, value, max, cfg);
      reasons.push(reasonOf[name]);
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
      reasonOf[name] = `recovering: ${LABEL[name]} clear for ${clean}/${need} samples${why}`;
      reasons.push(reasonOf[name]);
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
    reasonOf,
  };
}

// ---------------------------------------------------------------------------------------------
// Per-host admission (SPEC §4.6.15): a task placed on a peer is admitted by that machine's own
// signals, read from its record at each heartbeat with the same hysteresis, plus the global
// signals; the supervisor's own machine signals (memory pressure, cmux ping, containers) are
// local-only and do not hold it.
// ---------------------------------------------------------------------------------------------

/** Signals that hold starts on every machine: they measure shared limits, not one machine. */
export const GLOBAL_SIGNALS: readonly SignalName[] = ["api_overload", "ci_queue"];

export const HOST_SIGNALS = ["memory_available", "load_per_core"] as const;
export type HostSignalName = (typeof HOST_SIGNALS)[number];
export type HostSamples = Partial<Record<HostSignalName, Sample | undefined>>;
export type HostAdmissionState = Partial<Record<HostSignalName, SignalMemory>>;

/** The per-host thresholds: placement's eligibility minimums, admission's hysteresis. */
export interface HostThresholds {
  mem_available_min_pct: number;
  load_per_core_max: number;
  hysteresis_samples: number;
}

export interface HostVerdict extends Admission {
  state: HostAdmissionState;
  /**
   * The hysteresis reasons alone (`recovering: …`), without the host's name: what placement's
   * filter adds to its own load and memory checks, which already cover a signal that is over.
   */
  recovering: string[];
}

const HOST_LABEL: Record<HostSignalName, string> = {
  memory_available: "memory available",
  load_per_core: "load per core",
};

/** A machine record's signals (unknown when the record does not carry them). */
export function hostSamples(r: {
  cores: number;
  load: [number, number, number];
  memory?: { available_pct: number };
}): HostSamples {
  const mem = r.memory?.available_pct;
  // The higher of the 1- and 5-minute loads, as placement's overload filter reads it: a heartbeat
  // whose 1-minute load dipped while the 5-minute one is still over is not a clean sample.
  const perCore = r.cores > 0 ? Math.max(r.load[0], r.load[1]) / r.cores : undefined;
  return {
    memory_available:
      mem !== undefined
        ? { ok: true, value: mem, raw: String(mem) }
        : { ok: false, raw: "", error: "no memory figure in the machine record" },
    load_per_core:
      perCore !== undefined
        ? { ok: true, value: perCore, raw: String(perCore) }
        : { ok: false, raw: "", error: "no cores in the machine record" },
  };
}

/**
 * `host`'s verdict for one heartbeat: memory available under its minimum, or load per core over
 * its maximum, holds starts there; after a breach both must be clear for `hysteresis_samples`
 * heartbeats. Every reason names the host. The input state is not modified.
 */
export function decideHost(
  host: string,
  samples: HostSamples,
  state: HostAdmissionState,
  t: HostThresholds,
): HostVerdict {
  const next: HostAdmissionState = {};
  const reasons: string[] = [];
  const recovering: string[] = [];
  for (const name of HOST_SIGNALS) {
    const sample = samples[name];
    const prev = state[name] ?? { tripped: false, clean: 0 };
    const value = sample?.ok === true ? sample.value : undefined;
    const over =
      value !== undefined &&
      (name === "memory_available" ? value < t.mem_available_min_pct : value > t.load_per_core_max);
    if (over) {
      next[name] = { tripped: true, clean: 0 };
      reasons.push(
        name === "memory_available"
          ? `${host}: memory available ${Math.round(value)}% (min ${t.mem_available_min_pct}%)`
          : `${host}: load ${value.toFixed(2)} per core (max ${t.load_per_core_max})`,
      );
      continue;
    }
    const clean = prev.tripped ? prev.clean + 1 : 0;
    const tripped = prev.tripped && clean < t.hysteresis_samples;
    next[name] = { tripped, clean: tripped ? clean : 0 };
    if (tripped) {
      const why = `recovering: ${HOST_LABEL[name]} clear for ${clean}/${t.hysteresis_samples} samples`;
      recovering.push(why);
      reasons.push(`${host}: ${why}`);
    }
  }
  return {
    allow: reasons.length > 0 ? 0 : Number.POSITIVE_INFINITY,
    reasons,
    state: next,
    recovering,
  };
}

/**
 * `host`'s verdict now, from its last heartbeats (oldest first) under thresholds `t`: `decideHost`
 * folded over them from a clear state. Only the last `hysteresis_samples` heartbeats can hold
 * starts back, so a history that long gives the exact verdict, and the thresholds are the caller's
 * at the moment it asks (a wave's own `placement` overrides, a `config_set` that just landed).
 */
export function foldHost(host: string, history: HostSamples[], t: HostThresholds): HostVerdict {
  let v: HostVerdict = {
    allow: Number.POSITIVE_INFINITY,
    reasons: [],
    state: {},
    recovering: [],
  };
  for (const samples of history.slice(-t.hysteresis_samples)) {
    v = decideHost(host, samples, v.state, t);
  }
  return v;
}

/**
 * The reasons a verdict's own-machine signals give (memory pressure, cmux ping, containers): what
 * keeps a placement off the supervisor's machine. A verdict without per-signal reasons gives none
 * (it applies whole, through `forHost`).
 */
export function machineReasons(
  v: Admission & { reasonOf?: Partial<Record<SignalName, string>> },
): string[] {
  const of = v.reasonOf;
  if (of === undefined) return [];
  return SIGNALS.filter((n) => !GLOBAL_SIGNALS.includes(n)).flatMap((n) => {
    const r = of[n];
    return r !== undefined ? [r] : [];
  });
}

/**
 * The admission of a task placed on a peer: the global signals of `wave` (its wave's verdict)
 * plus `host`'s own. A verdict without per-signal reasons (injected, or before the first sample)
 * applies whole.
 */
export function forHost(
  wave: Admission & { reasonOf?: Partial<Record<SignalName, string>> },
  host: Admission,
): Admission {
  const global =
    wave.reasonOf === undefined
      ? wave.reasons
      : GLOBAL_SIGNALS.flatMap((n) => (wave.reasonOf?.[n] !== undefined ? [wave.reasonOf[n]] : []));
  const reasons = [...global, ...host.reasons];
  const allow =
    wave.reasonOf === undefined
      ? Math.min(wave.allow, host.allow)
      : reasons.length > 0
        ? 0
        : host.allow;
  return { allow, reasons };
}

/** A verdict as JSON: `allow` is null when pressure sets no limit. */
export interface AdmissionSummary {
  sampled_at: string;
  allow: number | null;
  throttled: boolean;
  reasons: string[];
  signals: Record<SignalName, SignalReport>;
  waves?: Record<string, { allow: number | null; reasons: string[] }>;
  /** What the hard ceiling counts now (absent from a supervisor that predates it). */
  ceiling?: CeilingView;
}

/**
 * The agents the hard ceiling counts: `live` in all (supervised, starting, and admitted tasks
 * queued for their implementer), `launching` the part not supervised yet, and `by_wave` each
 * wave's share (a wave with none is absent).
 */
export interface CeilingCount {
  live: number;
  launching: number;
  by_wave: Record<string, number>;
}

/** `CeilingCount` with the global `hard_ceiling` it is held to. */
export interface CeilingView extends CeilingCount {
  max: number;
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
