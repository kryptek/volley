import { parseArgs } from "node:util";
import { churnCauses } from "../autopilot/digest";
import { formatBriefPreface } from "../brief";
import { systemClock } from "../clock";
import { type ControlTarget, resolveControlTarget, withClient } from "../control";
import type { DecisionPayload } from "../decisions";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { resolveCaller, span } from "../ownership";
import { IN_FLIGHT } from "../scheduler";
import type { TaskState, WaveState } from "../types";
import { formatDecision } from "./decisions";

const HELP = `Usage: volleyd status [wave] [--all] [--json] [--by <agent-id>] [--broker-url <url>] [--namespace <ns>]

Print every live wave the daemon owns (or one wave) from the daemon's live state, with open
decisions and a "needs you" count on the waves the caller owns (--by, else
VOLLEY_AGENT_ID, else the session registered for this directory, else VOLLEY_COORDINATOR).
Archived waves (\`volleyd archive\`) are left out; --all lists them too, with when, by whom
and why each was archived.
--json prints, for one wave, its wave-state payload exactly as published on
volley/_waves/<wave>/state (each task's pr { number, head_sha, ci, checks }, stage_group and
alarms included); without a wave, { waves: [those payloads], agent_logins }.
A placed task shows its host and, under it, every machine the supervisor considered for it,
best first, with its score and the supervisor's one-line why.
Without a wave, a first line counts the broker's agent logins (as last re-read: after each
mint, delete and sweep, and every 30 s), and how many the credential sweeps deleted in total
(--json: agent_logins), then the hard ceiling's count, the agents volleyd runs or is starting
in every wave against hard_ceiling (--json: ceiling { live, max }). With a paired machine
configured, the next says how the supervisor's own machine takes auto-placed tasks
(fleet.local_agents) and whether it is the fallback now (--json: local_agents).
`;

