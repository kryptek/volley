import { randomBytes } from "node:crypto";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
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
  /**
   * MQTT clientId, used verbatim when supplied. REQUIRED when `cleanSession` is false,
   * because the broker keys the persistent session on it (a clean connect with the same
   * clientId discards that session). When omitted, `connect` generates
   * `volley-<agentId>-<random>`. Each persistent
   * consumer MUST own a distinct clientId (e.g. `volley-<agent_id>-mcp` vs
   * `volley-<agent_id>-hooks`): a same-clientId connect kicks the older client off.
   */
  clientId?: string;
  /**
   * false = persistent session: the broker keeps this client's subscriptions and queues
   * QoS 1 messages for it while it is offline. Default true (today's behaviour).
   */
  cleanSession?: boolean;
  /**
   * MQTT v5 `sessionExpiryInterval` for a persistent session; ignored on v4, where a
   * persistent session lives until the broker's own expiry policy removes it. Applies
   * to NEW connections only: an existing session keeps the expiry it was created with
   * until the client reconnects.
   */
  sessionExpirySeconds?: number;
  /** MQTT protocol version. Default 4 (v3.1.1). */
  protocolVersion?: 4 | 5;
}

export interface BrokerMessage {
  topic: string;
  payload: string;
}

export interface DrainOptions {
  /** Resolve once no message has arrived for this long (measured from SUBACK). */
  idleMs: number;
  /** Stop after this many messages; any remainder stays buffered for the next drain. */
  maxMessages?: number;
}

/** MQTT topic-filter match (`+` = one level, trailing `#` = any remaining levels). */
function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/**
 * `mqtt.connectAsync(url, options, false)`, plus a hook that runs on the client before the
 * connection completes so listeners are attached ahead of the first inbound packet.
 */
function connectClient(
  url: string,
  options: IClientOptions,
  beforeConnect: (client: MqttClient) => void,
): Promise<MqttClient> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(url, options);
    beforeConnect(client);
    const off = () => {
      client.off("connect", onConnect);
      client.off("error", onError);
      client.off("close", onClose);
    };
    const onConnect = () => {
      off();
      resolve(client);
    };
    const onError = (err: Error) => {
      off();
      client.end();
      reject(err);
    };
    const onClose = () => onError(new Error("Couldn't connect to server"));
    client.on("connect", onConnect);
    client.on("error", onError);
    client.on("close", onClose);
  });
}

/** Thin wrapper over an MQTT client — the only module in volley-mcp that imports `mqtt`. */
export class VolleyBroker {
  private client: MqttClient | null = null;
  /**
   * Messages received for `drainQueued` but not yet handed out. They are PUBACKed on
   * receipt, so anything still here at disconnect is lost — which is why mailbox
   * recipients confirm end-to-end with an application-level `ack` (SPEC §4.4).
   */
  private drainBuffer: BrokerMessage[] = [];
  /** Filters drained on this connection; null = buffer everything (persistent session, pre-first-drain). */
  private drainFilters: Set<string> | null = null;
  private drainClient: MqttClient | null = null;
  private drainListener: ((t: string, p: Buffer) => void) | null = null;
  private drainWaiters = new Set<() => void>();

