import { parseArgs } from "node:util";
import { daemonAuth } from "../broker-auth";
import { defaultsFor } from "../config-defaults";
import { volleydHome } from "../config-store";
import { resolveTarget } from "../control";
import { Daemon, type DaemonOptions, type SpawnerOptions } from "../daemon";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { ghIssueBody } from "../overlap";

const HELP = `Usage: volleyd daemon [--broker-url <url>] [--namespace <ns>] [--no-spawn] [--no-mint]

Run the supervisor in the foreground until SIGINT/SIGTERM. Exits 1 if the broker connection is
lost (launchd then restarts it). State lives in $VOLLEYD_HOME (default ~/.volley/volleyd);
only one daemon may use a home at a time. \`volleyd install\` runs this under launchd instead.
Broker credentials: $VOLLEYD_HOME/broker.json (mode 0600; \`volley auth init --volleyd-file\`),
else VOLLEY_AUTH_USERNAME / VOLLEY_AUTH_PASSWORD, else anonymous.

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
      ...daemonStartOptions(target, env, spawner),
      // With the spawner on, `stop` presses Escape in the agent's workspace and resolved
      // decisions land in the task's worktree (`.volley/decisions.md`); both from agent_spawned.
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

/**
 * What `volleyd daemon` starts the daemon with: the home, its broker credentials (`daemonAuth`;
 * throws on an unusable credentials file) and the production issue-body fetcher.
 */
export function daemonStartOptions(
  target: { brokerUrl: string; namespace: string },
  env: Record<string, string | undefined>,
  spawner?: SpawnerOptions,
): DaemonOptions {
  const home = volleydHome(env);
  const auth = daemonAuth(home, env);
  return {
    ...target,
    home,
    ...(auth !== null ? { auth } : {}),
    ...(spawner !== undefined ? { spawner } : {}),
    // worktree_root defaults to $VOLLEYD_HOME/worktrees when VOLLEYD_HOME is set.
    configDefaults: defaultsFor(env),
    issueBody: ghIssueBody,
  };
}
