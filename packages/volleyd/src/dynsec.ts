import { randomBytes } from "node:crypto";
import {
  DynsecBatcher,
  DynsecError,
  DynsecSession,
  brokerTransport,
  classify,
  clientOf,
  cmd,
  inspectRoles,
  listAllClients,
  sysVersion,
} from "volley-cli/auth/dynsec";
import { isAgentClient } from "volley-cli/auth/roles";
import { requireBrokerVersion } from "volley-cli/auth/version";
import { VolleyBroker } from "volley-mcp/broker";
import type { BrokerAuth } from "volley-mcp/config";
import type { Clock, TimerHandle } from "./clock";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { BrokerCredentials, CredentialStore } from "./identity";

/**
 * volleyd's agent logins on mosquitto's Dynamic Security plugin: ONE long-lived admin control
 * connection (opened lazily, version-checked on every open, reconnected with backoff after a
 * drop), over which a wave's simultaneous mints and retires are batched into one control
 * message each (`dynsec_batch_ms`), so mosquitto 2.1 rewrites its state file once per batch.
 * Mint is one `createClient` (username = agent id, role volley-agent inline); retire and the
 * sweep are `deleteClient`. Shared roles are never edited here.
 */

/** One admin connection: what DynsecControl needs from it. */
export interface ControlLink {
  session: DynsecSession;
  sysVersion: () => Promise<string | null>;
  connected: () => boolean;
  /** Milliseconds since the broker last sent anything on it (a PINGRESP at least each keepalive). */
  idleMs?: () => number;
  /** Close it as dead (a broker that stopped answering without closing the socket). */
  kill?: (why: string) => void;
  close: () => Promise<void>;
}

/** No packet from the broker for this long: the link is dead even if its socket looks open. */
const STALE_MS = DAEMON_DEFAULTS.broker_keepalive_s * 1000 * DAEMON_DEFAULTS.broker_stale_factor;

/** Log in to `url` as the dynsec admin (TCP_NODELAY is the broker's `set_tcp_nodelay`). */
export function brokerControl(url: string, admin: BrokerAuth): () => Promise<ControlLink> {
  return async () => {
    const b = new VolleyBroker();
    await b.connect({
      url,
      agentId: `volleyd-dynsec-${randomBytes(3).toString("hex")}`,
      ...admin,
      keepaliveSeconds: DAEMON_DEFAULTS.broker_keepalive_s,
      connectTimeoutMs: DAEMON_DEFAULTS.dynsec_timeout_ms,
    });
    const session = await DynsecSession.open(brokerTransport(b), DAEMON_DEFAULTS.dynsec_timeout_ms);
    return {
      session,
      sysVersion: () => sysVersion(b, DAEMON_DEFAULTS.probe_ms),
      connected: () => b.connected,
      idleMs: () => b.inboundIdleMs(),
      kill: (why) => b.kill(why),
      close: async () => {
        await session.close();
        await b.disconnect().catch(() => {});
      },
    };
  };
}

export interface DynsecControlOptions {
  connect: () => Promise<ControlLink>;
  /** The batch window, read per batch (the `dynsec_batch_ms` tunable, hot-applied). */
  batchMs: () => number;
  /** `mosquitto -h` through the fenced exec: the version when the broker retains none. */
  binaryVersion?: () => Promise<string | null>;
  log?: (line: string) => void;
  /** The daemon's clock: the reconnect backoff and the drop watchdog run on it. */
  clock: Clock;
}

export class DynsecControl {
  private link: ControlLink | null = null;
  private opening: Promise<ControlLink> | null = null;
  private failures = 0;
  private retryAt = 0;
  private watchdog: TimerHandle | null = null;
  private closed = false;
  readonly batcher: DynsecBatcher;
  /** Control connections opened so far (one, unless the broker dropped it). */
  opened = 0;
  /** The broker's version, once a connection checked it. */
  version: string | null = null;

  constructor(private readonly o: DynsecControlOptions) {
    this.batcher = new DynsecBatcher(() => this.session(), o.batchMs, o.clock);
  }

  private now(): number {
    return this.o.clock.now();
  }

