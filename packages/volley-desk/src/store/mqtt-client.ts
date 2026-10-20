/**
 * Thin typed wrapper around mqtt.js, ported from volley-dash. Subscribes to
 * every topic the Desk renders on connect and surfaces each delivery as a
 * `DeskMessage` for the reducer. Unlike the dashboard client it passes a
 * zero-length payload through as `envelope: null` — that is how a supervisor
 * clears a retained topic (SPEC §4.6) — flags retained replays, and it
 * reconnects by default, since the Desk stays open for hours (the store
 * resyncs on each reconnect; see `attachClient` in `context.tsx`). With broker
 * credentials (T14, the `desk` identity) it can also `publish` (steering, D4).
 * A broker that refuses the credentials (or an anonymous client) surfaces as an
 * `AuthFailedError`, from `connect()` and from `onError` on a later reconnect.
 * `reconnect()` probes the broker (a SUBSCRIBE round trip on a filter of its own)
 * and drops the socket if it does not answer, or connects again at once when already disconnected:
 * the store calls it when the page comes back to the foreground, since a phone
 * that suspended the tab leaves a dead socket the keepalive notices much later.
 */
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import type { DeskMessage, Envelope } from "./types";

/** Broker credentials (mosquitto `password_file` identity, e.g. `desk`). */
export interface BrokerCredentials {
  username: string;
  password: string;
}

/** CONNACK codes meaning "credentials refused": MQTT 3.1.1 (4, 5) and MQTT 5 (134, 135). */
const AUTH_REFUSED_CODES = new Set([4, 5, 134, 135]);

/** The broker refused the credentials (SPEC §9 AUTH_FAILED). */
export class AuthFailedError extends Error {
  readonly code = "AUTH_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "AuthFailedError";
  }
}

function asAuthFailure(err: Error): Error {
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === "number" && AUTH_REFUSED_CODES.has(code)
    ? new AuthFailedError(err.message)
    : err;
}

export interface CreateMqttClientOptions {
  url: string;
  clientId?: string;
  /** Sign in as this identity; anonymous when absent. */
  auth?: BrokerCredentials | undefined;
  /** ms between reconnect attempts; 0 disables reconnecting. */
  reconnectPeriod?: number;
  /** ms the `reconnect()` probe waits for its SUBACK before dropping the socket. */
  probeTimeoutMs?: number;
}

export type MessageHandler = (msg: DeskMessage) => void;
export type VoidHandler = () => void;
export type ErrorHandler = (err: Error) => void;

export interface DeskMqttClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Publish at QoS 1, not retained; resolves on PUBACK, rejects when not connected. */
  publish(topic: string, payload: string): Promise<void>;
  /** Drop the socket and connect again now (a resumed page probing for a dead socket). */
  reconnect?(): void;
  onMessage(handler: MessageHandler): () => void;
  /** Each (re)connect, once its subscriptions are granted: just before the retained replay. */
  onConnect(handler: VoidHandler): () => void;
  onDisconnect(handler: VoidHandler): () => void;
  onError(handler: ErrorHandler): () => void;
}

export const DESK_SUBSCRIPTIONS = [
  "volley/_system/registry/+",
  "volley/+/+/status",
  "volley/+/+/progress",
  "volley/+/+/result",
  "volley/+/+/mailbox",
  "volley/+/+/screen",
  "volley/_waves/+/state",
  "volley/_waves/+/decisions/+",
  "volley/_waves/_config",
  "volley/_system/leases/+",
  "volley/_system/admission",
  "volley/+/+/usage",
  "volley/_system/claude-accounts/+",
  "volley/_system/claude/+/signin",
  // Each machine's record and, under it, volleyd's readiness verdict (SPEC §4.6.15).
  "volley/_system/machines/#",
  // The needs-you inbox: one retained record per thing waiting for a person (SPEC §4.6.17).
  "volley/_inbox/+",
  // volleyd's answers to account ops (SPEC §4.6.10); secrets in them are sealed to the requester.
  "volley/_system/auth/replies/+",
] as const;

/**
 * The filter `reconnect()` subscribes to (and unsubscribes from) as a probe. It is
 * this client's own: a SUBSCRIBE to a Desk filter would make the broker replay every
 * retained topic under it again.
 * Nothing publishes there; the global `read volley/#` grant covers it.
 */
