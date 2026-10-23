import { DAEMON_DEFAULTS } from "./config-defaults";
import type { Tree } from "./footprint";
import { globRe, isPattern, sharedFiles } from "./overlap";
import type { Footprint, PlanCluster, PlanStrategy, TaskId, TaskPlan } from "./types";

/**
 * The overlap planner: a weighted overlap graph over the wave's task footprints, clustered by the
 * source files they share; per cluster, strongly coupled tasks collapse into one bundled task (or
 * chain when they cannot bundle), and a big cluster is capped in flight. Every cluster and task
 * carries a one-line why. Pure: the tree (path → bytes) is passed in.
 */
export type { PlanCluster, PlanStrategy, TaskPlan } from "./types";
export type { Tree } from "./footprint";

export interface PlanTask {
  id: TaskId;
  issue: number;
  title?: string;
  files: string[];
  footprint: Footprint;
  after: TaskId[];
}

export interface PlannedTask {
  id: TaskId;
  issue: number;
  /** Every issue the task closes, ascending (one unless it is a bundle). */
  issues: number[];
  title?: string;
  after: TaskId[];
  files: string[];
  footprint: Footprint;
  plan: TaskPlan & { by: NonNullable<TaskPlan["by"]>; why: string };
}

export interface Plan {
  tasks: PlannedTask[];
  clusters: PlanCluster[];
}

/** Bytes per line in `explain`'s "k lines": a stated approximation (bytes drive the maths). */
const BYTES_PER_LINE = 40;
const KILO = 10 ** 3;
const SHOWN_FILES = 2;
const HOT_FILES = 3;

// ---------------------------------------------------------------------------
// Files and weights
// ---------------------------------------------------------------------------

const excluded = (p: string) => p.startsWith("changes/") || p.startsWith("spec/examples/");
const isDoc = (p: string) => p.endsWith(".md") && !excluded(p);

/** A source file: any path but a doc (`*.md`), `changes/**` and `spec/examples/**`. */
export const isSourceFile = (p: string) => !p.endsWith(".md") && !excluded(p);