export async function status({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseStatus>;
  let target: ControlTarget;
  try {
    parsed = parseStatus(argv);
    target = resolveControlTarget(parsed.values, env);
  } catch (e) {
    io.stderr(`volleyd status: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const wave = parsed.positionals[0];
  return withClient(target, io, "volleyd status", async (client) => {
    const res = await client.request(
      "status",
      wave !== undefined ? { wave } : parsed.values.all === true ? { all: true } : {},
    );
    if (!res.ok) {
      io.stderr(`volleyd status: ${res.error ?? "failed"}\n`);
      return EXIT.ERROR;
    }
    if (parsed.values.json === true) {
      io.stdout(`${JSON.stringify(res.result, null, 2)}\n`);
      return EXIT.OK;
    }
    const states =
      wave !== undefined ? [res.result as WaveState] : (res.result as { waves: WaveState[] }).waves;
    const kill = (res.result as { kill_switch?: boolean }).kill_switch === true;
    const logins = (res.result as { agent_logins?: { live: number; swept: number } }).agent_logins;
    const localAgents = (res.result as { local_agents?: LocalAgentsView }).local_agents;
    const ceiling = (res.result as { ceiling?: { live: number; max: number } }).ceiling;
    let decisions: DecisionPayload[] = [];
    let caller: string | null = null;
    if (states.some((s) => s.open_decisions.length > 0)) {
      const d = await client.request("decisions", wave !== undefined ? { wave } : {});
      decisions = d.ok ? (d.result as { decisions: DecisionPayload[] }).decisions : [];
      caller = (await resolveCaller(client, parsed.values.by, env)).id;
    }
    io.stdout(
      (kill ? "KILL SWITCH ENGAGED: run is refused until `volleyd resume --all`\n" : "") +
        (logins !== undefined ? `${formatLogins(logins)}\n` : "") +
        (ceiling !== undefined ? `hard ceiling: ${ceiling.live}/${ceiling.max}\n` : "") +
        (localAgents !== undefined ? `${formatLocalAgents(localAgents)}\n` : "") +
        (states.length === 0
          ? "no waves\n"
          : states.map((s) => formatWave(s, { caller, decisions })).join("\n")),
    );
    return EXIT.OK;
  });
}

/**
 * Where a placed task runs and why (SPEC §4.6.15): `on <host> (<by>, <score>)`, then every
 * candidate the supervisor considered, best first, with the line it wrote. Empty when unplaced.
 */
export function formatPlacement(t: TaskState): string {
  const p = t.placement;
  if (p === undefined) return "";
  const score = (n: number | null) => (n === null ? "-" : n.toFixed(2));
  const hostW = Math.max(...p.candidates.map((c) => c.host.length), 1);
  const head = `    on ${p.host} (${p.by}${p.score !== null ? `, ${score(p.score)}` : ""})\n`;
  return (
    head +
    p.candidates
      .map((c) => `      ${c.host.padEnd(hostW)}  ${score(c.score).padEnd(4)}  ${c.line}\n`)
      .join("")
  );
}

/** `agent logins: N live, M swept` (status header, from the daemon's credential sweep). */
export function formatLogins(l: { live: number; swept: number }): string {
  return `agent logins: ${l.live} live, ${l.swept} swept`;
}

/** The own machine's verdict's `local_agents` (readiness.schema.json). */
export interface LocalAgentsView {
  mode: "always" | "fallback" | "never";
  active: boolean;
  why?: string;
}

/**
 * `local agents: fallback (idle: box-a eligible)` / `fallback (active: box-a: tunnel down)` /
 * `always` / `never`: how the supervisor's own machine takes auto-placed tasks (SPEC §4.6.15).
 */
export function formatLocalAgents(l: LocalAgentsView): string {
  if (l.mode !== "fallback") return `local agents: ${l.mode}`;
  const state = l.active ? "active" : "idle";
  return `local agents: fallback (${l.why !== undefined ? `${state}: ${l.why}` : state})`;
}

/**
 * The owner line's presence suffix (SPEC §4.6.1 `coordinator`): `· online`, `· reconnecting`,
 * `· away (autopilot) · last seen 2h ago` (`· away` with autopilot off) or `· gone` with what
 * waits for the owner: the open escalated decisions of the wave, when `decisions` has them, else
 * `something waits for you` (a gate under `merge: manual` or an owner-only inbox item).
 */
function ownerPresence(s: WaveState, decisions: readonly DecisionPayload[], now: number): string {
  const c = s.coordinator;
  if (c === undefined) return "";
  if (c.presence === "online") return " · online";
  if (c.state === "reconnecting") return " · reconnecting";
  if (c.state === "gone") {
    const autopilotOn = s.autopilot?.enabled ?? true;
    const waiting = decisions.filter(
      (d) =>
        d.wave === s.wave &&
        s.open_decisions.includes(d.decision_id) &&
        d.held === undefined &&
        ((d as { escalated?: unknown }).escalated !== undefined || !autopilotOn),
    ).length;
    return waiting > 0
      ? ` · gone · ${waiting} decision${waiting === 1 ? " waits" : "s wait"} for you`
      : " · gone · something waits for you";
  }
  const autopilot = s.autopilot?.enabled === true ? " (autopilot)" : "";
  return ` · away${autopilot} · last seen ${agoText(now - Date.parse(c.last_seen))}`;
}

/** How long ago, as the owner line says it: `40s ago`, `5m ago`, `2h ago`, `3d ago`. */
function agoText(ms: number): string {
  return `${span(ms)} ago`;
}

function parseStatus(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      by: { type: "string" },
      "broker-url": { type: "string" },
      namespace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}

/**
 * Human-readable wave summary: a header line, then one line per task, then its open decisions.
 * The header shows `plan vN`, with `(K tasks pending decision)` when open plan_change decisions
 * (in `ctx.decisions`) wait on K tasks, names the agent a coordinator-name owner acts through
 * (`owner: coord-main (via coordinator-c7d9)`) and the owner's presence (`· online`,
 * `· away (autopilot) · last seen 2h ago`, `· gone · 1 decision waits for you`, `· reconnecting`;
 * `ownerPresence`), gains `needs you: N` when `caller` owns the wave
 * (or is that agent) and N decisions are open, and ends with `alarms: N`, the tasks whose spawn
 * failed and is unrecovered or hold an alarm, plus the wave's own alarms (each on a `!` line).
 */
export function formatWave(
  s: WaveState,
  ctx: { caller?: string | null; decisions?: DecisionPayload[]; now?: number } = {},
): string {
  const open = s.open_decisions.length;
  // A coordinator-name owner acts through the agent bound to it (SPEC §4.6.1).
  const via =
    s.owner !== null && s.coordinator !== undefined && s.coordinator.agent_id !== s.owner
      ? s.coordinator.agent_id
      : undefined;
  const mine = ctx.caller != null && (ctx.caller === s.owner || ctx.caller === via);
  const needs = open > 0 && mine ? `  needs you: ${open}` : "";
  const owner =
    (via !== undefined ? `${s.owner} (via ${via})` : (s.owner ?? "-")) +
    // real clock: `last seen` in a one-shot command's output, not the daemon
    ownerPresence(s, ctx.decisions ?? [], ctx.now ?? systemClock.now());
  const pending = new Set(
    (ctx.decisions ?? [])
      .filter(
        (d) =>
          d.wave === s.wave &&
          d.kind === "plan_change" &&
          d.task !== null &&
          s.open_decisions.includes(d.decision_id),
      )
      .map((d) => d.task),
  ).size;
  const version =
    pending > 0
      ? `plan v${s.version} (${pending} task${pending === 1 ? "" : "s"} pending decision)`
      : `plan v${s.version}`;
  // Open alarms: tasks whose spawn failed and has not recovered since, or with an alarm that holds.
  // And the wave's own (peer_idle_under_load), each shown under the header.
  const waveAlarms = s.alarms ?? [];
  const alarms =
    s.tasks.filter((t) => t.last_error !== undefined || (t.alarms ?? []).length > 0).length +
    waveAlarms.length;
  const waveAlarmLines = waveAlarms.map((a) => `  ! ${a.alarm}: ${a.message}\n`).join("");
  const header =
    `${s.wave}  ${s.status}  ${version}  owner: ${owner}  ` +
    `tasks: ${s.tasks.length}  gates: ${s.gates.length}  decisions: ${open}${needs}  alarms: ${alarms}\n`;
  // Which rules the agents got (absent: a state from before the field).
  const preface = s.brief_preface !== undefined ? `  ${formatBriefPreface(s.brief_preface)}\n` : "";
  const hygiene = s.hygiene_level !== undefined ? `  ${formatHygiene(s)}\n` : "";
  const github = s.github !== undefined ? `  github: ${s.github.slug}\n` : "";
  // What autopilot did in the wave (absent: a state from before autopilot).
  const ap = s.autopilot;
  const autopilot =
    ap !== undefined
      ? `  autopilot: ${ap.enabled ? "on" : "off"} · ${ap.auto_resolved} auto-resolved · ${ap.escalated} escalated\n`
      : "";
  const archived =
    s.archived !== undefined
      ? `  archived ${s.archived.at} by ${s.archived.by}: ${s.archived.reason}\n`
      : "";
  const queue = s.merge_queue !== undefined ? `  ${formatMergeQueue(s.merge_queue)}\n` : "";
  const spawns = s.spawns !== undefined ? `  ${formatSpawns(s.spawns)}\n` : "";
  // The release train (SPEC §4.6.19): the stage running, awaiting its go or failed, and how far
  // the train is (`release: smoke running (2/4 verified)`).
  const r = s.release;
  const cur = r?.stages.find(
    (x) => x.state === "running" || x.state === "awaiting_go" || x.state === "failed",
  );
  const where =
    cur !== undefined
      ? `${cur.name} ${cur.state === "awaiting_go" ? "awaiting go" : cur.state}`
      : "-";
  const release =
    r !== undefined
      ? `  release: ${where} (${r.stages.filter((x) => x.state === "verified").length}/${r.stages.length} verified)\n`
      : "";
  // The overlap plan (SPEC §4.6.22): each cluster, how it runs now, its members in flight, and why.
  const plan = (s.overlap_plan?.clusters ?? [])
    .map((c) => {
      const flying = s.tasks
        .filter((t) => t.cluster === c.id && IN_FLIGHT.has(t.stage))
        .map((t) => t.id);
      const state = flying.length > 0 ? `${c.state}; in flight: ${flying.join(", ")}` : c.state;
      return `  plan: cluster ${c.id} (${state}): ${c.why}\n`;
    })
    .join("");
  const idW = Math.max(...s.tasks.map((t) => t.id.length), 2);
  const rows = s.tasks.map((t) => {
    const why = t.why_waiting !== undefined ? `  ${t.why_waiting}` : "";
    const pr = t.pr !== undefined ? `  PR #${t.pr.number}` : "";
    const skipped = t.reviews_skipped_by_plan === true ? "  reviews skipped by plan" : "";
    const queued = t.queued_steers !== undefined ? `  steer queued (${t.queued_steers})` : "";
    const unacked = t.steer_unacked !== undefined ? `  steer unacked (${t.steer_unacked})` : "";
    const stage = t.stage_label ?? t.stage;
    // A parallel stage group: every role of it, with its agent and state.
    const group = (t.stage_group ?? [])
      .map((g) => `    ${g.role} ${g.agent_id ?? "-"} (${g.state})\n`)
      .join("");
    const alarms = (t.alarms ?? []).map((a) => `    ! ${a.alarm}: ${a.message}\n`).join("");
    // A flake's fixer (SPEC §4.6.16): no issue (its column blank, so the stages line up); what it
    // fixes and for whom.
    const r = t.remediation;
    if (t.synthetic === true && r !== undefined) {
      const closed = r.outcome !== undefined ? ` [${r.outcome}]` : "";
      return `  ${t.id.padEnd(idW)}  ${"".padEnd(7)}${stage.padEnd(14)}fixer for ${(r.for ?? []).join(", ") || "-"} (flake: ${r.test})${closed}${pr}${queued}${unacked}${why}\n${group}${alarms}${formatPlacement(t)}`;
    }
    return `  ${t.id.padEnd(idW)}  #${String(t.issue).padEnd(5)} ${stage.padEnd(14)}${pr}${skipped}${queued}${unacked}${why}\n${group}${alarms}${formatPlacement(t)}`;
  });
  const decisions = (ctx.decisions ?? [])
    .filter((d) => d.wave === s.wave && s.open_decisions.includes(d.decision_id))
    .map((d) => `  ? ${formatDecision(d).trimEnd().replace(/\n/g, "\n    ")}\n`);
  return (
    header +
    spawns +
    waveAlarmLines +
    archived +
    queue +
    release +
    plan +
    autopilot +
    preface +
    hygiene +
    github +
    rows.join("") +
    decisions.join("")
  );
}

/**
 * `spawns: 52 productive / 156 budget · 141 churn (116 branch updates, 25 re-reviews)`: what
 * spent the spawn budget, and the churn that did not (SPEC §4.6.16), by cause.
 */
export function formatSpawns(sp: NonNullable<WaveState["spawns"]>): string {
  const budget = sp.budget !== undefined ? ` / ${sp.budget} budget` : "";
  const causes = sp.churn_by !== undefined ? churnCauses(sp.churn_by) : "";
  const churn = sp.churn > 0 ? ` · ${sp.churn} churn${causes !== "" ? ` (${causes})` : ""}` : "";
  return `spawns: ${sp.productive} productive${budget}${churn}`;
}

/**
 * `merge queue: T3 merging · T5 updating · T7, T9 queued` (SPEC §4.6.17): the queue in merge
 * order, neighbours in the same state named together.
 */
export function formatMergeQueue(q: NonNullable<WaveState["merge_queue"]>): string {
  const runs: { state: string; tasks: string[] }[] = [];
  for (const e of q) {
    const last = runs.at(-1);
    if (last?.state === e.state) last.tasks.push(e.task);
    else runs.push({ state: e.state, tasks: [e.task] });
  }
  return `merge queue: ${runs.map((r) => `${r.tasks.join(", ")} ${r.state}`).join(" · ")}`;
}

/**
 * `hygiene: P1 (public)`, `P3 (private)`, `P1 (unknown)` (the visibility could not be read),
 * `P1 (forced)` (`public_hygiene: on`) or `off`: what the wave's reviewers flag.
 */
function formatHygiene(s: WaveState): string {
  if (s.hygiene_level === "off") return "hygiene: off";
  return `hygiene: ${s.hygiene_level === "p3" ? "P3" : "P1"} (${s.repo_visibility ?? "forced"})`;
}
