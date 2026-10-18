/**
 * Delivery state of the mailbox messages the Desk sends (D4), as a pure
 * function of what this browser published and what the store has seen since.
 *
 * Agent target: **sending** (published, no PUBACK yet) → **sent** (PUBACK:
 * the broker has it) → **delivered** (the recipient's hook acked it to the
 * Desk's mailbox, SPEC §4.4) → **acked** (the model published
 * `progress/steering_acked` with the message id, §4.3).
 *
 * Coordinator target: the same states, read as "shown in your Claude session"
 * (its hooks acked it) and "coordinator replied" (`acked`: a live `resumed`
 * or `working` signal after the send, or a mailbox message correlated to it).
 *
 * A message that a newer one to the same target supersedes is **superseded**,
 * unless the recipient already acted on it. A refused publish is **failed**.
 */
import type { DeskState, Receipts } from "../store/types";

export type AckState =
  | "idle"
  | "sending"
  | "sent"
  | "delivered"
  | "acked"
  | "superseded"
  | "failed";

export type SteerType = "steering" | "cancel" | "nudge";

/** One message this Desk published to an agent's mailbox. */
export interface SentSteer {
  /** The message id (`correlation_id`). */
  id: string;
  /** Recipient agent id. */
  target: string;
  namespace: string;
  coordinator: boolean;
  type: SteerType;
  text: string;
  seq: number;
  supersedes?: string;
  /** Local ms when it was published. */
  sentAt: number;
  /** The broker acknowledged the publish (QoS 1 PUBACK). */
  puback: boolean;
  /** Why the publish was refused. */
  error?: string;
  /** Sent urgent (`/stop`, Urgent mode): the daemon was asked to interrupt first. */
  urgent?: true;
  /** The interrupt's outcome, once known (urgent only). */
  interrupt?: { interrupted: boolean; reason?: string };
}

export type SteerLogEvent =
  | { type: "sending"; msg: SentSteer }
  | { type: "puback"; id: string }
  | { type: "failed"; id: string; error: string }
  | { type: "interrupt"; id: string; interrupted: boolean; reason?: string };

/** Messages kept in the log; the oldest are dropped first. */
export const STEER_LOG_LIMIT = 100;

export function steerLog(log: readonly SentSteer[], e: SteerLogEvent): SentSteer[] {
  switch (e.type) {
    case "sending": {
      const next = [...log, e.msg];
      return next.length > STEER_LOG_LIMIT ? next.slice(next.length - STEER_LOG_LIMIT) : next;
    }
    case "puback":
      return log.map((m) => (m.id === e.id ? { ...m, puback: true } : m));
    case "failed":
      return log.map((m) => (m.id === e.id ? { ...m, error: e.error } : m));
    case "interrupt": {
      const interrupt = {
        interrupted: e.interrupted,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
      };
      return log.map((m) => (m.id === e.id ? { ...m, interrupt } : m));
    }
  }
}

const from = (r: Receipts | undefined, id: string, agent: string): boolean =>
  r?.[id]?.[agent] !== undefined;

export function ackStateOf(msg: SentSteer, log: readonly SentSteer[], desk: DeskState): AckState {
  if (msg.error !== undefined) return "failed";
  const r = desk.steering;
  // Only the addressed recipient's answers count (SPEC §4.4).
  const acted = msg.coordinator
    ? from(r?.applied, msg.id, msg.target) ||
      from(r?.replies, msg.id, msg.target) ||
      (r?.signals[msg.target] ?? Number.NEGATIVE_INFINITY) >= msg.sentAt
    : from(r?.applied, msg.id, msg.target);
  if (acted) return "acked";
  if (log.some((m) => m.supersedes === msg.id && m.target === msg.target)) return "superseded";
  if (from(r?.acks, msg.id, msg.target)) return "delivered";
  return msg.puback ? "sent" : "sending";
}

/** The panel's three delivery steps for a target kind. */
export function ackLabels(coordinator: boolean): [string, string, string] {
  return coordinator
    ? ["Sent", "Shown in your Claude session", "Coordinator replied"]
    : ["Sent", "Delivered by hook", "Agent acknowledged"];
}

/** How many of the three steps are lit for a state. */
export function ackStep(state: AckState): number {
  switch (state) {
    case "sent":
      return 1;
    case "delivered":
      return 2;
    case "acked":
      return 3;
    default:
      return 0;
  }
}
