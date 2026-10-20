import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { dateOf, systemClock } from "./clock";
import { CONFIG_DEFAULTS, DEFAULTS_AUTHOR } from "./config-defaults";
import { LOCAL_HOST, localMachineName } from "./fleet-name";
import { type Journal, writeFileAtomic } from "./journal";
import { type PathError, toPathErrors, validator } from "./schemas";
import type { ConfigPayload, LocalAgentsMode, Tunables, TunablesPatch, WaveId } from "./types";

/** `$VOLLEYD_HOME`, else `~/.volley/volleyd`. */
export function volleydHome(env: Record<string, string | undefined>): string {
  return env.VOLLEYD_HOME ?? join(env.HOME ?? homedir(), ".volley", "volleyd");
}

export class ConfigError extends Error {
  readonly errors: PathError[];
  constructor(where: string, errors: PathError[]) {
    super(`${where}: invalid config:\n${errors.map((e) => `  ${e.path}: ${e.reason}`).join("\n")}`);
    this.name = "ConfigError";
    this.errors = errors;
  }
}

export interface ConfigChange {
  /** Seq of the `config_changed` event in the `_system` journal. */
  seq: number;
  version: number;
  by: string;
  at: string;
  patch: TunablesPatch;
  previous: Record<string, unknown>;
}

export interface PatchResult {
  applied: boolean;
  rejected: PathError[];
  version?: number;
}

type Plain = Record<string, unknown>;

const isPlain = (v: unknown): v is Plain =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge: plain objects merge key by key; arrays, scalars and null replace. */
function merge<T>(base: T, over: unknown): T {
  if (!isPlain(base) || !isPlain(over)) return (over === undefined ? base : over) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out as T;
}

/** The values in `source` at every leaf path present in `shape`. */
function pick(source: unknown, shape: unknown): unknown {
  if (!isPlain(shape) || !isPlain(source)) return source;
  const out: Plain = {};
  for (const k of Object.keys(shape)) out[k] = pick(source[k], shape[k]);
  return out;
}

/** Every plain sub-object of `patch` that sets no key — a no-op that must not bump the version. */
function emptyObjects(patch: unknown, path = ""): PathError[] {
  if (!isPlain(patch)) return [];
  return Object.entries(patch).flatMap(([k, v]) => {
    const p = path === "" ? k : `${path}.${k}`;
    if (isPlain(v) && Object.keys(v).length === 0)
      return [{ path: p, reason: "must set at least 1 key" }];
    return emptyObjects(v, p);
  });
}

function errorsFor(ref: string, value: unknown): PathError[] {
  const v = validator(ref);
  return v(value) ? [] : toPathErrors(v.errors);
}

const TUNABLES = "config.schema.json#/$defs/tunables";

/**
 * The tunables' schema errors, with a lease pool's `per_machine` above its `capacity` said
 * plainly at the field's path: the schema can only express that bound as `if`/`then` pairs,
 * whose errors (`must match "then" schema`) name neither the field nor the bound.
 */
function tunablesErrors(value: unknown, host: string): PathError[] {
  return [
    ...fleetNameErrors(value, host),
    ...overrideErrors(value),
    ...poolErrors(value).map(rewordWeights),
  ];
}

/**
 * Every `lease_pools.<pool>.per_machine_overrides.<host>` above the pool's `capacity` (SPEC
 * §4.6.5): the schema's `perMachineWithinCapacity` trick does not extend to a map.
 */
function overrideErrors(value: unknown): PathError[] {
  const pools = isPlain(value) && isPlain(value.lease_pools) ? value.lease_pools : {};
  return Object.entries(pools).flatMap(([name, p]) => {
    if (!isPlain(p) || typeof p.capacity !== "number" || !isPlain(p.per_machine_overrides))
      return [];
    const capacity = p.capacity;
    return Object.entries(p.per_machine_overrides).flatMap(([host, n]) =>
      typeof n === "number" && n > capacity
        ? [
            {
              path: `lease_pools.${name}.per_machine_overrides.${host}`,
              reason: `${n} is over capacity ${capacity}`,
            },
          ]
        : [],
    );
  });
}

/** `fleet.local_agents`, resolved: null is `fallback` when any host is configured, else `always`. */
export function resolveLocalAgents(t: Pick<Tunables, "fleet" | "hosts">): LocalAgentsMode {
  return t.fleet.local_agents ?? (Object.keys(t.hosts).length > 0 ? "fallback" : "always");
}

