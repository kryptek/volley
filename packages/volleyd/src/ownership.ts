import { parseEnvelope } from "volley-mcp/envelope";
import { isValidAgentId } from "volley-mcp/topics";
import { DAEMON_AGENT_ID } from "./control";
import { OWNER_GONE, type Presence } from "./presence";
import type { WaveId } from "./types";

/**
 * Wave ownership: one coordinator per wave is the single writer. Mutating control ops (resolve,
 * pause, resume, stop, steer, re-run) need `by == owner`; anyone else first claims the wave,
 * which succeeds only when the owner is offline (presence.ts). The owner is an agent id or a stable coordinator
 * name (`VOLLEY_COORDINATOR`, SPEC §6.2) bound to the newest live session carrying it, so a
 * restarted MCP server (a new agent id) keeps its waves. Pure: the daemon gathers the owner's
 * presence and binding and passes them in.
 */

/** A coordinator name's binding: the agent acting under it, since when, and its last status. */
export interface Binding {
  agent_id: string;
  since: string;
  status: string | null;
}

/** Coordinator name → its binding (the daemon's view of the registry). */
export type Bindings = ReadonlyMap<string, Binding>;

/**
 * The agent a coordinator name binds to: the newest registry entry carrying it whose retained
 * status (`statuses`, by agent id) is not terminal; null when none is live.
 */
export function bindOwner(
  entries: readonly RegistryEntry[],
  statuses: ReadonlyMap<string, string>,
  name: string,
): string | null {
  const live = entries
    .filter((e) => e.coordinator === name && !OWNER_GONE.has(statuses.get(e.agent_id) ?? ""))
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return live[0]?.agent_id ?? null;
}

/** null when `by` may mutate the wave; otherwise the refusal, naming the owner. */
export function guardMutation(
  state: { wave: WaveId; owner: string | null },
  by: string,
  op: string,
  bindings: Bindings = new Map(),
): string | null {
  if (state.owner === null || state.owner === by) return null;
  const binding = bindings.get(state.owner);
  const bound = binding?.agent_id;
  // A bound agent that went away keeps the binding (for `reconnecting`) but no longer acts.
  if (bound === by && !OWNER_GONE.has(binding?.status ?? "")) return null;
  const owner = bound !== undefined ? `${state.owner} (via ${bound})` : state.owner;
  return `wave '${state.wave}' is owned by ${owner}; '${op}' as ${by} is refused (claim it with \`volleyd claim ${state.wave}\` once ${state.owner} is gone)`;
}

export interface ClaimInput {
  owner: string | null;
  by: string;
  /**
   * When the owner is a coordinator name: the agent bound to it (null before any has). The
   * presence then is that agent's, and going offline frees the wave only past `graceMs`: the name
   * may reconnect under a new agent id.
   */
  bound?: string | null;
  /** The owner's presence (presence.ts), from its retained status. */
  presence: Presence;
  /** When it went offline (epoch ms); null when unknown (it never had a status). */
  awayAt: number | null;
  /** `autopilot.reconnect_grace_s`, in ms. */
  graceMs: number;
  now: number;
}

/**
 * May `by` take the wave over? Yes when it is unowned or already `by`'s, or when the owner is
 * offline (SPEC §7.5) — for a coordinator name, offline past the reconnect grace, so a wave shown
 * `reconnecting` is never claimable. Silence never frees a wave: a quiet connected owner keeps it.
 */
export function claimVerdict(
  c: ClaimInput,
): { ok: true; why: string } | { ok: false; reason: string } {
  if (c.owner === null) return { ok: true, why: "wave has no owner" };
  if (c.owner === c.by) return { ok: true, why: `${c.by} already owns it` };
  const bound = c.bound ?? undefined;
  if (bound !== undefined && bound === c.by)
    return { ok: true, why: `${c.by} already owns it as ${c.owner}` };
  const owner = bound !== undefined ? `${c.owner} (via ${bound})` : c.owner;
  if (c.presence === "online")
    return {
      ok: false,
      reason: `wave is owned by ${owner}, online; claim allowed once its session is gone (the will fired or it shut down)`,
    };
  if (c.awayAt === null) return { ok: true, why: `owner ${owner} offline (no status)` };
  const since = new Date(c.awayAt).toISOString();
  if (bound === undefined || c.now - c.awayAt >= c.graceMs)
    return { ok: true, why: `owner ${owner} offline since ${since}` };
  return {
    ok: false,
    reason:
      `wave is owned by ${owner}, reconnecting (gone ${span(c.now - c.awayAt)} ago, grace ${span(c.graceMs)}); ` +
      `claim allowed at ${new Date(c.awayAt + c.graceMs).toISOString()} unless it reconnects`,
  };
}

/** A duration in a refusal: `40s`, `3m`, `2h`. */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** The registry fields owner auto-detection needs. */
export interface RegistryEntry {
  agent_id: string;
  parent_id: string | null;
  namespace?: string;
  cwd?: string;
  started_at?: string;
  /** The stable coordinator name the session acts as (`VOLLEY_COORDINATOR`, SPEC §6.2). */
  coordinator?: string;
  /** The cmux workspace ref the session's SessionStart hook reported. */
  workspace?: string;
}

