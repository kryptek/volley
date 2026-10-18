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
}

export type MessageHandler = (msg: DeskMessage) => void;
export type VoidHandler = () => void;
export type ErrorHandler = (err: Error) => void;

export interface DeskMqttClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Publish at QoS 1, not retained; resolves on PUBACK, rejects when not connected. */
  publish(topic: string, payload: string): Promise<void>;
  onMessage(handler: MessageHandler): () => void;
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
] as const;

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

  const subscribe = (instance: MqttClient): Promise<void> =>
    new Promise((resolve, reject) => {
      instance.subscribe([...DESK_SUBSCRIPTIONS], { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
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
        // mqtt.js re-subscribes on reconnect (`resubscribe` defaults on) the
        // filters that were granted, so we subscribe explicitly until one
        // SUBSCRIBE succeeds. Connect handlers run on every (re)connect after
        // that; each reconnect is followed by a replay of every retained topic.
        let subscribed = false;
        instance.on("connect", () => {
          if (subscribed) {
            for (const h of connectHandlers) h();
            return;
          }
          subscribe(instance)
            .then(() => {
              subscribed = true;
              for (const h of connectHandlers) h();
              resolve();
            })
            .catch((err: Error) => {
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
