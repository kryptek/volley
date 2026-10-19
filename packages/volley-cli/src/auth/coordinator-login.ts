import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type BrokerAuth, readCoordinatorAuth } from "volley-mcp/config";
import { readSetupInstall } from "../setup/journal";
import { volleydHome } from "./context";

/**
 * The coordinator's login as `volley setup` saved it on the supervisor machine, for the operator's
 * own CLIs (`volley …`, `volleyd config get`, …) when nothing else names a login: the macOS
 * keychain item (service `volley-broker`), then `coordinator.json` in the auth dir
 * (`VOLLEY_AUTH_DIR`, else the one `$VOLLEYD_HOME/setup.json` records, else the default). Nobody
 * has to export a password in a shell profile.
 *
 * Narrow on purpose:
 * - off until a real CLI entry point turns it on (`useSavedLogin`): a library caller, and every
 *   test, never reads the keychain or the auth dir;
 * - only for a broker on this machine: the login never goes to another host;
 * - never for an agent (`agentContext`): an agent uses only the login minted for it.
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

/** Where the saved login comes from: injected, so tests fake both sources. */
export interface SavedLoginDeps {
  platform: NodeJS.Platform;
  /** The keychain item's password, or null when there is none (or no keychain to ask). */
  keychain: () => string | null;
  /** The auth dir's `coordinator.json` login, or null. */
  coordinatorFile: (env: Record<string, string | undefined>) => BrokerAuth | null;
}

/**
 * `env`, with VOLLEY_AUTH_DIR set to the auth dir in `$VOLLEYD_HOME/setup.json` when it names none
 * (a `--dir` or `--layout container` setup keeps coordinator.json outside the default dir).
 */
export function withSetupAuthDir(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (env.VOLLEY_AUTH_DIR !== undefined) return env;
  const saved = readSetupInstall(volleydHome(env));
  return saved === null ? env : { ...env, VOLLEY_AUTH_DIR: saved.auth_dir };
}

/** coordinator.json from the auth dir setup used; null when absent or another user's. */
export function readSavedCoordinatorFile(
  env: Record<string, string | undefined>,
): BrokerAuth | null {
  try {
    return readCoordinatorAuth(withSetupAuthDir(env));
  } catch (e) {
    // Another user's file (a root-owned auth dir): not this user's login to use.
    if (/EACCES|EPERM/.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

/** The real sources, for `volley`'s entry point: the keychain (macOS), then coordinator.json. */
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
  coordinatorFile: readSavedCoordinatorFile,
};

/**
 * coordinator.json only, never the keychain: for `volleyd`'s entry point, which starts no child
 * process outside its fenced exec. The file holds the same login.
 */
export const fileSavedLoginDeps: SavedLoginDeps = {
  platform: process.platform,
  keychain: () => null,
  coordinatorFile: readSavedCoordinatorFile,
};

/** This process's sources: none until a real CLI entry point opts in. */
let source: SavedLoginDeps | null = null;

/** Turn the saved-login fallback on (or off, with null) for this process. Entry points only. */
export function useSavedLogin(deps: SavedLoginDeps | null): void {
  source = deps;
}

/** The sources this process uses (null: the fallback is off). */
export function savedLoginSource(): SavedLoginDeps | null {
  return source;
}

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

/**
 * Why the caller is an agent, or null for an operator: `VOLLEY_AGENT_ID` (a remote agent's
 * launch, the owner's own tooling), `VOLLEY_HOOKS_DIR` (every agent volleyd launches), or a
 * `.volley/agent.json` in `cwd` or any directory above it (an agent's worktree, from a
 * subdirectory too).
 */
export function agentContext(env: Record<string, string | undefined>, cwd: string): string | null {
  for (const k of ["VOLLEY_AGENT_ID", "VOLLEY_HOOKS_DIR"]) {
    if (env[k] !== undefined && env[k] !== "") return `${k} is set`;
  }
  for (let d = resolve(cwd); ; d = dirname(d)) {
    const f = join(d, ".volley", "agent.json");
    if (existsSync(f)) return `${f} exists`;
    if (dirname(d) === d) return null;
  }
}

/**
 * The saved coordinator login for a broker at `brokerUrl`, or null: off in this process, opted
 * out (`VOLLEY_NO_SAVED_LOGIN`), another machine's broker, an agent, or nothing saved.
 */
export function savedCoordinatorLogin(
  env: Record<string, string | undefined>,
  brokerUrl: string,
  cwd: string = process.cwd(),
  deps: SavedLoginDeps | null = source,
): BrokerAuth | null {
  if (deps === null) return null;
  if (env.VOLLEY_NO_SAVED_LOGIN !== undefined && env.VOLLEY_NO_SAVED_LOGIN !== "") return null;
  if (!isLocalBroker(brokerUrl)) return null;
  if (agentContext(env, cwd) !== null) return null;
  if (deps.platform === "darwin") {
    const password = deps.keychain();
    if (password !== null) return { username: "coordinator", password };
  }
  return deps.coordinatorFile(env);
}
