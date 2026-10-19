import { LOCAL_HOST } from "./fleet-name";
import type { MachineRecord } from "./machines";
import type { PlacementConfig, Wave, WaveTask } from "./types";

/**
 * Placement (SPEC §4.6.15), as a pure function: where a task that does not name its host starts.
 * It runs once, when the scheduler admits the task: filter the eligible machines, rank them by
 * weighted headroom, and return every candidate with the one-line `line` the Desk shows ("why
 * here"), so no client re-derives anything. Nothing running is ever moved.
 *
 * The daemon assembles the `Snapshot` from what it already knows (F2's readiness inputs, F4's
 * per-machine lease counts, the usage meter, each host's own admission verdict) and journals the
 * result as `task_placed`. Memory is the record's `memory.available_pct`, one definition on every
 * machine (Linux: MemAvailable; macOS: vm_stat's free + inactive + speculative + purgeable pages),
 * as the machine reports it; nothing here re-samples it.
 *
 * `machineIneligible` is the one machine filter: the published readiness verdict's `eligible` /
 * `ineligible_reason` (readiness.ts) and placement both read it, so the two never disagree.
 */

/** A task's `host:` (or a `placement: auto` wave's default) that asks the supervisor to place it. */
export const AUTO_HOST = "auto";

/** What placement knows about one candidate machine. */
export interface MachineView {
  name: string;
  /** The supervisor's own machine (its `fleet.local_name`). */
  local: boolean;
  /** Its last record (load, cores, memory, disk); undefined: none, so it is no candidate. */
  record?: MachineRecord;
  /** Its readiness verdict (readiness.ts): `ready`, and its blockers when not. */
  ready: boolean;
  reasons: string[];
  drain: boolean;
  max_agents: number;
  /**
   * Live supervised agents on it, plus placements reserved for it that have not spawned. The
   * supervisor's own machine counts every one, wherever it runs (`hard_ceiling` caps the total).
   */
  agents: number;
  /** Each lease pool that sets `per_machine`: its holders' leases on this machine. */
  heavy: Record<string, { held: number; per_machine: number }>;
  /** Its account's 5-hour usage percentage; null: unknown. */
  usage_pct: number | null;
  /**
   * What its own admission holds back beyond the load and memory filter below: on the supervisor's
   * own machine its local signals (memory pressure, cmux ping, containers), on a peer its per-host
   * hysteresis (`recovering: …`). Without the machine's name (the caller adds it). Empty: open.
   */
  held: string[];
}

export interface Snapshot {
  machines: MachineView[];
  /** Placements made since `machines` was read (this tick), per machine name. */
  reservations: Record<string, number>;
  /** Heavy placements among them: per machine name, per lease pool, the slots they will take. */
  heavyReserved?: Record<string, Record<string, number>>;
}

/** The machine filter's options: placement's thresholds and the usage warning level. */
export type FilterOptions = Pick<PlaceOptions, "placement" | "warn_at_pct">;

export interface PlaceOptions {
  placement: Pick<
    PlacementConfig,
    "load_per_core_max" | "mem_available_min_pct" | "disk_free_min_gb" | "weights"
  >;
  /** `claude.warn_at_pct`: usage at or over it takes no new placement. */
  warn_at_pct: number;
  /** The supervisor's own machine name (`local` in a wave file). */
  localName: string;
}

/** One `tasks[].placement.candidates[]` entry (wave-state.schema.json). */
export interface PlacementCandidate {
  host: string;
  /** null: not eligible, or not scored. */
  score: number | null;
  line: string;
}

export interface Placement {
  /** The machine's name: the supervisor's own under its `fleet.local_name`. */
  host: string;
  /** The supervisor's own machine (its agents' `host:` is `local`). */
  local: boolean;
  by: "auto" | "wave_file";
  score: number | null;
  candidates: PlacementCandidate[];
}

