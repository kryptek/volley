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
  /** Publish the will retained (default true: an agent's LWT is its retained status). */
  willRetain?: boolean;
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
   * MQTT v5 `sessionExpiryInterval` for a persistent session (default
   * `DEFAULT_SESSION_EXPIRY_S`); ignored on v4, where a persistent session lives until
   * the broker's own expiry policy removes it. Applies to NEW connections only: an
   * existing session keeps the expiry it was created with until the client reconnects.
   */
  sessionExpirySeconds?: number;
  /** MQTT protocol version. Default 4 (v3.1.1). */
  protocolVersion?: 4 | 5;
  /** Broker credentials (SPEC §11.5). Omit both to connect anonymously. */
  username?: string;
  password?: string;
}

/** CONNACK codes meaning "credentials refused": MQTT 3.1.1 (4, 5) and MQTT 5 (134, 135). */
const AUTH_REFUSED_CODES = new Set([4, 5, 134, 135]);

/** Printed with every AUTH_FAILED — points at the command that says which login was used. */
export const AUTH_HINT =
  "Hint: run `volley auth status` to see which login this shell uses and why.";

function authFailed(url: string, username: string | undefined): VolleyError {
  const who =
    username !== undefined ? `the credentials for user "${username}"` : "anonymous access";
  return new VolleyError("AUTH_FAILED", `broker at ${url} refused ${who}. ${AUTH_HINT}`);
}

/** Default v5 session expiry for persistent consumers: 7 days (tunable `mailbox.session_expiry_s`). */
export const DEFAULT_SESSION_EXPIRY_S = 7 * 24 * 60 * 60;

export interface BrokerMessage {
  topic: string;
  payload: string;
}

export interface DrainOptions {
  /** Resolve once no message has arrived for this long (measured from SUBACK). */
  idleMs: number;
  /** Stop after this many messages; any remainder stays buffered for the next drain. */
  maxMessages?: number;
  /** Resolve after this long (measured from SUBACK) even if messages keep arriving. */
  maxWaitMs?: number;
}

/** A local subscriber: receives every inbound message whose topic matches `filter`. */
interface Route {
  filter: string;
  deliver: (msg: BrokerMessage) => void;
}

