import { randomBytes } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import { VolleyError } from "./errors";

export interface BrokerConnectOptions {
  url: string;
  agentId: string;
  /**
   * LWT topic + payload — published retained by the broker on an ungraceful disconnect.
   * Both must be supplied together (will is configured) or both omitted (no will).
   * Conforming Volley agents (SPEC §7) MUST set a will; non-agent CLI tools MAY omit it.
   */
  willTopic?: string;
  willPayload?: string;
  keepaliveSeconds?: number;
  connectTimeoutMs?: number;
}

/** Thin wrapper over an MQTT client — the only module in volley-mcp that imports `mqtt`. */
export class VolleyBroker {
  private client: MqttClient | null = null;

  async connect(opts: BrokerConnectOptions): Promise<void> {
    if (this.client !== null) {
      throw new VolleyError("BROKER_DOWN", "broker is already connected; call disconnect() first");
    }
    const timeoutMs = opts.connectTimeoutMs ?? 5000;
    // Hoist timer so the catch block can clear it on the connect-failure path.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Pass allowRetries=false so connectAsync adds a 'close' listener that rejects
      // when the connection closes without a successful connect. This ensures the
      // promise rejects (rather than hanging) when the broker is unreachable.
      const will =
        opts.willTopic !== undefined && opts.willPayload !== undefined
          ? {
              topic: opts.willTopic,
              payload: Buffer.from(opts.willPayload),
              qos: 1 as const,
              retain: true,
            }
          : undefined;
      // Append a random suffix so two MCP processes sharing one VOLLEY_AGENT_ID
      // (the user-scope-MCP-on-two-Claude-Code-sessions case) get distinct MQTT
      // clientIds and don't kick each other off — MQTT spec mandates the broker
      // disconnect the older client on a same-clientId reconnect.
      const clientSuffix = randomBytes(4).toString("hex");
      this.client = await Promise.race([
        mqtt
          .connectAsync(
            opts.url,
            {
              clientId: `volley-${opts.agentId}-${clientSuffix}`,
              keepalive: opts.keepaliveSeconds ?? 60,
              connectTimeout: timeoutMs,
              reconnectPeriod: 0,
              clean: true,
              ...(will !== undefined ? { will } : {}),
            },
            false,
          )
          .then((client) => {
            // Clear the timeout timer so it does not keep the event loop alive
            // after a successful connect.
            clearTimeout(timer);
            return client;
          }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new VolleyError(
                  "BROKER_DOWN",
                  `connect to ${opts.url} timed out after ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          );
        }),
      ]);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof VolleyError) throw e;
      throw new VolleyError(
        "BROKER_DOWN",
        `cannot connect to broker at ${opts.url}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /** The MQTT clientId in use for the current connection, or null if not connected. */
  get clientId(): string | null {
    const v = this.client?.options.clientId;
    return typeof v === "string" ? v : null;
  }

  private requireClient(): MqttClient {
    if (this.client === null) {
      throw new VolleyError("BROKER_DOWN", "broker is not connected");
    }
    if (!this.client.connected) {
      throw new VolleyError(
        "BROKER_DOWN",
        "broker connection was dropped (kicked by same-clientId reconnect, network issue, or server-side close). Reconnect by restarting the MCP server.",
      );
    }
    return this.client;
  }

  /** Clean disconnect — sends a DISCONNECT packet, which suppresses the LWT. */
  async disconnect(): Promise<void> {
    if (this.client === null) return;
    await this.client.endAsync();
    this.client = null;
  }

  /** Test/crash helper: destroy the socket with no DISCONNECT so the broker fires the LWT. */
  simulateCrash(): void {
    if (this.client === null) return;
    this.client.stream.destroy();
    this.client = null;
  }

  /**
   * Test-only: destroy the underlying socket WITHOUT nulling `this.client`,
   * to exercise the "set-but-disconnected" branch in `requireClient()`.
   * NOT for production code paths — `disconnect()` and `simulateCrash()` are
   * the public verbs.
   */
  _destroyForTest(): void {
    if (this.client === null) return;
    this.client.stream.destroy();
    // intentionally NOT setting this.client = null
  }

  async publish(
    topic: string,
    payload: string,
    opts: { qos: 0 | 1; retain: boolean },
  ): Promise<void> {
    const client = this.requireClient();
    await client.publishAsync(topic, payload, { qos: opts.qos, retain: opts.retain });
  }

  /**
   * Read the current retained message at an exact topic. Subscribing causes the broker
   * to deliver the retained value immediately; resolves with the payload string, or null
   * if nothing arrives within `timeoutMs`. Always unsubscribes and detaches its listener.
   */
  async queryRetained(topic: string, timeoutMs = 1000): Promise<string | null> {
    const client = this.requireClient();
    return new Promise<string | null>((resolve, reject) => {
      let settled = false;
      const onMessage = (t: string, p: Buffer) => {
        if (settled || t !== topic) return;
        settled = true;
        cleanup();
        resolve(p.toString());
      };
      const cleanup = () => {
        clearTimeout(timer);
        client.removeListener("message", onMessage);
        // Harmless no-op if the subscribe itself failed; the .catch swallows it.
        client.unsubscribeAsync(topic).catch(() => {});
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      }, timeoutMs);
      client.on("message", onMessage);
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err && !settled) {
          settled = true;
          cleanup();
          reject(new VolleyError("BROKER_DOWN", `subscribe failed for ${topic}: ${err.message}`));
        }
      });
    });
  }

  /**
   * Subscribe to a topic pattern and collect messages until `maxMessages` arrive or
   * `timeoutMs` elapses, whichever comes first. Retained messages arrive immediately on
   * subscribe; live messages arrive as published. Always unsubscribes, detaches its
   * listener, and resolves with whatever was collected (never rejects on timeout).
   */
  async subscribeCollect(
    topicPattern: string,
    maxMessages: number,
    timeoutMs: number,
  ): Promise<{ topic: string; payload: string }[]> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      const collected: { topic: string; payload: string }[] = [];
      let settled = false;
      const onMessage = (t: string, p: Buffer) => {
        if (settled) return;
        collected.push({ topic: t, payload: p.toString() });
        if (collected.length >= maxMessages) finish();
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeListener("message", onMessage);
        client.unsubscribeAsync(topicPattern).catch(() => {});
        resolve(collected);
      };
      const timer = setTimeout(finish, timeoutMs);
      client.on("message", onMessage);
      client.subscribe(topicPattern, { qos: 1 }, (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timer);
          client.removeListener("message", onMessage);
          reject(
            new VolleyError("BROKER_DOWN", `subscribe failed for ${topicPattern}: ${err.message}`),
          );
        }
      });
    });
  }

  /**
   * Subscribe to a topic pattern ONCE and resolve with the first message whose payload
   * satisfies `predicate`, or null if the predicate never matches within `timeoutMs`.
   *
   * Retained messages are delivered immediately on subscribe; subsequent live messages
   * arrive as they are published. Because the subscription stays open for the whole
   * wait, the broker never re-delivers the retained payload — non-matching messages
   * (retained or live) are silently skipped. This is the right primitive for
   * "block until predicate true," vs. `subscribeCollect` which is "block until N
   * messages arrive or time runs out."
   */
  async subscribeUntil(
    topicPattern: string,
    predicate: (payload: string, topic: string) => boolean,
    timeoutMs: number,
  ): Promise<{ topic: string; payload: string } | null> {
    const client = this.requireClient();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (result: { topic: string; payload: string } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeListener("message", onMessage);
        client.unsubscribeAsync(topicPattern).catch(() => {});
        resolve(result);
      };
      const onMessage = (t: string, p: Buffer) => {
        if (settled) return;
        const payload = p.toString();
        if (predicate(payload, t)) finish({ topic: t, payload });
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      client.on("message", onMessage);
      client.subscribe(topicPattern, { qos: 1 }, (err) => {
        if (err && !settled) {
          settled = true;
          clearTimeout(timer);
          client.removeListener("message", onMessage);
          reject(
            new VolleyError("BROKER_DOWN", `subscribe failed for ${topicPattern}: ${err.message}`),
          );
        }
      });
    });
  }

  /**
   * Subscribe to a topic pattern and invoke `onMessage` for every message,
   * indefinitely. Returns an `unsubscribe` function that detaches the listener,
   * calls MQTT UNSUBSCRIBE, and resolves once both are clean.
   *
   * Unlike `subscribeCollect`, this does NOT accumulate messages in memory —
   * it streams them through the callback. The right primitive for indefinite-
   * runtime consumers like `volley notify`.
   */
  async subscribeStream(
    topicPattern: string,
    onMessage: (msg: { topic: string; payload: string }) => void,
  ): Promise<() => Promise<void>> {
    const client = this.requireClient();
    const listener = (t: string, p: Buffer) => {
      onMessage({ topic: t, payload: p.toString() });
    };
    client.on("message", listener);
    await new Promise<void>((resolve, reject) => {
      client.subscribe(topicPattern, { qos: 1 }, (err) => {
        if (err) {
          client.removeListener("message", listener);
          reject(
            new VolleyError("BROKER_DOWN", `subscribe failed for ${topicPattern}: ${err.message}`),
          );
          return;
        }
        resolve();
      });
    });
    return async () => {
      client.removeListener("message", listener);
      await client.unsubscribeAsync(topicPattern).catch(() => {});
    };
  }
}
