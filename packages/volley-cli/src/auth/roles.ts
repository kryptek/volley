/**
 * Volley's broker roles as Dynamic Security data, shared by `volley auth init` and
 * `volley auth migrate` (and read by volleyd to recognise agent logins).
 *
 * Eight static roles are created once and never edited at runtime: an ACL change on a role
 * disconnects every client holding it. Per-identity scoping uses `%u` (the client's username),
 * which mosquitto substitutes in Dynamic Security ACLs from 2.1 on (version.ts refuses older
 * brokers). An agent's login is one client whose username is its agent id, holding `agent`.
 *
 * The roles carry a `volley-` prefix in the broker: `mosquitto_ctrl dynsec init` creates a role
 * named `admin` that may administer the plugin itself, so a Volley role of that name would hand
 * every admin account control of the broker's logins.
 *
 * mosquitto semantics these definitions rely on (Dynamic Security plugin):
 *   - default access: publishing is denied, receiving is allowed, subscribing is denied. A client
 *     receives only what it may subscribe to, so `subscribePattern` is the read grant.
 *   - a client's roles are checked in order; within a role, ACLs by descending priority. The first
 *     ACL matching the topic decides. So a `deny` needs a higher priority than the role's allows.
 *   - mosquitto's `+` also matches the reserved `_waves`, `_system` and `_meta` levels (the
 *     caveat of examples/mosquitto-auth/README.md carries over unchanged).
 *   - a denied PUBLISH is dropped silently for MQTT 3.1.1 clients (they still get a PUBACK).
 */

export const VOLLEY_ROLES = [
  "volleyd",
  "coordinator",
  "desk",
  "supervisor",
  "admin",
  "token",
  "account",
  "agent",
] as const;
export type VolleyRole = (typeof VOLLEY_ROLES)[number];

/** The role's name in the broker. */
export const roleName = (role: VolleyRole): string => `volley-${role}`;

export type AclType =
  | "publishClientSend"
  | "publishClientReceive"
  | "subscribeLiteral"
  | "subscribePattern"
  | "unsubscribeLiteral"
  | "unsubscribePattern";

export interface RoleAcl {
  acltype: AclType;
  topic: string;
  allow: boolean;
  priority?: number;
}

const send = (topic: string): RoleAcl => ({ acltype: "publishClientSend", topic, allow: true });
const read = (topic: string): RoleAcl => ({ acltype: "subscribePattern", topic, allow: true });
/** A send deny that wins over the same role's allows. */
const refuse = (topic: string): RoleAcl => ({
  acltype: "publishClientSend",
  topic,
  allow: false,
  priority: 10,
});

/** The per-agent channels an identity may publish on (never `mailbox`, never `screen`). */
const OWN_CHANNELS = ["status", "progress", "result", "capability", "control", "_user/#"];

/** Its own channels, its own registry entry and lease requests: what every login may write. */
const ownIdentity: RoleAcl[] = [
  read("volley/#"),
  ...OWN_CHANNELS.map((c) => send(`volley/+/%u/${c}`)),
  send("volley/_system/registry/%u"),
  // Lease requests are the one user-space write under a reserved prefix (SPEC §2.4, §4.6.5).
  send("volley/_system/leases/+/requests"),
];

/** Operator-level writes: steer any agent, write any agent's standard channels and registry. */
const operator: RoleAcl[] = [
  send("volley/+/+/mailbox"),
  ...OWN_CHANNELS.map((c) => send(`volley/+/+/${c}`)),
  send("volley/_system/registry/+"),
];

