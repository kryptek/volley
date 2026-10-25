import { isMap, parseDocument } from "yaml";
import { type Tree, footprintOf } from "./footprint";
import type { IssueFacts } from "./issue";
import { assignTaskIds, parseDependsOn } from "./issue-task";
import type { Footprint, TaskId, Wave } from "./types";
import { parseWaveFile } from "./wave-file";

/**
 * `volleyd add`'s plan: the wave file with the call's issues added as tasks, derived as
 * volley-issues' `wave-from-issues` derives them on day one, or why not. Pure: the command
 * fetches the issues and the tree, asks the daemon, writes the file and submits.
 */

/** The volleyd label a task's issue carries from its merge until the release reaches main. */
const MERGED_TO_RELEASE = "merged-to-release";

/** What `checkAdd` needs: the file as it is, the wave id, the call's issues and `--after`. */
export interface AddCheck {
  text: string;
  wave: string;
  issues: number[];
  after: string[];
}

export interface AddInput {
  /** The wave file as it is (the daemon's plan, `diff` said unchanged). */
  text: string;
  source?: string;
  wave: string;
  /** The call's issues, fetched (`fetchIssueFacts`), in the order given. */
  issues: IssueFacts[];
  /** The dependencies outside the wave and the call, fetched (`need` names them). */
  facts: ReadonlyMap<number, IssueFacts>;
  /** `--after`: existing task ids every added task waits for too. */
  after: string[];
  /** The release branch's tree; null when there is none here (footprints `none`). */
  tree: Tree | null;
  /** `owner/repo` of the wave's repository: qualified references to it are accepted. */
  slug?: string;
}

/** A task `add` writes. */
export interface AddedTask {
  id: TaskId;
  issue: number;
  title: string;
  after: TaskId[];
}

export type AddPlan =
  | { text: string; added: AddedTask[]; warnings: string[]; notes: string[] }
  /** Refused; `usage`: the command line was wrong (exit 2). */
  | { refused: string; usage?: true }
  /** These dependencies are outside the wave and the call: fetch them and plan again. */
  | { need: number[] };

/** Each issue of the wave's tasks (`issue:` and a bundle's `issues:`) and the task carrying it. */
function issueTasks(wave: Wave): Map<number, TaskId> {
  const out = new Map<number, TaskId>();
  for (const id of wave.task_order) {
    const t = wave.tasks[id];
    if (t === undefined || t.synthetic === true) continue;
    for (const n of [t.issue, ...(t.issues ?? [])]) if (!out.has(n)) out.set(n, id);
  }
  return out;
}

/** The wave's own tasks, in file order. */
const fileTasks = (wave: Wave): TaskId[] =>
  wave.task_order.filter((id) => wave.tasks[id]?.synthetic !== true);

/**
 * What can be refused before any issue is fetched: an `--after` that is no task of the wave
 * (usage), an issue that is already one of its tasks. Null when neither.
 */
export function checkAdd(c: AddCheck): { refused: string; usage?: true } | null {
  const wave = parseWaveFile(c.text);
  if (wave.wave !== c.wave)
    return { refused: `the file is for wave '${wave.wave}', not '${c.wave}'` };
  const ids = fileTasks(wave);
  const unknown = c.after.filter((a) => !ids.includes(a));
  if (unknown.length > 0) {
    return {
      refused: `--after ${unknown.join(", ")}: no such task in wave ${c.wave} (its tasks: ${ids.join(", ")})`,
      usage: true,
    };
  }
  const carried = issueTasks(wave);
  for (const n of c.issues) {
    const task = carried.get(n);
    if (task !== undefined) return { refused: `#${n} is already in wave ${c.wave} as ${task}` };
  }
  return null;
}

/** JSON is valid YAML: a JSON string is a double-quoted scalar, a JSON array a flow sequence. */
const q = (v: unknown) => JSON.stringify(v);

/**
 * The `host:` every task of the file writes, when they all write the same one (a wave
 * `wave-from-issues --placement <machine>` pinned): the added task is pinned there too.
 */
function pinnedHost(text: string): string | undefined {
  const tasks = (parseDocument(text).toJS() as { tasks?: Record<string, { host?: unknown }> })
    .tasks;
  const hosts = new Set(Object.values(tasks ?? {}).map((t) => t?.host));
  const [host] = hosts;
  return hosts.size === 1 && typeof host === "string" ? host : undefined;
}

/**
 * `text` with `block` (whole lines) inserted after the last line of the `tasks:` map, found
 * through the YAML AST, so every byte of the file around it is kept.
 */
