#!/usr/bin/env bun
import { fileSavedLoginDeps, useSavedLogin } from "volley-cli/auth/coordinator-login";
import pkg from "../package.json";
import { type Command, type CommandArgs, EXIT, type ExitCode, realIO } from "./io";

const VERSION = pkg.version;

const USAGE = `Usage: volleyd <command> [options]

Commands:
  daemon      Run the supervisor in the foreground
  install     Install and load the launchd service (macOS)
  uninstall   Unload and remove the launchd service
  run         Validate a wave file and submit it to the daemon (or a new version of it)
  diff        Show the structural diff between a wave's plan and a wave file
  validate    Validate a wave file locally (no daemon needed)
  status      Show wave state from the daemon
  events      Print journal events after a named cursor
  ack         Advance a named journal cursor
  config      Get or set supervisor config (volleyd config get|set)
  admission   Show the spawn admission verdict and its reasons
  spawn       Spawn one task's agent now (worktree, identity, launch, verify)
  cleanup     Remove a wave's retired worktrees and workspaces (--yes)
  decisions   List open decisions
  resolve     Answer a decision (owner only)
  inbox       The needs-you inbox: what waits for a person; inbox answer <id> <answer>
  policy      Show autopilot's policy table: the decisions volleyd answers itself
  claim       Take over a wave whose owner is gone
  pause       Stop admitting new tasks in a wave
  resume      Resume a wave, or release the kill switch (--all)
  stop        Stop a wave and cancel its agents; --all is the kill switch
  steer       Send mailbox steering to a task's agent and report the ack
  merge       Merge one gated task now, at its gated head (owner only)
  merged      Record a gated task merged outside GitHub's merge button (verified; owner only)

Global flags (daemon/install/run/diff/status/config and the wave controls):
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --namespace <ns>     Volley namespace (env: VOLLEY_NAMESPACE; default: default)
State directory: $VOLLEYD_HOME (default: ~/.volley/volleyd)

Run \`volleyd <command> --help\` for per-command options.
`;

/**
 * Command table. A new command is one line here (and its own file under commands/).
 */
const COMMANDS: Record<string, () => Promise<Command>> = {
  daemon: async () => (await import("./commands/daemon")).daemon,
  install: async () => (await import("./commands/install")).install,
  uninstall: async () => (await import("./commands/install")).uninstall,
  run: async () => (await import("./commands/run")).run,
  diff: async () => (await import("./commands/diff")).diff,
  validate: async () => (await import("./commands/validate")).validate,
  status: async () => (await import("./commands/status")).status,
  events: async () => (await import("./commands/events")).events,
  ack: async () => (await import("./commands/ack")).ack,
  config: async () => (await import("./commands/config")).config,
  admission: async () => (await import("./commands/admission")).admission,
  spawn: async () => (await import("./commands/spawn")).spawn,
  cleanup: async () => (await import("./commands/cleanup")).cleanup,
  decisions: async () => (await import("./commands/decisions")).decisions,
  resolve: async () => (await import("./commands/resolve")).resolve,
  inbox: async () => (await import("./commands/inbox")).inbox,
  policy: async () => (await import("./commands/policy")).policy,
  claim: async () => (await import("./commands/claim")).claim,
  pause: async () => (await import("./commands/pause")).pause,
  resume: async () => (await import("./commands/resume")).resume,
  stop: async () => (await import("./commands/stop")).stop,
  steer: async () => (await import("./commands/steer")).steer,
  merge: async () => (await import("./commands/merge")).merge,
  merged: async () => (await import("./commands/merged")).merged,
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
  // Control commands may use the coordinator login setup saved: its coordinator.json, never the
  // keychain (that would start a child process outside exec.ts). Never under a test.
  useSavedLogin(fileSavedLoginDeps);
  main({ argv: process.argv.slice(2), env: process.env, io: realIO })
    .then((code) => process.exit(code))
    .catch((e) => {
      process.stderr.write(`volleyd: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    });
}