/** Every role's ACLs. Order is the order the broker gets them; priorities decide evaluation. */
export const ROLE_ACLS: Record<VolleyRole, readonly RoleAcl[]> = {
  // The supervisor daemon: the whole tree, including `_waves/*`, `_waves/_config`, the screen
  // channel it publishes on each agent's behalf, and the one-time token topics under volley-auth/.
  volleyd: [send("volley/#"), read("volley/#"), send("volley-auth/#"), read("volley-auth/#")],
  // A coordinator session runs its own MCP server whose agent id is random-suffixed
  // (`coordinator-ab12`), so `%u` cannot pin it: it is operator-level (README, "Identities").
  coordinator: operator,
  // Browser clients (volley dash, the Desk) and `steer` accounts: steer any agent and send control
  // requests (config_set included) to the daemon's mailbox.
  desk: [send("volley/+/+/mailbox")],
  // Another volleyd: the whole tree except the account-op and answer topics, so it can neither
  // impersonate an admin nor forge volleyd's answers (SPEC §4.6.10).
  supervisor: [
    refuse("volley/_system/auth/ops/#"),
    refuse("volley/_system/auth/replies/#"),
    send("volley/#"),
    read("volley/#"),
  ],
  // An admin account: a coordinator's writes plus account ops on its own ops topic.
  admin: [...operator, send("volley/_system/auth/ops/%u")],
  // A one-time token's login (username = token id): its own redeem topic and its own answer,
  // nothing under volley/ (it may subscribe to nothing else, so it receives nothing else).
  token: [send("volley-auth/redeem/%u"), read("volley-auth/redeem/%u/reply")],
  // Every account: read the tree, its own channels, registry entry and machine record.
  account: [
    ...ownIdentity,
    send("volley/_system/machines/%u"),
    send("volley/_system/machines/%u/#"),
  ],
  // A dispatched agent (username = agent id): read the tree, write its own channels and registry
  // entry, lease requests, and ack the fixed steering identities' mailboxes (SPEC §4.4: an ack goes
  // to the sender's mailbox). Never another agent's mailbox, status or registry entry.
  agent: [...ownIdentity, send("volley/+/volleyd/mailbox"), send("volley/+/desk/mailbox")],
};

/** The fixed identities every deployment has, and the roles each holds. */
export const FIXED_CLIENTS = {
  volleyd: ["volleyd"],
  desk: ["account", "desk"],
  coordinator: ["account", "coordinator"],
} as const satisfies Record<string, readonly VolleyRole[]>;
export type FixedIdentity = keyof typeof FIXED_CLIENTS;
export const FIXED_IDENTITIES = Object.keys(FIXED_CLIENTS) as FixedIdentity[];

/** The roles an account's broker login holds, per account role (`volley auth add --role`). */
export const ACCOUNT_ROLE_MAP = {
  admin: ["account", "admin"],
  steer: ["account", "desk"],
  watch: ["account"],
  supervisor: ["account", "supervisor"],
  peer: ["account"],
} as const satisfies Record<string, readonly VolleyRole[]>;

export const AGENT_ROLES: readonly VolleyRole[] = ["agent"];
export const TOKEN_ROLES: readonly VolleyRole[] = ["token"];

/** The dynsec admin login `volley auth init` creates (`mosquitto_ctrl dynsec init`). */
export const DYNSEC_ADMIN_USER = "dynsec-admin";

/** A token login's username: the token id, 8 hex digits (so `%u` names its topics). */
export const TOKEN_ID_RE = /^[0-9a-f]{8}$/;

/** `[{ rolename }]` for a createClient. */
export const clientRoles = (roles: readonly VolleyRole[]) =>
  roles.map((r) => ({ rolename: roleName(r) }));

/** The Volley role names a client's `roles` (as `getClient` / `listClients` return them) hold. */
export function heldRoles(roles: readonly { rolename: string }[] | undefined): string[] {
  return (roles ?? []).map((r) => r.rolename);
}

/**
 * Whether a client (its role names, as `listAllClients` returns them) is an agent login: it holds
 * `volley-agent` and nothing else. The sweep and
 * `list-agents` only ever touch these; a fixed identity, account, token or the admin never is one.
 */
export function isAgentClient(client: { roles: readonly string[] }): boolean {
  return client.roles.length === 1 && client.roles[0] === roleName("agent");
}
