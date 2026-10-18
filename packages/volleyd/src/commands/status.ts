import { parseArgs } from "node:util";
import { resolveTarget, withClient } from "../control";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import type { WaveState } from "../types";

const HELP = `Usage: volleyd status [wave] [--json] [--broker-url <url>] [--namespace <ns>]

Print every wave the daemon owns (or one wave) from the daemon's live state.
--json prints the wave-state payload(s) exactly as published on volley/_waves/<wave>/state.
`;

export async function status({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseStatus>;
  let target: ReturnType<typeof resolveTarget>;
  try {
    parsed = parseStatus(argv);
    target = resolveTarget(parsed.values, env);
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
    io.stdout(states.length === 0 ? "no waves\n" : states.map(formatWave).join("\n"));
    return EXIT.OK;
  });
}

function parseStatus(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      "broker-url": { type: "string" },
      namespace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}

/** Human-readable wave summary: a header line, then one line per task. */
export function formatWave(s: WaveState): string {
  const pending = s.plan_pending?.length ?? 0;
  const version =
    pending > 0
      ? `plan v${s.version} (${pending} task${pending === 1 ? "" : "s"} pending decision)`
      : `v${s.version}`;
  const header =
    `${s.wave}  ${s.status}  ${version}  owner: ${s.owner ?? "-"}  ` +
    `tasks: ${s.tasks.length}  gates: ${s.gates.length}  decisions: ${s.open_decisions.length}\n`;
  const idW = Math.max(...s.tasks.map((t) => t.id.length), 2);
  const rows = s.tasks.map((t) => {
    const why = t.why_waiting !== undefined ? `  ${t.why_waiting}` : "";
    const pr = t.pr !== undefined ? `  PR #${t.pr.number}` : "";
    return `  ${t.id.padEnd(idW)}  #${String(t.issue).padEnd(5)} ${t.stage.padEnd(14)}${pr}${why}\n`;
  });
  return header + rows.join("");
}
