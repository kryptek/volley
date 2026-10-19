import { randomBytes } from "node:crypto";
import type { VolleyBroker } from "volley-mcp/broker";
import {
  ROLE_ACLS,
  type RoleAcl,
  VOLLEY_ROLES,
  type VolleyRole,
  clientRoles,
  heldRoles,
  roleName,
} from "./roles";

/**
 * The mosquitto Dynamic Security control API (`$CONTROL/dynamic-security/v1`), shared by
 * `volley auth` and volleyd. One admin connection sends control messages, each a `commands`
 * array; the plugin answers each message with one `responses` array on `.../response`, and every
 * subscribed admin connection gets every answer, so responses are matched by `correlationData`.
 * mosquitto 2.1 rewrites its state file once per control MESSAGE, which is why callers batch.
 */

export const CONTROL_TOPIC = "$CONTROL/dynamic-security/v1";
export const RESPONSE_TOPIC = `${CONTROL_TOPIC}/response`;

export interface DynsecCommand {
  command: string;
  correlationData?: string;
  [k: string]: unknown;
}

export interface DynsecResponse {
  command: string;
  error?: string;
  data?: Record<string, unknown>;
  correlationData?: string;
}

/** What a session needs from an MQTT connection logged in as the dynsec admin. */
export interface ControlTransport {
  publish: (topic: string, payload: string) => Promise<void>;
  subscribe: (
    filter: string,
    onMessage: (topic: string, payload: string) => void,
  ) => Promise<() => Promise<void>>;
}

/** A ControlTransport over a connected VolleyBroker (QoS 1, never retained). */
export function brokerTransport(b: VolleyBroker): ControlTransport {
  return {
    publish: (topic, payload) => b.publish(topic, payload, { qos: 1, retain: false }),
    subscribe: (filter, onMessage) =>
      b.subscribeStream(filter, (m) => onMessage(m.topic, m.payload)),
  };
}

/** The broker's retained `$SYS/broker/version` (null when none arrives in `timeoutMs`). */
export async function sysVersion(b: VolleyBroker, timeoutMs = 1_000): Promise<string | null> {
  const v = await b.queryRetained("$SYS/broker/version", timeoutMs);
  return v === null || v === "" ? null : v;
}

export class DynsecError extends Error {
  constructor(
    message: string,
    /** The connection went away before the answer: the command may or may not have applied. */
    readonly connectionLost = false,
  ) {
    super(message);
    this.name = "DynsecError";
  }
}

/** Control messages over one admin connection, matched to their answers by correlationData. */
export class DynsecSession {
  private readonly pending = new Map<
    string,
    { resolve: (r: DynsecResponse) => void; reject: (e: Error) => void }
  >();
  private seq = 0;
  private readonly prefix = randomBytes(4).toString("hex");
  private unsubscribe: (() => Promise<void>) | null = null;
  /** Control messages sent on this session (tests and the batching assertions read it). */
  messagesSent = 0;

  private constructor(
    private readonly transport: ControlTransport,
    private readonly timeoutMs: number,
  ) {}

  static async open(transport: ControlTransport, timeoutMs = 10_000): Promise<DynsecSession> {
    const s = new DynsecSession(transport, timeoutMs);
    s.unsubscribe = await transport.subscribe(RESPONSE_TOPIC, (_t, payload) => s.onAnswer(payload));
    return s;
  }

  private onAnswer(payload: string): void {
    let body: { responses?: DynsecResponse[] };
    try {
      body = JSON.parse(payload) as { responses?: DynsecResponse[] };
    } catch {
      return;
    }
    for (const r of body.responses ?? []) {
      const id = r.correlationData;
      const p = id !== undefined ? this.pending.get(id) : undefined;
      if (id === undefined || p === undefined) continue; // another admin connection's answer
      this.pending.delete(id);
      p.resolve(r);
    }
  }

