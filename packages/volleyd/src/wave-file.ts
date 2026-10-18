import { readFile } from "node:fs/promises";
import { type Node, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { type PathError, toPathErrors, validator } from "./schemas";
import type { PipelineStage, PipelineStep, TaskId, TunablesPatch, Wave, WaveTask } from "./types";

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

interface RawTask {
  issue: number;
  title?: string;
  after?: TaskId[];
  pipeline?: PipelineStep[];
  model?: string;
  host?: string;
  files?: string[];
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
  if (!validate(raw)) errors.push(...toPathErrors(validate.errors).map(rewordWaveId));
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
      host: t.host ?? "local",
      files: t.files ?? [],
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
  };
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
