import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { DAEMON_DEFAULTS } from "../config-defaults";
import { resolveTarget, withClient } from "../control";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { resolveCaller } from "../ownership";
import type { WaveState } from "../types";
import { parseWaveFile } from "../wave-file";
import { formatWave } from "./status";

const HELP = `Usage: volleyd run <wave.yaml> [--owner <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Validate a wave file locally, then submit it to the running daemon. Returns as soon as the
daemon has journaled the wave; tasks start as the scheduler admits them.

The wave's owner (the one coordinator allowed to resolve, pause, stop and steer it) is --owner,
else VOLLEY_AGENT_ID, else the session registered for this directory (printed as "(auto)").
Paths a task shares with a running wave's task are printed as overlap warnings (advisory).
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
    const owner = await resolveCaller(client, parsed.values.owner, env);
    if (owner.warning !== undefined) io.stderr(`warning: ${owner.warning}\n`);
    const res = await client.request(
      "run",
      { wave_yaml: text, source: file, ...(owner.id !== null ? { owner: owner.id } : {}) },
      // The daemon fetches each task issue's body (overlap warnings) before it answers.
      {
        text: `volleyd run ${file}`,
        timeoutMs: DAEMON_DEFAULTS.issue_fetch_ms + DAEMON_DEFAULTS.request_timeout_ms,
      },
    );
    if (!res.ok) {
      io.stderr(`volleyd run: ${res.error ?? "rejected"}\n`);
      return EXIT.ERROR;
    }
    const state = res.result as WaveState;
    const warnings = (res.warnings ?? []).map((w) => `warning: ${w}\n`).join("");
    if (parsed.values.json === true) {
      io.stdout(`${JSON.stringify(state, null, 2)}\n`);
      io.stderr(warnings);
    } else {
      const auto = owner.auto ? " (auto)" : "";
      io.stdout(
        `submitted wave ${state.wave} (${state.tasks.length} tasks)\nowner: ${state.owner ?? "none"}${auto}\n${warnings}${formatWave(state)}`,
      );
    }
    return EXIT.OK;
  });
}

function parseRun(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      owner: { type: "string" },
      "broker-url": { type: "string" },
      namespace: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
}
