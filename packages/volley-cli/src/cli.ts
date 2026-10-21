#!/usr/bin/env bun
import pkg from "../package.json";
import { parseGlobal } from "./args";
import { realSavedLoginDeps, useSavedLogin } from "./auth/coordinator-login";
import { EXIT, type ExitCode } from "./exit-codes";
import { type IO, realIO } from "./io";

const VERSION = pkg.version;

const USAGE = `Usage: volley <subcommand> [options]

Subcommands:
  pub      Publish one envelope to a Volley channel
  sub      Subscribe to a wildcard topic pattern (live tail)
  wait     Block until an agent reaches a terminal status
  list     Enumerate agents registered on the broker
  dash     Launch the Volley Desk (Vite; --legacy: the old dashboard)
  notify   Long-lived subscriber that fires bell/desktop/webhook on matching events
  auth     Manage broker credentials (init, agents, accounts, one-time tokens)
  lease    Heavy-operation leases from volleyd (run, acquire, release, status)
  claude   Claude account profiles on volleyd (add, signin, list, sync, move)
  peer     Pair machines with volleyd's (invite, join, list, remove)
  setup    First-run / repair wizard: broker, accounts, services, phone sign-in QR
  desk     Serve the built Volley Desk (desk serve) for phones and the setup service
  deploy   Deploy a release tag to this machine's volleyd and Desk services

Global flags:
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --namespace <ns>     Volley namespace (env: VOLLEY_NAMESPACE; default: default)
  --username <user>    Broker username (env: VOLLEY_AUTH_USERNAME; .volley/agent.json "broker" wins over env)
  --password <pw>      Broker password (env: VOLLEY_AUTH_PASSWORD; prefer the env var, argv is visible in ps)
  --help               Show this help and exit
  --version            Print version and exit

Run \`volley <subcommand> --help\` for per-subcommand options.
`;

export interface MainArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

type Subcommand = (args: MainArgs) => Promise<ExitCode>;

/**
 * Subcommand dispatch table. Phase-2..5 tasks populate this map; until then the
 * commands resolve to a stub that prints a not-yet-implemented stderr.
 *
 * The map is built lazily inside `main` so `cli.test.ts` can run against the
 * scaffold before any subcommand exists.
 */
async function loadSubcommand(name: string): Promise<Subcommand | null> {
  switch (name) {
    case "pub":
      return (await import("./commands/pub")).pub as Subcommand;
    case "sub":
      return (await import("./commands/sub")).sub as Subcommand;
    case "wait":
      return (await import("./commands/wait")).wait as Subcommand;
    case "list":
      return (await import("./commands/list")).list as Subcommand;
    case "dash":
      return (await import("./commands/dash")).dash as Subcommand;
    case "notify":
      return (await import("./commands/notify")).notify as Subcommand;
    case "auth":
      return (await import("./commands/auth")).auth as Subcommand;
    case "lease":
      return (await import("./commands/lease")).lease as Subcommand;
    case "claude":
      return (await import("./commands/claude")).claude as Subcommand;
    case "peer":
      return (await import("./commands/peer")).peer as Subcommand;
    case "setup":
      return (await import("./commands/setup")).setup as Subcommand;
    case "desk":
      return (await import("./commands/desk-serve")).desk as Subcommand;
    case "deploy":
      return (await import("./commands/deploy")).deploy as Subcommand;
    default:
      return null;
  }
}

export async function main(args: MainArgs): Promise<ExitCode> {
  const { subcommand, rest } = parseGlobal(args.argv);

  if (subcommand === null) {
    args.io.stderr(USAGE);
    return EXIT.USAGE;
  }
  if (subcommand === "--help" || subcommand === "-h") {
    args.io.stdout(USAGE);
    return EXIT.OK;
  }
  if (subcommand === "--version" || subcommand === "-V") {
    args.io.stdout(`${VERSION}\n`);
    return EXIT.OK;
  }

  const cmd = await loadSubcommand(subcommand);
  if (cmd === null) {
    args.io.stderr(`volley: unknown subcommand: ${subcommand}\n\n${USAGE}`);
    return EXIT.USAGE;
  }

  try {
    return await cmd({ argv: rest, env: args.env, io: args.io });
  } catch (e) {
    // Subcommands print their own contextual stderr before throwing. This is the last-
    // line safety net for anything that escapes.
    const msg = e instanceof Error ? e.message : String(e);
    args.io.stderr(`volley: ${msg}\n`);
    return EXIT.ERROR;
  }
}

// Real-process entry point. `import.meta.main` is Bun-only; under vitest it stays false.
if (import.meta.main) {
  // The operator's own commands may use the coordinator login setup saved (never under a test).
  useSavedLogin(realSavedLoginDeps);
  main({ argv: process.argv.slice(2), env: process.env, io: realIO })
    .then((code) => {
      process.exit(code);
    })
    .catch((e) => {
      // Last-resort: if main itself rejects (e.g. a dynamic import of a command module
      // throws a syntax error), Node would otherwise print an UnhandledPromiseRejection
      // and exit 0. Surface the error explicitly and exit non-zero.
      process.stderr.write(`volley: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
      process.exit(1);
    });
}
