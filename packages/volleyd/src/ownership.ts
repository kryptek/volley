import { parseEnvelope } from "volley-mcp/envelope";
import { isValidAgentId } from "volley-mcp/topics";
import { DAEMON_AGENT_ID } from "./control";
import type { WaveId } from "./types";

/**
 * Wave ownership: one coordinator per wave is the single writer. Mutating control ops (resolve,
 * pause, resume, stop, steer, re-run) need `by == owner`; anyone else first claims the wave,
 * which succeeds only when the owner is gone. The owner is an agent id or a stable coordinator
 * name (`VOLLEY_COORDINATOR`, SPEC §6.2) bound to the newest live session carrying it, so a
 * restarted MCP server (a new agent id) keeps its waves. Pure: the daemon gathers the owner's
 * status, registry entry, last heartbeat and binding and passes them in.
 */

/** Owner statuses after which the wave is free to claim. */
const GONE = new Set(["reaped", "done", "failed"]);

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
    .filter((e) => e.coordinator === name && !GONE.has(statuses.get(e.agent_id) ?? ""))
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
  const bound = bindings.get(state.owner)?.agent_id;
  if (bound === by) return null;
  const owner = bound !== undefined ? `${state.owner} (via ${bound})` : state.owner;
  return `wave '${state.wave}' is owned by ${owner}; '${op}' as ${by} is refused (claim it with \`volleyd claim ${state.wave}\` once ${state.owner} is gone)`;
}

export interface ClaimInput {
  owner: string | null;
  by: string;
  /** The owner's retained status: its type and wall_time. */
  status: { type: string; at: string } | null;
  /** When the owner's registry entry was (re)published. */
  registryAt: string | null;
  /**
   * Epoch ms of the owner's last progress/heartbeat the daemon saw — or, when it has seen none,
   * when the daemon started (its memory of heartbeats does not survive a restart).
   */
  heartbeatAt: number | null;
  /** When the owner got the wave (its `wave_submitted` or latest `owner_claimed`). */
  ownedSince: string;
  now: number;
  claimAfterS: number;
  /**
   * When the owner is a coordinator name: the agent bound to it (null before any has). The
   * status, registry and heartbeat fields then describe that agent, and its terminal status does
   * not free the wave at once: the name may reconnect under a new agent id.
   */
  bound?: string | null;
}

/**
 * May `by` take the wave over? Yes when it is unowned or already `by`'s, when the owner's status
 * is reaped/done/failed, or when nothing has been heard from the owner (registry, status,
 * heartbeat) for `claim_after_s`. The time ownership began counts as a sighting, so an owner the
 * broker has never seen is claimable only after `claim_after_s` too.
 */
export function claimVerdict(
  c: ClaimInput,
): { ok: true; why: string } | { ok: false; reason: string } {
  if (c.owner === null) return { ok: true, why: "wave has no owner" };
  if (c.owner === c.by) return { ok: true, why: `${c.by} already owns it` };
  if (c.bound !== undefined && c.bound !== null && c.bound === c.by)
    return { ok: true, why: `${c.by} already owns it as ${c.owner}` };
  const owner = c.bound !== undefined && c.bound !== null ? `${c.owner} (via ${c.bound})` : c.owner;
  if (c.bound === undefined && c.status !== null && GONE.has(c.status.type))
    return { ok: true, why: `owner ${c.owner} is ${c.status.type}` };
  const seen = [
    c.status?.at,
    c.registryAt ?? undefined,
    c.heartbeatAt !== null ? new Date(c.heartbeatAt).toISOString() : undefined,
    c.ownedSince,
  ]
    .map((t) => (t !== undefined ? Date.parse(t) : Number.NaN))
    .filter((t) => !Number.isNaN(t));
  const last = seen.length > 0 ? Math.max(...seen) : c.now;
  const silentS = Math.max(0, Math.floor((c.now - last) / 1000));
  if (silentS >= c.claimAfterS)
    return {
      ok: true,
      why: `owner ${owner} silent for ${silentS}s (claim_after_s ${c.claimAfterS})`,
    };
  return {
    ok: false,
    reason:
      `wave is owned by ${owner} (${c.status?.type ?? "no status"}, last seen ${silentS}s ago); ` +
      `claim allowed once it is reaped/done or silent for claim_after_s=${c.claimAfterS}s`,
  };
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
}

/** Parse one retained `volley/_system/registry/<id>` message; null if it is not an entry. */
export function parseRegistryEntry(raw: string): RegistryEntry | null {
  const env = parseEnvelope(raw);
  if (env === null) return null;
  const p = (env.payload ?? {}) as { cwd?: unknown; started_at?: unknown; coordinator?: unknown };
  return {
    agent_id: env.agent_id,
    parent_id: env.parent_id,
    ...(env.namespace !== undefined ? { namespace: env.namespace } : {}),
    ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
    ...(typeof p.started_at === "string" ? { started_at: p.started_at } : {}),
    ...(typeof p.coordinator === "string" && isValidAgentId(p.coordinator)
      ? { coordinator: p.coordinator }
      : {}),
  };
}

/**
 * Who is calling, as a wave owner: the session's coordinator name when its registry entry has
 * one, else its agent id. The session is `VOLLEY_AGENT_ID` when set, else the top-level (no parent) session registered
 * for the caller's cwd (in the caller's namespace, when given) or the closest parent directory of
 * it — newest first among equally close ones — skipping the daemon itself and sessions whose
 * retained status (`statuses`, by agent id) is terminal, since registry entries outlive their
 * sessions (SPEC §6). Else null.
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
  // `/repo/` and `/repo` are the same directory; `/` stays matchable as the empty base.
  const base = (dir: string) => dir.replace(/\/+$/, "");
  const inCwd = (dir: string) =>
    base(caller.cwd) === base(dir) || caller.cwd.startsWith(`${base(dir)}/`);
  const match = entries
    .filter(
      (e): e is RegistryEntry & { cwd: string } =>
        e.parent_id === null &&
        e.agent_id !== DAEMON_AGENT_ID &&
        (caller.namespace === undefined || e.namespace === caller.namespace) &&
        e.cwd !== undefined &&
        inCwd(e.cwd) &&
        !GONE.has(statuses.get(e.agent_id) ?? ""),
    )
    .sort(
      (a, b) =>
        base(b.cwd).length - base(a.cwd).length ||
        (b.started_at ?? "").localeCompare(a.started_at ?? ""),
    );
  const session = match[0];
  return session === undefined ? null : (session.coordinator ?? session.agent_id);
}

/**
 * The CLI caller's identity: `--by`/`--owner` flag, else `VOLLEY_COORDINATOR`, else
 * `VOLLEY_AGENT_ID`, else the registry session for the caller's cwd (its coordinator name when
 * it has one), else null. `auto` is true when it was detected, not given.
 * `warning` is set when `VOLLEY_AGENT_ID` names an agent with no registry entry.
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
  const name = env.VOLLEY_COORDINATOR;
  if (name !== undefined && name !== "") return { id: name, auto: true };
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
  return {
    id: detectOwner(entries, { cwd, namespace: client.namespace }, await client.readStatuses()),
    auto: true,
  };
}
