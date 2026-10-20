import { parseArgs } from "node:util";
import { volleydHome } from "../config-store";
import { ackCursor } from "../cursors";
import { type CommandArgs, EXIT, type ExitCode } from "../io";

const HELP = `Usage: volleyd ack <wave> --cursor <name> --seq <N>

Advance the named cursor to journal seq N (after acting on every event up to N). Acking an
older seq is a no-op; acking past the end of the journal is an error.
`;

export async function ack({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        cursor: { type: "string" },
        seq: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volleyd ack: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const wave = parsed.positionals[0];
  const { cursor, seq } = parsed.values;
  if (
    wave === undefined ||
    typeof cursor !== "string" ||
    typeof seq !== "string" ||
    !/^[0-9]+$/.test(seq)
  ) {
    io.stderr(
      `volleyd ack: a wave, --cursor and a non-negative integer --seq are required\n${HELP}`,
    );
    return EXIT.USAGE;
  }
  try {
    const r = ackCursor(volleydHome(env), wave, cursor, Number.parseInt(seq, 10));
    io.stdout(`${wave} cursor ${cursor}: ${r.previous} -> ${r.seq}\n`);
    return EXIT.OK;
  } catch (e) {
    io.stderr(`volleyd ack: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
}
