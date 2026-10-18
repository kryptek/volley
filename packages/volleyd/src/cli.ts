#!/usr/bin/env bun
import { type Command, type CommandArgs, EXIT, type ExitCode, realIO } from "./io";

const VERSION = "0.1.0-dev";

const USAGE = `Usage: volleyd <command> [options]

Commands:
  daemon      Run the supervisor in the foreground
  install     Install and load the launchd service (macOS)
  uninstall   Unload and remove the launchd service
  run         Validate a wave file and submit it to the daemon
  validate    Validate a wave file locally (no daemon needed)
  status      Show wave state from the daemon
  events      Print journal events after a named cursor
  ack         Advance a named journal cursor
  config      Get or set supervisor config (volleyd config get|set)

Global flags (daemon/install/run/status/config):
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --namespace <ns>     Volley namespace (env: VOLLEY_NAMESPACE; default: default)
State directory: $VOLLEYD_HOME (default: ~/.volley/volleyd)

Run \`volleyd <command> --help\` for per-command options.
`;

/**
 * Command table. Later tasks add one line each here (and their own file under commands/).
 */
const COMMANDS: Record<string, () => Promise<Command>> = {
  daemon: async () => (await import("./commands/daemon")).daemon,
  install: async () => (await import("./commands/install")).install,
  uninstall: async () => (await import("./commands/install")).uninstall,
  run: async () => (await import("./commands/run")).run,
  validate: async () => (await import("./commands/validate")).validate,
  status: async () => (await import("./commands/status")).status,
  events: async () => (await import("./commands/events")).events,
  ack: async () => (await import("./commands/ack")).ack,
  config: async () => (await import("./commands/config")).config,
};

export async function main(args: CommandArgs): Promise<ExitCode> {
  const [name, ...rest] = args.argv;
  if (name === undefined) {
    args.io.stderr(USAGE);
    return EXIT.USAGE;
  }
  if (name === "--help" || name === "-h") {
    args.io.stdout(USAGE);
    return EXIT.OK;
  }
  if (name === "--version" || name === "-V") {
    args.io.stdout(`${VERSION}\n`);
    return EXIT.OK;
  }
  const load = COMMANDS[name];
  if (load === undefined) {
    args.io.stderr(`volleyd: unknown command: ${name}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  try {
    return await (await load())({ argv: rest, env: args.env, io: args.io });
  } catch (e) {
    args.io.stderr(`volleyd: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }
}

// Real-process entry point. `import.meta.main` is Bun-only; under vitest it stays false.
if (import.meta.main) {
  main({ argv: process.argv.slice(2), env: process.env, io: realIO })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`volleyd: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    });
}
