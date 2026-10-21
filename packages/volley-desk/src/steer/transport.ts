/**
 * Steering transport (D4): publishes T0-shaped mailbox envelopes (SPEC §4.4)
 * from the browser client, signed as the Desk's broker identity.
 *
 * Every message gets a fresh UUID `correlation_id` (its message id) and a
 * `seq` per target. `supersedes` chains `steering` only: a steering message
 * supersedes the previous steering message to the same target, while a
 * `nudge` (`/status`) or `cancel` supersedes nothing, so a quick status ask
 * never retires a standing directive in the agent's STEERING.md. The publish
 * lifecycle is reported through `onEvent` (`sending`, then `puback` or
 * `failed`); what comes back afterwards (hook ack, `steering_acked`) is read
 * from the store by `ackState.ts`.
 *
 * Urgent (`/stop`, or Urgent mode) first asks the daemon to interrupt the
 * session: a mailbox `query` to `volley/<ns>/volleyd/mailbox` with
 * `payload: { op: "steer", urgent: true, escape_only: true, wait_ack_ms: 0,
 * wave, task, role, by }`. `role` names the target agent's pipeline role, so
 * volleyd interrupts that agent rather than the task's current stage's.
 * `escape_only` makes volleyd press Escape (its interrupt hook) and deliver
 * nothing, so once it answers the Desk publishes its own message and the agent
 * gets exactly one. The outcome is reported as an `interrupt` event
 * (`interrupted: false` with a reason when volleyd has no interrupt wired,
 * refused, did not answer, interrupted some other agent, or the target has no
 * wave task or no longer holds its role slot, `SteerTarget.noInterrupt`);
 * the message is delivered either way. `control()` sends any other op
 * (`claim`) the same way and resolves with the daemon's ack on the Desk's own
 * mailbox.
 *
 * The transport takes the smallest client it needs (publish + the delivery
 * stream), so the Desk's broker client backs it once signed in with broker
 * credentials; without credentials the panel is read-only and offers
 * `copySteerCommand` instead.
 */
import { newId as defaultNewId } from "../lib/id";
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
  /** The agent's pipeline role in `task` (`tasks[].agents`): who volleyd interrupts. */
  role?: string | undefined;
  /**
   * Why this agent must not be interrupted (it no longer holds its role slot,
   * so volleyd would press Escape in the slot's new agent): urgent sends skip
   * the interrupt and report this reason.
   */
  noInterrupt?: string | undefined;
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
  /** The request never reached the broker (the publish failed): nothing was refused. */
  unsent?: true;
}

export interface SteerTransport {
  /** The Desk's identity: every message's sender. */
  identity: string;
  /** Publish to `target`'s mailbox; returns the message as first logged. */
  send(target: SteerTarget, input: string, opts?: { urgent?: boolean }): SentSteer;
  /**
   * A volleyd control request (`claim`, …); resolves with its answer. `timeoutMs`
   * overrides the default wait for an op volleyd answers late (`agent_move_account`).
   */
  control(
    op: string,
    fields: Record<string, unknown>,
    text?: string,
    timeoutMs?: number,
  ): Promise<ControlReply>;
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
  const newId = opts.newId ?? defaultNewId;
  const now = opts.now ?? (() => new Date());
  /** Last seq per target agent. */
  const lastSeq = new Map<string, number>();
  /** Last `steering` message id per target agent (what the next steering supersedes). */
  const lastSteering = new Map<string, string>();

  /** Ask volleyd to interrupt `target` (escape_only); resolves with the outcome, never rejects. */
  const interrupt = async (
    target: SteerTarget,
  ): Promise<{ interrupted: boolean; reason?: string }> => {
    if (target.noInterrupt !== undefined) return { interrupted: false, reason: target.noInterrupt };
    if (target.wave === undefined || target.task === undefined)
      return { interrupted: false, reason: "no wave task to interrupt" };
    const r = await control(
      "steer",
      {
        urgent: true,
        escape_only: true,
        wait_ack_ms: 0,
        wave: target.wave,
        task: target.task,
        ...(target.role !== undefined ? { role: target.role } : {}),
      },
      `Interrupt ${target.agentId} (Escape)`,
    );
    if (!r.ok) return { interrupted: false, reason: r.error ?? "volleyd refused the interrupt" };
    const result = (r.result ?? {}) as { interrupted?: unknown; agent_id?: unknown };
    if (typeof result.agent_id === "string" && result.agent_id !== target.agentId)
      return {
        interrupted: false,
        reason: `volleyd interrupted ${result.agent_id}, not ${target.agentId}`,
      };
    return result.interrupted === true
      ? { interrupted: true }
      : { interrupted: false, reason: "volleyd has no interrupt for this agent" };
  };

