/**
 * Thin typed wrapper around mqtt.js. Subscribes to all 5 Volley wildcards
 * on connect and surfaces each message as `(topic, envelope)` via `onMessage`.
 * Defensive: silently drops topics that don't match the Volley grammar and
 * messages whose payloads fail envelope validation (both `console.warn` in
 * the helpers, so noise is visible in DevTools without breaking the UI).
 */
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { type ParsedEnvelope, parseEnvelope } from "./parse-envelope";
import { parseTopic } from "./parse-topic";

/** Broker credentials (mosquitto `password_file` identity, e.g. `desk`). */
export interface BrokerCredentials {
  username: string;
  password: string;
}

export interface CreateMqttClientOptions {
  url: string;
  clientId?: string;
  /** Omit to connect anonymously. */
  auth?: BrokerCredentials | undefined;
}

/** CONNACK codes meaning "credentials refused": MQTT 3.1.1 (4, 5) and MQTT 5 (134, 135). */
const AUTH_REFUSED_CODES = new Set([4, 5, 134, 135]);

/** `connect()` rejects with this when the broker refuses the credentials (SPEC §9 AUTH_FAILED). */
export class AuthFailedError extends Error {
  readonly code = "AUTH_FAILED";
  constructor(message: string) {
    super(message);
    this.name = "AuthFailedError";
  }
}

function isAuthRefusal(err: Error): boolean {
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === "number" && AUTH_REFUSED_CODES.has(code);
}

export type MessageHandler = (topic: string, envelope: ParsedEnvelope) => void;
export type VoidHandler = () => void;
export type ErrorHandler = (err: Error) => void;

export interface VolleyMqttClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onMessage(handler: MessageHandler): () => void;
  onConnect(handler: VoidHandler): () => void;
  onDisconnect(handler: VoidHandler): () => void;
  onError(handler: ErrorHandler): () => void;
}

export const VOLLEY_WILDCARDS = [
  "volley/_system/registry/+",
  "volley/+/+/status",
  "volley/+/+/progress",
  "volley/+/+/mailbox",
  "volley/+/+/result",
] as const;

function defaultClientId(): string {
  return `volley-dash-${Math.random().toString(36).slice(2, 10)}`;
}

export function createMqttClient(options: CreateMqttClientOptions): VolleyMqttClient {
  const clientId = options.clientId ?? defaultClientId();
  const messageHandlers = new Set<MessageHandler>();
  const connectHandlers = new Set<VoidHandler>();
  const disconnectHandlers = new Set<VoidHandler>();
  const errorHandlers = new Set<ErrorHandler>();

  let client: MqttClient | null = null;

  const subscribe = (instance: MqttClient): Promise<void> =>
    new Promise((resolve, reject) => {
      instance.subscribe(VOLLEY_WILDCARDS as unknown as string[], { qos: 1 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

  return {
    connect() {
      return new Promise<void>((resolve, reject) => {
        const connectOptions: IClientOptions = {
          clientId,
          reconnectPeriod: 0,
          ...(options.auth !== undefined
            ? { username: options.auth.username, password: options.auth.password }
            : {}),
        };
        const instance = mqtt.connect(options.url, connectOptions);
        client = instance;

        instance.on("message", (topic, payload) => {
          const parsedTopic = parseTopic(topic);
          if (parsedTopic === null) return;
          const envelope = parseEnvelope(payload);
          if (envelope === null) return;
          for (const h of messageHandlers) h(topic, envelope);
        });
        instance.on("error", (err) => {
          for (const h of errorHandlers) h(err);
        });
        instance.on("close", () => {
          for (const h of disconnectHandlers) h();
        });

        instance.once("connect", () => {
          subscribe(instance)
            .then(() => {
              for (const h of connectHandlers) h();
              resolve();
            })
            .catch(reject);
        });
        instance.once("error", (err) => {
          // First-error before connect rejects connect(); subsequent errors
          // flow through errorHandlers above.
          if (instance.connected) return;
          reject(isAuthRefusal(err) ? new AuthFailedError(err.message) : err);
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
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => {
        messageHandlers.delete(handler);
      };
    },
    onConnect(handler) {
      connectHandlers.add(handler);
      return () => {
        connectHandlers.delete(handler);
      };
    },
    onDisconnect(handler) {
      disconnectHandlers.add(handler);
      return () => {
        disconnectHandlers.delete(handler);
      };
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => {
        errorHandlers.delete(handler);
      };
    },
  };
}