/**
 * `t` as clients and subsystems read it: `fleet.local_agents` resolved, and each pool's
 * `per_machine_overrides.local` under the supervisor's machine name `local`.
 */
function resolved(t: Tunables, local: string): Tunables {
  const pools = Object.fromEntries(
    Object.entries(t.lease_pools).map(([name, p]) => {
      const o = p.per_machine_overrides;
      if (o === undefined || !Object.hasOwn(o, LOCAL_HOST)) return [name, p];
      const { [LOCAL_HOST]: own, ...rest } = o;
      return [name, { ...p, per_machine_overrides: { ...rest, [local]: own as number } }];
    }),
  );
  return {
    ...t,
    lease_pools: pools,
    fleet: { ...t.fleet, local_agents: resolveLocalAgents(t) },
  };
}

/** The reason all four `placement.weights` at 0 are refused with (SPEC §4.6.15). */
export const ALL_ZERO_WEIGHTS = "not all four weights may be 0 (cpu, slots, mem, usage)";

/** The schema's `not` on all-zero weights (`must NOT be valid`), said plainly. */
export function rewordWeights(e: PathError): PathError {
  return e.path.endsWith("placement.weights") && e.reason === "must NOT be valid"
    ? { path: e.path, reason: ALL_ZERO_WEIGHTS }
    : e;
}

/**
 * The supervisor's own machine name (`fleet.local_name`, else derived from `host`) is never a
 * configured host's (SPEC §4.6.15): two machines would write one record topic.
 */
function fleetNameErrors(value: unknown, host: string): PathError[] {
  if (!isPlain(value) || !isPlain(value.hosts)) return [];
  const set = isPlain(value.fleet) ? value.fleet.local_name : undefined;
  const name = localMachineName(typeof set === "string" ? set : null, host);
  if (!Object.hasOwn(value.hosts, name)) return [];
  return typeof set === "string" && set === name
    ? [{ path: "fleet.local_name", reason: `"${name}" is a configured host (hosts.${name})` }]
    : [
        {
          path: `hosts.${name}`,
          reason: `"${name}" is the supervisor's own machine name (derived from its host name; set fleet.local_name to name it otherwise)`,
        },
      ];
}

function poolErrors(value: unknown): PathError[] {
  const pools = isPlain(value) && isPlain(value.lease_pools) ? value.lease_pools : {};
  const over = Object.entries(pools).flatMap(([name, p]) =>
    isPlain(p) &&
    typeof p.capacity === "number" &&
    typeof p.per_machine === "number" &&
    p.per_machine > p.capacity
      ? [{ name, capacity: p.capacity }]
      : [],
  );
  if (over.length === 0) return errorsFor(TUNABLES, value);
  // Everything else about the value is still checked, with the over-cap fields left out.
  const without = (p: Plain) =>
    Object.fromEntries(Object.entries(p).filter(([k]) => k !== "per_machine"));
  const rest = {
    ...(value as Plain),
    lease_pools: Object.fromEntries(
      Object.entries(pools).map(([name, p]) => [
        name,
        isPlain(p) && over.some((o) => o.name === name) ? without(p) : p,
      ]),
    ),
  };
  return [
    ...over.map(({ name, capacity }) => ({
      path: `lease_pools.${name}.per_machine`,
      reason: `must be at most capacity (${capacity})`,
    })),
    ...errorsFor(TUNABLES, rest),
  ];
}

/**
 * The supervisor config model: built-in defaults ← `$VOLLEYD_HOME/config.yaml` ← per-wave
 * `config:` overrides. Every subsystem reads tunables through `get()`/`effective()` so a
 * `config_set` takes effect without a restart. Changes are validated against the T1 config
 * schema, written atomically, journaled as `config_changed` in the `_system` journal (which is
 * also where `version`/`updated_by` come from on restart) and announced to `onChange` listeners.
 */
export class ConfigStore {
  private readonly file: string;
  private readonly system: Journal;
  private readonly now: () => Date;
  /** The bottom layer (CONFIG_DEFAULTS, or `defaultsFor` the daemon's env). */
  private readonly defaults: Tunables;
  private fileLayer: TunablesPatch;
  private global: Tunables;
  private readonly waves = new Map<WaveId, TunablesPatch>();
  private version: number;
  private updatedAt: string;
  private updatedBy: string;
  private readonly listeners: ((c: ConfigChange) => void)[] = [];
  /** The machine's host name, from which `fleet.local_name: null` derives the machine name. */
  private readonly hostname: string;

