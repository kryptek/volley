import { readFile } from "node:fs/promises";
import { type Node, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { dropRetired, rewordWeights } from "./config-store";
import type { Tree } from "./footprint";
import {
  type FileTask,
  type Plan,
  type PlanTask,
  type PlannedTask,
  clusterFrom,
  diffPlan,
  planWave,
} from "./overlap-plan";
import { AUTO_HOST } from "./placement";
import { type RepoConfig, cloneFor, holdersOf, isSlug } from "./repos";
import { type PathError, toPathErrors, validator } from "./schemas";
import type {
  Footprint,
  MergeMode,
  PipelineStage,
  PipelineStep,
  PlacementDefault,
  PlanCluster,
  PlanStrategy,
  RemoteHostConfig,
  TaskId,
  TaskPlan,
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
  issues?: number[];
  footprint?: Footprint;
  plan?: TaskPlan;
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
  playbook?: string;
}

/**
 * What a wave file without `placement:` takes (SPEC §4.6.15): the supervisor's
 * `placement.default` (its config.yaml over the built-in) and how many paired machines
 * (`hosts.<name>`) it has configured. The wave's own `config: placement.default` wins over
 * `default`. Absent: `local`, as before the tunable.
 */
export interface PlacementDefaults {
  default: PlacementDefault;
  paired: number;
  /** A known wave's kept placement: only the file's own `placement:` changes it, not its `config:`. */
  kept?: boolean;
}

/** Where a wave's unpinned tasks run, and what decided it (the line validate and run print). */
export interface WavePlacement {
  placement: "auto" | "local";
  /** `wave file`: its `placement:`; `default`: `placement.default` with a paired machine; `unpaired`: no paired machine. */
  by: "wave file" | "default" | "unpaired";
}

/** `placement:` of the raw wave, else the effective `placement.default` once a machine is paired. */
export function defaultPlacement(
  raw: { placement?: "auto" | "local"; config?: TunablesPatch },
  d: PlacementDefaults | undefined,
): WavePlacement {
  if (raw.placement !== undefined) return { placement: raw.placement, by: "wave file" };
  const def = d?.kept ? d.default : (raw.config?.placement?.default ?? d?.default ?? "local");
  if (def === "local") return { placement: "local", by: "default" };
  return (d?.paired ?? 0) > 0
    ? { placement: "auto", by: "default" }
    : { placement: "local", by: "unpaired" };
}

/**
 * `placement: auto (placement.default; 1 paired machine)`, `placement: local (no paired
 * machine)`, `placement: local (placement.default)` or `placement: auto (wave file)`.
 */
export function formatPlacement(p: WavePlacement, paired: number): string {
  if (p.by === "wave file") return `placement: ${p.placement} (wave file)`;
  if (p.by === "unpaired") return `placement: ${p.placement} (no paired machine)`;
  if (p.placement === "local") return "placement: local (placement.default)";
  return `placement: auto (placement.default; ${paired} paired machine${paired === 1 ? "" : "s"})`;
}

/**
 * The wave's `repo:` as the supervisor runs it. An `owner/name` slug resolves to its clone on the
 * supervisor's own machine `local` (`cloneFor`: adopted, else managed under `fleet.repo_root`,
 * `~` being `home`); when only paired machines hold it by config (`holdersOf`) the slug is kept
 * and its tasks are placed on them, a task pinned to `local` being a WaveFileError at
 * `tasks.<id>.host`; a slug no machine holds is a WaveFileError at `repo` (#448). Any other value
 * is a path and is kept. (A relative path shaped like a slug is written `./owner/name`.) Pure:
 * decided from config alone, so `volleyd validate` agrees offline.
 */
export function resolveWaveRepo(
  wave: Wave,
  cfg: RepoConfig,
  local: string,
  home: string,
  source?: string,
): Wave {
  if (!isSlug(wave.repo)) return wave;
  const slug = wave.repo;
  const clone = cloneFor(cfg, local, slug, { home });
  if (clone !== undefined) return { ...wave, repo: clone };
  const holders = holdersOf(cfg, local, slug).filter((m) => m !== local);
  if (holders.length === 0) {
    const paired = Object.keys(cfg.hosts).filter((n) => n !== local);
    const reason = `no clone of ${slug} on any machine: add it to one (Settings → Repositories, or volley repo add ${slug} --machine ${paired[0] ?? local})`;
    throw new WaveFileError([{ path: "repo", reason }], source);
  }
  const pinned = Object.keys(wave.tasks).find((id) => wave.tasks[id]?.host === "local");
  if (pinned !== undefined) {
    const reason = `no clone of ${slug} on ${local}: set placement: auto so it runs on ${holders.join(", ")}, or add the clone (volley repo add ${slug} --machine ${local})`;
    throw new WaveFileError([{ path: `tasks.${pinned}.host`, reason }], source);
  }
  return wave;
}

/** True when the wave's `repo:` is an `owner/name` the supervisor holds no clone of (#448). */
export const isSlugRepo = (wave: Pick<Wave, "repo">): boolean => isSlug(wave.repo);

/**
 * Parse wave-file YAML, validate it (schema + structural rules) and normalise it. `defaults`
 * decides a wave without `placement:` (`defaultPlacement`); without it such a wave is `local`.
 */
export function parseWaveFile(
  text: string,
  source?: string,
  defaults?: PlacementDefaults,
  /** Gets a line per retired key dropped from the file's `config:` (`config.<why>`). */
  notes?: string[],
): Wave {
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
  // A retired tunable in `config:` no longer means anything: dropped, with a note, not an error.
  const top = raw as { config?: unknown } | null;
  if (typeof top === "object" && top !== null && !Array.isArray(top)) {
    const kept = dropRetired(top.config);
    if (kept.retired.length > 0) top.config = kept.patch;
    notes?.push(...kept.retired.map((why) => `config.${why}`));
  }
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
  // A bundle's `issues`: its own issue among them, each once, and no other task's (SPEC §4.6.22).
  const bundles = bundleErrors(raw);
  if (bundles.length > 0) {
    // These replace the schema's `uniqueItems` error on `issues` (ajv's "must NOT have duplicate
    // items"), which says less.
    const reported = new Set(bundles.map((e) => e.path.replace(/\[\d+\]$/, "")));
    for (let i = errors.length - 1; i >= 0; i--) {
      const e = errors[i];
      if (e !== undefined && reported.has(e.path) && e.reason.includes("duplicate"))
        errors.splice(i, 1);
    }
    errors.push(...bundles);
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

  return normalise(w, defaultPlacement(w, defaults).placement);
}

/** Read and parse a wave file from disk; errors carry the file path. */
export async function loadWaveFile(path: string, defaults?: PlacementDefaults): Promise<Wave> {
  return parseWaveFile(await readFile(path, "utf-8"), path, defaults);
}

function normalise(w: RawWave, placement: "auto" | "local"): Wave {
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
      ...normaliseHost(t.host, placement),
      files: t.files ?? [],
      ...(t.account !== undefined ? { account: t.account } : {}),
      ...(t.heavy === true ? { heavy: true } : {}),
      ...(t.issues !== undefined ? { issues: t.issues } : {}),
      ...(t.footprint !== undefined ? { footprint: t.footprint } : {}),
      ...(t.plan !== undefined ? { plan: t.plan } : {}),
    };
  }
  const planned = Object.values(w.tasks).some((t) => t.plan !== undefined);
  const wave: Wave = {
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
    ...(placement === "auto" ? { placement: "auto" as const } : {}),
    ...(w.placement_prefer !== undefined ? { placement_prefer: w.placement_prefer } : {}),
    ...(w.placement_avoid !== undefined ? { placement_avoid: w.placement_avoid } : {}),
    ...(w.merge !== undefined ? { merge: w.merge } : {}),
    ...(w.playbook !== undefined ? { playbook: w.playbook } : {}),
  };
  // The file's own overlap plan, as written: the Desk and `validate` read it before any run.
  if (planned) wave.overlap_plan = { clusters: filePlan(wave).clusters };
  return wave;
}

