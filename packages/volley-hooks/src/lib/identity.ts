import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "volley-mcp/config";
import { parseEnvelope } from "volley-mcp/envelope";
import { isValidAgentId, isValidNamespace } from "volley-mcp/topics";
import { CredentialsError, isAuthFailed } from "./auth";
import type { Env, HookInput } from "./hook-io";
import { writeFileAtomic } from "./seq";

/** Who the hooks speak for, and where they keep their state files. */
export interface HookIdentity {
  /**
   * `agent`: `.volley/agent.json` (SPEC §6.5). `coordinator`: a registry entry matched by cwd
   * and, when known, the session's cmux surface.
   */
  mode: "agent" | "coordinator";
  agentId: string;
  namespace: string;
  parentId: string | null;
  brokerUrl: string;
  projectDir: string;
  /** seq counter, locks, STEERING.md, activity and caches. */
  stateDir: string;
  /** The Claude account profile a supervisor launched the agent under (agent.json `claude_account`). */
  claudeAccount?: string;
}

/** The session's project directory: `$CLAUDE_PROJECT_DIR`, else the hook input's cwd. */
export function projectDirOf(input: HookInput, env: Env): string {
  return env.CLAUDE_PROJECT_DIR ?? (typeof input.cwd === "string" ? input.cwd : process.cwd());
}

/**
 * The supervisor-assigned identity in `<dir>/.volley/agent.json`, resolved exactly as the MCP
 * server resolves it (file beats env). Null when the file is absent. A file that exists but is
 * unreadable or malformed throws `CredentialsError` (loud: it holds this agent's credentials,
 * and treating it as absent would leave the agent silently dark). No I/O beyond the file.
 */
export function readAgentIdentity(dir: string, env: Env): HookIdentity | null {
  const stateDir = join(dir, ".volley");
  const path = join(stateDir, "agent.json");
  if (!existsSync(path)) return null;
  try {
    readFileSync(path);
  } catch (e) {
    throw new CredentialsError(
      `${path}: cannot read identity file — ${(e as Error).message}`,
      stateDir,
    );
  }
  try {
    const config = loadConfig(env, dir, () => {});
    return {
      mode: "agent",
      agentId: config.agentId,
      namespace: config.namespace,
      parentId: config.parentId,
      brokerUrl: config.brokerUrl,
      projectDir: dir,
      stateDir,
      ...(config.claudeAccount !== undefined ? { claudeAccount: config.claudeAccount } : {}),
    };
  } catch (e) {
    throw new CredentialsError((e as Error).message, stateDir);
  }
}

/** Coordinator mode is opt-in (`scripts/install.sh` sets it in the installed commands). */
export function coordinatorEnabled(env: Env): boolean {
  return env.VOLLEY_HOOKS_COORDINATOR === "1";
}

/** Where the hooks keep machine-wide state: `$VOLLEY_HOOKS_STATE_DIR`, else `~/.volley/hooks`. */
export function hooksStateRoot(env: Env): string {
  return env.VOLLEY_HOOKS_STATE_DIR ?? join(homedir(), ".volley", "hooks");
}

/**
 * Which session a coordinator hook runs in: the hook input's `session_id`, else the cmux
 * surface (`CMUX_SURFACE_ID`), else null (one key per directory, as before). Several sessions
 * can share a cwd; each keeps its own identity and state under its own key.
 */
export function sessionKey(input: { session_id?: unknown }, env: Env): string | null {
  if (typeof input.session_id === "string" && input.session_id !== "")
    return `session:${input.session_id}`;
  const surface = env.CMUX_SURFACE_ID;
  return surface !== undefined && surface !== "" ? `surface:${surface}` : null;
}

/**
 * Per-session state directory for a coordinator session (its cwd is a user repo: keep out):
 * keyed by the directory and `key` (`sessionKey`), or by the directory alone without one.
 */
export function coordinatorStateDir(dir: string, env: Env, key: string | null = null): string {
  const h = createHash("sha256").update(canonical(dir));
  if (key !== null) h.update(`\0${key}`);
  return join(hooksStateRoot(env), h.digest("hex").slice(0, 16));
}

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** The broker a coordinator session's hooks use (no identity file to name one). */
export function coordinatorBrokerUrl(env: Env): string {
  return env.VOLLEY_BROKER_URL ?? "mqtt://localhost:1883";
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
  /** On a miss: the entry this session resolved before, still preferred when it reappears. */
  pinned?: string;
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
  /** The cmux surface the entry's MCP server runs in (SPEC §6.2), when it recorded one. */
  surface?: string;
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
    const p = env.payload as { cwd?: unknown; started_at?: unknown; surface?: unknown };
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
      ...(typeof p.surface === "string" && p.surface !== "" ? { surface: p.surface } : {}),
    });
  }
  return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/**
 * The entry a session's hooks speak for, among the live `candidates` (newest first). Inside
 * cmux (`CMUX_SURFACE_ID`), the entry recorded from this surface; an entry recorded from
 * another surface is another session's and never adopted. Then the entry this session
 * resolved before (`pinned`), so a session that registered first keeps its own entry after a
 * second session in the same cwd registers. Else the newest.
 */
