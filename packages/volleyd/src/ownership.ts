import { parseEnvelope } from "volley-mcp/envelope";
import type { WaveId } from "./types";

/**
 * Wave ownership: one coordinator (agent id) per wave is the single writer. Mutating control ops
 * (resolve, pause, resume, stop, steer, re-run) need `by == owner`; anyone else first claims the
 * wave, which succeeds only when the owner is gone. Pure: the daemon gathers the owner's status,
 * registry entry and last heartbeat and passes them in.
 */

/** Owner statuses after which the wave is free to claim. */
const GONE = new Set(["reaped", "done", "failed"]);

/** null when `by` may mutate the wave; otherwise the refusal, naming the owner. */
export function guardMutation(
  state: { wave: WaveId; owner: string | null },
  by: string,
  op: string,
): string | null {
  if (state.owner === null || state.owner === by) return null;
  return `wave '${state.wave}' is owned by ${state.owner}; '${op}' as ${by} is refused (claim it with \`volleyd claim ${state.wave}\` once ${state.owner} is gone)`;
}

export interface ClaimInput {
  owner: string | null;
  by: string;
  /** The owner's retained status: its type and wall_time. */
  status: { type: string; at: string } | null;
  /** When the owner's registry entry was (re)published. */
  registryAt: string | null;
  /** Epoch ms of the owner's last progress/heartbeat the daemon saw, if any. */
  heartbeatAt: number | null;
  now: number;
  claimAfterS: number;
}

/**
 * May `by` take the wave over? Yes when it is unowned or already `by`'s, when the owner's status
 * is reaped/done/failed, or when nothing has been heard from the owner (registry, status,
 * heartbeat) for `claim_after_s`.
 */
export function claimVerdict(
  c: ClaimInput,
): { ok: true; why: string } | { ok: false; reason: string } {
  if (c.owner === null) return { ok: true, why: "wave has no owner" };
  if (c.owner === c.by) return { ok: true, why: `${c.by} already owns it` };
  if (c.status !== null && GONE.has(c.status.type))
    return { ok: true, why: `owner ${c.owner} is ${c.status.type}` };
  const seen = [
    c.status?.at,
    c.registryAt ?? undefined,
    c.heartbeatAt !== null ? new Date(c.heartbeatAt).toISOString() : undefined,
  ]
    .map((t) => (t !== undefined ? Date.parse(t) : Number.NaN))
    .filter((t) => !Number.isNaN(t));
  if (seen.length === 0) return { ok: true, why: `owner ${c.owner} is unknown to the broker` };
  const silentS = Math.floor((c.now - Math.max(...seen)) / 1000);
  if (silentS >= c.claimAfterS)
    return {
      ok: true,
      why: `owner ${c.owner} silent for ${silentS}s (claim_after_s ${c.claimAfterS})`,
    };
  return {
    ok: false,
    reason:
      `wave is owned by ${c.owner} (${c.status?.type ?? "no status"}, last seen ${silentS}s ago); ` +
      `claim allowed once it is reaped/done or silent for claim_after_s=${c.claimAfterS}s`,
  };
}

/** The registry fields owner auto-detection needs. */
export interface RegistryEntry {
  agent_id: string;
  parent_id: string | null;
  cwd?: string;
  started_at?: string;
}

/** Parse one retained `volley/_system/registry/<id>` message; null if it is not an entry. */
export function parseRegistryEntry(raw: string): RegistryEntry | null {
  const env = parseEnvelope(raw);
  if (env === null) return null;
  const p = (env.payload ?? {}) as { cwd?: unknown; started_at?: unknown };
  return {
    agent_id: env.agent_id,
    parent_id: env.parent_id,
    ...(typeof p.cwd === "string" ? { cwd: p.cwd } : {}),
    ...(typeof p.started_at === "string" ? { started_at: p.started_at } : {}),
  };
}

/**
 * Who is calling: `VOLLEY_AGENT_ID` when set, else the newest top-level (no parent) session
 * registered for the caller's cwd or a parent directory of it, else null.
 */
export function detectOwner(
  entries: RegistryEntry[],
  caller: { agentId?: string | undefined; cwd: string },
): string | null {
  if (caller.agentId !== undefined && caller.agentId !== "") return caller.agentId;
  const inCwd = (dir: string | undefined) =>
    dir !== undefined &&
    (caller.cwd === dir || caller.cwd.startsWith(`${dir.replace(/\/$/, "")}/`));
  const match = entries
    .filter((e) => e.parent_id === null && inCwd(e.cwd))
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return match[0]?.agent_id ?? null;
}

/**
 * The CLI caller's agent id: `--by`/`--owner` flag, else `VOLLEY_AGENT_ID`, else the registry
 * session for the caller's cwd, else null. `auto` is true when it was detected, not given.
 */
export async function resolveCaller(
  client: { readRegistry: () => Promise<string[]> },
  flag: string | undefined,
  env: Record<string, string | undefined>,
  cwd: string = process.cwd(),
): Promise<{ id: string | null; auto: boolean }> {
  if (flag !== undefined && flag !== "") return { id: flag, auto: false };
  const agentId = env.VOLLEY_AGENT_ID;
  if (agentId !== undefined && agentId !== "") return { id: agentId, auto: true };
  const entries = (await client.readRegistry()).flatMap((raw) => {
    const e = parseRegistryEntry(raw);
    return e === null ? [] : [e];
  });
  return { id: detectOwner(entries, { cwd }), auto: true };
}
