import { createServer } from "node:net";
import Aedes from "aedes";
import type { RoleAcl } from "../../src/auth/roles";

/**
 * An in-process stand-in for mosquitto 2.1 + the Dynamic Security plugin, on Aedes: logins are
 * the plugin's clients, every PUBLISH and SUBSCRIBE is checked against the client's roles with
 * `%u` / `%c` substituted (the 2.1 semantics), and the admin's control messages on
 * `$CONTROL/dynamic-security/v1` are answered on `.../response` with one `responses` array per
 * message, in order, with the plugin's error strings (the error table bench/dynsec measured):
 *
 *   createRole on an existing role       "Role already exists"
 *   addRoleACL of an existing ACL        "ACL with this topic already exists"
 *   createClient on an existing client   "Client already exists" (the password is NOT changed)
 *   addClientRole of a role it holds     "Internal error"
 *   deleteClient / getClient, unknown    "Client not found"
 *
 * A denied publish is dropped silently, as mosquitto does for MQTT 3.1.1 (the publisher still
 * gets its PUBACK). deleteClient / disableClient close the client's connection without its will;
 * an ACL change on a role disconnects every client holding it (both measured on 2.1.2). The
 * broker's version is the retained `$SYS/broker/version` (null: none retained).
 *
 * Shared by volley-cli's and volleyd's tests (volleyd re-exports it from its test helpers).
 */

export const CONTROL_TOPIC = "$CONTROL/dynamic-security/v1";
export const RESPONSE_TOPIC = `${CONTROL_TOPIC}/response`;

interface FakeClient {
  password: string;
  roles: string[];
  disabled: boolean;
}

export interface FakeCommand {
  command: string;
  correlationData?: string;
  [k: string]: unknown;
}

export interface FakeDynsec {
  url: string;
  port: number;
  admin: { username: string; password: string };
  /** Every control message the admin sent, as its `commands` array. */
  controlMessages: FakeCommand[][];
  /** createRole / addRoleACL / removeRoleACL / deleteRole commands that changed a role. */
  roleEdits: () => number;
  clients: () => Map<string, { password: string; roles: string[] }>;
  roles: () => Map<string, RoleAcl[]>;
  /** Usernames with a live connection right now. */
  connected: () => string[];
  /**
   * Fail the next `command` (optionally only for `username`) with `error`; with `applied`, the
   * command still takes effect and only its answer carries the error.
   */
  failNext: (command: string, error: string, username?: string, applied?: boolean) => void;
  /** Hold every control message (no response) until `release()`; returns release. */
  stall: () => () => void;
  /** Set (or create, holding `roles`) a login directly: what `dynsec init` does offline. */
  setPassword: (username: string, password: string, roles?: string[]) => void;
  /** Close every connection of `username` from the broker side (no will). */
  kick: (username: string) => number;
  /** Retain (or clear, with null) `$SYS/broker/version`. */
  setVersion: (v: string | null) => Promise<void>;
  /** Would `username` be allowed to publish `topic` (the ACL evaluation the broker applies)? */
  canPublish: (username: string, topic: string, clientId?: string) => boolean;
  canSubscribe: (username: string, filter: string, clientId?: string) => boolean;
  close: () => Promise<void>;
}