function insertTasks(text: string, block: string): string {
  const tasks = parseDocument(text).get("tasks", true);
  if (!isMap(tasks) || tasks.flow === true || tasks.range == null) {
    throw new Error("the wave file's tasks: is not a block mapping; add the task by hand");
  }
  const end = tasks.range[2];
  if (end > 0 && text[end - 1] === "\n") return `${text.slice(0, end)}${block}${text.slice(end)}`;
  const nl = text.indexOf("\n", end);
  if (nl === -1) return `${text}\n${block}`;
  return `${text.slice(0, nl + 1)}${block}${text.slice(nl + 1)}`;
}

/** Plan adding the call's issues to the wave (D4–D6 of #606). */
export function planAdd(input: AddInput): AddPlan {
  const numbers = [...new Set(input.issues.map((i) => i.number))];
  const pre = checkAdd({ text: input.text, wave: input.wave, issues: numbers, after: input.after });
  if (pre !== null) return pre;
  const wave = parseWaveFile(input.text, input.source);
  const issues = numbers.flatMap((n) => input.issues.find((i) => i.number === n) ?? []);
  for (const i of issues) {
    if (i.state === "CLOSED")
      return { refused: `#${i.number} is closed; reopen it or pick another issue` };
  }
  const carried = issueTasks(wave);
  const inCall = new Set(numbers);
  const deps = new Map<number, { declared: boolean; refs: number[] }>();
  for (const i of issues) {
    try {
      deps.set(i.number, parseDependsOn(i.body, input.slug));
    } catch (e) {
      return { refused: `#${i.number}: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (deps.get(i.number)?.refs.includes(i.number)) {
      return { refused: `#${i.number} depends on itself` };
    }
  }
  const outside = [...deps.values()]
    .flatMap((d) => d.refs)
    .filter((r, k, all) => !carried.has(r) && !inCall.has(r) && all.indexOf(r) === k);
  const need = outside.filter((r) => !input.facts.has(r));
  if (need.length > 0) return { need };

  let assigned: ReturnType<typeof assignTaskIds>;
  try {
    assigned = assignTaskIds(issues, fileTasks(wave));
  } catch (e) {
    return { refused: e instanceof Error ? e.message : String(e) };
  }
  const { ids, warnings } = assigned;
  const notes: string[] = [];
  const added: AddedTask[] = [];
  const host = pinnedHost(input.text);
  let block = "";
  for (const i of issues) {
    const d = deps.get(i.number) ?? { declared: false, refs: [] };
    if (!d.declared) {
      notes.push(`no Depends on:/deps: line in #${i.number}; it starts as soon as it is admitted`);
    }
    const after: TaskId[] = [];
    for (const ref of d.refs) {
      const id = carried.get(ref) ?? ids.get(ref);
      if (id !== undefined) {
        after.push(id);
        continue;
      }
      const f = input.facts.get(ref);
      const merged = f?.labels.includes(MERGED_TO_RELEASE) === true;
      if (f?.state === "CLOSED" || merged) {
        notes.push(
          `#${ref} is ${f?.state === "CLOSED" ? "closed" : "merged to the release"}: #${i.number}'s dependency on it is satisfied`,
        );
        continue;
      }
      return {
        refused: `#${i.number} depends on #${ref}, which is not in wave ${input.wave} and is open: add it too (volleyd add ${input.wave} ${[ref, ...numbers].join(" ")}) or close it first`,
      };
    }
    for (const a of input.after) after.push(a);
    const uniq = [...new Set(after)];
    const fp = footprintOf(i.body, input.tree ?? {});
    const footprint: Footprint = {
      confidence: fp.confidence,
      ...(fp.unresolved.length > 0 ? { unresolved: fp.unresolved } : {}),
    };
    const id = ids.get(i.number) ?? `i${i.number}`;
    // The lines `wave-from-issues` writes for a task (no plan: the planner is a first-submit affair).
    const lines = [`  ${id}:`, `    issue: ${i.number}`];
    if (host !== undefined) lines.push(`    host: ${q(host)}`);
    if (i.title !== "") lines.push(`    title: ${q(i.title)}`);
    if (uniq.length > 0) lines.push(`    after: [${uniq.join(", ")}]`);
    if (fp.files.length > 0) lines.push(`    files: ${q(fp.files)}`);
    lines.push(`    footprint: ${q(footprint)}`);
    block += `${lines.join("\n")}\n`;
    added.push({ id, issue: i.number, title: i.title, after: uniq });
  }
  const text = insertTasks(input.text, block);
  // The result must validate: an id or dependency that does not is a bug here, not the user's.
  try {
    parseWaveFile(text, input.source);
  } catch (e) {
    throw new Error(
      `volleyd add derived a wave file that does not validate (a bug in volleyd add): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { text, added, warnings, notes };
}
