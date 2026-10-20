import { readFile } from "node:fs/promises";
import { type Node, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { rewordWeights } from "./config-store";
import { AUTO_HOST } from "./placement";
import { type PathError, toPathErrors, validator } from "./schemas";
import type {
  MergeMode,
  PipelineStage,
  PipelineStep,
  RemoteHostConfig,
  TaskId,
  TunablesPatch,
  Wave,
  WaveTask,
} from "./types";

/** A wave file failed to parse or validate. `errors` are path-qualified (`tasks.T3.after[1]`). */
export class WaveFileError extends Error {
  readonly errors: PathError[];
  constructor(errors: PathError[], source?: string) {
    const where = source !== undefined ? `${source}: ` : "";
    super(
      `${where}invalid wave file:\n${errors.map((e) => `  ${e.path}: ${e.reason}`).join("\n")}`,
    );
    this.name = "WaveFileError";
    this.errors = errors;
  }
}

type InlineHost = RemoteHostConfig & { type: "ssh"; name?: string };

interface RawTask {
  issue: number;
  title?: string;
  after?: TaskId[];
  pipeline?: PipelineStep[];
  model?: string;
  host?: string | InlineHost;
  files?: string[];
  account?: string;
  heavy?: boolean;
}

interface RawWave {
  wave: string;
  version?: number;
  repo: string;
  release_branch: string;
  model: string;
  namespace?: string;
  pipeline: PipelineStep[];
  tasks: Record<TaskId, RawTask>;
  heavy_pools?: string[];
  spawn_budget?: number;
  config?: TunablesPatch;
  brief_preface?: string;
  account?: string;
  placement?: "auto" | "local";
  placement_prefer?: string[];
  placement_avoid?: string[];
  merge?: MergeMode;
}

/** Parse wave-file YAML, validate it (schema + structural rules) and normalise it. */
export function parseWaveFile(text: string, source?: string): Wave {
  const fail = (errors: PathError[]): never => {
    throw new WaveFileError(errors, source);
  };

  // uniqueKeys:false so a duplicate key is reported with its path instead of a bare YAML error.
  const doc = parseDocument(text, { uniqueKeys: false });
  if (doc.errors.length > 0) {
    fail(doc.errors.map((e) => ({ path: "(root)", reason: `invalid YAML: ${e.message}` })));
  }
  if (!isMap(doc.contents)) fail([{ path: "(root)", reason: "must be a mapping" }]);

  const errors = duplicateKeys(doc.contents, "");
  const raw = doc.toJS() as unknown;
  const validate = validator("wave-file.schema.json");
  if (!validate(raw)) {
    errors.push(...toPathErrors(validate.errors).map(rewordWaveId).map(rewordWeights));
  }
  // Pools are shared by every wave on the machine, so a per-wave override could not take
  // effect; reject it rather than accept it and show it in effective_config (SPEC §4.6.4).
  const config = (raw as { config?: { lease_pools?: unknown } } | null)?.config;
  if (config?.lease_pools !== undefined) {
    const path = "config.lease_pools";
    for (let i = errors.length - 1; i >= 0; i--) {
      if (errors[i]?.path.startsWith(path)) errors.splice(i, 1);
    }
    errors.push({
      path,
      reason: "lease pools are machine-global; set them in volleyd's global config, not per wave",
    });
  }
  if (errors.length > 0) fail(errors);

  const w = raw as RawWave;
  const ids = Object.keys(w.tasks);
  // Agent ids and broker usernames are lowercase: `T1` and `t1` would be one agent.
  const byLower = new Map<string, string>();
  const clashes: PathError[] = [];
  for (const id of ids) {
    const first = byLower.get(id.toLowerCase());
    if (first !== undefined) {
      clashes.push({
        path: `tasks.${id}`,
        reason: `task id '${id}' differs from '${first}' only in case`,
      });
    } else byLower.set(id.toLowerCase(), id);
  }
  if (clashes.length > 0) fail(clashes);
  const unknown: PathError[] = [];
  for (const id of ids) {
    (w.tasks[id]?.after ?? []).forEach((dep, i) => {
      if (!Object.hasOwn(w.tasks, dep)) {
        unknown.push({ path: `tasks.${id}.after[${i}]`, reason: `unknown task '${dep}'` });
      }
    });
  }
  if (unknown.length > 0) fail(unknown);

  // An inline host without a name has no config entry to inherit from: it must be complete.
  // Its name (else its target) names it, and `local` is the daemon's own machine, never an ssh one.
  const hostErrors: PathError[] = [];
  for (const id of ids) {
    const h = w.tasks[id]?.host;
    if (typeof h !== "object") continue;
    if ((h.name ?? h.target) === "local") {
      hostErrors.push({
        path: `tasks.${id}.host.${h.name !== undefined ? "name" : "target"}`,
        reason: "`local` is the supervisor's own host; name the ssh host something else",
      });
      continue;
    }
    if (h.name !== undefined) continue;
    for (const key of ["target", "repo", "volley_dir"] as const) {
      if (h[key] === undefined) {
        hostErrors.push({
          path: `tasks.${id}.host.${key}`,
          reason: "required for an inline host without a name",
        });
      }
    }
  }
  if (hostErrors.length > 0) fail(hostErrors);

  const cycle = findCycle(ids, (id) => w.tasks[id]?.after ?? []);
  if (cycle !== null) {
    fail([{ path: `tasks.${cycle[0]}.after`, reason: `dependency cycle ${cycle.join(" -> ")}` }]);
  }

  return normalise(w);
}

/** Read and parse a wave file from disk; errors carry the file path. */
export async function loadWaveFile(path: string): Promise<Wave> {
  return parseWaveFile(await readFile(path, "utf-8"), path);
}

function normalise(w: RawWave): Wave {
  const tasks: Record<TaskId, WaveTask> = {};
  for (const [id, t] of Object.entries(w.tasks)) {
    const pipeline = t.pipeline ?? w.pipeline;
    tasks[id] = {
      id,
      issue: t.issue,
      ...(t.title !== undefined ? { title: t.title } : {}),
      after: t.after ?? [],
      pipeline,
      stages: toStageGroups(pipeline),
      model: t.model ?? w.model,
      ...normaliseHost(t.host, w.placement),
      files: t.files ?? [],
      ...(t.account !== undefined ? { account: t.account } : {}),
      ...(t.heavy === true ? { heavy: true } : {}),
    };
  }
  return {
    wave: w.wave,
    version: w.version ?? 1,
    repo: w.repo,
    release_branch: w.release_branch,
    model: w.model,
    ...(w.namespace !== undefined ? { namespace: w.namespace } : {}),
    pipeline: w.pipeline,
    stages: toStageGroups(w.pipeline),
    tasks,
    task_order: Object.keys(tasks),
    heavy_pools: w.heavy_pools ?? [],
    ...(w.spawn_budget !== undefined ? { spawn_budget: w.spawn_budget } : {}),
    config: w.config ?? {},
    ...(w.brief_preface !== undefined ? { brief_preface: w.brief_preface } : {}),
    ...(w.account !== undefined ? { account: w.account } : {}),
    ...(w.placement === "auto" ? { placement: "auto" as const } : {}),
    ...(w.placement_prefer !== undefined ? { placement_prefer: w.placement_prefer } : {}),
    ...(w.placement_avoid !== undefined ? { placement_avoid: w.placement_avoid } : {}),
    ...(w.merge !== undefined ? { merge: w.merge } : {}),
  };
}

/**
 * `host:` as a name (`local`, `auto`, a config `hosts.<name>`) plus the inline spec when there is
 * one. No `host:` is `auto` under the wave's `placement: auto`, else `local`.
 */
function normaliseHost(
  h: RawTask["host"],
  placement: RawWave["placement"],
): Pick<WaveTask, "host" | "host_spec"> {
  if (h === undefined) return { host: placement === "auto" ? AUTO_HOST : "local" };
  if (typeof h === "string") return { host: h };
  return { host: h.name ?? (h.target as string), host_spec: h };
}

/** `[a, [b, c], d]` → `[[a], [b, c], [d]]`: every entry becomes a parallel group. */
export function toStageGroups(pipeline: PipelineStep[]): PipelineStage[][] {
  return pipeline.map((s) => (Array.isArray(s) ? [...s] : [s]));
}

/** First dependency cycle found walking tasks in file order, as `[a, …, a]`; null if acyclic. */
function findCycle(ids: TaskId[], deps: (id: TaskId) => TaskId[]): TaskId[] | null {
  const done = new Set<TaskId>();
  const stack: TaskId[] = [];
  const onStack = new Set<TaskId>();
  const visit = (id: TaskId): TaskId[] | null => {
    if (onStack.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (done.has(id)) return null;
    stack.push(id);
    onStack.add(id);
    for (const d of deps(id)) {
      const c = visit(d);
      if (c !== null) return c;
    }
    stack.pop();
    onStack.delete(id);
    done.add(id);
    return null;
  };
  for (const id of ids) {
    const c = visit(id);
    if (c !== null) return c;
  }
  return null;
}

/** Walk the YAML AST and report every repeated mapping key with its path. */
function duplicateKeys(node: Node | null | undefined, path: string): PathError[] {
  const out: PathError[] = [];
  if (isMap(node)) {
    const seen = new Set<string>();
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      const here = path === "" ? key : `${path}.${key}`;
      if (seen.has(key)) {
        const what = path === "tasks" ? "task id" : "key";
        out.push({ path: here, reason: `duplicate ${what} '${key}'` });
      }
      seen.add(key);
      out.push(...duplicateKeys(pair.value as Node, here));
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, i) => {
      out.push(...duplicateKeys(item as Node, `${path}[${i}]`));
    });
  }
  return out;
}

function rewordWaveId(e: PathError): PathError {
  if (e.path === "wave" && e.reason.startsWith("must match pattern")) {
    return { path: "wave", reason: "invalid wave id (must match [a-z0-9][a-z0-9_-]{0,62})" };
  }
  return e;
}
