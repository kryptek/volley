import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import pkg from "../../package.json";
import { volleydHome } from "../auth/context";
import { pairedPeers } from "../deploy/peers";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { type ExecResult, type MachineDeps, machineAdd } from "../machine/add";
import { readHostKeys } from "../machine/ssh";
import { askVolleyd, defaultName, replyKeyPair, unseal } from "./peer";
import { lanAddress } from "./setup";

/**
 * `volley machine add <user@host>`: install Volley on a bare box in peer mode, pair it, sign it in
 * and print its readiness row, from the supervisor's machine (src/machine/add.ts).
 */

const HELP = `Usage:
  volley machine add <user@host> [--name <name>] [--hub <user@address>] [--no-signin]

Makes a bare box (macOS or Ubuntu/Debian, reachable over ssh) a ready paired machine, from this
one (the supervisor's): installs this machine's ssh key there (one interactive ssh: any prompt is
ssh's own; every later step is BatchMode), installs Volley in peer mode at this machine's release
tag (install.sh --peer; sudo on the box only when it lacks git, tmux, curl or gh, announced first),
runs \`volley setup --peer\` there, authorizes the box's key here, pairs it (a code bound to its
name, redeemed with \`volley peer join\`), signs it in to GitHub (\`gh auth login --web\` over ssh -t)
and Claude (volleyd's remote sign-in: the link is printed), and prints its readiness row from
\`volley peer doctor\`. Rerunning it on a paired box changes nothing and prints the row.

Repositories need no flag: this machine's repositories for all machines reach the box through
the clone orchestration; \`volley repo add <owner/name> --machines <name>\` adds one for it alone.

Options:
  --name <name>          The machine's name (default: the host's short name, lower-cased)
  --hub <user@address>   How the box reaches this machine over ssh (default: $USER@<this
                         machine's LAN address>)
  --no-signin            Defer the two sign-ins (the row says what is missing)
  --broker-url <url>     MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --namespace <ns>       volleyd's namespace (env: VOLLEY_NAMESPACE; default: default)
  --username <user>      An admin account (env: VOLLEY_AUTH_USERNAME): the pairing code is an
                         admin op
  --password <pw>        Its password (env: VOLLEY_AUTH_PASSWORD)
  --timeout <seconds>    How long to wait for volleyd's answer (default 30)

Exit status: 0 the box is ready; 1 it is not (the row says why), or a step failed; 2 a usage error.
`;

const OPTIONS = {
  name: { type: "string" },
  hub: { type: "string" },
  "no-signin": { type: "boolean" },
  "broker-url": { type: "string" },
  namespace: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  timeout: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** An ssh destination: `[user@]host`, never an option, no whitespace or quote. */
const TARGET_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*@?[A-Za-z0-9_.:[\]-]*$/;

export interface MachineArgs {
  argv: string[];
  env: Record<string, string | undefined>;
  io: IO;
}

export function machine(args: MachineArgs): Promise<ExitCode> {
  return runMachine(args);
}

export async function runMachine(
  { argv, env, io }: MachineArgs,
  injected?: (flags: Record<string, string | undefined>) => MachineDeps,
): Promise<ExitCode> {
  const [verb, ...rest] = argv;
  if (verb === undefined || verb === "--help" || verb === "-h") {
    (verb === undefined ? io.stderr : io.stdout)(HELP);
    return verb === undefined ? EXIT.USAGE : EXIT.OK;
  }
  if (verb !== "add") {
    io.stderr(`volley machine: unknown verb '${verb}'\n\n${HELP}`);
    return EXIT.USAGE;
  }
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    io.stderr(`volley machine add: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  const v = parsed.values;
  if (v.help === true) {
    io.stdout(HELP);
    return EXIT.OK;
  }
  const usage = (msg: string) => {
    io.stderr(`volley machine add: ${msg}\n`);
    return EXIT.USAGE;
  };
  if (parsed.positionals.length !== 1) return usage("needs exactly one <user@host>");
  const target = parsed.positionals[0] as string;
  if (!TARGET_RE.test(target)) return usage(`"${target}" is not an ssh destination (user@host)`);
  const host = target.slice(target.lastIndexOf("@") + 1);
  const name = v.name ?? defaultName(host);
  if (!NAME_RE.test(name)) {
    return usage(`name "${name}" must match [a-z0-9][a-z0-9_-]{0,62} (pass --name)`);
  }
  const user = env.USER ?? env.LOGNAME ?? userInfo().username;
  const hub = v.hub ?? `${user}@${lanAddress()}`;
  if (!TARGET_RE.test(hub)) return usage(`--hub "${hub}" is not an ssh destination (user@address)`);
  const flags: Record<string, string | undefined> = {
    "broker-url": v["broker-url"],
    namespace: v.namespace,
    username: v.username,
    password: v.password,
    timeout: v.timeout,
  };
  const deps = injected !== undefined ? injected(flags) : realDeps(env, io, flags);
  return machineAdd({ target, name, hub, signin: v["no-signin"] !== true }, deps, io);
}

/** A command run for real: argv only, never a shell; a tty command gets the terminal. */
function spawnExec(argv: string[], opts?: { input?: string; tty?: boolean }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const [bin, ...args] = argv;
    const child = spawn(bin as string, args, {
      stdio: opts?.tty === true ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: e.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts?.input ?? "");
  });
}

function realDeps(
  env: Record<string, string | undefined>,
  io: IO,
  flags: Record<string, string | undefined>,
): MachineDeps {
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const installer = fileURLToPath(new URL("../../../../install.sh", import.meta.url));
  return {
    exec: spawnExec,
    home: env.HOME ?? homedir(),
    platform: process.platform,
    version: pkg.version,
    installer: () => readFileSync(installer, "utf-8"),
    volleyArgv: [process.execPath, cli],
    paired: () => {
      const { peers, problems } = pairedPeers(volleydHome(env));
      return [...peers.map((p) => p.name), ...problems.map((p) => p.name)];
    },
    hostKeys: () => readHostKeys(),
    mintCode: async (name) => {
      const key = replyKeyPair();
      const a = await askVolleyd(
        "volley machine add",
        "peer_invite",
        { for: name, reply_key: key.jwk },
        flags,
        env,
        io,
        true,
      );
      if (typeof a === "number") return null;
      const code = unseal(key.privateKey, a.sealed)?.code;
      if (typeof code !== "string") {
        io.stderr("volley machine add: volleyd's answer carried no code\n");
        return null;
      }
      return code;
    },
  };
}