  private constructor(
    opts: { home: string; system: Journal; now: () => Date; defaults: Tunables; hostname: string },
    layer: TunablesPatch,
  ) {
    this.file = join(opts.home, "config.yaml");
    this.hostname = opts.hostname;
    this.system = opts.system;
    this.now = opts.now;
    this.defaults = opts.defaults;
    this.fileLayer = layer;
    this.global = merge(this.defaults, layer);
    const changes = opts.system.readAll().filter((e) => e.type === "config_changed");
    const last = changes.at(-1);
    this.version = 1 + changes.length;
    this.updatedAt = last?.at ?? opts.now().toISOString();
    this.updatedBy = (last?.data.by as string | undefined) ?? DEFAULTS_AUTHOR;
  }

  /** Load and validate `config.yaml` (absent = defaults). Throws ConfigError naming the path. */
  static load(opts: {
    home: string;
    system: Journal;
    now?: () => Date;
    defaults?: Tunables;
    /** Tests: the host name `fleet.local_name: null` derives from (default: the machine's). */
    hostname?: string;
  }): ConfigStore {
    const defaults = opts.defaults ?? CONFIG_DEFAULTS;
    const host = opts.hostname ?? hostname();
    const file = join(opts.home, "config.yaml");
    let layer: TunablesPatch = {};
    if (existsSync(file)) {
      let parsed: unknown;
      try {
        parsed = parse(readFileSync(file, "utf-8"));
      } catch (e) {
        throw new ConfigError(file, [
          { path: "(root)", reason: `invalid YAML: ${(e as Error).message}` },
        ]);
      }
      layer = (parsed ?? {}) as TunablesPatch;
      // The file is a patch over the defaults: what must be valid is the merged result.
      const errors = tunablesErrors(isPlain(layer) ? merge(defaults, layer) : layer, host);
      if (errors.length > 0) throw new ConfigError(file, errors);
    }
    return new ConfigStore(
      // real clock: the default when the daemon injects no clock
      { ...opts, now: opts.now ?? (() => dateOf(systemClock)), defaults, hostname: host },
      layer,
    );
  }

  /**
   * What a wave's `config:` would make invalid once merged over the global config, which its own
   * schema check cannot see: all four `placement.weights` at 0 between the two layers.
   */
  waveOverrideErrors(overrides: TunablesPatch): PathError[] {
    const w = merge(this.global, overrides).placement.weights;
    return Object.values(w).every((v) => v === 0)
      ? [{ path: "config.placement.weights", reason: `${ALL_ZERO_WEIGHTS} with the global config` }]
      : [];
  }

  /** Register (or replace) a wave's `config:` overrides. Validated by the wave-file schema. */
  setWaveOverrides(wave: WaveId, overrides: TunablesPatch): void {
    this.waves.set(wave, overrides);
  }

  clearWave(wave: WaveId): void {
    this.waves.delete(wave);
  }

  /**
   * The full effective tunables: global, or global with `wave`'s overrides applied, with
   * `fleet.local_agents` and the `local` alias of `per_machine_overrides` resolved.
   */
  effective(wave?: WaveId): Tunables {
    const over = wave !== undefined ? this.waves.get(wave) : undefined;
    const eff = over === undefined ? structuredClone(this.global) : merge(this.global, over);
    return resolved(eff, this.localName());
  }

  /**
   * The effective value at a dotted path (`admission.ci_queue_max`), or the whole config when
   * `path` is omitted. The first segment must be a tunable; deeper misses return undefined.
   */
  get(path?: string, wave?: WaveId): unknown {
    const eff = this.effective(wave);
    if (path === undefined || path === "") return eff;
    const [head, ...rest] = path.split(".");
    if (head === undefined || !Object.hasOwn(CONFIG_DEFAULTS, head)) {
      throw new ConfigError("get", [{ path, reason: `unknown config path '${path}'` }]);
    }
    let v: unknown = eff[head as keyof Tunables];
    for (const seg of rest) v = isPlain(v) && Object.hasOwn(v, seg) ? v[seg] : undefined;
    return v;
  }

