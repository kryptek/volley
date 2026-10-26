import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SavedLoginDeps } from "volley-cli/auth/coordinator-login";
import { resolveLogin } from "volley-cli/auth/login";
import {
  type BrokerAuth,
  authFromEnv,
  parseCredentialsFile,
  readSecretText,
} from "volley-mcp/config";

/**
 * Broker credentials. The daemon authenticates as the fixed `volleyd` identity from a mode-0600
 * `$VOLLEYD_HOME/broker.json` (written by `volley auth init --volleyd-file`), else from
 * `VOLLEY_AUTH_*`. They never go in the launchd plist (0644, readable by every local user).
 * Control clients (`volleyd status/run/steer/…`) connect with the caller's identity instead.
 */

/** volleyd's credentials file, in `$VOLLEYD_HOME`. */
export const BROKER_FILE = "broker.json";
/**
 * The broker's Dynamic Security admin login volleyd mints and deletes agent logins with, in
 * `$VOLLEYD_HOME` (`volley auth init --volleyd-file`); else `$VOLLEY_AUTH_DIR/admin.json`.
 */
export const ADMIN_FILE = "dynsec-admin.json";

/** The daemon's credentials: `<home>/broker.json` wins, then `VOLLEY_AUTH_*`; null = anonymous. */
export function daemonAuth(
  home: string,
  env: Record<string, string | undefined>,
): BrokerAuth | null {
  const path = join(home, BROKER_FILE);
  if (!existsSync(path)) return authFromEnv(env);
  return readCredentialsFile(path);
}

/**
 * The dynsec admin login: `<home>/dynsec-admin.json`, else `$VOLLEY_AUTH_DIR/admin.json`, else
 * null (volleyd then mints nothing: spawns fail with CREDENTIALS_FAILED unless `--no-mint`).
 */
export function daemonAdminAuth(
  home: string,
  env: Record<string, string | undefined>,
): BrokerAuth | null {
  for (const path of [
    join(home, ADMIN_FILE),
    ...(env.VOLLEY_AUTH_DIR !== undefined ? [join(env.VOLLEY_AUTH_DIR, "admin.json")] : []),
  ]) {
    if (existsSync(path)) return readCredentialsFile(path);
  }
  return null;
}

/**
 * `{username, password}` from a mode-0600 file (anything looser is refused). A damaged file is
 * reported by path only (`parseCredentialsFile`): never a byte of it.
 */
function readCredentialsFile(path: string): BrokerAuth {
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} is mode 0${mode.toString(8)}; it holds the broker password, so run: chmod 600 ${path}`,
    );
  }
  return parseCredentialsFile(path, readSecretText(path));
}

/**
 * A control client's credentials: the caller's own, by the one login ladder every Volley CLI
 * climbs (volley-cli's auth/login.ts: flags, the identity file's `broker` block in `cwd`,
 * `VOLLEY_AUTH_*`, the auth dir VOLLEY_AUTH_DIR names, then, for an operator and a broker on this
 * machine, the coordinator.json `volley setup` saved, which `cli.ts` turns on; volleyd never asks
 * the keychain itself). The shipped ACL lets only volleyd, the Desk and coordinators write the
 * daemon's mailbox, so this is normally the `coordinator` identity.
 */
export function controlAuth(
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
  brokerUrl?: string,
  saved?: SavedLoginDeps,
): BrokerAuth | null {
  return resolveLogin({ env, cwd, brokerUrl, saved }).auth;
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
