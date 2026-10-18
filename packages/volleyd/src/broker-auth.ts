import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BrokerAuth, authFromEnv, resolveBrokerAuth } from "volley-mcp/config";

/**
 * Broker credentials. The daemon authenticates as the fixed `volleyd` identity from a mode-0600
 * `$VOLLEYD_HOME/broker.json` (written by `volley auth init --volleyd-file`), else from
 * `VOLLEY_AUTH_*`. They never go in the launchd plist (0644, readable by every local user).
 * Control clients (`volleyd status/run/steer/…`) connect with the caller's identity instead.
 */

/** volleyd's credentials file, in `$VOLLEYD_HOME`. */
export const BROKER_FILE = "broker.json";

/** The daemon's credentials: `<home>/broker.json` wins, then `VOLLEY_AUTH_*`; null = anonymous. */
export function daemonAuth(
  home: string,
  env: Record<string, string | undefined>,
): BrokerAuth | null {
  const path = join(home, BROKER_FILE);
  if (!existsSync(path)) return authFromEnv(env);
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} is mode 0${mode.toString(8)}; it holds the broker password, so run: chmod 600 ${path}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`${path}: malformed broker credentials — ${(e as Error).message}`);
  }
  const c = raw as { username?: unknown; password?: unknown } | null;
  if (
    typeof c !== "object" ||
    c === null ||
    typeof c.username !== "string" ||
    c.username === "" ||
    typeof c.password !== "string"
  ) {
    throw new Error(`${path}: must hold a non-empty string username and a string password`);
  }
  return { username: c.username, password: c.password };
}

/**
 * A control client's credentials: the caller's own, resolved like every other Volley client (the
 * identity file's `broker` block in `cwd`, then `VOLLEY_AUTH_*`). The shipped ACL lets only
 * volleyd, the Desk and coordinators write the daemon's mailbox, so this is normally the
 * `coordinator` identity.
 */
export function controlAuth(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): BrokerAuth | null {
  return resolveBrokerAuth(env, cwd);
}

/** Connect-option fields for `auth` (none for an anonymous connect). */
export function authFields(auth: BrokerAuth | null | undefined): {
  username?: string;
  password?: string;
} {
  if (auth == null) return {};
  return {
    username: auth.username,
    ...(auth.password !== undefined ? { password: auth.password } : {}),
  };
}