const probeFilter = (clientId: string) => `volley/_system/desk-probe/${clientId}`;
/** How long the probe waits for the SUBACK before it drops the socket. */
const PROBE_TIMEOUT_MS = 3000;

const REQUIRED = ["schema_version", "agent_id", "channel", "type"] as const;

/** The protocol major this client speaks; others are rejected (SPEC §3.1). */
const SCHEMA_MAJOR = "0";

/** Parse a payload: `null` for a cleared topic, `undefined` for one to drop. */
export function parsePayload(raw: Uint8Array | string): Envelope | null | undefined {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.warn("volley-desk: malformed envelope JSON", err);
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const obj = parsed as Record<string, unknown>;
  if (REQUIRED.some((f) => typeof obj[f] !== "string")) {
    console.warn("volley-desk: envelope missing a required field");
    return undefined;
  }
  if ((obj.schema_version as string).split(".")[0] !== SCHEMA_MAJOR) {
    console.warn(`volley-desk: unsupported schema_version ${obj.schema_version as string}`);
    return undefined;
  }
  return obj as Envelope;
}

function defaultClientId(): string {
  return `volley-desk-${Math.random().toString(36).slice(2, 10)}`;
}

export function createMqttClient(options: CreateMqttClientOptions): DeskMqttClient {
  const clientId = options.clientId ?? defaultClientId();
  const messageHandlers = new Set<MessageHandler>();
  const connectHandlers = new Set<VoidHandler>();
  const disconnectHandlers = new Set<VoidHandler>();
  const errorHandlers = new Set<ErrorHandler>();

  let client: MqttClient | null = null;

  // `onGranted` runs in the SUBACK callback itself, before the broker's retained replay
  // (sent after the SUBACK) is handled: a promise continuation could run after it.
  const subscribe = (instance: MqttClient, onGranted: () => void): Promise<void> =>
    new Promise((resolve, reject) => {
      instance.subscribe([...DESK_SUBSCRIPTIONS], { qos: 1 }, (err) => {
        if (err) return reject(err);
        onGranted();
        resolve();
      });
    });

  const on =
    <H>(set: Set<H>) =>
    (handler: H) => {
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    };

  return {
    connect() {
      return new Promise<void>((resolve, reject) => {
        const connectOptions: IClientOptions = {
          clientId,
          reconnectPeriod: options.reconnectPeriod ?? 2000,
          // Every connect subscribes itself (below), so its handlers run at the SUBACK.
          resubscribe: false,
          ...(options.auth
            ? { username: options.auth.username, password: options.auth.password }
            : {}),
        };
        const instance = mqtt.connect(options.url, connectOptions);
        client = instance;

        instance.on("message", (topic, payload, packet) => {
          const envelope = parsePayload(payload);
          if (envelope === undefined) return;
          const msg: DeskMessage = {
            topic,
            envelope,
            receivedAt: Date.now(),
            retained: packet.retain,
          };
          for (const h of messageHandlers) h(msg);
        });
        instance.on("error", (raw) => {
          const err = asAuthFailure(raw);
          for (const h of errorHandlers) h(err);
        });
        instance.on("close", () => {
          for (const h of disconnectHandlers) h();
        });
        // Every (re)connect subscribes explicitly (mqtt.js's own resubscribe is off)
        // and runs the connect handlers in the SUBACK callback: the broker's retained
        // replay follows the SUBACK, so the handlers always run just before it (the
        // store holds it, C11), never a round trip early at the CONNACK. A SUBACK
        // from a connection that has since dropped is ignored; the next connect
        // subscribes again.
        let attempt = 0;
        instance.on("connect", () => {
          const mine = ++attempt;
          subscribe(instance, () => {
            if (mine !== attempt || !instance.connected) return;
            for (const h of connectHandlers) h();
          })
            .then(() => resolve())
            .catch((err: Error) => {
              if (mine !== attempt) return;
              for (const h of errorHandlers) h(err);
              reject(err);
            });
        });
        instance.once("error", (err) => {
          if (!instance.connected) reject(asAuthFailure(err));
        });
      });
    },
    disconnect() {
      const instance = client;
      if (instance === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        instance.end(false, {}, () => {
          client = null;
          resolve();
        });
      });
    },
    reconnect() {
      const instance = client;
      if (instance === null || instance.disconnecting) return;
      if (!instance.connected) {
        instance.reconnect();
        return;
      }
      // Looks connected: probe with a SUBSCRIBE a live broker answers at once. A dead
      // socket never does (and a failed one is no answer either), so drop it and let
      // mqtt.js reconnect (and the store resync).
      const filter = probeFilter(clientId);
      const drop = () => instance.stream?.destroy();
      const timer = setTimeout(drop, options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
      instance.subscribe(filter, { qos: 0 }, (err) => {
        clearTimeout(timer);
        if (err) drop();
        else instance.unsubscribe(filter);
      });
    },
    publish(topic, payload) {
      const instance = client;
      if (instance === null || !instance.connected) {
        return Promise.reject(new Error("not connected to the broker"));
      }
      return new Promise<void>((resolve, reject) => {
        instance.publish(topic, payload, { qos: 1, retain: false }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    onMessage: on(messageHandlers),
    onConnect: on(connectHandlers),
    onDisconnect: on(disconnectHandlers),
    onError: on(errorHandlers),
  };
}

/**
 * A one-time token's own short-lived broker login (SPEC §4.6.10): username = the token id,
 * password = the token. Its role grants exactly two topics, `volley-auth/redeem/<id>` (write)
 * and `.../reply` (read), so this client subscribes to nothing by itself, never reconnects and
 * is ended as soon as the redemption has its answer.
 */
export interface TokenClient {
  /** Rejects with `AuthFailedError` when the broker refuses the login (a used or expired token). */
  connect(): Promise<void>;
  /** Rejects when the broker refuses the subscription. */
  subscribe(topic: string): Promise<void>;
  publish(topic: string, payload: string): Promise<void>;
  onMessage(handler: (topic: string, payload: string) => void): () => void;
  end(): Promise<void>;
}

/** SUBACK return code for a refused subscription. */
const SUBACK_FAILURE = 128;

export function createTokenClient(url: string, auth: BrokerCredentials): TokenClient {
  const handlers = new Set<(topic: string, payload: string) => void>();
  let client: MqttClient | null = null;
  return {
    connect() {
      return new Promise<void>((resolve, reject) => {
        const instance = mqtt.connect(url, {
          clientId: `volley-desk-token-${Math.random().toString(36).slice(2, 10)}`,
          username: auth.username,
          password: auth.password,
          reconnectPeriod: 0,
          connectTimeout: 10_000,
        });
        client = instance;
        instance.on("message", (topic, payload) => {
          const text = new TextDecoder().decode(payload);
          for (const h of handlers) h(topic, text);
        });
        instance.once("connect", () => resolve());
        // `on`, not `once`: mqtt.js emits every stream error, and an "error" with no listener
        // throws. Only the first settles the connect; the rest are dropped (the client is ended).
        let settled = false;
        instance.on("error", (err) => {
          if (settled) return;
          settled = true;
          reject(asAuthFailure(err));
        });
        instance.once("close", () => {
          // A refused CONNACK also closes the socket: let its error (AUTH_FAILED) settle first.
          setTimeout(() => {
            settled = true;
            reject(new Error(`could not reach the broker at ${url}`));
          }, 0);
        });
      });
    },
    subscribe(topic) {
      const instance = client;
      if (instance === null) return Promise.reject(new Error("not connected to the broker"));
      return new Promise<void>((resolve, reject) => {
        instance.subscribe(topic, { qos: 1 }, (err, granted) => {
          if (err) reject(err);
          else if (granted?.some((g) => g.qos === SUBACK_FAILURE))
            reject(new Error(`the broker refused the subscription to ${topic}`));
          else resolve();
        });
      });
    },
    publish(topic, payload) {
      const instance = client;
      if (instance === null) return Promise.reject(new Error("not connected to the broker"));
      return new Promise<void>((resolve, reject) => {
        instance.publish(topic, payload, { qos: 1, retain: false }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    end() {
      const instance = client;
      client = null;
      if (instance === null) return Promise.resolve();
      return new Promise<void>((resolve) => {
        instance.end(true, {}, () => resolve());
      });
    },
  };
}
