import { rmSync } from "node:fs";
import { join } from "node:path";
import type { BrokerConnectOptions } from "volley-mcp/broker";
import {
  type BrokerAuth,
  authFromEnv,
  readCoordinatorAuth,
  resolveBrokerAuth,
} from "volley-mcp/config";
import { VolleyError } from "volley-mcp/errors";
import type { Env } from "./hook-io";
import type { HookIdentity } from "./identity";
import { writeFileAtomic } from "./seq";

/** Who a connection speaks for, as far as credentials go. */
export type AuthTarget = Pick<HookIdentity, "mode" | "projectDir">;

/** Everything a connect needs: credentials, where to connect and as whom, and the state dir. */
export type ConnectTarget = AuthTarget & Pick<HookIdentity, "brokerUrl" | "agentId" | "stateDir">;

export const CONNECT_TIMEOUT_MS = 3000;

/**
 * The hooks cannot even try to authenticate: an identity or credentials file is unreadable or
 * malformed, or `VOLLEY_AUTH_*` is inconsistent. Code `AUTH_FAILED`, so it takes the same loud
 * path as a refused CONNACK (stderr line, `hooks-error.json`, exit 1) and is never cached as a
 * registry miss. `stateDir`, when set, is where the error file goes.
 */
export class CredentialsError extends VolleyError {
  readonly stateDir: string | undefined;
  constructor(message: string, stateDir?: string) {
    super("AUTH_FAILED", message);
    this.name = "CredentialsError";
    this.stateDir = stateDir;
  }
}

/** Run a credential resolution; any plain error it throws becomes a `CredentialsError`. */
function loudly<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof VolleyError && e.code === "AUTH_FAILED") throw e;
    throw new CredentialsError((e as Error).message);
  }
}

/**
 * The hooks' broker credentials. Agent mode: exactly as the MCP server sharing the worktree
 * resolves them (the identity file's `broker` block, then `VOLLEY_AUTH_*`). Coordinator mode:
 * `VOLLEY_AUTH_*`, else `$VOLLEY_AUTH_DIR/coordinator.json`, so an installed session needs no
 * secret in settings.json; the directory's identity file is never read. Null means connect
 * anonymously. Unusable credentials throw `CredentialsError`.
 */
export function resolveHooksAuth(target: AuthTarget, env: Env): BrokerAuth | null {
  if (target.mode === "agent") return loudly(() => resolveBrokerAuth(env, target.projectDir));
  return loudly(() => authFromEnv(env) ?? readCoordinatorAuth(env));
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

/**
 * `<stateDir>/hooks-error.json`: the last refused connect, for the supervisor to find (or the
 * one-line note that the agent is retired).
 */
export const HOOKS_ERROR_FILE = "hooks-error.json";

export type HooksError =
  | {
      code: "AUTH_FAILED";
      at: string;
      hook_event: string;
      /** The username the broker refused; null for an anonymous connect or unusable credentials. */
      username: string | null;
      /** Why no credentials could be sent (a `CredentialsError`); absent for a refused CONNACK. */
      detail?: string;
    }
  /** volleyd retired this agent (`.volley/retired.json`): the hooks stopped connecting, on purpose. */
  | { code: "RETIRED"; at: string; hook_event: string; agent_id: string };

export function writeHooksError(stateDir: string, err: HooksError): void {
  writeFileAtomic(join(stateDir, HOOKS_ERROR_FILE), `${JSON.stringify(err)}\n`);
}

/** Called after every successful connect: the broker accepts us again. */
export function clearHooksError(stateDir: string): void {
  rmSync(join(stateDir, HOOKS_ERROR_FILE), { force: true });
}
