import { parseArgs } from "node:util";
import { formatBriefPreface } from "../brief";
import { type ControlTarget, resolveControlTarget, withClient } from "../control";
import type { DecisionPayload } from "../decisions";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { resolveCaller } from "../ownership";
import type { WaveState } from "../types";
import { formatDecision } from "./decisions";

const HELP = `Usage: volleyd status [wave] [--json] [--by <agent-id>] [--broker-url <url>] [--namespace <ns>]

Print every wave the daemon owns (or one wave) from the daemon's live state, with open
decisions and a "needs you" count on the waves the caller owns (--by, else VOLLEY_AGENT_ID,
else the session registered for this directory).
--json prints the wave-state payload(s) exactly as published on volley/_waves/<wave>/state.
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
    const res = await client.request("status", wave !== undefined ? { wave } : {});
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
    let decisions: DecisionPayload[] = [];
    let caller: string | null = null;
    if (states.some((s) => s.open_decisions.length > 0)) {
      const d = await client.request("decisions", wave !== undefined ? { wave } : {});
      decisions = d.ok ? (d.result as { decisions: DecisionPayload[] }).decisions : [];
      caller = (await resolveCaller(client, parsed.values.by, env)).id;
    }
    io.stdout(
      (kill ? "KILL SWITCH ENGAGED: run is refused until `volleyd resume --all`\n" : "") +
        (states.length === 0
          ? "no waves\n"
          : states.map((s) => formatWave(s, { caller, decisions })).join("\n")),
    );
    return EXIT.OK;
  });
}

function parseStatus(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
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
  // Open alarms: tasks whose spawn failed and has not recovered since.
  const alarms = s.tasks.filter((t) => t.last_error !== undefined).length;
  const header =
    `${s.wave}  ${s.status}  ${version}  owner: ${s.owner ?? "-"}  ` +
    `tasks: ${s.tasks.length}  gates: ${s.gates.length}  decisions: ${open}${needs}  alarms: ${alarms}\n`;
  // Which rules the agents got (absent: a state from before the field).
  const preface = s.brief_preface !== undefined ? `  ${formatBriefPreface(s.brief_preface)}\n` : "";
  const idW = Math.max(...s.tasks.map((t) => t.id.length), 2);
  const rows = s.tasks.map((t) => {
    const why = t.why_waiting !== undefined ? `  ${t.why_waiting}` : "";
    const pr = t.pr !== undefined ? `  PR #${t.pr.number}` : "";
    const skipped = t.reviews_skipped_by_plan === true ? "  reviews skipped by plan" : "";
    return `  ${t.id.padEnd(idW)}  #${String(t.issue).padEnd(5)} ${t.stage.padEnd(14)}${pr}${skipped}${why}\n`;
  });
  const decisions = (ctx.decisions ?? [])
    .filter((d) => d.wave === s.wave && s.open_decisions.includes(d.decision_id))
    .map((d) => `  ? ${formatDecision(d).trimEnd().replace(/\n/g, "\n    ")}\n`);
  return header + preface + rows.join("") + decisions.join("");
}
