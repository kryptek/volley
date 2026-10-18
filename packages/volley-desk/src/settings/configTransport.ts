/**
 * config_set over the volleyd control channel (SPEC §4.6.4,
 * `config-set-request.schema.json`). A request is a mailbox `query` to
 * `volley/<ns>/volleyd/mailbox` with `payload: { op: "config_set", text,
 * patch, by, wave? }` and a fresh `correlation_id`; volleyd answers on the
 * sender's own mailbox with an `ack` carrying the same id and
 * `{ applied, rejected: [{ path, reason }], result: { version } }`.
 *
 * The transport takes the smallest client it needs (publish + the delivery
 * stream): the App builds it on the Desk's broker client once it has signed
 * in, in volleyd's namespace (its registry entry); without one the settings
 * modal stays read-only and offers `copyCommand` instead.
 */
import type { DeskMessage, Envelope } from "../store/types";

export const DAEMON_AGENT_ID = "volleyd";
export const CONFIG_ACK_TIMEOUT_MS = 10_000;

export interface ConfigClient {
  /** Publish one envelope (QoS 1, not retained). Rejects when the broker refuses it. */
  publish(topic: string, payload: string): Promise<void>;
  /**
   * Every delivery the client receives. The client must already subscribe to
   * the sender's own mailbox, `volley/<ns>/<identity>/mailbox`: volleyd
   * answers there, and the transport does not subscribe by itself.
   */
  onMessage(handler: (msg: DeskMessage) => void): () => void;
}

export interface PathReason {
  path: string;
  reason: string;
}

/** What the settings modal shows for one request. */
export interface ConfigAck {
  applied: boolean;
  version?: number;
  rejected: PathReason[];
  /** A daemon error, a refused publish or no answer in time. */
  error?: string;
  /** No answer in time: volleyd may still have applied the change. */
  unanswered?: true;
}

export interface ConfigTransport {
  /** The Desk's identity: the request's sender and its `by`. */
  identity: string;
  send(patch: Record<string, unknown>, opts?: { wave?: string; text?: string }): Promise<ConfigAck>;
}

const mailbox = (namespace: string, agentId: string) => `volley/${namespace}/${agentId}/mailbox`;

/** The request envelope. The namespace is in the topic, not the envelope (registry only). */
export function configSetEnvelope(r: {
  identity: string;
  correlationId: string;
  patch: Record<string, unknown>;
  text: string;
  wave?: string | undefined;
  now: Date;
}): Envelope {
  return {
    schema_version: "0.1",
    agent_id: r.identity,
    parent_id: null,
    channel: "mailbox",
    type: "query",
    wall_time: r.now.toISOString(),
    correlation_id: r.correlationId,
    payload: {
      op: "config_set",
      text: r.text,
      patch: r.patch,
      by: r.identity,
      ...(r.wave !== undefined ? { wave: r.wave } : {}),
    },
  };
}

function toAck(payload: unknown): ConfigAck {
  const p = (payload ?? {}) as Record<string, unknown>;
  const rejected = Array.isArray(p.rejected) ? (p.rejected as PathReason[]) : [];
  const version = (p.result as { version?: unknown } | undefined)?.version;
  return {
    applied: p.applied === true,
    ...(typeof version === "number" ? { version } : {}),
    rejected,
    ...(typeof p.error === "string" ? { error: p.error } : {}),
  };
}

export function createConfigTransport(
  client: ConfigClient,
  opts: {
    identity: string;
    namespace?: string;
    timeoutMs?: number;
    newId?: () => string;
    now?: () => Date;
  },
): ConfigTransport {
  const namespace = opts.namespace ?? "default";
  const timeoutMs = opts.timeoutMs ?? CONFIG_ACK_TIMEOUT_MS;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => new Date());
  const replies = mailbox(namespace, opts.identity);

  return {
    identity: opts.identity,
    send(patch, { wave, text = "config_set" } = {}) {
      const correlationId = newId();
      return new Promise<ConfigAck>((resolve) => {
        let off = () => {};
        const timer = setTimeout(
          () =>
            done({
              applied: false,
              rejected: [],
              error: `volleyd did not answer within ${timeoutMs / 1000}s`,
              unanswered: true,
            }),
          timeoutMs,
        );
        function done(ack: ConfigAck) {
          clearTimeout(timer);
          off();
          resolve(ack);
        }
        // Listen before publishing so a fast answer is not missed.
        off = client.onMessage((m) => {
          const env = m.envelope;
          // Only volleyd's answer counts: anyone may write the Desk's mailbox (SPEC §4.4).
          if (
            m.topic === replies &&
            env?.type === "ack" &&
            env.correlation_id === correlationId &&
            env.agent_id === DAEMON_AGENT_ID
          ) {
            done(toAck(env.payload));
          }
        });
        const envelope = configSetEnvelope({
          identity: opts.identity,
          correlationId,
          patch,
          text,
          wave,
          now: now(),
        });
        client
          .publish(mailbox(namespace, DAEMON_AGENT_ID), JSON.stringify(envelope))
          .catch((err: unknown) =>
            done({
              applied: false,
              rejected: [],
              error: err instanceof Error ? err.message : String(err),
            }),
          );
      });
    },
  };
}

/** Plain YAML scalars that stay strings: a letter or `/` first, no YAML keywords. */
const BARE = /^[A-Za-z/][A-Za-z0-9_./-]*$/;
const KEYWORDS = /^(null|true|false|yes|no|on|off)$/i;

/**
 * The `volleyd config set <path> <value>` line for a value. volleyd parses the
 * value as YAML, so a string that YAML would read as something else (or that
 * needs shell quoting) goes in as a JSON string inside single quotes.
 */
export function copyCommand(path: string, value: unknown): string {
  let v: string;
  if (typeof value === "string") {
    v =
      BARE.test(value) && !KEYWORDS.test(value)
        ? value
        : `'${JSON.stringify(value).replaceAll("'", "'\\''")}'`;
  } else {
    v = value === undefined ? "null" : JSON.stringify(value);
  }
  return `volleyd config set ${path} ${v}`;
}
