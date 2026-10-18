import { parseArgs } from "node:util";
import { volleydHome } from "../config-store";
import { resolveTarget } from "../control";
import { Daemon } from "../daemon";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { ghIssueBody } from "../overlap";

const HELP = `Usage: volleyd daemon [--broker-url <url>] [--namespace <ns>]

Run the supervisor in the foreground until SIGINT/SIGTERM. State lives in $VOLLEYD_HOME
(default ~/.volley/volleyd). \`volleyd install\` runs this under launchd instead.
`;

export async function daemon({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let target: ReturnType<typeof resolveTarget>;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        "broker-url": { type: "string" },
        namespace: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (parsed.values.help === true) {
      io.stdout(HELP);
      return EXIT.OK;
    }
    target = resolveTarget(parsed.values, env);
  } catch (e) {
    io.stderr(`volleyd daemon: ${e instanceof Error ? e.message : String(e)}\n${HELP}`);
    return EXIT.USAGE;
  }

  let d: Daemon;
  try {
    d = await Daemon.start({
      ...target,
      home: volleydHome(env),
      issueBody: ghIssueBody,
      log: (line) => io.stdout(`${new Date().toISOString()} ${line}\n`),
    });
  } catch (e) {
    io.stderr(`volleyd daemon: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await d.stop();
  return EXIT.OK;
}
