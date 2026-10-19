import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { dateOf, systemClock } from "./clock";
import { CONFIG_DEFAULTS, DEFAULTS_AUTHOR } from "./config-defaults";
import { type Journal, writeFileAtomic } from "./journal";
import { type PathError, toPathErrors, validator } from "./schemas";
import type { ConfigPayload, Tunables, TunablesPatch, WaveId } from "./types";

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

  private constructor(
    opts: { home: string; system: Journal; now: () => Date; defaults: Tunables },
    layer: TunablesPatch,
  ) {
    this.file = join(opts.home, "config.yaml");
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
  }): ConfigStore {
    const defaults = opts.defaults ?? CONFIG_DEFAULTS;
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
      const errors = errorsFor(TUNABLES, isPlain(layer) ? merge(defaults, layer) : layer);
      if (errors.length > 0) throw new ConfigError(file, errors);
    }
    return new ConfigStore(
      { ...opts, now: opts.now ?? (() => dateOf(systemClock)), defaults },
      layer,
    );
  }

  /** Register (or replace) a wave's `config:` overrides. Validated by the wave-file schema. */
  setWaveOverrides(wave: WaveId, overrides: TunablesPatch): void {
    this.waves.set(wave, overrides);
  }

  clearWave(wave: WaveId): void {
    this.waves.delete(wave);
  }

  /** The full effective tunables: global, or global with `wave`'s overrides applied. */
  effective(wave?: WaveId): Tunables {
    const over = wave !== undefined ? this.waves.get(wave) : undefined;
    return over === undefined ? structuredClone(this.global) : merge(this.global, over);
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

  /** The retained `volley/_waves/_config` payload (config.schema.json). */
  retainedPayload(): ConfigPayload {
    return {
      version: this.version,
      updated_at: this.updatedAt,
      updated_by: this.updatedBy,
      ...this.effective(),
    };
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
    if (rejected.length === 0) rejected.push(...errorsFor(TUNABLES, nextGlobal));
    if (rejected.length > 0) return { applied: false, rejected };

    const previous = pick(this.global, patch) as Record<string, unknown>;
    mkdirSync(join(this.file, ".."), { recursive: true });
    writeFileAtomic(this.file, stringify(nextLayer));

    const version = this.version + 1;
    const ev = this.system.append(
      { type: "config_changed", data: { by, patch, previous, version } },
      this.now(),
    );
    this.fileLayer = nextLayer;
    this.global = nextGlobal;
    this.version = version;
    this.updatedAt = ev.at;
    this.updatedBy = by;
    const change: ConfigChange = { seq: ev.seq, version, by, at: ev.at, patch, previous };
    for (const l of this.listeners) l(change);
    return { applied: true, rejected: [], version };
  }
}
