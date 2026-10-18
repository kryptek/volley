import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrokerConnectOptions } from "volley-mcp/broker";
import { type BrokerAuth, resolveBrokerAuth } from "volley-mcp/config";
import { VolleyError } from "volley-mcp/errors";
import type { Env } from "./hook-io";
import type { HookIdentity } from "./identity";
import { writeFileAtomic } from "./seq";

/** Who a connection speaks for, as far as credentials go. */
export type AuthTarget = Pick<HookIdentity, "mode" | "projectDir">;

/** Everything a connect needs: credentials plus where to connect and as whom. */
export type ConnectTarget = AuthTarget & Pick<HookIdentity, "brokerUrl" | "agentId">;

export const CONNECT_TIMEOUT_MS = 3000;

/**
 * Where `volley auth` keeps its files when VOLLEY_AUTH_DIR is unset (mirrors the CLI's
 * default): the first mosquitto config directory that exists, plus `volley/`.
 */
const MOSQUITTO_ETC_DIRS = [
  "/opt/homebrew/etc/mosquitto",
  "/usr/local/etc/mosquitto",
  "/etc/mosquitto",
];

/** `$VOLLEY_AUTH_DIR/coordinator.json` (written by `volley auth init --coordinator-file`). */
export function coordinatorAuthPath(env: Env): string | null {
  const dir = env.VOLLEY_AUTH_DIR ?? MOSQUITTO_ETC_DIRS.find((d) => existsSync(d));
  if (dir === undefined) return null;
  return env.VOLLEY_AUTH_DIR !== undefined
    ? join(dir, "coordinator.json")
    : join(dir, "volley", "coordinator.json");
}

function readCoordinatorFile(env: Env): BrokerAuth | null {
  const path = coordinatorAuthPath(env);
  if (path === null || !existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new Error(`${path}: malformed coordinator credentials — ${(e as Error).message}`);
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
 * The hooks' broker credentials. Agent mode: exactly as the MCP server sharing the worktree
 * resolves them (the identity file's `broker` block, then `VOLLEY_AUTH_*`). Coordinator mode
 * (no identity file): `VOLLEY_AUTH_*`, else `$VOLLEY_AUTH_DIR/coordinator.json`, so an
 * installed session needs no secret in settings.json. Null means connect anonymously.
 */
export function resolveHooksAuth(target: AuthTarget, env: Env): BrokerAuth | null {
  // Coordinator mode means the directory has no identity file, so this is `VOLLEY_AUTH_*` alone.
  const auth = resolveBrokerAuth(env, target.projectDir);
  if (auth !== null || target.mode === "agent") return auth;
  return readCoordinatorFile(env);
}

/** The connect options for `target`, credentials included — every hook connect goes through it. */
export function connectOpts(
  target: ConnectTarget,
  env: Env,
  extra: Partial<BrokerConnectOptions> = {},
): BrokerConnectOptions {
  const auth = resolveHooksAuth(target, env);
  return {
    url: target.brokerUrl,
    agentId: target.agentId,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
    ...extra,
    ...(auth !== null ? { username: auth.username } : {}),
    ...(auth?.password !== undefined ? { password: auth.password } : {}),
  };
}

export function isAuthFailed(e: unknown): e is VolleyError {
  return e instanceof VolleyError && e.code === "AUTH_FAILED";
}

/** `<stateDir>/hooks-error.json`: the last refused connect, for the supervisor to find. */
export const HOOKS_ERROR_FILE = "hooks-error.json";

export interface HooksError {
  code: "AUTH_FAILED";
  at: string;
  hook_event: string;
  /** The username the broker refused; null for an anonymous connect. */
  username: string | null;
}

export function writeHooksError(stateDir: string, err: HooksError): void {
  writeFileAtomic(join(stateDir, HOOKS_ERROR_FILE), `${JSON.stringify(err)}\n`);
}

/** Called after every successful connect: the broker accepts us again. */
export function clearHooksError(stateDir: string): void {
  rmSync(join(stateDir, HOOKS_ERROR_FILE), { force: true });
}