/** Parse one retained `volley/_system/registry/<id>` message; null if it is not an entry. */
export function parseRegistryEntry(raw: string): RegistryEntry | null {
  const env = parseEnvelope(raw);
  if (env === null) return null;
  const p = (env.payload ?? {}) as {
    cwd?: unknown;
    started_at?: unknown;
    coordinator?: unknown;
    workspace?: unknown;
  };
  return {
    agent_id: env.agent_id,
    parent_id: env.parent_id,
    ...(env.namespace !== undefined ? { namespace: env.namespace } : {}),
    ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
    ...(typeof p.started_at === "string" ? { started_at: p.started_at } : {}),
    ...(typeof p.coordinator === "string" && isValidAgentId(p.coordinator)
      ? { coordinator: p.coordinator }
      : {}),
    ...(typeof p.workspace === "string" && p.workspace !== "" ? { workspace: p.workspace } : {}),
  };
}

/**
 * Who is calling, as a wave owner: the session's coordinator name when its registry entry has
 * one, else its agent id. The session is `VOLLEY_AGENT_ID` when set, else the top-level (no
 * parent) session registered for the caller's cwd (in the caller's namespace, when given) or the
 * closest parent directory of it — newest first among equally close ones — skipping the daemon
 * itself and sessions whose retained status (`statuses`, by agent id) is terminal, since
 * registry entries outlive their sessions (SPEC §6). Else null.
 */
export function detectOwner(
  entries: RegistryEntry[],
  caller: { agentId?: string | undefined; cwd: string; namespace?: string | undefined },
  statuses: ReadonlyMap<string, string> = new Map(),
): string | null {
  if (caller.agentId !== undefined && caller.agentId !== "") {
    const own = entries.find((e) => e.agent_id === caller.agentId);
    return own?.coordinator ?? caller.agentId;
  }
  const session = sessionsIn(entries, caller, statuses).find((e) => e.parent_id === null);
  return session === undefined ? null : (session.coordinator ?? session.agent_id);
}

/** Live registry entries whose cwd contains the caller's, innermost and newest first. */
function sessionsIn(
  entries: RegistryEntry[],
  caller: { cwd: string; namespace?: string | undefined },
  statuses: ReadonlyMap<string, string>,
): RegistryEntry[] {
  // `/repo/` and `/repo` are the same directory; `/` stays matchable as the empty base.
  const base = (dir: string) => dir.replace(/\/+$/, "");
  const inCwd = (dir: string) =>
    base(caller.cwd) === base(dir) || caller.cwd.startsWith(`${base(dir)}/`);
  return entries
    .filter(
      (e): e is RegistryEntry & { cwd: string } =>
        e.agent_id !== DAEMON_AGENT_ID &&
        (caller.namespace === undefined || e.namespace === caller.namespace) &&
        e.cwd !== undefined &&
        inCwd(e.cwd) &&
        !OWNER_GONE.has(statuses.get(e.agent_id) ?? ""),
    )
    .sort(
      (a, b) =>
        base(b.cwd).length - base(a.cwd).length ||
        (b.started_at ?? "").localeCompare(a.started_at ?? ""),
    );
}

/**
 * The CLI caller's identity: `--by`/`--owner` flag, else `VOLLEY_AGENT_ID`, else the registry
 * session for the caller's cwd (its coordinator name when it has one; a supervised worker's own
 * id), else `VOLLEY_COORDINATOR`, else null. The exported name comes last: a supervised worker
 * whose shell inherited it is its own session, never the coordinator. `auto` is true when it was
 * detected, not given.
 * `warning` is set when `VOLLEY_AGENT_ID` names an agent with no registry entry, or when
 * `VOLLEY_COORDINATOR` is not in the agent-id grammar (it is then ignored).
 */
export async function resolveCaller(
  client: {
    readRegistry: () => Promise<string[]>;
    readStatuses: () => Promise<Map<string, string>>;
    /** The namespace the caller acts in; registry entries of other namespaces are skipped. */
    readonly namespace?: string;
  },
  flag: string | undefined,
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): Promise<{ id: string | null; auto: boolean; warning?: string }> {
  if (flag !== undefined && flag !== "") return { id: flag, auto: false };
  const entries = (await client.readRegistry()).flatMap((raw) => {
    const e = parseRegistryEntry(raw);
    return e === null ? [] : [e];
  });
  const agentId = env.VOLLEY_AGENT_ID;
  if (agentId !== undefined && agentId !== "") {
    const own = entries.find((e) => e.agent_id === agentId);
    return own !== undefined
      ? { id: own.coordinator ?? agentId, auto: true }
      : {
          id: agentId,
          auto: true,
          warning: `VOLLEY_AGENT_ID=${agentId} has no registry entry; using it anyway`,
        };
  }
  const statuses = await client.readStatuses();
  const session = detectOwner(entries, { cwd, namespace: client.namespace }, statuses);
  if (session !== null) return { id: session, auto: true };
  // A supervised worker (its entry has a parent) in this directory acts as itself, never as a
  // coordinator name its shell inherited.
  const worker = sessionsIn(entries, { cwd, namespace: client.namespace }, statuses)[0];
  if (worker !== undefined) return { id: worker.agent_id, auto: true };
  const name = env.VOLLEY_COORDINATOR;
  if (name === undefined || name === "") return { id: null, auto: true };
  return isValidAgentId(name)
    ? { id: name, auto: true }
    : {
        id: null,
        auto: true,
        warning: `VOLLEY_COORDINATOR "${name}" does not match [a-z0-9][a-z0-9_-]{0,62}; ignoring it`,
      };
}
