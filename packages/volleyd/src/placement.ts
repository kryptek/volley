import { LOCAL_HOST } from "./fleet-name";
import type { MachineRecord } from "./machines";
import type { FallbackProfile, LocalAgentsMode, PlacementConfig, Wave, WaveTask } from "./types";

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
  /**
   * The supervisor's own machine: the agents on it alone (live, plus reservations for it), which
   * its fallback profile counts against `fleet.fallback.max_agents`. Unset: `agents`.
   */
  local_agents?: number;
  /** A peer the supervisor marked down: since when (its own clock, epoch ms). */
  down_since?: number;
  /** Each lease pool that sets `per_machine`: its holders' leases on this machine. */
  heavy: Record<string, { held: number; per_machine: number }>;
  /** Its best candidate account's 5-hour usage percentage; null: unknown. */
  usage_pct: number | null;
  /** That account (the balancing rule's pick on the machine), when known. */
  usage_account?: string;
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

/**
 * The machine filter's options: placement's thresholds, the usage warning level, and how the
 * supervisor's own machine takes auto-placed tasks.
 */
export type FilterOptions = Pick<
  PlaceOptions,
  "placement" | "warn_at_pct" | "local_agents" | "fallback" | "now" | "down_grace_ms" | "exclude"
>;

export interface PlaceOptions {
  placement: Pick<
    PlacementConfig,
    "load_per_core_max" | "mem_available_min_pct" | "disk_free_min_gb" | "weights"
  >;
  /** `claude.warn_at_pct`: usage at or over it takes no new placement. */
  warn_at_pct: number;
  /** The supervisor's own machine name (`local` in a wave file). */
  localName: string;
  /**
   * Machines a re-placement moves the task off (SPEC §4.6.15: a `machine_down` or `respawn on`
   * answer): never chosen, shown as ineligible.
   */
  exclude?: string[];
  /** `fleet.local_agents`, resolved (SPEC §4.6.15); unset: `always`. */
  local_agents?: LocalAgentsMode;
  /** `fleet.fallback`: the own machine's profile while it is the fallback. */
  fallback?: FallbackProfile;
  /** Now (epoch ms), against which a down peer's `down_since` is judged. */
  now?: number;
  /**
   * `placement.down_decision_after_s` in ms: a peer down for less is not yet ineligible for the
   * fallback's purposes (it may be back), so the own machine stays closed to auto placement.
   */
  down_grace_ms?: number;
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
/** Why an excluded machine is skipped (`PlaceOptions.exclude`). */
const EXCLUDED = "excluded: the task is being moved off it";
/** An overload line (load or memory): nothing running there is touched, nothing new starts. */
const overloaded = (what: string) => `overloaded: ${what} · no new agents`;
/**
 * The load an overload is judged on: the higher of the 1- and 5-minute averages, so a dip in the
 * 1-minute figure alone does not reopen a machine that is still busy.
 */
export const overloadLoad = (r: Pick<MachineRecord, "load">): number =>
  Math.max(r.load[0], r.load[1]);
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

/** The own machine's role in auto placement now (`localRole`). */
export interface LocalRole {
  mode: LocalAgentsMode;
  /** The fallback profile is in force: `fallback`, and no paired machine eligible or maybe back. */
  active: boolean;
  /** Why the mode keeps the own machine from auto placement now (its first ineligible reason). */
  blocked?: string;
  /** The eligible peer (`box-a eligible`), the peer that may be back, or the closest peer's reason. */
  why?: string;
  /** Held back only for a down peer still within the grace: the reason a waiting task shows. */
  back?: true;
}

const seconds = (ms: number) => Math.max(0, Math.round(ms / 1000));

/**
 * The own machine's role under `fleet.local_agents` (SPEC §4.6.15). `always`: a candidate like
 * any peer. `never`: none. `fallback`: none while any peer is eligible, or a down peer is still
 * within `down_grace_ms` of going down (a tunnel blip never pulls work onto it); otherwise the
 * fallback profile is in force. A peer's eligibility is task-agnostic (`machineIneligible`), so a
 * peer with its heavy slots full still keeps the own machine closed to a heavy task. Readiness
 * and placement both read it, so they agree.
 */
export function localRole(snap: Snapshot, o: FilterOptions): LocalRole {
  const mode = o.local_agents ?? "always";
  if (mode === "always") return { mode, active: false };
  if (mode === "never") return { mode, active: false, blocked: "local_agents: never" };
  const peers = snap.machines
    .filter((m) => !m.local)
    .map((m) => ({
      m,
      why: [
        ...(o.exclude?.includes(m.name) === true ? [EXCLUDED] : []),
        ...machineIneligible(m, snap, o),
      ],
    }));
  const eligible = peers.find((p) => p.why.length === 0);
  if (eligible !== undefined) {
    const name = eligible.m.name;
    return {
      mode,
      active: false,
      blocked: `fallback: ${name} is eligible`,
      why: `${name} eligible`,
    };
  }
  const now = o.now ?? 0;
  const grace = o.down_grace_ms ?? 0;
  const back = peers.find((p) => p.m.down_since !== undefined && now - p.m.down_since < grace);
  if (back !== undefined) {
    const why = `${back.m.name} may be back (down ${seconds(now - (back.m.down_since ?? now))} s, grace ${seconds(grace)} s)`;
    return { mode, active: false, blocked: `fallback: ${why}`, why, back: true };
  }
  const closest = [...peers].sort(
    (a, b) => a.why.length - b.why.length || byName(a.m.name, b.m.name),
  )[0];
  return {
    mode,
    active: true,
    why: closest !== undefined ? `${closest.m.name}: ${closest.why[0]}` : "no paired machine",
  };
}

/**
 * The agents counted against `m`'s cap and the cap: under the own machine's fallback profile,
 * its own agents alone against `fleet.fallback.max_agents` (`hard_ceiling` still caps the total
 * through admission); otherwise `placed` against `max_agents`.
 */
function slots(
  m: MachineView,
  snap: Snapshot,
  o: FilterOptions,
): { n: number; max: number; fallback: boolean } {
  if (m.local && o.fallback !== undefined && localRole(snap, o).active) {
    return {
      n: (m.local_agents ?? m.agents) + (snap.reservations[m.name] ?? 0),
      max: Math.min(m.max_agents, o.fallback.max_agents),
      fallback: true,
    };
  }
  return { n: placed(m, snap), max: m.max_agents, fallback: false };
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
  o: FilterOptions,
): [string, number, number][] {
  if (task.heavy !== true) return [];
  const reserved = snap.heavyReserved?.[m.name] ?? {};
  // Under the fallback profile, each pool's slot there is `fleet.fallback.per_machine.<pool>`
  // (default 1), never more than the pool's own cap.
  const fallback = m.local && o.fallback !== undefined && localRole(snap, o).active;
  return wave.heavy_pools.flatMap((pool) => {
    const h = m.heavy[pool];
    if (h === undefined) return [];
    const cap = fallback
      ? Math.min(h.per_machine, o.fallback?.per_machine[pool] ?? 1)
      : h.per_machine;
    return [[pool, h.held + (reserved[pool] ?? 0), cap] as [string, number, number]];
  });
}

/**
 * Every reason `m` may take no new task now, whatever the task, in the order a person fixes them:
 * readiness, drain, `max_agents`, its own admission, load per core, memory, disk and usage. The
 * readiness verdict's `eligible` is this list being empty, its `ineligible_reason` the first entry.
 */
export function machineIneligible(m: MachineView, snap: Snapshot, o: FilterOptions): string[] {
  const out: string[] = [];
  // The own machine's mode first: under `never`, or `fallback` while a peer is eligible, it
  // takes no auto-placed task whatever else holds.
  if (m.local) {
    const blocked = localRole(snap, o).blocked;
    if (blocked !== undefined) out.push(blocked);
  }
  // Every readiness blocker counts (a machine that needs several fixes is farther away); the
  // line names the first.
  if (!m.ready) {
    const [first = "not ready", ...more] = m.reasons;
    out.push(`${first} (readiness)`, ...more.map((reason) => `${reason} (readiness)`));
  }
  if (m.drain) out.push("draining");
  const { n, max, fallback } = slots(m, snap, o);
  if (n >= max) out.push(`${n}/${max} agents (${fallback ? "fallback max_agents" : "max_agents"})`);
  out.push(...m.held);
  const r = m.record;
  if (r !== undefined) {
    const load = overloadLoad(r);
    if (load / r.cores > o.placement.load_per_core_max) {
      out.push(overloaded(`load ${load.toFixed(1)} on ${r.cores} cores`));
    }
    if (r.memory !== undefined && r.memory.available_pct < o.placement.mem_available_min_pct) {
      out.push(
        overloaded(
          `memory available ${pct(r.memory.available_pct)} (min ${o.placement.mem_available_min_pct}%)`,
        ),
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
  const out = [
    ...(o.exclude?.includes(m.name) === true ? [EXCLUDED] : []),
    ...machineIneligible(m, snap, o),
  ];
  for (const [pool, held, per] of heavySlots(m, task, wave, snap, o)) {
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
  const { n, max } = slots(m, snap, o);
  const parts: [number, number | null][] = [
    [w.cpu, Math.max(0, 1 - r.load[0] / r.cores / o.placement.load_per_core_max)],
    [w.slots, max > 0 ? Math.max(0, (max - n) / max) : 0],
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
    `${n}/${max} agents`,
    r.memory !== undefined ? `${pct(r.memory.available_pct)} mem` : "mem unknown",
    m.usage_pct !== null
      ? `usage ${pct(m.usage_pct)}${m.usage_account !== undefined ? ` (${m.usage_account})` : ""}`
      : "usage unknown",
    ...heavySlots(m, task, wave, snap, o).map(
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
  const role = localRole(snap, o);
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
        placed: slots(m, snap, o).n,
        line: line(
          why.length > 0
            ? `ineligible: ${why[0]}`
            : m.local && role.active
              ? `local (fallback: no peer eligible: ${role.why}) · ${s.line}${tag}`
              : `${s.line}${tag}`,
        ),
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
    // The own machine held back for a peer that may be back says so before any peer's reason.
    const closest = (role.back === true ? rest.find((r) => r.m.local) : undefined) ?? rest[0];
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
  usage: { five_hour_pct: number | null; account?: string | null };
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
        ...(typeof v?.usage.account === "string" ? { usage_account: v.usage.account } : {}),
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

// --- Fleet defaults (#324): the supervisor overloaded while a paired machine idles ---

/** A paired machine left unused while the supervisor's own machine is overloaded. */
export interface IdlePeer {
  /** The own machine's load (the higher of the 1- and 5-minute averages) and cores. */
  load: number;
  cores: number;
  /** The peer with the most free slots, and how many. */
  peer: string;
  free: number;
  /** The `alarm_raised` line: what is overloaded, what idles, and the key that uses it. */
  message: string;
}

/**
 * Whether the supervisor's own machine is over `placement.load_per_core_max` while a ready,
 * undrained peer that is not down has free `max_agents` slots (SPEC §4.6.15): what a
 * `placement: local` wave is leaving unused. Null otherwise, or before the own record is known.
 */
export function peerIdleUnderLoad(
  snap: Snapshot,
  o: { placement: Pick<PlacementConfig, "load_per_core_max"> },
): IdlePeer | null {
  const own = snap.machines.find((m) => m.local)?.record;
  if (own === undefined || !(own.cores > 0)) return null;
  const load = overloadLoad(own);
  const max = o.placement.load_per_core_max;
  if (load / own.cores <= max) return null;
  const idle = snap.machines
    .filter((m) => !m.local && m.ready && !m.drain && m.down_since === undefined)
    .map((m) => ({ name: m.name, free: m.max_agents - placed(m, snap) }))
    .filter((m) => m.free > 0)
    .sort((a, b) => b.free - a.free || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))[0];
  if (idle === undefined) return null;
  const slots = `${idle.free} free agent slot${idle.free === 1 ? "" : "s"}`;
  return {
    load,
    cores: own.cores,
    peer: idle.name,
    free: idle.free,
    message: `this machine is overloaded (load ${load.toFixed(1)} on ${own.cores} cores, max ${max} per core) while ${idle.name} is ready with ${slots}; this wave is placement: local (set placement: auto to use it)`,
  };
}
