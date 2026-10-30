import { parseArgs } from "node:util";
import { daemonAdminAuth, daemonAuth } from "../broker-auth";
import { dateOf, systemClock } from "../clock";
import { defaultsFor } from "../config-defaults";
import { volleydHome } from "../config-store";
import { resolveTarget } from "../control";
import {
  Daemon,
  type DaemonOptions,
  type SpawnerOptions,
  realLocalDoctor,
  realLocalProbe,
} from "../daemon";
import { type CommandArgs, EXIT, type ExitCode } from "../io";
import { ghIssueBody } from "../overlap";

const HELP = `Usage: volleyd daemon [--broker-url <url>] [--namespace <ns>] [--no-spawn] [--no-mint]

Run the supervisor in the foreground until SIGINT/SIGTERM. A lost broker connection is
reconnected with backoff; after 5 minutes without one it exits 1 (launchd then restarts it).
State lives in $VOLLEYD_HOME (default ~/.volley/volleyd); only one daemon may use a home at a time. \`volleyd install\` runs this under launchd instead.
Broker credentials: $VOLLEYD_HOME/broker.json (mode 0600; \`volley auth init --volleyd-file\`),
else VOLLEY_AUTH_USERNAME / VOLLEY_AUTH_PASSWORD, else anonymous. Agent logins are minted and
deleted with the broker's Dynamic Security admin login, $VOLLEYD_HOME/dynsec-admin.json (also
written by --volleyd-file), else $VOLLEY_AUTH_DIR/admin.json; the broker must be mosquitto >= 2.1.

  --no-spawn   Admit tasks but spawn nothing (the pre-spawn behaviour)
  --no-mint    Do not mint per-agent broker logins (an open, anonymous broker)
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
      // The supervisor is its own machine's doctor (SPEC §4.6.15).
      fleet: { localDoctor: realLocalDoctor(), localProbe: realLocalProbe() },
      // With the spawner on, `stop` presses Escape in the agent's workspace and resolved
      // decisions land in the task's worktree (`.volley/decisions.md`); both from agent_spawned.
      // real clock: the log line's timestamp, for the human reading the log
      log: (line) => io.stdout(`${dateOf(systemClock).toISOString()} ${line}\n`),
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
  // Minting needs the dynsec admin login; `--no-mint` (an open broker) needs none.
  const admin = spawner?.mintCredentials === false ? null : daemonAdminAuth(home, env);
  return {
    ...target,
    home,
    ...(auth !== null ? { auth } : {}),
    ...(admin !== null ? { dynsecAdmin: admin } : {}),
    ...(spawner !== undefined ? { spawner } : {}),
    // worktree_root defaults to $VOLLEYD_HOME/worktrees when VOLLEYD_HOME is set.
    configDefaults: defaultsFor(env),
    issueBody: ghIssueBody,
  };
}
