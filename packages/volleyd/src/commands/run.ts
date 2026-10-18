import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolveTarget, withClient } from "../control";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import type { WaveState } from "../types";
import { parseWaveFile } from "../wave-file";
import { formatWave } from "./status";

const HELP = `Usage: volleyd run <wave.yaml> [--json] [--broker-url <url>] [--namespace <ns>]

Validate a wave file locally, then submit it to the running daemon. Returns as soon as the
daemon has journaled the wave; tasks start as the scheduler admits them.
`;

export async function run({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseRun>;
  let target: ReturnType<typeof resolveTarget>;
  try {
    parsed = parseRun(argv);
    target = resolveTarget(parsed.values, env);
  } catch (e) {
    io.stderr(`volleyd run: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const file = parsed.positionals[0];
  if (file === undefined || parsed.positionals.length > 1) {
    io.stderr(`volleyd run: expected exactly one wave file\n${HELP}`);
    return EXIT.USAGE;
  }

  // Validate locally first: a bad file fails fast, with or without a daemon.
  let text: string;
  try {
    text = await readFile(file, "utf-8");
    parseWaveFile(text, file);
  } catch (e) {
    io.stderr(`volleyd run: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }

  return withClient(target, io, "volleyd run", async (client) => {
    const res = await client.request(
      "run",
      { wave_yaml: text, source: file },
      { text: `volleyd run ${file}` },
    );
    if (!res.ok) {
      io.stderr(`volleyd run: ${res.error ?? "rejected"}\n`);
      return EXIT.ERROR;
    }
    const state = res.result as WaveState;
    if (parsed.values.json === true) io.stdout(`${JSON.stringify(state, null, 2)}\n`);
    else
      io.stdout(`submitted wave ${state.wave} (${state.tasks.length} tasks)\n${formatWave(state)}`);
    return EXIT.OK;
  });
}

function parseRun(argv: string[]) {
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
