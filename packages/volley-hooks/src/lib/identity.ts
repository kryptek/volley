import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "volley-mcp/config";
import { parseEnvelope } from "volley-mcp/envelope";
import { isValidAgentId, isValidNamespace } from "volley-mcp/topics";
import type { Env, HookInput } from "./hook-io";
import { writeFileAtomic } from "./seq";

/** Who the hooks speak for, and where they keep their state files. */
export interface HookIdentity {
  /** `agent`: `.volley/agent.json` (SPEC §6.5). `coordinator`: a registry entry matched by cwd. */
  mode: "agent" | "coordinator";
  agentId: string;
  namespace: string;
  parentId: string | null;
  brokerUrl: string;
  projectDir: string;
  /** seq counter, locks, STEERING.md, activity and caches. */
  stateDir: string;
}

/** The session's project directory: `$CLAUDE_PROJECT_DIR`, else the hook input's cwd. */
export function projectDirOf(input: HookInput, env: Env): string {
  return env.CLAUDE_PROJECT_DIR ?? (typeof input.cwd === "string" ? input.cwd : process.cwd());
}

/**
 * The supervisor-assigned identity in `<dir>/.volley/agent.json`, resolved exactly as the MCP
 * server resolves it (file beats env). Null when the file is absent or unusable — a hook never
 * fails a session over it. No I/O beyond reading the file.
 */
export function readAgentIdentity(dir: string, env: Env): HookIdentity | null {
  if (!existsSync(join(dir, ".volley", "agent.json"))) return null;
  try {
    const config = loadConfig(env, dir);
    return {
      mode: "agent",
      agentId: config.agentId,
      namespace: config.namespace,
      parentId: config.parentId,
      brokerUrl: config.brokerUrl,
      projectDir: dir,
      stateDir: join(dir, ".volley"),
    };
  } catch {
    return null;
  }
}

/** Coordinator mode is opt-in (`scripts/install.sh` sets it in the installed commands). */
export function coordinatorEnabled(env: Env): boolean {
  return env.VOLLEY_HOOKS_COORDINATOR === "1";
}

/** Per-project state directory for a coordinator session (its cwd is a user repo: keep out). */
export function coordinatorStateDir(dir: string, env: Env): string {
  const root = env.VOLLEY_HOOKS_STATE_DIR ?? join(homedir(), ".volley", "hooks");
  return join(root, createHash("sha256").update(canonical(dir)).digest("hex").slice(0, 16));
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** Registry lookups are cached this long; SessionStart always refreshes. */
const IDENTITY_TTL_MS = 60_000;

interface CachedIdentity {
  agent_id: string;
  namespace: string;
  parent_id: string | null;
  fetched_at: number;
}

/** A retained registry entry: `volley/_system/registry/<id>` → raw payload. */
export interface RegistryRecord {
  topic: string;
  payload: string;
}

/**
 * Pick the coordinator's registry entry for `dir`: entries whose `payload.cwd` is that
 * directory, newest `started_at` first (the MCP server auto-registers at startup, so the
 * running session's entry is the newest).
 */
export function matchRegistry(
  records: RegistryRecord[],
  dir: string,
): { agentId: string; namespace: string; parentId: string | null } | null {
  const want = canonical(dir);
  let best: { agentId: string; namespace: string; parentId: string | null; at: string } | null =
    null;
  for (const r of records) {
    const env = parseEnvelope(r.payload);
    if (env === null || env.type !== "registered") continue;
    const p = env.payload as { cwd?: unknown; started_at?: unknown };
    if (typeof p.cwd !== "string" || canonical(p.cwd) !== want) continue;
    if (!isValidAgentId(env.agent_id)) continue;
    const ns = env.namespace ?? "default";
    if (!isValidNamespace(ns)) continue;
    const at = typeof p.started_at === "string" ? p.started_at : "";
    if (best === null || at > best.at) {
      best = { agentId: env.agent_id, namespace: ns, parentId: env.parent_id, at };
    }
  }
  return best === null
    ? null
    : { agentId: best.agentId, namespace: best.namespace, parentId: best.parentId };
}

/**
 * Coordinator identity: the registry entry whose cwd is `dir`, cached in the state directory
 * for 60 s. `listRegistry` reads the retained registry (it opens a socket — only called on a
 * cache miss).
 */
export async function resolveCoordinatorIdentity(
  dir: string,
  env: Env,
  listRegistry: (brokerUrl: string) => Promise<RegistryRecord[]>,
  opts: { refresh?: boolean; now?: () => number } = {},
): Promise<HookIdentity | null> {
  const now = opts.now ?? Date.now;
  const stateDir = coordinatorStateDir(dir, env);
  const brokerUrl = env.VOLLEY_BROKER_URL ?? "mqtt://localhost:1883";
  const cachePath = join(stateDir, "identity.json");
  const make = (c: CachedIdentity): HookIdentity => ({
    mode: "coordinator",
    agentId: c.agent_id,
    namespace: c.namespace,
    parentId: c.parent_id,
    brokerUrl,
    projectDir: dir,
    stateDir,
  });

  if (opts.refresh !== true) {
    try {
      const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as CachedIdentity;
      if (now() - cached.fetched_at < IDENTITY_TTL_MS && isValidAgentId(cached.agent_id)) {
        return make(cached);
      }
    } catch {
      // no usable cache
    }
  }

  const match = matchRegistry(await listRegistry(brokerUrl), dir);
  if (match === null) return null;
  const entry: CachedIdentity = {
    agent_id: match.agentId,
    namespace: match.namespace,
    parent_id: match.parentId,
    fetched_at: now(),
  };
  writeFileAtomic(cachePath, `${JSON.stringify(entry)}\n`);
  return make(entry);
}