/** A pending `drainQueued` call: `take` pulls matching buffered messages, `finish` resolves it. */
interface DrainWaiter {
  take: () => void;
  finish: () => void;
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

/** How long a clean `disconnect()` waits for DISCONNECT to go out before it forces the end. */
const DISCONNECT_FORCE_MS = 2000;

/** Thin wrapper over an MQTT client — the only module in volley-mcp that imports `mqtt`. */
export class VolleyBroker {
  private client: MqttClient | null = null;
  /** Each connection's close, for the publishes still waiting on an ack (`publish`). */
  private readonly closings = new WeakMap<MqttClient, Promise<"closed">>();
  /**
   * Per-connection routing. MQTT holds ONE subscription per filter per client — a second
   * SUBSCRIBE replaces the first and an UNSUBSCRIBE removes it for everyone — so a single
   * `message` listener (attached in `connect`) fans each message out to the local routes
   * whose filter matches, and `filterHolds` reference-counts the filters so UNSUBSCRIBE
   * only goes out when the last local holder releases one.
   */
  private routedClient: MqttClient | null = null;
  private dispatcher: ((t: string, p: Buffer) => void) | null = null;
  private routes = new Set<Route>();
  private filterHolds = new Map<string, number>();
  /** The current connection resumed (or created) a persistent session. */
  private persistentSession = false;
  /**
   * Messages received for `drainQueued` but not yet handed out. They are PUBACKed on
   * receipt, so anything still here at disconnect is lost — which is why mailbox
   * recipients confirm end-to-end with an application-level `ack` (SPEC §4.4).
   */
  private drainBuffer: BrokerMessage[] = [];
  /** Filters drained on this connection (held until disconnect) → their SUBSCRIBE. */
  private drainFilters = new Map<string, Promise<void>>();
  private drainWaiters = new Set<DrainWaiter>();

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
              retain: opts.willRetain ?? true,
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
        ...(protocolVersion === 5 && persistent
          ? {
              properties: {
                sessionExpiryInterval: opts.sessionExpirySeconds ?? DEFAULT_SESSION_EXPIRY_S,
              },
            }
          : {}),
        ...(will !== undefined ? { will } : {}),
        ...(opts.username !== undefined ? { username: opts.username } : {}),
        ...(opts.password !== undefined ? { password: opts.password } : {}),
      };
      this.client = await Promise.race([
        connectClient(opts.url, options, (client) => {
          // A resumed session's queued messages arrive right behind CONNACK — before
          // any caller can call drainQueued — so routing must be armed pre-connect.
          this.attachDispatcher(client, persistent);
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
      this.resetConnectionState();
      if (e instanceof VolleyError) throw e;
      const code = (e as { code?: unknown } | null)?.code;
      if (typeof code === "number" && AUTH_REFUSED_CODES.has(code)) {
        throw authFailed(opts.url, opts.username);
      }
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

  /** The v5 `sessionExpiryInterval` sent on CONNECT, or null if none was sent. */
  get sessionExpiryInterval(): number | null {
    return this.client?.options.properties?.sessionExpiryInterval ?? null;
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
  /**
   * End the connection; always settles. A live one sends DISCONNECT (so the broker does not
   * fire the LWT), falling back to force after DISCONNECT_FORCE_MS. A dropped one is ended
   * with force: mqtt.js's plain `end()` waits for its outgoing QoS 1 publishes to drain, which
   * on a closed socket that never reconnects is never.
   */
  async disconnect(): Promise<void> {
    const client = this.client;
    if (client === null) return;
    try {
      if (!client.connected) {
        await client.endAsync(true);
      } else {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const forced = new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            client.endAsync(true).then(resolve, () => resolve());
          }, DISCONNECT_FORCE_MS);
        });
        await Promise.race([client.endAsync(), forced]).finally(() => clearTimeout(timer));
      }
    } finally {
      if (this.client === client) {
        this.client = null;
        this.resetConnectionState();
      }
    }
  }

  /** Test/crash helper: destroy the socket with no DISCONNECT so the broker fires the LWT. */
  simulateCrash(): void {
    if (this.client === null) return;
    this.client.stream.destroy();
    this.client = null;
    this.resetConnectionState();
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
   * Route `client`'s inbound messages: to every local route whose filter matches, and
   * into the drain buffer when the topic is drained — or, on a persistent session, when
   * no route claims it (the session's restored subscriptions are unknown until drained,
   * and a message dropped here has already been PUBACKed, so it would be lost for good).
   */
  private attachDispatcher(client: MqttClient, persistent: boolean): void {
    this.resetConnectionState();
    const dispatcher = (t: string, p: Buffer) => {
      if (this.routedClient !== client) return;
      const msg = { topic: t, payload: p.toString() };
      let claimed = false;
      for (const route of [...this.routes]) {
        if (!topicMatches(route.filter, t)) continue;
        claimed = true;
        route.deliver(msg);
      }
      const drained = [...this.drainFilters.keys()].some((f) => topicMatches(f, t));
      if (drained || (this.persistentSession && !claimed)) {
        this.drainBuffer.push(msg);
        for (const waiter of [...this.drainWaiters]) waiter.take();
      }
    };
    client.on("message", dispatcher);
    this.routedClient = client;
    this.dispatcher = dispatcher;
    this.persistentSession = persistent;
  }

  /** Drop all per-connection state; a drain still pending resolves with what it has. */
  private resetConnectionState(): void {
    if (this.routedClient !== null && this.dispatcher !== null) {
      this.routedClient.removeListener("message", this.dispatcher);
    }
    for (const waiter of [...this.drainWaiters]) waiter.finish();
    this.routedClient = null;
    this.dispatcher = null;
    this.routes = new Set();
    this.filterHolds = new Map();
    this.persistentSession = false;
    this.drainBuffer = [];
    this.drainFilters = new Map();
    this.drainWaiters = new Set();
  }

  private sendSubscribe(client: MqttClient, filter: string): Promise<void> {
    return new Promise((resolve, reject) => {
      client.subscribe(filter, { qos: 1 }, (err) => {
        if (err) {
          reject(new VolleyError("BROKER_DOWN", `subscribe failed for ${filter}: ${err.message}`));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Take a hold on `filter` and SUBSCRIBE. Every hold re-sends SUBSCRIBE (so a new holder
   * gets the filter's retained messages; the broker re-delivers them to every route on
   * that filter). The SUBSCRIBE packet is written synchronously, ahead of any later
   * PUBLISH on this client.
   */
  private holdFilter(client: MqttClient, filter: string): Promise<void> {
    this.filterHolds.set(filter, (this.filterHolds.get(filter) ?? 0) + 1);
    return this.sendSubscribe(client, filter);
  }

  /** Release one hold; UNSUBSCRIBE only when no local holder remains. */
  private async releaseFilter(client: MqttClient, filter: string): Promise<void> {
    if (client !== this.routedClient) return; // the connection (and its holds) is gone
    const n = (this.filterHolds.get(filter) ?? 0) - 1;
    if (n > 0) {
      this.filterHolds.set(filter, n);
      return;
    }
    this.filterHolds.delete(filter);
    // A dead socket has no subscription left to remove (and the UNSUBACK would never come).
    if (!client.connected) return;
    await client.unsubscribeAsync(filter).catch(() => {});
  }

  /**
   * Add a route for `filter` and hold it. `close` (idempotent) removes the route and
   * releases the hold; callers MUST call it on every exit path, including a failed `ready`.
   */
  private attachRoute(
    client: MqttClient,
    filter: string,
    deliver: (msg: BrokerMessage) => void,
  ): { ready: Promise<void>; close: () => Promise<void> } {
    const route: Route = { filter, deliver };
    this.routes.add(route);
    let closed = false;
    const ready = this.holdFilter(client, filter);
    return {
      ready,
      close: async () => {
        if (closed) return;
        closed = true;
        this.routes.delete(route);
        await this.releaseFilter(client, filter);
      },
    };
  }

  /**
   * Subscribe (QoS 1) to `topic` and collect messages until none has arrived for
   * `opts.idleMs` (or `opts.maxMessages` are collected, or `opts.maxWaitMs` passes).
   * Unlike `subscribeCollect` this does NOT unsubscribe: the filter stays held for the
   * rest of the connection, so no other helper's release can UNSUBSCRIBE it, and on a
   * persistent session (`cleanSession: false`) the subscription outlives the connection —
   * the broker queues messages while this client is offline and delivers them on the next
   * connect, where this returns them. Messages that arrive on a live connection between
   * drains are buffered for the next call. Never rejects on idle; resolves with whatever
   * was collected (and early, with what it has, if the connection is reset).
   *
   * A persistent `VolleyBroker` SHOULD be dedicated to draining: until a filter is drained
   * on a resumed connection, call no other helper on it (its release would UNSUBSCRIBE the
   * restored subscription), and messages no route claims are buffered until drained or
   * disconnect.
   */
  async drainQueued(topic: string, opts: DrainOptions): Promise<BrokerMessage[]> {
    const client = this.requireClient();
    let subscribed = this.drainFilters.get(topic);
    if (subscribed === undefined) {
      subscribed = this.holdFilter(client, topic);
      this.drainFilters.set(topic, subscribed);
      subscribed.catch(() => {
        if (this.drainFilters.get(topic) !== subscribed) return;
        this.drainFilters.delete(topic);
        void this.releaseFilter(client, topic);
      });
    }
    await subscribed;
    const max = opts.maxMessages ?? Number.POSITIVE_INFINITY;
    return new Promise((resolve) => {
      const collected: BrokerMessage[] = [];
      let settled = false;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        clearTimeout(deadline);
        this.drainWaiters.delete(waiter);
        resolve(collected);
      };
      const deadline =
        opts.maxWaitMs === undefined ? undefined : setTimeout(finish, opts.maxWaitMs);
      const armIdle = () => {
        clearTimeout(idle);
        idle = setTimeout(finish, opts.idleMs);
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
      const waiter: DrainWaiter = { take, finish };
      this.drainWaiters.add(waiter);
      armIdle();
      take();
    });
  }

  /**
   * Publish, resolved once the broker acknowledged it (QoS 1). A publish still unacknowledged
   * when the connection closes fails with BROKER_DOWN: the client never reconnects, and mqtt.js
   * keeps a persistent session's QoS 1 publishes for a reconnect, so it would never settle.
   */
  async publish(
    topic: string,
    payload: string,
    opts: { qos: 0 | 1; retain: boolean },
  ): Promise<void> {
    const client = this.requireClient();
    const sent = client
      .publishAsync(topic, payload, { qos: opts.qos, retain: opts.retain })
      .then(() => "sent" as const);
    if ((await Promise.race([sent, this.closedOf(client)])) === "closed")
      throw new VolleyError(
        "BROKER_DOWN",
        `broker connection closed before the publish on ${topic} was acknowledged`,
      );
  }

  /** Resolves once `client`'s connection closes (one listener per connection). */
  private closedOf(client: MqttClient): Promise<"closed"> {
    let closed = this.closings.get(client);
    if (closed === undefined) {
      closed = new Promise((resolve) => client.once("close", () => resolve("closed")));
      this.closings.set(client, closed);
    }
    return closed;
  }

  /**
   * Read the current retained message at an exact topic. Subscribing causes the broker
   * to deliver the retained value immediately; resolves with the payload string, or null
   * if nothing arrives within `timeoutMs`. Always releases its subscription.
   */
  async queryRetained(topic: string, timeoutMs = 1000): Promise<string | null> {
    const client = this.requireClient();
    return new Promise<string | null>((resolve, reject) => {
      let settled = false;
      const sub = this.attachRoute(client, topic, (m) => {
        if (settled || m.topic !== topic) return;
        settled = true;
        cleanup();
        resolve(m.payload);
      });
      const cleanup = () => {
        clearTimeout(timer);
        void sub.close();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      }, timeoutMs);
      sub.ready.catch((err) => {
        cleanup();
        if (settled) return;
        settled = true;
        reject(err);
      });
    });
  }

  /**
   * Subscribe to a topic pattern and collect messages until `maxMessages` arrive or
   * `timeoutMs` elapses, whichever comes first. Retained messages arrive immediately on
   * subscribe; live messages arrive as published. Always releases its subscription and
   * resolves with whatever was collected (never rejects on timeout).
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
      const sub = this.attachRoute(client, topicPattern, (m) => {
        if (settled) return;
        collected.push(m);
        if (collected.length >= maxMessages) finish();
      });
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void sub.close();
        resolve(collected);
      };
      const timer = setTimeout(finish, timeoutMs);
      sub.ready.catch((err) => {
        void sub.close();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Subscribe to a topic pattern ONCE and resolve with the first message whose payload
   * satisfies `predicate`, or null if the predicate never matches within `timeoutMs` (or
   * `signal` aborts first).
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
    signal?: AbortSignal,
  ): Promise<{ topic: string; payload: string } | null> {
    const client = this.requireClient();
    if (signal?.aborted) return null;
    return new Promise((resolve, reject) => {
      let settled = false;
      const sub = this.attachRoute(client, topicPattern, (m) => {
        if (settled) return;
        if (predicate(m.payload, m.topic)) finish(m);
      });
      const finish = (result: { topic: string; payload: string } | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        void sub.close();
        resolve(result);
      };
      const onAbort = () => finish(null);
      const timer = setTimeout(() => finish(null), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      sub.ready.catch((err) => {
        void sub.close();
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
  }

  /**
   * Subscribe to a topic pattern and invoke `onMessage` for every message,
   * indefinitely. Returns an `unsubscribe` function that detaches the listener,
   * releases the subscription (UNSUBSCRIBE once no other local holder remains), and
   * resolves once both are clean.
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
    const sub = this.attachRoute(client, topicPattern, onMessage);
    try {
      await sub.ready;
    } catch (e) {
      await sub.close();
      throw e;
    }
    return sub.close;
  }
}