  const control: SteerTransport["control"] = (
    op,
    fields,
    text = `volleyd ${op}`,
    wait = timeoutMs,
  ) => {
    const id = newId();
    const daemonNs = opts.daemonNamespace?.() ?? "default";
    return new Promise<ControlReply>((resolve) => {
      let off = () => {};
      const timer = setTimeout(
        () => done({ ok: false, error: `volleyd did not answer within ${wait / 1000}s` }),
        wait,
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
        .catch((err: unknown) => done({ ok: false, error: message(err), unsent: true }));
    });
  };

  return {
    identity,
    control,
    send(target, input, { urgent = false } = {}) {
      const c = compose(input, urgent);
      const id = newId();
      const seq = (lastSeq.get(target.agentId) ?? 0) + 1;
      lastSeq.set(target.agentId, seq);
      const supersedes = c.type === "steering" ? lastSteering.get(target.agentId) : undefined;
      if (c.type === "steering") lastSteering.set(target.agentId, id);
      const at = now();
      const sent: SentSteer = {
        id,
        target: target.agentId,
        namespace: target.namespace,
        coordinator: target.coordinator,
        type: c.type,
        text: c.text,
        seq,
        ...(supersedes !== undefined ? { supersedes } : {}),
        sentAt: at.getTime(),
        puback: false,
        ...(c.urgent ? { urgent: true } : {}),
      };
      onEvent({ type: "sending", msg: sent });
      const env = envelope({
        identity,
        namespace: target.namespace,
        type: c.type,
        id,
        payload: { text: c.text, seq, ...(supersedes !== undefined ? { supersedes } : {}) },
        now: at,
      });
      const publish = () =>
        client.publish(mailbox(target.namespace, target.agentId), JSON.stringify(env)).then(
          () => onEvent({ type: "puback", id }),
          (err: unknown) => onEvent({ type: "failed", id, error: message(err) }),
        );
      if (c.urgent) {
        // Interrupt first, so the message lands in a stopped session; deliver it either way.
        void interrupt(target).then((r) => {
          onEvent({ type: "interrupt", id, ...r });
          return publish();
        });
      } else {
        void publish();
      }
      return sent;
    },
  };
}

/** Single-quote `s` for a POSIX shell (no `$`, backtick or `!` history expansion inside). */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The `volleyd steer` line the read-only panel offers to copy; `role` picks the task's agent. */
export function copySteerCommand(wave: string, task: string, text: string, role?: string): string {
  const to = role !== undefined ? ` --role ${role}` : "";
  return `volleyd steer ${wave} ${task} ${shellQuote(text)}${to}`;
}

/** localStorage key for this device's name in an inbox answer's `where.device` (Settings › General). */
export const INBOX_DEVICE_KEY = "inbox_device_label";

/** The name the person gave this device in Settings › General, or "" (blocked storage: ""). */
export function readDeviceLabel(): string {
  try {
    return localStorage.getItem(INBOX_DEVICE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writeDeviceLabel(label: string): void {
  try {
    if (label.trim() === "") localStorage.removeItem(INBOX_DEVICE_KEY);
    else localStorage.setItem(INBOX_DEVICE_KEY, label.trim());
  } catch {
    // A blocked localStorage only forgets the name on reload.
  }
}

/**
 * This device, for an inbox answer's `where: { kind: "desk", device }`: the name set in
 * Settings › General, else the browser's platform (`navigator.userAgentData.platform`), else
 * `phone` at phone width and `desktop` otherwise.
 */
export function deskDevice(narrow: boolean): string {
  const label = readDeviceLabel();
  if (label !== "") return label;
  const platform = (navigator as { userAgentData?: { platform?: unknown } }).userAgentData
    ?.platform;
  if (typeof platform === "string" && platform.trim() !== "") return platform.trim();
  return narrow ? "phone" : "desktop";
}
