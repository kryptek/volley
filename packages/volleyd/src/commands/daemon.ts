import { parseArgs } from "node:util";
import { volleydHome } from "../config-store";
import { resolveTarget } from "../control";
import { Daemon, type SpawnerOptions } from "../daemon";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { ghIssueBody } from "../overlap";

const HELP = `Usage: volleyd daemon [--broker-url <url>] [--namespace <ns>] [--no-spawn] [--no-mint]

Run the supervisor in the foreground until SIGINT/SIGTERM. Exits 1 if the broker connection is
lost (launchd then restarts it). State lives in $VOLLEYD_HOME (default ~/.volley/volleyd);
only one daemon may use a home at a time. \`volleyd install\` runs this under launchd instead.

  --no-spawn   Admit tasks but spawn nothing (the pre-spawn behaviour)
  --no-mint    Do not mint per-agent broker credentials (an open, anonymous broker)
`;

export async function daemon({ argv, env, io }: CommandArgs): Promise<ExitCode> {
  let target: ReturnType<typeof resolveTarget>;
  let spawner: SpawnerOptions | undefined;
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        "broker-url": { type: "string" },
        namespace: { type: "string" },
        "no-spawn": { type: "boolean", default: false },
        "no-mint": { type: "boolean", default: false },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    });
    spawner =
      parsed.values["no-spawn"] === true
        ? undefined
        : { mintCredentials: parsed.values["no-mint"] !== true };
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
      ...(spawner !== undefined ? { spawner } : {}),
      issueBody: ghIssueBody,
      // TODO(T4 spawner): wire `interrupt` (Escape into the agent's cmux workspace, via exec and
      // the fence) and `taskDir` (the task's worktree, so the next stage reads
      // `.volley/decisions.md`). Both need the agent→workspace/worktree mapping T4 introduces;
      // until then `stop` sends only the mailbox cancel and the brief lands under $VOLLEYD_HOME.
      log: (line) => io.stdout(`${new Date().toISOString()} ${line}\n`),
    });
  } catch (e) {
    io.stderr(`volleyd daemon: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
  // Run until a signal (clean stop) or until the daemon dies on its own (broker connection lost):
  // then exit non-zero so launchd's KeepAlive restarts it.
  let onSignal: () => void = () => {};
  const signalled = new Promise<"signal">((resolve) => {
    onSignal = () => resolve("signal");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
  const outcome = await Promise.race([signalled, d.closed]);
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  if (outcome !== "signal") {
    io.stderr(`volleyd daemon: ${outcome.message}; exiting so the service manager restarts it\n`);
    return EXIT.ERROR;
  }
  await d.stop();
  return EXIT.OK;
}
