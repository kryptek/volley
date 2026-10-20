import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { type ControlTarget, resolveControlTarget, withClient } from "../control";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { type PlanDiff, formatDiff } from "../plan-diff";
import { parseWaveFile } from "../wave-file";

const HELP = `Usage: volleyd diff <wave> <wave.yaml> [--json] [--broker-url <url>] [--namespace <ns>]

Print the structural diff between a submitted wave's current plan and a wave file — tasks added,
removed, and changed (dependencies, issue, pipeline, model) — without submitting anything.
Submit it as the wave's next version with \`volleyd run <wave.yaml>\`.
`;

export async function diff({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseDiff>;
  let target: ControlTarget;
  try {
    parsed = parseDiff(argv);
    target = resolveControlTarget(parsed.values, env);
  } catch (e) {
    io.stderr(`volleyd diff: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const [wave, file] = parsed.positionals;
  if (wave === undefined || file === undefined || parsed.positionals.length > 2) {
    io.stderr(`volleyd diff: expected a wave id and a wave file\n${HELP}`);
    return EXIT.USAGE;
  }

  let text: string;
  try {
    text = await readFile(file, "utf-8");
    parseWaveFile(text, file);
  } catch (e) {
    io.stderr(`volleyd diff: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }

  return withClient(target, io, "volleyd diff", async (client) => {
    const res = await client.request("diff", { wave, wave_yaml: text, source: file });
    if (!res.ok) {
      io.stderr(`volleyd diff: ${res.error ?? "failed"}\n`);
      return EXIT.ERROR;
    }
    const d = res.result as PlanDiff;
    if (parsed.values.json === true) io.stdout(`${JSON.stringify(d, null, 2)}\n`);
    else io.stdout(`${wave} plan v${res.plan?.version ?? "?"} -> ${file}\n${formatDiff(d)}`);
    return EXIT.OK;
  });
}

function parseDiff(argv: string[]) {
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