  /** Send `commands` as ONE control message; their answers, in order. */
  async run(commands: readonly DynsecCommand[]): Promise<DynsecResponse[]> {
    if (commands.length === 0) return [];
    const tagged = commands.map((c) => ({ ...c, correlationData: `${this.prefix}-${++this.seq}` }));
    const waits = tagged.map(
      (c) =>
        new Promise<DynsecResponse>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(c.correlationData);
            reject(new DynsecError(`no answer to ${c.command} within ${this.timeoutMs} ms`, true));
          }, this.timeoutMs);
          this.pending.set(c.correlationData, {
            resolve: (r) => {
              clearTimeout(timer);
              resolve(r);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
        }),
    );
    for (const w of waits) w.catch(() => {});
    try {
      await this.transport.publish(CONTROL_TOPIC, JSON.stringify({ commands: tagged }));
    } catch (e) {
      this.failAll(`control message not sent: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.messagesSent++;
    const settled = await Promise.allSettled(waits);
    const failed = settled.find((s) => s.status === "rejected");
    if (failed !== undefined) throw (failed as PromiseRejectedResult).reason;
    return settled.map((s) => (s as PromiseFulfilledResult<DynsecResponse>).value);
  }

  /** Reject every command still waiting (the connection dropped): they may or may not apply. */
  failAll(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      this.pending.delete(id);
      p.reject(new DynsecError(reason, true));
    }
  }

  async close(): Promise<void> {
    this.failAll("control session closed");
    await this.unsubscribe?.().catch(() => {});
    this.unsubscribe = null;
  }
}

/**
 * Commands collected for `windowMs` and sent as ONE control message: a wave's simultaneous mints
 * (or deletes) then cost one state-file rewrite instead of one each. Each caller gets its own
 * command's answer; a failed element fails only its caller. When the message cannot be sent or
 * answered (the connection dropped), every command in it rejects with a DynsecError.
 */
export class DynsecBatcher {
  private queue: {
    command: DynsecCommand;
    resolve: (r: DynsecResponse) => void;
    reject: (e: unknown) => void;
  }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly session: () => Promise<DynsecSession>,
    private readonly windowMs: () => number,
  ) {}

  /** Queue `command` for the next control message; resolves with its answer. */
  send(command: DynsecCommand): Promise<DynsecResponse> {
    return new Promise((resolve, reject) => {
      this.queue.push({ command, resolve, reject });
      if (this.timer === null) {
        this.timer = setTimeout(() => void this.flush(), Math.max(0, this.windowMs()));
      }
    });
  }

  /** Send everything queued now. */
  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;
    try {
      const s = await this.session();
      const answers = await s.run(batch.map((b) => b.command));
      batch.forEach((b, i) => b.resolve(answers[i] as DynsecResponse));
    } catch (e) {
      for (const b of batch) b.reject(e);
    }
  }
}

// --- the error table ----------------------------------------------------------------------------

/**
 * How a command's answer reads, with the plugin's rerun errors (bench/dynsec, row i):
 *   - `exists`: createRole / createClient / addRoleACL on something already there (unchanged).
 *   - `confirm`: addClientRole answers `Internal error` when the client already holds the role;
 *     never trust the text: check with getClient.
 *   - `missing`: deleteClient / getClient / getRole of something that is not there.
 */
export type Outcome = "ok" | "exists" | "confirm" | "missing" | "failed";

export function classify(r: DynsecResponse): Outcome {
  if (r.error === undefined) return "ok";
  const e = r.error;
  if (r.command === "createRole" && e === "Role already exists") return "exists";
  if (r.command === "createClient" && e === "Client already exists") return "exists";
  if (r.command === "addRoleACL" && e === "ACL with this topic already exists") return "exists";
  if (r.command === "addClientRole") return "confirm";
  if (e === "Client not found" || e === "Role not found") return "missing";
  return "failed";
}

// --- commands -----------------------------------------------------------------------------------

export const cmd = {
  createRole: (role: VolleyRole): DynsecCommand => ({
    command: "createRole",
    rolename: roleName(role),
    textname: `Volley ${role}`,
    acls: ROLE_ACLS[role].map((a) => ({ priority: 0, ...a })),
  }),
  getRole: (rolename: string): DynsecCommand => ({ command: "getRole", rolename }),
  addRoleACL: (rolename: string, acl: RoleAcl): DynsecCommand => ({
    command: "addRoleACL",
    rolename,
    priority: 0,
    ...acl,
  }),
  removeRoleACL: (rolename: string, acl: RoleAcl): DynsecCommand => ({
    command: "removeRoleACL",
    rolename,
    acltype: acl.acltype,
    topic: acl.topic,
  }),
  createClient: (
    username: string,
    password: string,
    roles: readonly VolleyRole[],
    textname?: string,
  ): DynsecCommand => ({
    command: "createClient",
    username,
    password,
    roles: clientRoles(roles),
    ...(textname !== undefined ? { textname } : {}),
  }),
  deleteClient: (username: string): DynsecCommand => ({ command: "deleteClient", username }),
  getClient: (username: string): DynsecCommand => ({ command: "getClient", username }),
  setClientPassword: (username: string, password: string): DynsecCommand => ({
    command: "setClientPassword",
    username,
    password,
  }),
  addClientRole: (username: string, role: VolleyRole): DynsecCommand => ({
    command: "addClientRole",
    username,
    rolename: roleName(role),
  }),
  listClients: (offset: number, count: number): DynsecCommand => ({
    command: "listClients",
    verbose: true,
    offset,
    count,
  }),
};

export interface ClientInfo {
  username: string;
  roles: string[];
}

/** The client a getClient answer describes, or null. */
export function clientOf(r: DynsecResponse): ClientInfo | null {
  const c = (r.data?.client ?? null) as {
    username?: unknown;
    roles?: { rolename: string }[];
  } | null;
  if (c === null || typeof c.username !== "string") return null;
  return { username: c.username, roles: heldRoles(c.roles) };
}

const fail = (r: DynsecResponse, what: string) =>
  new DynsecError(`${what}: ${r.command} failed: ${r.error ?? "unknown error"}`);

// --- operations ---------------------------------------------------------------------------------

/** An ACL as getRole reports it, reduced to what decides access. */
const aclKey = (a: RoleAcl) => `${a.acltype} ${a.topic} ${a.allow} ${a.priority ?? 0}`;

export interface RoleDrift {
  role: VolleyRole;
  missing: RoleAcl[];
  extra: RoleAcl[];
}

export interface EnsureRolesResult {
  created: VolleyRole[];
  existing: VolleyRole[];
  /** Existing roles whose ACLs differ from this Volley's: change them with `migrate --roles`. */
  drifted: RoleDrift[];
}

/**
 * Create the shared roles that do not exist yet, with their ACLs inline: one control message,
 * one state-file rewrite. An existing role is never edited here (that disconnects every client
 * holding it): its ACLs are only compared, and a difference is reported as drift.
 */
export async function ensureRoles(
  s: DynsecSession,
  roles: readonly VolleyRole[] = VOLLEY_ROLES,
): Promise<EnsureRolesResult> {
  const answers = await s.run(roles.map((r) => cmd.createRole(r)));
  const created: VolleyRole[] = [];
  const existing: VolleyRole[] = [];
  answers.forEach((r, i) => {
    const role = roles[i] as VolleyRole;
    const o = classify(r);
    if (o === "ok") created.push(role);
    else if (o === "exists") existing.push(role);
    else throw fail(r, `role ${roleName(role)}`);
  });
  return { created, existing, drifted: await roleDrift(s, existing) };
}

/** How each role's ACLs in the broker differ from this Volley's definitions. */
export async function roleDrift(
  s: DynsecSession,
  roles: readonly VolleyRole[],
): Promise<RoleDrift[]> {
  const answers = await s.run(roles.map((r) => cmd.getRole(roleName(r))));
  const drift: RoleDrift[] = [];
  answers.forEach((r, i) => {
    const role = roles[i] as VolleyRole;
    if (classify(r) !== "ok") throw fail(r, `role ${roleName(role)}`);
    const actual = ((r.data?.role as { acls?: RoleAcl[] } | undefined)?.acls ?? []).map((a) => ({
      acltype: a.acltype,
      topic: a.topic,
      allow: a.allow,
      priority: a.priority ?? 0,
    }));
    const want = ROLE_ACLS[role].map((a) => ({ ...a, priority: a.priority ?? 0 }));
    const have = new Set(actual.map(aclKey));
    const wanted = new Set(want.map(aclKey));
    const missing = want.filter((a) => !have.has(aclKey(a)));
    const extra = actual.filter((a) => !wanted.has(aclKey(a)));
    if (missing.length > 0 || extra.length > 0) drift.push({ role, missing, extra });
  });
  return drift;
}

/** Bring drifted roles to this Volley's ACLs. Disconnects every client holding each role. */
export async function applyRoleDrift(s: DynsecSession, drift: readonly RoleDrift[]): Promise<void> {
  const commands = drift.flatMap((d) => [
    ...d.extra.map((a) => cmd.removeRoleACL(roleName(d.role), a)),
    ...d.missing.map((a) => cmd.addRoleACL(roleName(d.role), a)),
  ]);
  for (const r of await s.run(commands)) {
    const o = classify(r);
    if (o !== "ok" && o !== "exists") throw fail(r, "role update");
  }
}

export type EnsureClient = "created" | "existing";

/**
 * Create a client holding `roles`, idempotently: an existing client keeps its password (never
 * rotated here: that disconnects it). Its roles are confirmed with getClient, and a missing one is
 * added (addClientRole's `Internal error` on a held role is confirmed the same way).
 */
export async function ensureClients(
  s: DynsecSession,
  wanted: readonly { username: string; password: string; roles: readonly VolleyRole[] }[],
): Promise<EnsureClient[]> {
  const answers = await s.run(wanted.map((w) => cmd.createClient(w.username, w.password, w.roles)));
  const out: EnsureClient[] = [];
  const recheck: number[] = [];
  answers.forEach((r, i) => {
    const o = classify(r);
    if (o === "ok") out[i] = "created";
    else if (o === "exists") {
      out[i] = "existing";
      recheck.push(i);
    } else throw fail(r, `client ${wanted[i]?.username}`);
  });
  if (recheck.length === 0) return out;
  const infos = await s.run(
    recheck.map((i) => cmd.getClient((wanted[i] as { username: string }).username)),
  );
  const adds: { username: string; role: VolleyRole }[] = [];
  infos.forEach((r, k) => {
    const w = wanted[recheck[k] as number] as { username: string; roles: readonly VolleyRole[] };
    const info = clientOf(r);
    if (info === null) throw fail(r, `client ${w.username}`);
    for (const role of w.roles) {
      if (!info.roles.includes(roleName(role))) adds.push({ username: w.username, role });
    }
  });
  if (adds.length > 0) {
    const added = await s.run(adds.map((a) => cmd.addClientRole(a.username, a.role)));
    const confirm = adds.filter((_a, k) => classify(added[k] as DynsecResponse) !== "ok");
    if (confirm.length > 0) {
      const again = await s.run(
        confirm.map((a) => cmd.getClient((a as { username: string }).username)),
      );
      again.forEach((r, k) => {
        const a = confirm[k] as { username: string; role: VolleyRole };
        if (!clientOf(r)?.roles.includes(roleName(a.role))) {
          throw new DynsecError(`client ${a.username}: could not add role ${roleName(a.role)}`);
        }
      });
    }
  }
  return out;
}

/** Every client with its roles, paged (`listClients` stays cheap at any size, bench row d). */
export async function listAllClients(s: DynsecSession, pageSize = 100): Promise<ClientInfo[]> {
  const all: ClientInfo[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const [r] = await s.run([cmd.listClients(offset, pageSize)]);
    if (r === undefined || classify(r) !== "ok")
      throw fail(r ?? { command: "listClients" }, "listClients");
    const page = (r.data?.clients ?? []) as { username: string; roles?: { rolename: string }[] }[];
    for (const c of page) all.push({ username: c.username, roles: heldRoles(c.roles) });
    const total = typeof r.data?.totalCount === "number" ? r.data.totalCount : all.length;
    if (page.length < pageSize || all.length >= total) return all;
  }
}

/** Delete clients in one message; `missing` ones count as deleted (a retry is safe). */
export async function deleteClients(s: DynsecSession, usernames: readonly string[]): Promise<void> {
  const answers = await s.run(usernames.map((u) => cmd.deleteClient(u)));
  answers.forEach((r, i) => {
    const o = classify(r);
    if (o !== "ok" && o !== "missing") throw fail(r, `client ${usernames[i]}`);
  });
}
