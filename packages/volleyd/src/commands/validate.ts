import { parseArgs } from "node:util";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { criticalPaths } from "../scheduler";
import { loadWaveFile } from "../wave-file";

const HELP = `Usage: volleyd validate <wave.yaml>

Parse and validate a wave file locally (no daemon needed). Exit 0 when valid, 1 with
path-qualified errors when not.
`;

export async function validate({ argv, io }: CommandArgs): Promise<ExitCode> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      options: { help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    });
  } catch (e) {
    io.stderr(`volleyd validate: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }
  if (parsed.values.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const file = parsed.positionals[0];
  if (file === undefined || parsed.positionals.length > 1) {
    io.stderr(`volleyd validate: expected exactly one wave file\n${HELP}`);
    return EXIT.USAGE;
  }
  try {
    const wave = await loadWaveFile(file);
    const cp = criticalPaths(wave);
    const longest = Math.max(...Object.values(cp));
    io.stdout(
      `ok: wave ${wave.wave} v${wave.version} — ${wave.task_order.length} task(s), ` +
        `critical path ${longest}, release branch ${wave.release_branch}\n`,
    );
    return EXIT.OK;
  } catch (e) {
    io.stderr(`volleyd validate: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
}