/** A test file: under a `test/` or `__tests__/` directory, or named `*.test.*` / `*.spec.*`. */
const isTestFile = (p: string) =>
  /(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.\w+$/.test(p);

/**
 * The files a bundle's size is counted in: its source files but tests, the code a reviewer reads
 * (a task's tests travel with it; counting them would leave almost nothing small enough to bundle).
 */
export const isBundleFile = (p: string) => isSourceFile(p) && !isTestFile(p);

/**
 * A file list resolved against the tree once per task: its concrete paths, and the patterns among
 * them (`globRe`/`isPattern` are the footprint matcher's, so the planner and `sharedFiles` agree).
 */
interface Expanded {
  paths: Set<string>;
  patterns: RegExp[];
}

function expand(files: string[], tree: Tree): Expanded {
  const paths = new Set<string>();
  const patterns: RegExp[] = [];
  for (const f of files) {
    if (!isPattern(f)) {
      paths.add(f);
      continue;
    }
    const re = globRe(f);
    patterns.push(re);
    for (const p of Object.keys(tree)) if (re.test(p)) paths.add(p);
  }
  return { paths, patterns };
}

const covers = (x: Expanded, p: string) => x.paths.has(p) || x.patterns.some((re) => re.test(p));

function shared(a: Expanded, b: Expanded): string[] {
  return [...new Set([...a.paths, ...b.paths])].filter((p) => covers(a, p) && covers(b, p)).sort();
}

const bytesOf = (tree: Tree, p: string) => tree[p] ?? 0;

/** Σ bytes of shared source files + `plan_doc_weight` × Σ bytes of shared docs. */
function weight(sharedPaths: string[], tree: Tree): number {
  let w = 0;
  for (const p of sharedPaths) {
    if (isSourceFile(p)) w += bytesOf(tree, p);
    else if (isDoc(p)) w += DAEMON_DEFAULTS.plan_doc_weight * bytesOf(tree, p);
  }
  return w;
}

const sourceBytes = (x: Expanded, tree: Tree) =>
  [...x.paths].filter(isSourceFile).reduce((n, p) => n + bytesOf(tree, p), 0);

function couplingOf(a: Expanded, b: Expanded, tree: Tree): number {
  const min = Math.min(sourceBytes(a, tree), sourceBytes(b, tree));
  return min === 0 ? 0 : weight(shared(a, b), tree) / min;
}

/** `c(a,b) = w(a,b) / min(bytes(a), bytes(b))`, source bytes only; 0 when either has none. */
export function coupling(a: string[], b: string[], tree: Tree): number {
  return couplingOf(expand(a, tree), expand(b, tree), tree);
}

// ---------------------------------------------------------------------------
// The planner
// ---------------------------------------------------------------------------

/** One strongly coupled pair, in the order the planner considers them. */
interface StrongPair {
  a: PlanTask;
  b: PlanTask;
  c: number;
  files: string[];
}

const fmtC = (c: number) => c.toFixed(2);

/** `src/a.ts, src/b.ts +3 more`: the shared source files, biggest first. */
function fileList(files: string[], tree: Tree): string {
  const src = files
    .filter(isSourceFile)
    .sort((x, y) => bytesOf(tree, y) - bytesOf(tree, x) || x.localeCompare(y));
  const more = src.length - SHOWN_FILES;
  return `${src.slice(0, SHOWN_FILES).join(", ")}${more > 0 ? ` +${more} more` : ""}`;
}

const clusterName = (n: number): string =>
  n < 26
    ? String.fromCharCode(65 + n)
    : `${clusterName(Math.floor(n / 26) - 1)}${clusterName(n % 26)}`;

/** Plan a wave: cluster, collapse, chain and cap. Same input → identical output. */
export function planWave(input: { tasks: PlanTask[]; tree: Tree }): Plan {
  const { tasks, tree } = input;
  const ex = new Map(tasks.map((t) => [t.id, expand(t.files, tree)]));
  const exOf = (t: PlanTask) => ex.get(t.id) as Expanded;
  const byIssue = (x: PlanTask, y: PlanTask) => x.issue - y.issue;
  const live = tasks.filter((t) => t.footprint.confidence !== "none");

  // Edges: pairs sharing at least one source file.
  const pairs: StrongPair[] = [];
  const neighbours = new Map<TaskId, PlanTask[]>(live.map((t) => [t.id, []]));
  const sorted = [...live].sort(byIssue);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i] as PlanTask;
      const b = sorted[j] as PlanTask;
      const files = shared(exOf(a), exOf(b));
      if (!files.some(isSourceFile)) continue;
      neighbours.get(a.id)?.push(b);
      neighbours.get(b.id)?.push(a);
      pairs.push({ a, b, c: couplingOf(exOf(a), exOf(b), tree), files });
    }
  }

  // Clusters: connected components, by size descending, then lowest issue.
  const seen = new Set<TaskId>();
  const components: PlanTask[][] = [];
  for (const t of sorted) {
    if (seen.has(t.id) || (neighbours.get(t.id) ?? []).length === 0) continue;
    const comp: PlanTask[] = [];
    const stack = [t];
    seen.add(t.id);
    while (stack.length > 0) {
      const u = stack.pop() as PlanTask;
      comp.push(u);
      for (const v of neighbours.get(u.id) ?? []) {
        if (!seen.has(v.id)) {
          seen.add(v.id);
          stack.push(v);
        }
      }
    }
    components.push(comp.sort(byIssue));
  }
  components.sort((x, y) => y.length - x.length || (x[0]?.issue ?? 0) - (y[0]?.issue ?? 0));
  const clusterOf = new Map<TaskId, string>();
  components.forEach((comp, n) => {
    for (const t of comp) clusterOf.set(t.id, clusterName(n));
  });

  // Units: a task, or the bundle it collapsed into (keyed by its lowest-issue member's id).
  const unitOf = new Map<TaskId, TaskId>(tasks.map((t) => [t.id, t.id]));
  const members = new Map<TaskId, PlanTask[]>(tasks.map((t) => [t.id, [t]]));
  const collapseWhy = new Map<TaskId, string[]>();
  const unit = (id: TaskId) => unitOf.get(id) ?? id;
  const unitBytes = (u: TaskId) => {
    const all = new Set((members.get(u) ?? []).flatMap((m) => [...exOf(m).paths]));
    return [...all].filter(isSourceFile).reduce((n, p) => n + bytesOf(tree, p), 0);
  };
  const unitIssue = (u: TaskId) => members.get(u)?.[0]?.issue ?? 0;

  /** Unit dependency edges (declared `after`, mapped to units, plus chains); u → its afters. */
  const chains: [TaskId, TaskId][] = [];
  function edges(map: (id: TaskId) => TaskId): Map<TaskId, Set<TaskId>> {
    const g = new Map<TaskId, Set<TaskId>>();
    for (const t of tasks) {
      const from = map(t.id);
      const set = g.get(from) ?? new Set<TaskId>();
      for (const d of t.after) if (map(d) !== from) set.add(map(d));
      g.set(from, set);
    }
    for (const [before, after] of chains) g.get(after)?.add(before);
    return g;
  }
  function reaches(g: Map<TaskId, Set<TaskId>>, from: TaskId, to: TaskId): boolean {
    const stack = [from];
    const visited = new Set<TaskId>();
    while (stack.length > 0) {
      const u = stack.pop() as TaskId;
      if (u === to) return true;
      if (visited.has(u)) continue;
      visited.add(u);
      stack.push(...(g.get(u) ?? []));
    }
    return false;
  }

  /** Why two units cannot merge into one bundle, or null when they can. */
  function cannotBundle(u: TaskId, v: TaskId): string | null {
    const all = [...(members.get(u) ?? []), ...(members.get(v) ?? [])];
    const weak = all.find((m) => !["listed", "resolved"].includes(m.footprint.confidence));
    if (weak !== undefined) return `${weak.id}'s footprint is ${weak.footprint.confidence}`;
    if (all.length > DAEMON_DEFAULTS.plan_bundle_issues_max) {
      return `over ${DAEMON_DEFAULTS.plan_bundle_issues_max} issues`;
    }
    const files = new Set(all.flatMap((m) => [...exOf(m).paths].filter(isBundleFile)));
    if (files.size > DAEMON_DEFAULTS.plan_bundle_files_max) {
      return `over ${DAEMON_DEFAULTS.plan_bundle_files_max} source files (tests aside)`;
    }
    // Any cycle the merge makes runs through the merged unit.
    const g = edges((id) => (unit(id) === v ? u : unit(id)));
    const cycles = [...(g.get(u) ?? [])].some((d) => reaches(g, d, u));
    return cycles ? "a declared after runs between them" : null;
  }

  // Collapse: strong pairs, highest coupling first, merge while the bundle fits.
  const strong = pairs
    .filter((p) => p.c >= DAEMON_DEFAULTS.plan_coupling_strong)
    .sort((x, y) => y.c - x.c || x.a.issue - y.a.issue || x.b.issue - y.b.issue);
  const refused: (StrongPair & { reason: string })[] = [];
  for (const p of strong) {
    const [u, v] = [unit(p.a.id), unit(p.b.id)].sort((x, y) => unitIssue(x) - unitIssue(y)) as [
      TaskId,
      TaskId,
    ];
    if (u === v) continue;
    const reason = cannotBundle(u, v);
    if (reason !== null) {
      refused.push({ ...p, reason });
      continue;
    }
    const merged = [...(members.get(u) ?? []), ...(members.get(v) ?? [])].sort(byIssue);
    const root = merged[0]?.id as TaskId;
    const other = root === u ? v : u;
    for (const m of merged) unitOf.set(m.id, root);
    members.set(root, merged);
    members.delete(other);
    collapseWhy.set(root, [
      ...(collapseWhy.get(u) ?? []),
      ...(collapseWhy.get(v) ?? []),
      `${p.a.id} + ${p.b.id} share ${fileList(p.files, tree)} (coupling ${fmtC(p.c)})`,
    ]);
    collapseWhy.delete(other);
  }

  // Chain: a strong pair that could not bundle runs bigger first; never against a declared after.
  // A task joins one chain at most, its strongest: past it the cluster's cap bounds the overlap,
  // where chaining every strong pair would run the cluster one task at a time.
  const notes = new Map<TaskId, string[]>();
  const note = (u: TaskId, s: string) => notes.set(u, [...(notes.get(u) ?? []), s]);
  const chained = new Set<string>();
  for (const p of refused) {
    const [x, y] = [unit(p.a.id), unit(p.b.id)];
    if (x === y || chained.has(x) || chained.has(y)) continue;
    const [first, second] = [x, y].sort(
      (s, t) => unitBytes(t) - unitBytes(s) || unitIssue(s) - unitIssue(t),
    ) as [TaskId, TaskId];
    const what = `share ${fileList(p.files, tree)} (coupling ${fmtC(p.c)}) and cannot bundle: ${p.reason}`;
    const g = edges(unit);
    if (reaches(g, second, first)) continue; // already ordered, bigger first
    if (reaches(g, first, second)) {
      // The chain would cycle: a declared after already orders them, smaller first.
      const ordered = `a declared after already runs ${second} before ${first}, so no chain is added`;
      note(first, `strongly coupled with ${second}: ${what}; ${ordered}`);
      note(second, `strongly coupled with ${first}: ${what}; ${ordered}`);
      continue;
    }
    chains.push([first, second]);
    chained.add(first).add(second);
    note(first, `before ${second}: they ${what}`);
    note(second, `after ${first}: they ${what}`);
  }

  // Clusters' strategies, and each planned task.
  const clusters: PlanCluster[] = components.map((comp, n) => {
    const id = clusterName(n);
    const units = [...new Set(comp.map((t) => unit(t.id)))].sort(
      (x, y) => unitIssue(x) - unitIssue(y),
    );
    const strategy: PlanStrategy = {};
    const collapse = units.filter((u) => (members.get(u) ?? []).length > 1);
    if (collapse.length > 0) {
      strategy.collapse = collapse.map((u) => (members.get(u) ?? []).map((m) => m.id));
    }
    const chain = chains.filter(([a]) => units.includes(a));
    if (chain.length > 0) strategy.chain = chain;
    if (units.length > DAEMON_DEFAULTS.plan_cluster_in_flight_max) {
      strategy.cap = DAEMON_DEFAULTS.plan_cluster_in_flight_max;
    }
    const hot = hotFiles(comp, (t) => exOf(t), tree);
    const cluster: PlanCluster = { id, tasks: units, hot, strategy, state: "planned", why: "" };
    cluster.why = clusterWhy(cluster, comp.length);
    return cluster;
  });

  const planned: PlannedTask[] = [];
  for (const t of tasks) {
    if (unit(t.id) !== t.id) continue;
    const ms = members.get(t.id) ?? [t];
    planned.push(plannedTask(t.id, ms));
  }

  function plannedTask(id: TaskId, ms: PlanTask[]): PlannedTask {
    const first = ms[0] as PlanTask;
    const ids = new Set(ms.map((m) => m.id));
    const after = [
      ...new Set([
        ...ms
          .flatMap((m) => m.after)
          .filter((d) => !ids.has(d))
          .map(unit),
        ...chains.filter(([, b]) => b === id).map(([a]) => a),
      ]),
    ];
    const issues = ms.map((m) => m.issue);
    const out: PlannedTask = {
      id,
      issue: first.issue,
      issues,
      after,
      files: [...new Set(ms.flatMap((m) => m.files))],
      footprint: ms.length === 1 ? first.footprint : bundleFootprint(ms),
      plan: planOf(id, ms),
    };
    if (ms.length > 1) {
      const head = `bundle: ${issues.map((i) => `#${i}`).join(" + ")}`;
      out.title = first.title !== undefined ? `${head} — ${first.title}` : head;
    } else if (first.title !== undefined) out.title = first.title;
    return out;
  }

  function planOf(id: TaskId, ms: PlanTask[]): PlannedTask["plan"] {
    const first = ms[0] as PlanTask;
    if (first.footprint.confidence === "none") return { by: "independent", why: "no footprint" };
    const cluster = clusterOf.get(first.id);
    if (cluster === undefined) return { by: "independent", why: "shares no source file" };
    const c = clusters.find((k) => k.id === cluster) as PlanCluster;
    const why: string[] = [];
    if (ms.length > 1) {
      why.push(
        `collapsed ${ms.map((m) => `#${m.issue}`).join(" + ")}: ${(collapseWhy.get(id) ?? []).join("; ")}`,
      );
    }
    why.push(...(notes.get(id) ?? []));
    const inChain = chains.some(([a, b]) => a === id || b === id);
    if (c.strategy.cap !== undefined) {
      why.push(
        `cluster ${cluster} runs at most ${c.strategy.cap} of its ${c.tasks.length} tasks at once`,
      );
    }
    if (why.length === 0) why.push(`loosely coupled in cluster ${cluster}; runs in parallel`);
    const by =
      ms.length > 1
        ? "collapse"
        : inChain
          ? "chain"
          : c.strategy.cap !== undefined
            ? "cap"
            : "independent";
    return { cluster, by, why: why.join("; ") };
  }

  return { tasks: planned, clusters };
}