export function pickCandidate(
  candidates: RegistryCandidate[],
  env: Env,
  pinned: string | null,
): RegistryCandidate | null {
  const surface = env.CMUX_SURFACE_ID;
  const mine =
    surface === undefined || surface === ""
      ? candidates
      : candidates.filter((c) => c.surface === undefined || c.surface === surface);
  return (
    (surface !== undefined && surface !== ""
      ? mine.find((c) => c.surface === surface)
      : undefined) ??
    mine.find((c) => c.agentId === pinned) ??
    mine[0] ??
    null
  );
}

/**
 * Coordinator identity: this session's registry entry for `dir` (`pickCandidate`) whose agent
 * is not gone (status `done`/`failed`/`reaped`). State lives under `opts.sessionKey`
 * (`coordinatorStateDir`), so sessions sharing a cwd never share it. The result — a hit or
 * a miss, including an unreachable broker — is cached in the state directory for 60 s, so a
 * directory with no coordinator costs one lookup a minute. With `notBefore` (SessionStart at
 * startup), an entry older than that is a previous session: look again a few times for this
 * session's own entry (its MCP server starts concurrently), and if none appears return null
 * without caching.
 */
export async function resolveCoordinatorIdentity(
  dir: string,
  env: Env,
  lookup: RegistryLookup,
  opts: {
    refresh?: boolean;
    now?: () => number;
    notBefore?: number;
    retryDelayMs?: number;
    sessionKey?: string | null;
  } = {},
): Promise<HookIdentity | null> {
  const now = opts.now ?? Date.now;
  const stateDir = coordinatorStateDir(dir, env, opts.sessionKey ?? null);
  const brokerUrl = coordinatorBrokerUrl(env);
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

  let pinned: string | null = null;
  try {
    const cached = JSON.parse(readFileSync(cachePath, "utf-8")) as CachedIdentity;
    const last = cached.agent_id ?? cached.pinned;
    if (typeof last === "string" && isValidAgentId(last)) pinned = last;
    if (opts.refresh !== true) {
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
    }
  } catch {
    // no usable cache
  }

  const attempts = opts.notBefore === undefined ? 1 : STARTUP_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    let candidates: RegistryCandidate[];
    try {
      candidates = await lookup(brokerUrl, dir);
    } catch (e) {
      // A refused CONNACK is not "no coordinator here": never cache it as a miss.
      if (isAuthFailed(e)) throw e;
      candidates = [];
    }
    const notBefore = opts.notBefore;
    // At startup an entry older than the session is a previous session's, never this one's.
    const eligible = candidates.filter(
      (c) =>
        (c.status === null || !GONE.has(c.status)) &&
        (notBefore === undefined || Date.parse(c.startedAt) >= notBefore),
    );
    const best = pickCandidate(eligible, env, pinned);
    if (best !== null) {
      const entry = {
        agent_id: best.agentId,
        namespace: best.namespace,
        parent_id: best.parentId,
      };
      writeFileAtomic(cachePath, `${JSON.stringify({ ...entry, fetched_at: now() })}\n`);
      return make(entry);
    }
    // Cache the miss, unless this is startup in a directory sessions have registered from:
    // this session's own entry may only be moments away (even when every entry so far is
    // another surface's).
    if (candidates.length === 0 || notBefore === undefined) {
      const miss: CachedIdentity = {
        agent_id: null,
        ...(pinned !== null ? { pinned } : {}),
        fetched_at: now(),
      };
      writeFileAtomic(cachePath, `${JSON.stringify(miss)}\n`);
      return null;
    }
    if (attempt >= attempts) return null;
    await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 500));
  }
}

/** `<stateDir>/retired.json`: volleyd's marker that it retired the agent (SPEC §4.6.4). */
export const RETIRED_FILE = "retired.json";

export interface RetiredMarker {
  agent_id: string;
  status: string;
  at: string;
}

/** The retired marker in `stateDir`, or null (none, unreadable or malformed: never loud). */
export function readRetiredMarker(stateDir: string): RetiredMarker | null {
  try {
    const m = JSON.parse(readFileSync(join(stateDir, RETIRED_FILE), "utf-8")) as Record<
      string,
      unknown
    >;
    if (typeof m?.agent_id !== "string" || m.agent_id === "") return null;
    return {
      agent_id: m.agent_id,
      status: typeof m.status === "string" ? m.status : "",
      at: typeof m.at === "string" ? m.at : "",
    };
  } catch {
    return null;
  }
}