  async connect(opts: BrokerConnectOptions): Promise<void> {
    if (this.client !== null) {
      throw new VolleyError("BROKER_DOWN", "broker is already connected; call disconnect() first");
    }
    const persistent = opts.cleanSession === false;
    if (persistent && (opts.clientId === undefined || opts.clientId === "")) {
      throw new VolleyError(
        "IMPL_CLIENT_ID_REQUIRED",
        "cleanSession:false requires an explicit clientId — the broker keys the persistent session on it",
      );
    }
    const timeoutMs = opts.connectTimeoutMs ?? 5000;
    // Hoist timer so the catch block can clear it on the connect-failure path.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // connectClient rejects on a 'close' before a successful connect (connectAsync's
      // allowRetries=false behaviour), so an unreachable broker rejects rather than hangs.
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
      // disconnect the older client on a same-clientId reconnect. An explicit
      // clientId (mandatory for a persistent session, which is keyed on it) is used
      // verbatim, so the caller owns uniqueness there.
      const clientId =
        opts.clientId !== undefined && opts.clientId !== ""
          ? opts.clientId
          : `volley-${opts.agentId}-${randomBytes(4).toString("hex")}`;
      const protocolVersion = opts.protocolVersion ?? 4;
      const options: IClientOptions = {
        clientId,
        keepalive: opts.keepaliveSeconds ?? 60,
        connectTimeout: timeoutMs,
        reconnectPeriod: 0,
        clean: !persistent,
        protocolVersion,
        ...(protocolVersion === 5 && persistent && opts.sessionExpirySeconds !== undefined
          ? { properties: { sessionExpiryInterval: opts.sessionExpirySeconds } }
          : {}),
        ...(will !== undefined ? { will } : {}),
      };
      this.client = await Promise.race([
        connectClient(opts.url, options, (client) => {
          // A resumed session's queued messages arrive right behind CONNACK — before
          // any caller can call drainQueued — so the buffer must be armed pre-connect.
          if (persistent) this.armDrainBuffer(client, null);
        }).then((client) => {
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
      this.resetDrainBuffer();
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
    this.resetDrainBuffer();
  }

  /** Test/crash helper: destroy the socket with no DISCONNECT so the broker fires the LWT. */
  simulateCrash(): void {
    if (this.client === null) return;
    this.client.stream.destroy();
    this.client = null;
    this.resetDrainBuffer();
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

  /**
   * Start buffering inbound messages for `drainQueued`. `filters` null buffers every
   * message (a resumed persistent session's subscriptions are unknown until drained).
   */
  private armDrainBuffer(client: MqttClient, filters: Set<string> | null): void {
    this.resetDrainBuffer();
    const listener = (t: string, p: Buffer) => {
      if (this.drainClient !== client) return;
      if (this.drainFilters !== null && ![...this.drainFilters].some((f) => topicMatches(f, t))) {
        return;
      }
      this.drainBuffer.push({ topic: t, payload: p.toString() });
      for (const wake of this.drainWaiters) wake();
    };
    client.on("message", listener);
    this.drainClient = client;
    this.drainListener = listener;
    this.drainFilters = filters;
  }

  private resetDrainBuffer(): void {
    if (this.drainClient !== null && this.drainListener !== null) {
      this.drainClient.removeListener("message", this.drainListener);
    }
    this.drainClient = null;
    this.drainListener = null;
    this.drainFilters = null;
    this.drainBuffer = [];
  }

  /**
   * Subscribe (QoS 1) to `topic` and collect messages until none has arrived for
   * `opts.idleMs` (or `opts.maxMessages` are collected). Unlike `subscribeCollect` this
   * does NOT unsubscribe: on a persistent session (`cleanSession: false`) the
   * subscription outlives the connection, so the broker queues messages while this
   * client is offline and delivers them on the next connect, where this returns them.
   * Messages that arrive on a live connection between drains are buffered for the next
   * call. Never rejects on idle; resolves with whatever was collected.
   */
  async drainQueued(topic: string, opts: DrainOptions): Promise<BrokerMessage[]> {
    const client = this.requireClient();
    if (this.drainClient !== client) this.armDrainBuffer(client, new Set());
    if (this.drainFilters === null) this.drainFilters = new Set([topic]);
    else this.drainFilters.add(topic);
    await new Promise<void>((resolve, reject) => {
      client.subscribe(topic, { qos: 1 }, (err) => {
        if (err) {
          reject(new VolleyError("BROKER_DOWN", `subscribe failed for ${topic}: ${err.message}`));
          return;
        }
        resolve();
      });
    });
    const max = opts.maxMessages ?? Number.POSITIVE_INFINITY;
    return new Promise((resolve) => {
      const collected: BrokerMessage[] = [];
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.drainWaiters.delete(take);
        resolve(collected);
      };
      const armIdle = () => {
        clearTimeout(timer);
        timer = setTimeout(finish, opts.idleMs);
      };
      const take = () => {
        if (settled) return;
        const before = collected.length;
        let i = 0;
        while (i < this.drainBuffer.length && collected.length < max) {
          const m = this.drainBuffer[i] as BrokerMessage;
          if (topicMatches(topic, m.topic)) {
            collected.push(m);
            this.drainBuffer.splice(i, 1);
          } else {
            i++;
          }
        }
        if (collected.length >= max) finish();
        else if (collected.length > before) armIdle();
      };
      this.drainWaiters.add(take);
      armIdle();
      take();
    });
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
