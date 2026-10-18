/**
 * Steering transport (D4): publishes T0-shaped mailbox envelopes (SPEC §4.4)
 * from the browser client, signed as the Desk's broker identity.
 *
 * Every message gets a fresh UUID `correlation_id` (its message id), a `seq`
 * per target and `supersedes` = the previous message to the same target. The
 * publish lifecycle is reported through `onEvent` (`sending`, then `puback`
 * or `failed`); what comes back afterwards (hook ack, `steering_acked`) is
 * read from the store by `ackState.ts`.
 *
 * Urgent (`/stop`, or Urgent mode) additionally sends the daemon a control
 * request to interrupt the session with Escape: a mailbox `query` to
 * `volley/<ns>/volleyd/mailbox` with `payload: { op: "steer", urgent: true,
 * escape_only: true, message_id, agent_id, wave?, task?, by, text }`. The
 * message itself was already published here, so `escape_only` asks the
 * daemon not to deliver it again. `control()` sends any other op (`claim`)
 * the same way and resolves with the daemon's ack on the Desk's own mailbox.
 *
 * The transport takes the smallest client it needs (publish + the delivery
 * stream), so the Desk's broker client backs it once signed in with broker
 * credentials; without credentials the panel is read-only and offers
 * `copySteerCommand` instead.
 */
import type { DeskMessage, Envelope } from "../store/types";
import type { SentSteer, SteerLogEvent, SteerType } from "./ackState";

export const DAEMON_AGENT_ID = "volleyd";
export const CONTROL_TIMEOUT_MS = 10_000;

export interface SteerClient {
  /** Publish one envelope (QoS 1, not retained); resolves on PUBACK. */
  publish(topic: string, payload: string): Promise<void>;
  onMessage(handler: (msg: DeskMessage) => void): () => void;
}

export interface SteerTarget {
  agentId: string;
  namespace: string;
  coordinator: boolean;
  wave?: string | undefined;
  task?: string | undefined;
}

/** The PromptBar's commands (names carry the slash, so picking one inserts `/stop `). */
export const STEER_COMMANDS = [
  { key: "stop", name: "/stop", description: "Interrupt now (Escape), then deliver" },
  { key: "wrap", name: "/wrap-up", description: "Finish the current step, push, publish done" },
  { key: "pause", name: "/pause", description: "Hold at the next tool-call boundary" },
  { key: "status", name: "/status", description: "Ask for a one-line progress update" },
] as const;

const COMMAND_TEXT: Record<string, { type: SteerType; text: string; urgent?: true }> = {
  stop: {
    type: "cancel",
    text: "Stop now: halt your current step, publish your status and wait for instructions.",
    urgent: true,
  },
  "wrap-up": {
    type: "steering",
    text: "Wrap up: finish the current step, push, and publish done.",
  },
  pause: {
    type: "steering",
    text: "Pause: hold at the next tool-call boundary and wait for further instructions.",
  },
  status: { type: "nudge", text: "Post a one-line progress update now." },
};

export interface Composed {
  type: SteerType;
  text: string;
  /** Also ask the daemon to interrupt the session (Escape). */
  urgent: boolean;
}

/** Turn panel input into a message: a leading `/command` picks the type and text. */
export function compose(input: string, urgent: boolean): Composed {
  const text = input.trim();
  const m = /^\/([\w-]+)(?:\s+([\s\S]*))?$/.exec(text);
  const cmd = m ? COMMAND_TEXT[m[1] as string] : undefined;
  if (!cmd) return { type: "steering", text, urgent };
  const rest = m?.[2]?.trim();
  return {
    type: cmd.type,
    text: rest ? `${cmd.text} ${rest}` : cmd.text,
    urgent: urgent || cmd.urgent === true,
  };
}

export interface ControlReply {
  ok: boolean;
  error?: string;
  result?: unknown;
}

export interface SteerTransport {
  /** The Desk's identity: every message's sender. */
  identity: string;
  /** Publish to `target`'s mailbox; returns the message as first logged. */
  send(target: SteerTarget, input: string, opts?: { urgent?: boolean }): SentSteer;
  /** A volleyd control request (`claim`, …); resolves with its answer. */
  control(op: string, fields: Record<string, unknown>, text?: string): Promise<ControlReply>;
}

const mailbox = (namespace: string, agentId: string) => `volley/${namespace}/${agentId}/mailbox`;

