import { spawnSync } from "node:child_process";
import { type BrokerAuth, readCoordinatorAuth } from "volley-mcp/config";
import { readSetupInstall } from "../setup/journal";
import { volleydHome } from "./context";

/**
 * The coordinator's login as `volley setup` saved it on the supervisor machine, for its own CLIs
 * (`volley …`, `volleyd config get`, …) when nothing else names a login: the macOS keychain item
 * (service `volley-broker`), then `coordinator.json` in the auth dir (`VOLLEY_AUTH_DIR`, else the
 * one `$VOLLEYD_HOME/setup.json` records, else the default). Nobody has to export a password in
 * a shell profile. Only for a broker on this machine: the login never goes to another host.
 */

/** The keychain item holding the coordinator's broker login (macOS `security`). */
export const KEYCHAIN_SERVICE = "volley-broker";

/** Reads the keychain item setup's accounts step stores (the password on stdout). */
export const keychainReadArgv = [
  "security",
  "find-generic-password",
  "-s",
  KEYCHAIN_SERVICE,
  "-a",
  "coordinator",
  "-w",
] as const;

export interface SavedLoginDeps {
  platform: NodeJS.Platform;
  /** The keychain item's password, or null when there is none (or no keychain to ask). */
  keychain: () => string | null;
}

export const realSavedLoginDeps: SavedLoginDeps = {
  platform: process.platform,
  keychain: () => {
    const [bin, ...args] = keychainReadArgv;
    const r = spawnSync(bin, args, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      encoding: "utf-8",
    });
    const pw = r.status === 0 ? r.stdout.replace(/\n$/, "") : "";
    return pw === "" ? null : pw;
  },
};

/** Whether `url` names a broker on this machine (loopback). */
export function isLocalBroker(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return (
    host === "localhost" || host === "[::1]" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** The saved coordinator login for a broker at `brokerUrl`, or null. */
export function savedCoordinatorLogin(
  env: Record<string, string | undefined>,
  brokerUrl: string,
  deps: SavedLoginDeps = realSavedLoginDeps,
): BrokerAuth | null {
  if (!isLocalBroker(brokerUrl)) return null;
  if (deps.platform === "darwin") {
    const password = deps.keychain();
    if (password !== null) return { username: "coordinator", password };
  }
  const authDir = env.VOLLEY_AUTH_DIR ?? readSetupInstall(volleydHome(env))?.auth_dir;
  try {
    return readCoordinatorAuth(authDir !== undefined ? { ...env, VOLLEY_AUTH_DIR: authDir } : env);
  } catch (e) {
    // Another user's file (a root-owned auth dir): not this user's login to use.
    if (/EACCES|EPERM/.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}