  /**
   * The retained `volley/_waves/_config` payload (config.schema.json). `fleet.local_name` is the
   * resolved name, never null: clients recognise the supervisor's machine by it.
   */
  retainedPayload(): ConfigPayload {
    const eff = this.effective();
    return {
      version: this.version,
      updated_at: this.updatedAt,
      updated_by: this.updatedBy,
      ...eff,
      fleet: { ...eff.fleet, local_name: this.localName() },
    };
  }

  /** The supervisor's own machine name: `fleet.local_name`, else derived from the host name. */
  localName(): string {
    return localMachineName(this.global.fleet?.local_name ?? null, this.hostname);
  }

  onChange(listener: (c: ConfigChange) => void): void {
    this.listeners.push(listener);
  }

  /**
   * Apply a partial tunables patch from `by`. The patch is rejected as a whole if it is empty,
   * sets an empty sub-object, or would leave the config invalid (an unknown key, an out-of-bounds
   * value, a new lease pool without `capacity`). Validation runs on the merged result, so a patch
   * may set one field of an existing object (`lease_pools.build.ttl_s`). On success: write
   * config.yaml atomically, journal `config_changed`, bump `version`, notify listeners.
   */
  applyPatch(patch: TunablesPatch, by: string): PatchResult {
    const rejected: PathError[] = [];
    if (!isPlain(patch)) rejected.push(...errorsFor(TUNABLES, patch));
    else if (Object.keys(patch).length === 0)
      rejected.push({ path: "(root)", reason: "patch must set at least 1 key" });
    else rejected.push(...emptyObjects(patch));
    const nextLayer = merge(this.fileLayer, patch);
    const nextGlobal = merge(this.defaults, nextLayer);
    if (rejected.length === 0) rejected.push(...tunablesErrors(nextGlobal, this.hostname));
    if (rejected.length > 0) return { applied: false, rejected };
    return this.commit(nextLayer, nextGlobal, patch, pick(this.global, patch), by);
  }

  /**
   * Remove `hosts.<name>` (a removed peer, `volley peer remove`): config_set cannot delete a key.
   * Journaled as `config_changed` with the patch `{ hosts: { <name>: null } }`.
   */
  removeHost(name: string, by: string): PatchResult {
    const hosts = this.fileLayer.hosts;
    if (hosts === undefined || !Object.hasOwn(hosts, name)) {
      return {
        applied: false,
        rejected: [{ path: `hosts.${name}`, reason: "not in config.yaml" }],
      };
    }
    const { [name]: _removed, ...rest } = hosts;
    const nextLayer: TunablesPatch = { ...this.fileLayer, hosts: rest };
    const previous = { hosts: { [name]: this.global.hosts[name] } };
    // A null leaf is how a removal reads in the journal; it is never a valid config_set patch.
    const patch = { hosts: { [name]: null } } as unknown as TunablesPatch;
    return this.commit(nextLayer, merge(this.defaults, nextLayer), patch, previous, by);
  }

  /** Write config.yaml atomically, journal `config_changed`, bump `version`, notify listeners. */
  private commit(
    nextLayer: TunablesPatch,
    nextGlobal: Tunables,
    patch: TunablesPatch,
    previousValues: unknown,
    by: string,
  ): PatchResult {
    const previous = previousValues as Record<string, unknown>;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, stringify(nextLayer));

    const mode = resolveLocalAgents(this.global);
    this.fileLayer = nextLayer;
    this.global = nextGlobal;
    this.record(patch, previous, by);
    // A derived `local_agents` (null) that the change flipped (the first host added, the last
    // removed) is journaled as the defaults' own change, so clients see the new mode.
    const next = resolveLocalAgents(nextGlobal);
    if (next !== mode) {
      this.record(
        { fleet: { local_agents: next } } as TunablesPatch,
        { fleet: { local_agents: mode } },
        DEFAULTS_AUTHOR,
      );
    }
    return { applied: true, rejected: [], version: this.version };
  }

  /** Journal one `config_changed`, bump `version` and notify listeners. */
  private record(patch: TunablesPatch, previous: Record<string, unknown>, by: string): void {
    const version = this.version + 1;
    const ev = this.system.append(
      { type: "config_changed", data: { by, patch, previous, version } },
      this.now(),
    );
    this.version = version;
    this.updatedAt = ev.at;
    this.updatedBy = by;
    const change: ConfigChange = { seq: ev.seq, version, by, at: ev.at, patch, previous };
    for (const l of this.listeners) l(change);
  }
}