/** MQTT topic-filter matching; `filter` may hold `+` / `#`, `topic` is taken literally. */
export function topicMatches(filter: string, topic: string): boolean {
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") return true;
    if (i >= t.length) return false;
    if (f[i] !== "+" && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

/** `%u` / `%c` substituted per level (2.1: a level that is exactly `%u` or `%c`). */
function substitute(aclTopic: string, username: string, clientId: string): string | null {
  const levels = aclTopic
    .split("/")
    .map((l) => (l === "%u" ? username : l === "%c" ? clientId : l));
  // A username or client id carrying a wildcard or separator never matches anything.
  if (levels.some((l, i) => l !== aclTopic.split("/")[i] && /[+#/]/.test(l))) return null;
  return levels.join("/");
}

const DEFAULT_ACCESS: Record<string, boolean> = {
  publishClientSend: false,
  subscribe: false,
};

export async function startFakeDynsec(
  opts: { version?: string | null; adminUser?: string; adminPassword?: string } = {},
): Promise<FakeDynsec> {
  const admin = {
    username: opts.adminUser ?? "dynsec-admin",
    password: opts.adminPassword ?? "admin-test-pw",
  };
  const clients = new Map<string, FakeClient>([
    [admin.username, { password: admin.password, roles: ["admin"], disabled: false }],
  ]);
  const roles = new Map<string, RoleAcl[]>([
    [
      "admin",
      [
        { acltype: "publishClientSend", topic: "$CONTROL/dynamic-security/#", allow: true },
        { acltype: "subscribePattern", topic: "$CONTROL/dynamic-security/#", allow: true },
        { acltype: "subscribePattern", topic: "$SYS/#", allow: true },
        { acltype: "subscribePattern", topic: "#", allow: true },
      ],
    ],
  ]);
  const controlMessages: FakeCommand[][] = [];
  const failures: { command: string; error: string; username?: string; applied?: boolean }[] = [];
  let edits = 0;
  let stalled: (() => void)[] | null = null;
  /** Aedes client id → username, for connected clients. */
  const usernames = new Map<string, string>();

  const aedes = new Aedes({
    authenticate: (client, username, password, done) => {
      const c = username !== undefined ? clients.get(username) : undefined;
      if (c !== undefined && !c.disabled && password?.toString() === c.password) {
        usernames.set(client.id, username as string);
        return done(null, true);
      }
      done(Object.assign(new Error("not authorised"), { returnCode: 5 as const }), null);
    },
    authorizePublish: (client, packet, done) => {
      const user = client !== null ? usernames.get(client.id) : undefined;
      if (client === null) return done(null);
      if (packet.topic === CONTROL_TOPIC && user === admin.username) {
        const body = JSON.parse(packet.payload.toString()) as { commands?: FakeCommand[] };
        const commands = body.commands ?? [];
        controlMessages.push(commands);
        const answer = () => {
          const responses = commands.map((c) => run(c));
          aedes.publish(
            {
              cmd: "publish",
              topic: RESPONSE_TOPIC,
              payload: Buffer.from(JSON.stringify({ responses })),
              qos: 0,
              retain: false,
              dup: false,
            },
            () => {},
          );
        };
        if (stalled !== null) stalled.push(answer);
        else setImmediate(answer);
        return done(null);
      }
      if (user === undefined || !allowed(user, client.id, "publishClientSend", packet.topic)) {
        // Dropped silently, like mosquitto for an MQTT 3.1.1 publisher: steer it off every filter.
        packet.topic = `$denied/${packet.topic}`;
        packet.retain = false;
      }
      done(null);
    },
    authorizeSubscribe: (client, sub, done) => {
      const user = client !== null ? usernames.get(client.id) : undefined;
      if (client === null || (user !== undefined && allowedSubscribe(user, client.id, sub.topic))) {
        return done(null, sub);
      }
      done(null, null);
    },
  });
  aedes.on("clientDisconnect", (client) => usernames.delete(client.id));

  const liveClients = () =>
    (aedes as unknown as { clients: Record<string, { id: string; will: unknown; close(): void }> })
      .clients;

  /** Close `username`'s connections without their wills (an administrative disconnect). */
  function kick(username: string): number {
    let n = 0;
    for (const c of Object.values(liveClients())) {
      if (usernames.get(c.id) !== username) continue;
      c.will = null;
      c.close();
      n++;
    }
    return n;
  }

  function aclsFor(user: string): RoleAcl[][] {
    return (clients.get(user)?.roles ?? []).map((r) =>
      [...(roles.get(r) ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    );
  }

  function allowed(user: string, clientId: string, type: string, topic: string): boolean {
    for (const acls of aclsFor(user)) {
      for (const acl of acls) {
        if (acl.acltype !== type) continue;
        const t = substitute(acl.topic, user, clientId);
        if (t !== null && topicMatches(t, topic)) return acl.allow;
      }
    }
    return DEFAULT_ACCESS[type] ?? false;
  }

  function allowedSubscribe(user: string, clientId: string, filter: string): boolean {
    for (const acls of aclsFor(user)) {
      for (const acl of acls) {
        if (acl.acltype === "subscribeLiteral" && acl.topic === filter) return acl.allow;
        if (acl.acltype !== "subscribePattern") continue;
        const t = substitute(acl.topic, user, clientId);
        if (t !== null && topicMatches(t, filter)) return acl.allow;
      }
    }
    return DEFAULT_ACCESS.subscribe as boolean;
  }

  function holders(rolename: string): string[] {
    return [...clients].filter(([, c]) => c.roles.includes(rolename)).map(([u]) => u);
  }

  function run(c: FakeCommand): Record<string, unknown> {
    const base = {
      command: c.command,
      ...(c.correlationData !== undefined ? { correlationData: c.correlationData } : {}),
    };
    const err = (error: string) => ({ ...base, error });
    const fi = failures.findIndex(
      (f) => f.command === c.command && (f.username === undefined || f.username === c.username),
    );
    if (fi !== -1) {
      const f = failures.splice(fi, 1)[0] as { error: string; applied?: boolean };
      if (f.applied === true) apply(c);
      return err(f.error);
    }
    return apply(c);
  }

  function apply(c: FakeCommand): Record<string, unknown> {
    const base = {
      command: c.command,
      ...(c.correlationData !== undefined ? { correlationData: c.correlationData } : {}),
    };
    const err = (error: string) => ({ ...base, error });
    const username = c.username as string;
    const rolename = c.rolename as string;
    switch (c.command) {
      case "createRole": {
        if (roles.has(rolename)) return err("Role already exists");
        roles.set(
          rolename,
          ((c.acls as RoleAcl[] | undefined) ?? []).map((a) => ({ ...a })),
        );
        edits++;
        return base;
      }
      case "getRole": {
        const acls = roles.get(rolename);
        if (acls === undefined) return err("Role not found");
        return {
          ...base,
          data: { role: { rolename, acls: acls.map((a) => ({ priority: 0, ...a })) } },
        };
      }
      case "deleteRole": {
        if (!roles.delete(rolename)) return err("Role not found");
        for (const cl of clients.values()) cl.roles = cl.roles.filter((r) => r !== rolename);
        edits++;
        return base;
      }
      case "addRoleACL": {
        const acls = roles.get(rolename);
        if (acls === undefined) return err("Role not found");
        if (acls.some((a) => a.acltype === c.acltype && a.topic === c.topic)) {
          return err("ACL with this topic already exists");
        }
        acls.push({
          acltype: c.acltype as RoleAcl["acltype"],
          topic: c.topic as string,
          allow: c.allow as boolean,
          ...(c.priority !== undefined ? { priority: c.priority as number } : {}),
        });
        edits++;
        for (const u of holders(rolename)) kick(u);
        return base;
      }
      case "removeRoleACL": {
        const acls = roles.get(rolename);
        if (acls === undefined) return err("Role not found");
        const i = acls.findIndex((a) => a.acltype === c.acltype && a.topic === c.topic);
        if (i === -1) return err("ACL not found");
        acls.splice(i, 1);
        edits++;
        for (const u of holders(rolename)) kick(u);
        return base;
      }
      case "createClient": {
        if (clients.has(username)) return err("Client already exists");
        const rs = ((c.roles as { rolename: string }[] | undefined) ?? []).map((r) => r.rolename);
        if (rs.some((r) => !roles.has(r))) return err("Role not found");
        clients.set(username, { password: c.password as string, roles: rs, disabled: false });
        return base;
      }
      case "deleteClient": {
        if (!clients.delete(username)) return err("Client not found");
        kick(username);
        return base;
      }
      case "getClient": {
        const cl = clients.get(username);
        if (cl === undefined) return err("Client not found");
        return {
          ...base,
          data: {
            client: {
              username,
              roles: cl.roles.map((r) => ({ rolename: r })),
              groups: [],
              ...(cl.disabled ? { disabled: true } : {}),
            },
          },
        };
      }
      case "listClients": {
        const all = [...clients.keys()].sort();
        const offset = (c.offset as number | undefined) ?? 0;
        const count = (c.count as number | undefined) ?? -1;
        const page = count < 0 ? all.slice(offset) : all.slice(offset, offset + count);
        return {
          ...base,
          data: {
            totalCount: all.length,
            clients:
              c.verbose === true
                ? page.map((u) => ({
                    username: u,
                    roles: (clients.get(u) as FakeClient).roles.map((r) => ({ rolename: r })),
                    groups: [],
                  }))
                : page,
          },
        };
      }
      case "addClientRole": {
        const cl = clients.get(username);
        if (cl === undefined) return err("Client not found");
        if (!roles.has(rolename)) return err("Role not found");
        if (cl.roles.includes(rolename)) return err("Internal error");
        cl.roles.push(rolename);
        kick(username);
        return base;
      }
      case "setClientPassword": {
        const cl = clients.get(username);
        if (cl === undefined) return err("Client not found");
        cl.password = c.password as string;
        kick(username);
        return base;
      }
      case "disableClient": {
        const cl = clients.get(username);
        if (cl === undefined) return err("Client not found");
        cl.disabled = true;
        kick(username);
        return base;
      }
      case "enableClient": {
        const cl = clients.get(username);
        if (cl === undefined) return err("Client not found");
        cl.disabled = false;
        return base;
      }
      default:
        return err("Unknown command");
    }
  }

  const server = createServer(aedes.handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const port = address.port;

  const setVersion = (v: string | null) =>
    new Promise<void>((resolve) =>
      aedes.publish(
        {
          cmd: "publish",
          topic: "$SYS/broker/version",
          payload: Buffer.from(v ?? ""),
          qos: 0,
          retain: true,
          dup: false,
        },
        () => resolve(),
      ),
    );
  const version = opts.version === undefined ? "mosquitto version 2.1.2" : opts.version;
  if (version !== null) await setVersion(version);

  return {
    url: `mqtt://127.0.0.1:${port}`,
    port,
    admin,
    controlMessages,
    roleEdits: () => edits,
    clients: () =>
      new Map([...clients].map(([u, c]) => [u, { password: c.password, roles: [...c.roles] }])),
    roles: () => new Map([...roles].map(([r, a]) => [r, a.map((x) => ({ ...x }))])),
    connected: () => [...new Set(usernames.values())].sort(),
    failNext: (command, error, username, applied) =>
      failures.push({
        command,
        error,
        ...(username !== undefined ? { username } : {}),
        ...(applied === true ? { applied } : {}),
      }),
    stall: () => {
      stalled = [];
      return () => {
        const held = stalled ?? [];
        stalled = null;
        for (const a of held) a();
      };
    },
    kick,
    setPassword: (username, password, rs) => {
      const c = clients.get(username);
      if (c !== undefined) c.password = password;
      else clients.set(username, { password, roles: rs ?? [], disabled: false });
    },
    setVersion,
    canPublish: (u, t, cid = `cid-${u}`) => allowed(u, cid, "publishClientSend", t),
    canSubscribe: (u, f, cid = `cid-${u}`) => allowedSubscribe(u, cid, f),
    close: () =>
      new Promise<void>((resolve, reject) => {
        aedes.close(() => server.close((e) => (e ? reject(e) : resolve())));
      }),
  };
}