/**
 * `tasks.<id>.issues` errors: it must contain the task's `issue`, name each issue once, and name
 * none another task closes (its `issue`, or in its `issues`).
 */
function bundleErrors(raw: unknown): PathError[] {
  const tasks = (raw as { tasks?: unknown } | null)?.tasks;
  if (tasks === null || typeof tasks !== "object") return [];
  const entries = Object.entries(tasks as Record<string, { issue?: unknown; issues?: unknown }>);
  // Who closes each issue: its task's `issue` first, then the first bundle naming it.
  const owner = new Map<unknown, TaskId>();
  for (const [id, t] of entries) if (!owner.has(t?.issue)) owner.set(t?.issue, id);
  for (const [id, t] of entries) {
    for (const i of Array.isArray(t?.issues) ? t.issues : []) if (!owner.has(i)) owner.set(i, id);
  }
  const out: PathError[] = [];
  for (const [id, t] of entries) {
    if (!Array.isArray(t?.issues)) continue;
    const path = `tasks.${id}.issues`;
    if (!t.issues.includes(t.issue)) out.push({ path, reason: `must include issue ${t.issue}` });
    t.issues.forEach((i, k) => {
      if ((t.issues as unknown[]).indexOf(i) < k) {
        out.push({ path: `${path}[${k}]`, reason: `duplicate issue #${i}` });
      } else if (owner.get(i) !== id) {
        out.push({ path: `${path}[${k}]`, reason: `issue #${i} is also tasks.${owner.get(i)}'s` });
      }
    });
  }
  return out;
}

