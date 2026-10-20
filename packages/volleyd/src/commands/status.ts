import { parseArgs } from "node:util";
import { formatBriefPreface } from "../brief";
import { type ControlTarget, resolveControlTarget, withClient } from "../control";
import type { DecisionPayload } from "../decisions";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { resolveCaller } from "../ownership";
import type { TaskState, WaveState } from "../types";
import { formatDecision } from "./decisions";

const HELP = `Usage: volleyd status [wave] [--all] [--json] [--by <agent-id>] [--broker-url <url>] [--namespace <ns>]

Print every live wave the daemon owns (or one wave) from the daemon's live state, with open
decisions and a "needs you" count on the waves the caller owns (--by, else VOLLEY_AGENT_ID,
else the session registered for this directory). Archived waves (\`volleyd archive\`) are left
out; --all lists them too, with when, by whom and why each was archived.
--json prints, for one wave, its wave-state payload exactly as published on
volley/_waves/<wave>/state (each task's pr { number, head_sha, ci, checks }, stage_group and
alarms included); without a wave, { waves: [those payloads], agent_logins }.
A placed task shows its host and, under it, every machine the supervisor considered for it,
best first, with its score and the supervisor's one-line why.
Without a wave, a first line counts the broker's agent logins (as last re-read: after each
mint, delete and sweep, and every 30 s), and how many the credential sweeps deleted in total
(--json: agent_logins).
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
 * (in `ctx.decisions`) wait on K tasks, gains `needs you: N` when `caller` owns the wave and N
 * decisions are open, and ends with `alarms: N`, the tasks whose spawn failed and is unrecovered.
 */
export function formatWave(
  s: WaveState,
  ctx: { caller?: string | null; decisions?: DecisionPayload[] } = {},
): string {
  const open = s.open_decisions.length;
  const needs =
    open > 0 && s.owner !== null && s.owner === ctx.caller ? `  needs you: ${open}` : "";
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
  const alarms = s.tasks.filter(
    (t) => t.last_error !== undefined || (t.alarms ?? []).length > 0,
  ).length;
  const header =
    `${s.wave}  ${s.status}  ${version}  owner: ${s.owner ?? "-"}  ` +
    `tasks: ${s.tasks.length}  gates: ${s.gates.length}  decisions: ${open}${needs}  alarms: ${alarms}\n`;
  // Which rules the agents got (absent: a state from before the field).
  const preface = s.brief_preface !== undefined ? `  ${formatBriefPreface(s.brief_preface)}\n` : "";
  const hygiene = s.hygiene_level !== undefined ? `  ${formatHygiene(s)}\n` : "";
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
  const idW = Math.max(...s.tasks.map((t) => t.id.length), 2);
  const rows = s.tasks.map((t) => {
    const why = t.why_waiting !== undefined ? `  ${t.why_waiting}` : "";
    const pr = t.pr !== undefined ? `  PR #${t.pr.number}` : "";
    const skipped = t.reviews_skipped_by_plan === true ? "  reviews skipped by plan" : "";
    const queued = t.queued_steers !== undefined ? `  steer queued (${t.queued_steers})` : "";
    const stage = t.stage_label ?? t.stage;
    // A parallel stage group: every role of it, with its agent and state.
    const group = (t.stage_group ?? [])
      .map((g) => `    ${g.role} ${g.agent_id ?? "-"} (${g.state})\n`)
      .join("");
    const alarms = (t.alarms ?? []).map((a) => `    ! ${a.alarm}: ${a.message}\n`).join("");
    return `  ${t.id.padEnd(idW)}  #${String(t.issue).padEnd(5)} ${stage.padEnd(14)}${pr}${skipped}${queued}${why}\n${group}${alarms}${formatPlacement(t)}`;
  });
  const decisions = (ctx.decisions ?? [])
    .filter((d) => d.wave === s.wave && s.open_decisions.includes(d.decision_id))
    .map((d) => `  ? ${formatDecision(d).trimEnd().replace(/\n/g, "\n    ")}\n`);
  return header + archived + autopilot + preface + hygiene + rows.join("") + decisions.join("");
}

/**
 * `hygiene: P1 (public)`, `P3 (private)`, `P1 (unknown)` (the visibility could not be read),
 * `P1 (forced)` (`public_hygiene: on`) or `off`: what the wave's reviewers flag.
 */
function formatHygiene(s: WaveState): string {
  if (s.hygiene_level === "off") return "hygiene: off";
  return `hygiene: ${s.hygiene_level === "p3" ? "P3" : "P1"} (${s.repo_visibility ?? "forced"})`;
}