/** No machine is eligible: the task stays queued with `why`, and is placed again next tick. */
export interface Unplaced {
  host: null;
  why: string;
  candidates: PlacementCandidate[];
}

/** Bounds of wave-state.schema.json `placement` (`candidates` maxItems, `line` maxLength). */
const CANDIDATES_MAX = 64;
const LINE_MAX = 200;

/** Whether the task's host is the supervisor's choice (`host: auto`, or unpinned under `placement: auto`). */
export const needsPlacement = (t: Pick<WaveTask, "host">): boolean => t.host === AUTO_HOST;

const line = (s: string) => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s);
const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${Math.round(n)}%`;

/**
 * A copy of `snap` with one more placement reserved on `host`; a heavy task (of `wave`) also
 * reserves one slot in each of the wave's heavy pools there, so the next heavy task does not stack.
 */
export function reserve(snap: Snapshot, host: string, task?: WaveTask, wave?: Wave): Snapshot {
  const heavy = { ...(snap.heavyReserved ?? {}) };
  if (task?.heavy === true && wave !== undefined) {
    const on = { ...(heavy[host] ?? {}) };
    for (const pool of wave.heavy_pools) on[pool] = (on[pool] ?? 0) + 1;
    heavy[host] = on;
  }
  return {
    machines: snap.machines,
    reservations: { ...snap.reservations, [host]: (snap.reservations[host] ?? 0) + 1 },
    heavyReserved: heavy,
  };
}

/** Agents counted against `m`'s cap: its own, plus reservations (every one on the own machine). */
function placed(m: MachineView, snap: Snapshot): number {
  const reserved = m.local
    ? Object.values(snap.reservations).reduce((a, b) => a + b, 0)
    : (snap.reservations[m.name] ?? 0);
  return m.agents + reserved;
}

/**
 * The heavy pools the task needs a per-machine slot in, as `[pool, held, per_machine]`: `held`
 * counts the leases held there plus this tick's heavy reservations.
 */
function heavySlots(
  m: MachineView,
  task: WaveTask,
  wave: Wave,
  snap: Snapshot,
): [string, number, number][] {
  if (task.heavy !== true) return [];
  const reserved = snap.heavyReserved?.[m.name] ?? {};
  return wave.heavy_pools.flatMap((pool) => {
    const h = m.heavy[pool];
    return h === undefined
      ? []
      : [[pool, h.held + (reserved[pool] ?? 0), h.per_machine] as [string, number, number]];
  });
}

/**
 * Every reason `m` may take no new task now, whatever the task, in the order a person fixes them:
 * readiness, drain, `max_agents`, its own admission, load per core, memory, disk and usage. The
 * readiness verdict's `eligible` is this list being empty, its `ineligible_reason` the first entry.
 */
export function machineIneligible(m: MachineView, snap: Snapshot, o: FilterOptions): string[] {
  const out: string[] = [];
  // Every readiness blocker counts (a machine that needs several fixes is farther away); the
  // line names the first.
  if (!m.ready) {
    const [first = "not ready", ...more] = m.reasons;
    out.push(`${first} (readiness)`, ...more.map((reason) => `${reason} (readiness)`));
  }
  if (m.drain) out.push("draining");
  const n = placed(m, snap);
  if (n >= m.max_agents) out.push(`${n}/${m.max_agents} agents (max_agents)`);
  out.push(...m.held);
  const r = m.record;
  if (r !== undefined) {
    const perCore = r.load[0] / r.cores;
    if (perCore > o.placement.load_per_core_max) {
      out.push(
        `load ${r.load[0].toFixed(1)} on ${r.cores} cores (${perCore.toFixed(2)} per core > max ${o.placement.load_per_core_max})`,
      );
    }
    if (r.memory !== undefined && r.memory.available_pct < o.placement.mem_available_min_pct) {
      out.push(
        `memory available ${pct(r.memory.available_pct)} (min ${o.placement.mem_available_min_pct}%)`,
      );
    }
    if (r.disk !== undefined && r.disk.free_gb < o.placement.disk_free_min_gb) {
      out.push(
        `disk free ${Math.floor(r.disk.free_gb)} GB (min ${o.placement.disk_free_min_gb} GB)`,
      );
    }
  }
  if (m.usage_pct !== null && m.usage_pct >= o.warn_at_pct) {
    out.push(`usage ${pct(m.usage_pct)} (warn at ${o.warn_at_pct}%)`);
  }
  return out;
}

/** Every reason `m` may not take `task` now: the machine filter, then a heavy task's slots. */
function ineligible(
  m: MachineView,
  task: WaveTask,
  wave: Wave,
  snap: Snapshot,
  o: PlaceOptions,
): string[] {
  const out = machineIneligible(m, snap, o);
  for (const [pool, held, per] of heavySlots(m, task, wave, snap)) {
    if (held >= per) out.push(`heavy slots ${Math.max(0, per - held)}/${per} free (${pool})`);
  }
  return out;
}

/**
 * The weighted mean of `m`'s known headrooms, in 0..1 (null: no weighted headroom is known), and
 * the line that explains it.
 */
function score(
  m: MachineView,
  task: WaveTask,
  wave: Wave,
  snap: Snapshot,
  o: PlaceOptions,
): { score: number | null; line: string } {
  const r = m.record as MachineRecord;
  const w = o.placement.weights;
  const n = placed(m, snap);
  const parts: [number, number | null][] = [
    [w.cpu, Math.max(0, 1 - r.load[0] / r.cores / o.placement.load_per_core_max)],
    [w.slots, m.max_agents > 0 ? Math.max(0, (m.max_agents - n) / m.max_agents) : 0],
    [w.mem, r.memory !== undefined ? r.memory.available_pct / 100 : null],
    [w.usage, m.usage_pct !== null ? 1 - m.usage_pct / 100 : null],
  ];
  const known = parts.filter((p): p is [number, number] => p[1] !== null && p[0] > 0);
  const weight = known.reduce((a, [wt]) => a + wt, 0);
  const s =
    weight > 0
      ? round2(Math.min(1, Math.max(0, known.reduce((a, [wt, h]) => a + wt * h, 0) / weight)))
      : null;
  const bits = [
    `load ${r.load[0].toFixed(1)} on ${r.cores} cores`,
    `${n}/${m.max_agents} agents`,
    r.memory !== undefined ? `${pct(r.memory.available_pct)} mem` : "mem unknown",
    m.usage_pct !== null ? `usage ${pct(m.usage_pct)}` : "usage unknown",
    ...heavySlots(m, task, wave, snap).map(
      ([pool, held, per]) => `heavy slots ${Math.max(0, per - held)}/${per} free (${pool})`,
    ),
  ];
  if (s === null) bits.push("no weighted headroom known");
  return { score: s, line: bits.join(" · ") };
}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Where `task` starts. A task that names its host (or any task of a wave that does not opt in)
 * is placed where the wave file says, `by: wave_file`, unscored; an `auto` task goes to the best
 * eligible machine, or nowhere yet (`host: null`, with the closest machine's reason).
 */
export function place(
  task: WaveTask,
  wave: Wave,
  snap: Snapshot,
  o: PlaceOptions,
): Placement | Unplaced {
  if (!needsPlacement(task)) {
    const local = task.host === LOCAL_HOST;
    const host = local ? o.localName : task.host;
    return {
      host,
      local,
      by: "wave_file",
      score: null,
      candidates: [{ host, score: null, line: "named in the wave file" }],
    };
  }
  const prefer = wave.placement_prefer ?? [];
  const avoid = wave.placement_avoid ?? [];
  const rows = snap.machines
    .filter((m) => m.record !== undefined)
    .map((m) => {
      const why = ineligible(m, task, wave, snap, o);
      const s = score(m, task, wave, snap, o);
      const tag = prefer.includes(m.name)
        ? " · preferred"
        : avoid.includes(m.name)
          ? " · avoided"
          : "";
      return {
        m,
        why,
        // Unscored (no weighted headroom known) ranks as 0, which its line says.
        score: s.score ?? 0,
        // Prefer first; avoid only when nothing else is eligible.
        group: prefer.includes(m.name) ? 0 : avoid.includes(m.name) ? 2 : 1,
        placed: placed(m, snap),
        line: line(why.length > 0 ? `ineligible: ${why[0]}` : `${s.line}${tag}`),
      };
    });
  const eligible = rows
    .filter((r) => r.why.length === 0)
    .sort(
      (a, b) =>
        a.group - b.group || b.score - a.score || a.placed - b.placed || byName(a.m.name, b.m.name),
    );
  // Closest first: the fewest reasons, then the best headroom it would have.
  const rest = rows
    .filter((r) => r.why.length > 0)
    .sort((a, b) => a.why.length - b.why.length || b.score - a.score || byName(a.m.name, b.m.name));
  const candidates = [...eligible, ...rest].slice(0, CANDIDATES_MAX).map((r) => ({
    host: r.m.name,
    score: r.why.length === 0 ? r.score : null,
    line: r.line,
  }));
  const best = eligible[0];
  if (best === undefined) {
    const closest = rest[0];
    return {
      host: null,
      why: line(
        `no eligible machine: ${closest !== undefined ? `${closest.m.name}: ${closest.why[0]}` : "no machine reports a record"}`,
      ),
      candidates,
    };
  }
  return { host: best.m.name, local: best.m.local, by: "auto", score: best.score, candidates };
}

// ---------------------------------------------------------------------------------------------
// Preview (`volleyd validate` / `run`): where the wave's auto tasks would go if admitted now,
// from the retained records and verdicts. The real decision is made at admission.
// ---------------------------------------------------------------------------------------------

/** The fields of a retained readiness verdict (readiness.schema.json) placement reads. */
export interface VerdictView {
  name: string;
  ready: boolean;
  reasons: string[];
  drain: boolean;
  max_agents: number;
  placed: number;
  heavy: Record<string, { held: number; per_machine: number }>;
  usage: { five_hour_pct: number | null };
}

/** A snapshot from the retained machine records and readiness verdicts. */
export function snapshotFrom(
  records: MachineRecord[],
  verdicts: VerdictView[],
  localName: string,
): Snapshot {
  const verdictOf = new Map(verdicts.map((v) => [v.name, v]));
  return {
    machines: records.map((record) => {
      const v = verdictOf.get(record.name);
      return {
        name: record.name,
        local: record.name === localName,
        record,
        ready: v?.ready ?? false,
        reasons: v?.reasons ?? ["no readiness verdict yet"],
        drain: v?.drain ?? false,
        max_agents: v?.max_agents ?? 0,
        agents: v?.placed ?? 0,
        heavy: v?.heavy ?? {},
        usage_pct: v?.usage.five_hour_pct ?? null,
        held: [],
      };
    }),
    reservations: {},
  };
}

/**
 * `if admitted now: T1 → box-a (0.81), T3 → local (0.63)`: each task the supervisor would place,
 * in file order, each placement reserved for the next. null when the wave places nothing.
 */
export function preview(wave: Wave, snap: Snapshot, o: PlaceOptions): string | null {
  let s = snap;
  const parts: string[] = [];
  for (const id of wave.task_order) {
    const t = wave.tasks[id];
    if (t === undefined || !needsPlacement(t)) continue;
    const p = place(t, wave, s, o);
    if (p.host === null) {
      parts.push(`${id} → waiting (${p.why})`);
      continue;
    }
    parts.push(`${id} → ${p.local ? LOCAL_HOST : p.host} (${(p.score ?? 0).toFixed(2)})`);
    s = reserve(s, p.host, t, wave);
  }
  return parts.length === 0 ? null : `if admitted now: ${parts.join(", ")}`;
}
