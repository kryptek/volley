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

import { isValidAgentId } from "volley-mcp/topics";

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
// `usage` is the sample the agent's statusLine publishes (SPEC §4.6.12).
const OWN_CHANNELS = ["status", "progress", "result", "capability", "usage", "control", "_user/#"];

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

/**
 * Every role's ACLs. Order is the order the broker gets them; priorities decide evaluation.
 *
 * The needs-you inbox (`volley/_inbox/<id>`, SPEC §4.6.18) needs no rows of its own: every
 * account reads it through `volley/#`, no account or agent grant reaches it (their writes are
 * four levels deep, or under `_system`), and only `volleyd` and `supervisor` write it, through
 * `volley/#`. A Desk login answers on its own account-op topic (`desk` grants it, `%u`), where the
 * broker names the sender; the owner's CLI and coordinator sessions answer on volleyd's mailbox.
 */
export const ROLE_ACLS: Record<VolleyRole, readonly RoleAcl[]> = {
  // The supervisor daemon: the whole tree, including `_waves/*`, `_waves/_config`, the screen
  // channel it publishes on each agent's behalf, and the one-time token topics under volley-auth/.
  volleyd: [send("volley/#"), read("volley/#"), send("volley-auth/#"), read("volley-auth/#")],
  // A coordinator session runs its own MCP server whose agent id is random-suffixed
  // (`coordinator-ab12`), so `%u` cannot pin it: it is operator-level (README, "Identities").
  coordinator: operator,
  // Browser clients (volley dash, the Desk) and `steer` accounts: steer any agent and send control
  // requests (config_set included) to the daemon's mailbox. The Desk's resume probe subscribes to
  // a topic named by its own client id (nothing publishes there), granted here with `%c` so it
  // does not hang on the broad read of the account role. Its own account-op topic carries its
  // Needs-you answers (SPEC §4.6.18): the broker names the sender there, so volleyd can tell a
  // Desk login from an agent claiming to be one.
  desk: [
    send("volley/+/+/mailbox"),
    send("volley/_system/auth/ops/%u"),
    read("volley/_system/desk-probe/%c"),
  ],
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
  // Every account: read the tree, its own channels, registry entry and machine record. The record
  // topic only: never a machine's readiness verdict under it, its own included (SPEC §4.6.15). Not
  // a deny: a supervisor account holds this role first, and its first matching ACL would decide.
  account: [...ownIdentity, send("volley/_system/machines/%u")],
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

/** A one-time token's id: the `<id>` of `vly_<kind>_<id>_<secret>`; null when it is not one. */
export function tokenIdOf(token: string): string | null {
  return /^vly_[a-z]+_([0-9a-f]{8})_/.exec(token)?.[1] ?? null;
}

/**
 * Ids `add-agent` refuses because the role's `volley/+/%u/…` grants would carry them into
 * reserved or foreign topics: with %u=`registry`, `volley/+/%u/status` matches
 * `volley/_system/registry/status`, and an agent named after a channel has a registry entry
 * (`volley/_system/registry/mailbox`) that every steering client's `volley/+/+/mailbox` matches.
 */
export const RESERVED_AGENT_IDS = [
  "registry",
  "leases",
  "health",
  "federation",
  "machines",
  "auth",
  "status",
  "progress",
  "result",
  "capability",
  "control",
  "mailbox",
  "screen",
  "usage",
  // `volley/+/%u/<channel>` would match `volley/_system/claude-accounts/<channel>` (SPEC §4.6.12).
  "claude-accounts",
] as const;

/** Why `id` cannot be an agent login (`add-agent` and `migrate` refuse it), or null. */
export function badAgentId(id: string): string | null {
  if (!isValidAgentId(id)) return `"${id}" does not match [a-z0-9][a-z0-9_-]{0,62}`;
  if ((FIXED_IDENTITIES as readonly string[]).includes(id) || id === DYNSEC_ADMIN_USER) {
    return `"${id}" is a fixed identity`;
  }
  if ((RESERVED_AGENT_IDS as readonly string[]).includes(id)) {
    return `"${id}" is reserved (a reserved topic segment or channel name: ${RESERVED_AGENT_IDS.join(", ")}); prefer the <wave>-<task>-<role>-<attempt> form`;
  }
  if (TOKEN_ID_RE.test(id)) return `"${id}": 8 hex digits are reserved for one-time token logins`;
  return null;
}

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

/**
 * The roles as examples/mosquitto-auth/roles.json documents them (a test keeps the file equal):
 * the broker role names, their ACLs with priorities, and who holds which.
 */
export function rolesDocument(): Record<string, unknown> {
  return {
    $comment:
      "Generated from packages/volley-cli/src/auth/roles.ts (volley auth init creates these roles once). Dynamic Security ACL types; %u is the client's username (mosquitto >= 2.1).",
    roles: VOLLEY_ROLES.map((r) => ({
      rolename: roleName(r),
      acls: ROLE_ACLS[r].map((a) => ({ priority: 0, ...a })),
    })),
    fixed_clients: Object.fromEntries(
      Object.entries(FIXED_CLIENTS).map(([u, rs]) => [u, rs.map((x) => roleName(x))]),
    ),
    account_roles: Object.fromEntries(
      Object.entries(ACCOUNT_ROLE_MAP).map(([u, rs]) => [u, rs.map((x) => roleName(x))]),
    ),
    agent_login: AGENT_ROLES.map(roleName),
    token_login: TOKEN_ROLES.map(roleName),
  };
}
