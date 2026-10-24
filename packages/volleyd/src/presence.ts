import type { CoordinatorAttention, MergeMode } from "./types";

/**
 * The wave owner's presence (SPEC §4.6.1): read from its retained status, which its connection's
 * will turns `reaped` when the session drops. `online` / `offline` is the connection; the
 * coordinator `state` adds what the job needs: `away` while autopilot runs and nothing waits on the
 * owner, `gone` only when something only the owner can answer waits and the owner is offline.
 * Pure: the daemon passes the status, the wave's open decisions, inbox items and gates in.
 */

/** Statuses that end a session: its will fired (`reaped`) or it shut down. */
export const OWNER_GONE: ReadonlySet<string> = new Set(["reaped", "done", "failed"]);

export type Presence = CoordinatorAttention["presence"];

/**
 * `online` while a status exists and is not terminal: `reaped` / `done` / `failed`, or the
 * `blocked` a clean shutdown leaves (`reason: "shutdown"`, SPEC §7.5). No status is `offline`.
 */
export function presenceOf(status: { type: string; reason?: string } | null | undefined): Presence {
  if (status == null || OWNER_GONE.has(status.type)) return "offline";
  return status.type === "blocked" && status.reason === "shutdown" ? "offline" : "online";
}

/** What waits on the owner in one wave (each count > 0 for at least one). */
export interface OwnerWaits {
  decisions: number;
  items: number;
  gates: number;
}

export interface WaitsInput {
  /** The wave's open decisions. */
  decisions: readonly { resolved?: unknown; held?: unknown; escalated?: unknown }[];
  /** The wave's inbox items. A decision's own item is counted through `decisions`. */
  inbox: readonly { kind: string; owner_only: boolean; answered?: unknown; held?: unknown }[];
  autopilotEnabled: boolean;
  mergeMode: MergeMode;
  /** The wave's merge-ready gates. */
  gates: readonly unknown[];
}

/**
 * What only the owner can answer in a wave: open unheld decisions autopilot left (`escalated`, or
 * every one while autopilot is off), open unanswered unheld owner-only inbox items, and merge-ready
 * gates under `merge: manual`. null when nothing waits.
 */
export function waitsOnOwner(w: WaitsInput): OwnerWaits | null {
  const decisions = w.decisions.filter(
    (d) =>
      d.resolved === undefined &&
      d.held === undefined &&
      (d.escalated !== undefined || !w.autopilotEnabled),
  ).length;
  const items = w.inbox.filter(
    (i) =>
      i.kind !== "decision" && i.owner_only && i.answered === undefined && i.held === undefined,
  ).length;
  const gates = w.mergeMode === "manual" ? w.gates.length : 0;
  return decisions + items + gates > 0 ? { decisions, items, gates } : null;
}

export interface OwnerStateInput {
  presence: Presence;
  attention: { state: CoordinatorAttention["state"] } | undefined;
  /** When a bound coordinator name's agent went away (ms); undefined for a plain agent id. */
  awayAt: number | undefined;
  graceMs: number;
  now: number;
  waits: OwnerWaits | null;
}

/**
 * The coordinator `state`: an online owner's attention (`working` by default); an offline one is
 * `reconnecting` within the grace (a coordinator name only: nothing rebinds an agent id), then
 * `gone` while something waits on it, else `away`.
 */
export function ownerState(o: OwnerStateInput): CoordinatorAttention["state"] {
  if (o.presence === "online") return o.attention?.state ?? "working";
  if (o.awayAt !== undefined && o.now - o.awayAt < o.graceMs) return "reconnecting";
  return o.waits !== null ? "gone" : "away";
}