function bundleFootprint(ms: PlanTask[]): Footprint {
  const fp: Footprint = {
    confidence: ms.every((m) => m.footprint.confidence === "listed") ? "listed" : "resolved",
  };
  const unresolved = [...new Set(ms.flatMap((m) => m.footprint.unresolved ?? []))];
  if (unresolved.length > 0) fp.unresolved = unresolved;
  return fp;
}

/** The cluster's top files by bytes × tasks sharing them (source files shared by two or more). */
function hotFiles(
  comp: PlanTask[],
  exOf: (t: PlanTask) => Expanded,
  tree: Tree,
): PlanCluster["hot"] {
  const sharers = new Map<string, Set<TaskId>>();
  for (let i = 0; i < comp.length; i++) {
    for (let j = i + 1; j < comp.length; j++) {
      const a = comp[i] as PlanTask;
      const b = comp[j] as PlanTask;
      for (const f of shared(exOf(a), exOf(b)).filter(isSourceFile)) {
        const s = sharers.get(f) ?? new Set<TaskId>();
        s.add(a.id).add(b.id);
        sharers.set(f, s);
      }
    }
  }
  const order = comp.map((t) => t.id);
  return [...sharers]
    .map(([file, s]) => ({
      file,
      bytes: bytesOf(tree, file),
      shared_by: order.filter((id) => s.has(id)),
    }))
    .sort(
      (x, y) =>
        y.bytes * y.shared_by.length - x.bytes * x.shared_by.length || x.file.localeCompare(y.file),
    )
    .slice(0, HOT_FILES);
}