/** A task's footprint as written; without one, `listed` when it has `files`, else `none`. */
const footprintOf = (t: WaveTask): Footprint =>
  t.footprint ?? { confidence: t.files.length > 0 ? "listed" : "none" };

/** The wave's own tasks (a supervisor-added fixer aside), in file order. */
const fileTasks = (wave: Wave): WaveTask[] =>
  wave.task_order.flatMap((id) => {
    const t = wave.tasks[id];
    return t === undefined || t.synthetic === true ? [] : [t];
  });

/** Whether `t.after`'s `dep` is a chain the planner added: its why names it (`after <dep>: …`). */
const chainedAfter = (t: WaveTask, dep: TaskId): boolean =>
  (t.plan?.why ?? "").includes(`after ${dep}: `);

/**
 * The wave file's own overlap plan (SPEC §4.6.22): clusters rebuilt from `plan.cluster` (a bundle
 * is a collapse, an `after` the planner added a chain, more tasks than
 * `plan_cluster_in_flight_max` a cap), each with its hot files sized from `tree` (0 without one).
 * `explain` words it as it words `planWave`'s.
 */
export function filePlan(wave: Wave, tree: Tree = {}): Plan {
  const tasks: PlannedTask[] = fileTasks(wave).map((t) => ({
    id: t.id,
    issue: t.issue,
    issues: t.issues ?? [t.issue],
    ...(t.title !== undefined ? { title: t.title } : {}),
    after: t.after,
    files: t.files,
    footprint: footprintOf(t),
    plan: {
      ...(t.plan?.cluster !== undefined ? { cluster: t.plan.cluster } : {}),
      by: t.plan?.by ?? "independent",
      why: t.plan?.why ?? "",
    },
  }));
  const groups = new Map<string, PlannedTask[]>();
  for (const t of tasks) {
    const c = t.plan.cluster;
    if (c !== undefined) groups.set(c, [...(groups.get(c) ?? []), t]);
  }
  const ids = [...groups.keys()].sort((a, b) => a.length - b.length || a.localeCompare(b));
  const clusters: PlanCluster[] = ids.map((id) => {
    const members = [...(groups.get(id) ?? [])].sort((a, b) => a.issue - b.issue);
    const inCluster = new Set(members.map((m) => m.id));
    const strategy: PlanStrategy = {};
    const collapse = members.filter((m) => m.issues.length > 1).map((m) => [m.id]);
    if (collapse.length > 0) strategy.collapse = collapse;
    const chain = members.flatMap((m) =>
      m.after
        .filter((d) => inCluster.has(d) && chainedAfter(wave.tasks[m.id] as WaveTask, d))
        .map((d): [TaskId, TaskId] => [d, m.id]),
    );
    if (chain.length > 0) strategy.chain = chain;
    const max = DAEMON_DEFAULTS.plan_cluster_in_flight_max;
    if (members.length > max || members.some((m) => m.plan.by === "cap")) strategy.cap = max;
    const issues = members.reduce((n, m) => n + m.issues.length, 0);
    return clusterFrom(id, members, strategy, tree, issues);
  });
  return { tasks, clusters };
}

/**
 * Where the file's bundles, `after` and `plan` differ from what the planner would do over its
 * tasks and `tree` (`diffPlan`'s notes; advisory, the file is kept as written). A bundle in the
 * file plans as one task, closing each of its issues.
 */
export function planNotes(wave: Wave, tree: Tree): string[] {
  const own = fileTasks(wave);
  const input: PlanTask[] = own.map((t) => ({
    id: t.id,
    issue: t.issue,
    ...(t.title !== undefined ? { title: t.title } : {}),
    files: t.files,
    footprint: footprintOf(t),
    after: t.after,
  }));
  const plan = planWave({ tasks: input, tree });
  const bundleOf = new Map(own.map((t) => [t.issue, t.issues ?? [t.issue]]));
  const tasks = plan.tasks.map((p) => ({
    ...p,
    issues: [...new Set(p.issues.flatMap((i) => bundleOf.get(i) ?? [i]))].sort((a, b) => a - b),
  }));
  const asWritten: FileTask[] = own.map((t) => ({
    id: t.id,
    issue: t.issue,
    ...(t.issues !== undefined ? { issues: t.issues } : {}),
    after: t.after,
    ...(t.plan !== undefined ? { plan: t.plan } : {}),
  }));
  return diffPlan(asWritten, { tasks, clusters: plan.clusters });
}

/**
 * `host:` as a name (`local`, `auto`, a config `hosts.<name>`) plus the inline spec when there is
 * one. No `host:` is `auto` under the wave's placement `auto` (its own, or the default), else `local`.
 */
function normaliseHost(
  h: RawTask["host"],
  placement: "auto" | "local",
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
