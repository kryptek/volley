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

/** Registry lookups (hits and misses) are cached this long; SessionStart always refreshes. */
const IDENTITY_TTL_MS = 60_000;

/** At startup, how many times to look again for this session's own entry. */
const STARTUP_ATTEMPTS = 4;

interface CachedIdentity {
  /** null: no coordinator entry for this directory (a cached miss). */
  agent_id: string | null;
  namespace?: string;
  parent_id?: string | null;
  fetched_at: number;
}

/** A retained registry entry: `volley/_system/registry/<id>` → raw payload. */
export interface RegistryRecord {
  topic: string;
  payload: string;
}

/** A registry entry whose cwd is the session's directory, with its retained status type. */
export interface RegistryCandidate {
  agentId: string;
  namespace: string;
  parentId: string | null;
  startedAt: string;
  status: string | null;
}

/** Reads the registry entries for `dir`, newest `started_at` first (it opens a socket). */
export type RegistryLookup = (brokerUrl: string, dir: string) => Promise<RegistryCandidate[]>;

/** SPEC §5.1 terminal states that mean the session is gone (`blocked` may still be alive). */
const GONE = new Set(["done", "failed", "reaped"]);

/** Registry entries whose `payload.cwd` is `dir`, newest `started_at` first (status unset). */
export function registryCandidates(records: RegistryRecord[], dir: string): RegistryCandidate[] {
  const want = canonical(dir);
  const out: RegistryCandidate[] = [];
  for (const r of records) {
    const env = parseEnvelope(r.payload);
    if (env === null || env.type !== "registered") continue;
    const p = env.payload as { cwd?: unknown; started_at?: unknown };
    if (typeof p.cwd !== "string" || canonical(p.cwd) !== want) continue;
    if (!isValidAgentId(env.agent_id)) continue;
    const ns = env.namespace ?? "default";
    if (!isValidNamespace(ns)) continue;
    out.push({
      agentId: env.agent_id,
      namespace: ns,
      parentId: env.parent_id,
      startedAt: typeof p.started_at === "string" ? p.started_at : "",
      status: null,
    });
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/**
 * Coordinator identity: the newest registry entry for `dir` whose agent is not gone (status
 * `done`/`failed`/`reaped`). The result — a hit or a miss, including an unreachable broker —
 * is cached in the state directory for 60 s, so a directory with no coordinator costs one
 * lookup a minute. With `notBefore` (SessionStart at startup), an entry older than that is
 * a previous session: look again a few times for this session's own entry (its MCP server
 * starts concurrently), and if none appears return null without caching.
 */
export async function resolveCoordinatorIdentity(
  dir: string,
  env: Env,
  lookup: RegistryLookup,
  opts: { refresh?: boolean; now?: () => number; notBefore?: number; retryDelayMs?: number } = {},
): Promise<HookIdentity | null> {
  const now = opts.now ?? Date.now;
  const stateDir = coordinatorStateDir(dir, env);
  const brokerUrl = env.VOLLEY_BROKER_URL ?? "mqtt://localhost:1883";
  const cachePath = join(stateDir, "identity.json");
  const make = (c: { agent_id: string; namespace: string; parent_id: string | null }) => ({
    mode: "coordinator" as const,
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
      if (now() - cached.fetched_at < IDENTITY_TTL_MS) {
        if (cached.agent_id === null) return null;
        if (isValidAgentId(cached.agent_id) && typeof cached.namespace === "string") {
          return make({
            agent_id: cached.agent_id,
            namespace: cached.namespace,
            parent_id: cached.parent_id ?? null,
          });
        }
      }
    } catch {
      // no usable cache
    }
  }

  const attempts = opts.notBefore === undefined ? 1 : STARTUP_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    let candidates: RegistryCandidate[];
    try {
      candidates = await lookup(brokerUrl, dir);
    } catch {
      candidates = [];
    }
    const best = candidates.find((c) => c.status === null || !GONE.has(c.status)) ?? null;
    const stale =
      best !== null &&
      opts.notBefore !== undefined &&
      !(Date.parse(best.startedAt) >= opts.notBefore);
    if (best !== null && !stale) {
      const entry = {
        agent_id: best.agentId,
        namespace: best.namespace,
        parent_id: best.parentId,
      };
      writeFileAtomic(cachePath, `${JSON.stringify({ ...entry, fetched_at: now() })}\n`);
      return make(entry);
    }
    // Cache the miss, unless this is startup in a directory sessions have registered from:
    // this session's own entry may only be moments away.
    if (candidates.length === 0 || opts.notBefore === undefined) {
      const miss: CachedIdentity = { agent_id: null, fetched_at: now() };
      writeFileAtomic(cachePath, `${JSON.stringify(miss)}\n`);
      return null;
    }
    if (attempt >= attempts) return null;
    await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 500));
  }
}
