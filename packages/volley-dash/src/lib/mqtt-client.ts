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

export interface CreateMqttClientOptions {
  url: string;
  clientId?: string;
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
          if (!instance.connected) reject(err);
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