function envelope(r: {
  identity: string;
  namespace: string;
  type: string;
  id: string;
  payload: Record<string, unknown>;
  now: Date;
}): Envelope {
  return {
    schema_version: "0.1",
    agent_id: r.identity,
    parent_id: null,
    namespace: r.namespace,
    channel: "mailbox",
    type: r.type,
    wall_time: r.now.toISOString(),
    correlation_id: r.id,
    payload: r.payload,
  };
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createSteerTransport(
  client: SteerClient,
  opts: {
    identity: string;
    onEvent: (e: SteerLogEvent) => void;
    /** The daemon's namespace (from its registry entry), read per request; default `default`. */
    daemonNamespace?: () => string;
    timeoutMs?: number;
    newId?: () => string;
    now?: () => Date;
  },
): SteerTransport {
  const { identity, onEvent } = opts;
  const timeoutMs = opts.timeoutMs ?? CONTROL_TIMEOUT_MS;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => new Date());
  /** Last seq and message id per target agent. */
  const last = new Map<string, { seq: number; id: string }>();

  const control: SteerTransport["control"] = (op, fields, text = `volleyd ${op}`) => {
    const id = newId();
    const daemonNs = opts.daemonNamespace?.() ?? "default";
    return new Promise<ControlReply>((resolve) => {
      let off = () => {};
      const timer = setTimeout(
        () => done({ ok: false, error: `volleyd did not answer within ${timeoutMs / 1000}s` }),
        timeoutMs,
      );
      function done(reply: ControlReply) {
        clearTimeout(timer);
        off();
        resolve(reply);
      }
      // Listen before publishing so a fast answer is not missed.
      off = client.onMessage((m) => {
        const env = m.envelope;
        if (
          env?.type === "ack" &&
          env.correlation_id === id &&
          env.agent_id === DAEMON_AGENT_ID &&
          m.topic === mailbox(daemonNs, identity)
        ) {
          const p = (env.payload ?? {}) as Record<string, unknown>;
          done({
            ok: p.ok === true,
            ...(typeof p.error === "string" ? { error: p.error } : {}),
            ...(p.result !== undefined ? { result: p.result } : {}),
          });
        }
      });
      const req = envelope({
        identity,
        namespace: daemonNs,
        type: "query",
        id,
        payload: { op, text, ...fields, by: identity },
        now: now(),
      });
      client
        .publish(mailbox(daemonNs, DAEMON_AGENT_ID), JSON.stringify(req))
        .catch((err: unknown) => done({ ok: false, error: message(err) }));
    });
  };

  return {
    identity,
    control,
    send(target, input, { urgent = false } = {}) {
      const c = compose(input, urgent);
      const id = newId();
      const prev = last.get(target.agentId);
      const seq = (prev?.seq ?? 0) + 1;
      last.set(target.agentId, { seq, id });
      const at = now();
      const sent: SentSteer = {
        id,
        target: target.agentId,
        namespace: target.namespace,
        coordinator: target.coordinator,
        type: c.type,
        text: c.text,
        seq,
        ...(prev ? { supersedes: prev.id } : {}),
        sentAt: at.getTime(),
        puback: false,
      };
      onEvent({ type: "sending", msg: sent });
      const env = envelope({
        identity,
        namespace: target.namespace,
        type: c.type,
        id,
        payload: { text: c.text, seq, ...(prev ? { supersedes: prev.id } : {}) },
        now: at,
      });
      client.publish(mailbox(target.namespace, target.agentId), JSON.stringify(env)).then(
        () => onEvent({ type: "puback", id }),
        (err: unknown) => onEvent({ type: "failed", id, error: message(err) }),
      );
      if (c.urgent) {
        void control(
          "steer",
          {
            urgent: true,
            escape_only: true,
            message_id: id,
            agent_id: target.agentId,
            ...(target.wave !== undefined ? { wave: target.wave } : {}),
            ...(target.task !== undefined ? { task: target.task } : {}),
          },
          `Interrupt ${target.agentId} (Escape) for urgent ${c.type} ${id}`,
        );
      }
      return sent;
    },
  };
}

/** Double-quote `s` for a POSIX shell. */
function shellQuote(s: string): string {
  return `"${s.replace(/["\\$`]/g, (ch) => `\\${ch}`)}"`;
}

/** The `volleyd steer` line the read-only panel offers to copy. */
export function copySteerCommand(wave: string, task: string, text: string): string {
  return `volleyd steer ${wave} ${task} ${shellQuote(text)}`;
}
