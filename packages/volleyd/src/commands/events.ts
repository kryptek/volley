import { parseArgs } from "node:util";
import { volleydHome } from "../config-store";
import { eventsAfter } from "../cursors";
import { type CommandArgs, EXIT, type ExitCode } from "../io";

const HELP = `Usage: volleyd events <wave> --cursor <name>

Print, one JSON object per line, every journal event after the named cursor. Does not move the
cursor: run \`volleyd ack <wave> --cursor <name> --seq <N>\` after acting on the events, so
anything not yet acked is printed again next time. Use the wave \`_system\` for global events
(config_changed). Reads $VOLLEYD_HOME directly; works while the daemon is down.
`;

export async function events({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { cursor: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volleyd events: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const wave = parsed.positionals[0];
  const cursor = parsed.values.cursor;
  if (wave === undefined || typeof cursor !== "string") {
    io.stderr(`volleyd events: a wave and --cursor are required\n${HELP}`);
    return EXIT.USAGE;
  }
  try {
    for (const e of eventsAfter(volleydHome(env), wave, cursor))
      io.stdout(`${JSON.stringify(e)}\n`);
    return EXIT.OK;
  } catch (e) {
    io.stderr(`volleyd events: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
}