function lines(bytes: number): string {
  const n = bytes / BYTES_PER_LINE;
  return n >= KILO ? `${Math.round(n / KILO)}k lines` : `${Math.round(n)} lines`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `20 tasks share src/daemon.ts (11k lines, 14 tasks), … → 5 bundles (…), 2 chains (…), cap 4 in flight`. */
function clusterWhy(c: PlanCluster, taskCount: number): string {
  const hot = c.hot.map((h) => `${h.file} (${lines(h.bytes)}, ${h.shared_by.length} tasks)`);
  const how: string[] = [];
  const { collapse, chain, cap } = c.strategy;
  if (collapse !== undefined) {
    how.push(
      `${plural(collapse.length, "bundle")} (${collapse.map((b) => b.join("+")).join(", ")})`,
    );
  }
  if (chain !== undefined) {
    how.push(
      `${plural(chain.length, "chain")} (${chain.map(([a, b]) => `${a} → ${b}`).join(", ")})`,
    );
  }
  if (cap !== undefined) how.push(`cap ${cap} in flight`);
  if (how.length === 0) how.push("run in parallel");
  return `${taskCount} tasks share ${hot.join(", ")} → ${how.join(", ")}`;
}

/**
 * The plan in words: one line per cluster, the independent tasks, and the expected branch
 * updates (Σ over clusters of ⌈(n − 1) / train_size_max⌉, plus one per chain) against one PR at
 * a time (one per task after the first).
 */
export function explain(plan: Plan): string[] {
  const out = plan.clusters.map((c) => `cluster ${c.id}: ${c.why}`);
  const independent = plan.tasks.filter((t) => t.plan.cluster === undefined).map((t) => t.id);
  if (independent.length > 0) out.push(`independent: ${independent.join(", ")}`);
  const updates = plan.clusters.reduce(
    (n, c) =>
      n +
      Math.ceil((c.tasks.length - 1) / DAEMON_DEFAULTS.train_size_max) +
      (c.strategy.chain?.length ?? 0),
    0,
  );
  const was = Math.max(0, plan.tasks.reduce((n, t) => n + t.issues.length, 0) - 1);
  out.push(`expected branch updates: ≤ ${updates} (was ≤ ${was} one at a time)`);
  return out;
}

/** A wave file's task, as far as `diffPlan` reads it. */
export interface FileTask {
  id: TaskId;
  issue: number;
  issues?: number[];
  after: TaskId[];
  plan?: TaskPlan;
}

/**
 * Where a wave file's own bundles, `after` and `plan` differ from what `planWave` would do: one
 * note each, in words. Advisory only; the file is kept as written.
 */
export function diffPlan(fileTasks: FileTask[], plan: Plan): string[] {
  const kept = "kept as written";
  const out: string[] = [];
  const fileOf = new Map<number, FileTask>();
  for (const t of fileTasks) for (const i of t.issues ?? [t.issue]) fileOf.set(i, t);
  const issuesKey = (is: number[]) => [...is].sort((a, b) => a - b).join(",");
  const plannedKeys = new Set(plan.tasks.map((t) => issuesKey(t.issues)));

  for (const t of plan.tasks) {
    if (t.issues.length < 2) continue;
    const ids = [...new Set(t.issues.flatMap((i) => fileOf.get(i)?.id ?? []))];
    if (ids.length > 1) {
      out.push(
        `${listWords(ids)} run as separate tasks; the planner would bundle them as ${t.id} — ${kept}`,
      );
    }
  }
  for (const t of fileTasks) {
    const issues = t.issues ?? [t.issue];
    if (issues.length > 1 && !plannedKeys.has(issuesKey(issues))) {
      out.push(
        `${t.id} bundles ${issues.map((i) => `#${i}`).join(" + ")}; the planner would not — ${kept}`,
      );
    }
  }

  const byFileId = new Map(fileTasks.map((t) => [t.id, t]));
  const dependsOn = (from: FileTask, to: FileTask): boolean => {
    const stack = [...from.after];
    const visited = new Set<TaskId>();
    while (stack.length > 0) {
      const id = stack.pop() as TaskId;
      if (id === to.id) return true;
      if (visited.has(id)) continue;
      visited.add(id);
      stack.push(...(byFileId.get(id)?.after ?? []));
    }
    return false;
  };
  const plannedById = new Map(plan.tasks.map((t) => [t.id, t]));
  for (const c of plan.clusters) {
    for (const [a, b] of c.strategy.chain ?? []) {
      const pa = plannedById.get(a);
      const pb = plannedById.get(b);
      const fa = pa !== undefined ? fileOf.get(pa.issue) : undefined;
      const fb = pb !== undefined ? fileOf.get(pb.issue) : undefined;
      if (pa === undefined || pb === undefined || fa === undefined || fb === undefined) continue;
      if (fa.id === fb.id || dependsOn(fb, fa) || dependsOn(fa, fb)) continue;
      // No tree here: a glob still matches the other side's paths, and two globs only themselves.
      const files = sharedFiles(pa.files, pb.files, {}).filter(isSourceFile).sort();
      const more = files.length - SHOWN_FILES;
      const share =
        files.length === 0
          ? `files of cluster ${c.id}`
          : `${files.slice(0, SHOWN_FILES).join(", ")}${more > 0 ? ` +${more} more` : ""}`;
      out.push(
        `${fa.id} and ${fb.id} share ${share} and run in parallel; the planner would chain them — ${kept}`,
      );
    }
  }

  const plannedByIssue = new Map(plan.tasks.flatMap((t) => t.issues.map((i) => [i, t] as const)));
  const where = (p: TaskPlan) =>
    `${p.by ?? "unplanned"}${p.cluster ? ` in cluster ${p.cluster}` : ""}`;
  for (const t of fileTasks) {
    const p = plannedByIssue.get(t.issue)?.plan;
    if (t.plan === undefined || p === undefined) continue;
    if (t.plan.by === p.by && t.plan.cluster === p.cluster) continue;
    out.push(
      `${t.id} is planned by ${where(t.plan)}; the planner would plan it ${where(p)} — ${kept}`,
    );
  }
  return out;
}

const listWords = (xs: string[]) =>
  xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