  /**
   * Connect and check the version (BrokerVersionError for a broker older than 2.1, which the
   * daemon refuses at start). A failed attempt backs the next one off.
   */
  async open(): Promise<ControlLink> {
    if (this.link?.connected()) return this.link;
    if (this.opening !== null) return this.opening;
    this.opening = (async () => {
      const link = await this.o.connect();
      try {
        this.version = await requireBrokerVersion({
          sys: link.sysVersion,
          ...(this.o.binaryVersion !== undefined ? { binary: this.o.binaryVersion } : {}),
        });
      } catch (e) {
        await link.close().catch(() => {});
        throw e;
      }
      this.opened++;
      this.failures = 0;
      this.link = link;
      this.watchdog ??= this.o.clock.setInterval(() => this.check(), DAEMON_DEFAULTS.watchdog_ms);
      return link;
    })();
    try {
      return await this.opening;
    } catch (e) {
      this.failures++;
      const backoff = Math.min(
        DAEMON_DEFAULTS.dynsec_reconnect_max_ms,
        DAEMON_DEFAULTS.dynsec_reconnect_base_ms * 2 ** (this.failures - 1),
      );
      this.retryAt = this.now() + backoff;
      throw e;
    } finally {
      this.opening = null;
    }
  }

  /**
   * A dropped connection fails what was in flight on it, once; the next use reconnects. A silent
   * one (no packet for `STALE_MS`) is closed first, so it is dropped the same way.
   */
  private check(): void {
    const link = this.link;
    if (link === null) return;
    const idle = link.idleMs?.() ?? 0;
    if (link.connected() && idle > STALE_MS) {
      this.o.log?.(`dynsec: control connection silent for ${Math.round(idle / 1000)}s; closing it`);
      link.kill?.(`no packet from the broker for ${Math.round(idle / 1000)}s`);
    }
    if (link.connected()) return;
    this.link = null;
    link.session.failAll("the broker dropped volleyd's control connection");
    void link.close().catch(() => {});
    this.o.log?.("dynsec: control connection lost; reconnecting on next use");
  }

  private async session(): Promise<DynsecSession> {
    if (this.closed) throw new DynsecError("the control connection is closed", true);
    this.check();
    if (this.link !== null) return this.link.session;
    if (this.now() < this.retryAt) {
      throw new DynsecError("the broker's control connection is down; retrying shortly", true);
    }
    return (await this.open()).session;
  }

  /** One command through the batching queue. */
  send(command: Parameters<DynsecBatcher["send"]>[0]) {
    return this.batcher.send(command);
  }

  /**
   * Why the broker's shared agent role differs from this Volley's (missing, or its ACLs
   * drifted), or null when it matches. Read-only: roles are never edited here.
   */
  async agentRoleDrift(): Promise<string | null> {
    const { missing, drifted } = await inspectRoles(await this.session(), ["agent"]);
    if (missing.length > 0) return "it does not exist";
    const d = drifted[0];
    if (d === undefined) return null;
    return `${d.missing.length} ACL(s) missing, ${d.extra.length} extra`;
  }

  /** Every client with its roles (paged listClients, each page its own message). */
  async clients() {
    return listAllClients(await this.session());
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.watchdog !== null) this.o.clock.clearInterval(this.watchdog);
    await this.batcher.flush();
    await this.link?.close().catch(() => {});
    this.link = null;
  }
}

/** Agent logins on a DynsecControl. */
export class DynsecCredentials implements CredentialStore {
  /** When each login this daemon minted was created (the sweep spares young ones). */
  readonly mintedAt = new Map<string, number>();

  constructor(
    private readonly control: DynsecControl,
    private readonly clock: Clock,
    private readonly password: () => string = () => randomBytes(24).toString("base64url"),
  ) {}

  /**
   * One createClient, batched with the wave's other mints. A login that already exists (a retry
   * after a dropped answer) is reused only if it is an agent login: it gets a new password.
   * Anything else (a fixed identity, an account) is never taken over.
   */
  async mint(agentId: string): Promise<BrokerCredentials> {
    const password = this.password();
    const r = await this.control.send(cmd.createClient(agentId, password, ["agent"]));
    const o = classify(r);
    if (o === "exists") {
      const info = clientOf(await this.control.send(cmd.getClient(agentId)));
      if (info === null || !isAgentClient(info)) {
        throw new Error(`${agentId} already has a broker login that is not an agent login`);
      }
      const set = await this.control.send(cmd.setClientPassword(agentId, password));
      if (classify(set) !== "ok") throw new Error(`setClientPassword: ${set.error}`);
    } else if (o !== "ok") {
      throw new Error(`createClient: ${r.error ?? "failed"}`);
    }
    this.mintedAt.set(agentId, this.clock.now());
    return { username: agentId, password };
  }

  /** deleteClient, batched; a login that is already gone counts. Never throws. */
  async revoke(agentId: string): Promise<boolean> {
    try {
      const o = classify(await this.control.send(cmd.deleteClient(agentId)));
      if (o === "ok" || o === "missing") {
        this.mintedAt.delete(agentId);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Every agent login on the broker (paged listClients). */
  async agentLogins(): Promise<string[]> {
    return (await this.control.clients()).filter(isAgentClient).map((c) => c.username);
  }
}
