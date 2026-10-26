import { parseArgs } from "node:util";
import { VolleyError } from "volley-mcp/errors";
import { resolveBrokerUrl } from "../args";
import { withSetupAuthDir } from "../auth/coordinator-login";
import {
  type BrokerResult,
  type LoginKind,
  type ResolvedLogin,
  describeLogin,
  loginLines,
  resolveLogin,
} from "../auth/login";
import { DYNSEC_ADMIN_USER, FIXED_IDENTITIES } from "../auth/roles";
import { openClient, reportUnreachable } from "../connect";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import type { Probes } from "../supervisor/probes";
import { readAccounts } from "./auth-accounts";

/**
 * `volley auth status [--json]`: the login this shell's commands use — who, what this machine
 * knows of it, which step of the ladder (auth/login.ts) answered and why the others did not —
 * and whether the broker accepts it. It needs no admin login and never prints a password.
 */

export const AUTH_STATUS_HELP = `Usage: volley auth status [--json]

The broker login this shell's volley and volleyd commands use, found as they find it (flags,
.volley/agent.json, VOLLEY_AUTH_*, the auth dir VOLLEY_AUTH_DIR names, the keychain, the
coordinator.json \`volley setup\` saved), and whether the broker accepts it. Never a password.

Exit: 0 accepted · 1 refused, or no login at all · 69 the broker is unreachable

Options:
  --json               {username, kind, role?, source, path?, broker: {url, result}, skipped}
  --broker-url <url>   MQTT broker URL (env: VOLLEY_BROKER_URL; default: mqtt://localhost:1883)
  --username <user>    Check this login instead (password: --password or VOLLEY_AUTH_PASSWORD)
  --password <pw>      Its password (prefer VOLLEY_AUTH_PASSWORD: argv is visible in ps)
  -h, --help           Show this help and exit
`;

export interface AuthStatusDeps {
  /** Where the ladder's identity file step looks. */
  cwd: string;
  /** The connectivity ladder's probes for an unreachable broker (unset: the real ones). */
  probes?: Probes;
}

/** What this machine knows about `username`: a fixed identity, an account's role, or nothing. */
export function loginKind(username: string, env: Record<string, string | undefined>): LoginKind {
  if ((FIXED_IDENTITIES as readonly string[]).includes(username) || username === DYNSEC_ADMIN_USER)
    return { kind: "fixed" };
  const dir = withSetupAuthDir(env).VOLLEY_AUTH_DIR;
  if (dir === undefined || dir === "") return { kind: "account" };
  try {
    const role = readAccounts(dir).find((a) => a.name === username)?.role;
    return role !== undefined ? { kind: "account", role } : { kind: "account" };
  } catch {
    return { kind: "account" };
  }
}

export async function authStatus(
  argv: string[],
  env: Record<string, string | undefined>,
  io: IO,
  deps: AuthStatusDeps = { cwd: process.cwd() },
): Promise<ExitCode> {
  let v: {
    json?: boolean;
    help?: boolean;
    "broker-url"?: string;
    username?: string;
    password?: string;
  };
  try {
    v = parseArgs({
      args: argv,
      options: {
        json: { type: "boolean" },
        "broker-url": { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (e) {
    io.stderr(`volley auth status: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.USAGE;
  }
  if (v.help === true) {
    io.stdout(AUTH_STATUS_HELP);
    return EXIT.OK;
  }
  const url = resolveBrokerUrl(v["broker-url"], env);
  let login: ResolvedLogin;
  try {
    login = resolveLogin({
      flags: { username: v.username, password: v.password },
      env,
      cwd: deps.cwd,
      brokerUrl: url,
    });
  } catch (e) {
    // A damaged credentials file: its path, never a byte of it (parseCredentialsFile).
    io.stderr(`volley auth status: ${e instanceof Error ? e.message : String(e)}\n`);
    return EXIT.ERROR;
  }

  let result: BrokerResult;
  let unreachable: unknown = null;
  try {
    const b = await openClient(url, login.auth);
    await b.disconnect();
    result = "accepted";
  } catch (e) {
    if (e instanceof VolleyError && e.code === "AUTH_FAILED") {
      result = "refused";
    } else {
      result = "unreachable";
      unreachable = e;
    }
  }

  const kind = login.auth !== null ? loginKind(login.auth.username, env) : null;
  const report = describeLogin(login, kind, { url, result });
  if (v.json === true) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
  else io.stdout(`${loginLines(report).join("\n")}\n`);

  if (result === "unreachable") {
    // The usual diagnosis (internet → network → tunnel → broker) on stderr, and its exit code.
    return reportUnreachable(io, unreachable, url, {
      command: "volley auth status",
      env,
      ...(deps.probes !== undefined ? { probes: deps.probes } : {}),
    });
  }
  if (login.auth === null || result === "refused") return EXIT.ERROR;
  return EXIT.OK;
}
