/**
 * Account roles and their ACL templates (`volley auth add <name> --role <role>`). Each account
 * gets one managed `user <name>` block appended to acl.conf; the shipped acl.conf's `pattern`
 * lines (read `volley/#`, its own `%u` channels and registry entry, lease requests) apply to it
 * as to every authenticated client. Per-agent identities (`add-agent`) keep their own blocks.
 */

/** The roles an account can hold. `agent` identities are minted by `add-agent`, not here. */
export const ROLES = ["admin", "steer", "watch", "supervisor", "peer"] as const;
export type Role = (typeof ROLES)[number];

/** What an account is for; shown in `volley auth list` and the Desk. */
export const KINDS = ["human", "device", "machine", "service"] as const;
export type Kind = (typeof KINDS)[number];

export const DEFAULT_KIND: Record<Role, Kind> = {
  admin: "human",
  steer: "device",
  watch: "device",
  supervisor: "service",
  peer: "machine",
};

/** Roles a one-time sign-in link may grant: never an operator-level one. */
export const SIGNIN_ROLES = ["steer", "watch"] as const satisfies readonly Role[];

/** Where an admin sends account control ops: the broker ACL pins the last level to its username. */
export const authOpsTopic = (user: string) => `volley/_system/auth/ops/${user}`;
/** Where a token login sends its redemption request. */
export const AUTH_REDEEM_TOPIC = "volley/_system/auth/redeem";

/** The `topic` lines each role adds on top of the shared patterns. */
function roleLines(name: string, role: Role): string[] {
  switch (role) {
    // Everything a coordinator can, plus account ops on its own ops topic.
    case "admin":
      return [
        "topic write volley/+/+/mailbox",
        "topic write volley/+/+/status",
        "topic write volley/+/+/progress",
        "topic write volley/+/+/result",
        "topic write volley/+/+/capability",
        "topic write volley/+/+/control",
        "topic write volley/+/+/_user/#",
        "topic write volley/_system/registry/+",
        `topic write ${authOpsTopic(name)}`,
      ];
    // Steer agents (and send control requests to the daemon's mailbox).
    case "steer":
      return ["topic write volley/+/+/mailbox"];
    // Observe only: nothing beyond the shared patterns.
    case "watch":
      return [];
    // A volleyd: like the fixed `volleyd` identity, except for the account-op topics. The
    // daemon takes an op's sender from its ops topic and trusts only `volleyd`'s answers, so a
    // supervisor must write neither (mosquitto applies `deny` before any grant).
    case "supervisor":
      return [
        "topic deny volley/_system/auth/ops/#",
        "topic deny volley/_system/auth/replies/#",
        "topic readwrite volley/#",
      ];
    // A paired machine: its own `%u` channels (patterns) and its machine topic.
    case "peer":
      return [
        `topic write volley/_system/machines/${name}`,
        `topic write volley/_system/machines/${name}/#`,
      ];
  }
}

export const accountBlockStart = (name: string) =>
  `# >>> volley account ${name} (managed by \`volley auth\`; do not edit)`;
export const accountBlockEnd = (name: string) => `# <<< volley account ${name}`;

/** The managed acl.conf block for account `name` with `role` (no surrounding blank lines). */
export function aclBlock(name: string, role: Role): string {
  return [
    accountBlockStart(name),
    `# role: ${role}`,
    `user ${name}`,
    ...roleLines(name, role),
    accountBlockEnd(name),
    "",
  ].join("\n");
}

/** The broker login a one-time token carries: `redeem-<token id>`. */
export const tokenUser = (id: string) => `redeem-${id}`;

export const tokenBlockStart = (id: string) =>
  `# >>> volley token ${id} (managed by \`volley auth\`; removed when redeemed or expired)`;
export const tokenBlockEnd = (id: string) => `# <<< volley token ${id}`;

/** The managed acl.conf block for a one-time token's login: it may only ask to be redeemed. */
export function tokenAclBlock(id: string): string {
  return [
    tokenBlockStart(id),
    `user ${tokenUser(id)}`,
    `topic write ${AUTH_REDEEM_TOPIC}`,
    tokenBlockEnd(id),
    "",
  ].join("\n");
}

/** Remove the block between `start` and `end` lines (and the blank line before it). */
export function withoutBlock(acl: string, start: string, end: string): string {
  const at = acl.indexOf(`\n${start}\n`);
  if (at === -1) return acl;
  const endMarker = `${end}\n`;
  const stop = acl.indexOf(endMarker, at);
  return stop === -1 ? acl : acl.slice(0, at) + acl.slice(stop + endMarker.length);
}

/** Append `block` to the ACL text after a blank line. */
export function withBlock(acl: string, block: string): string {
  const base = acl.endsWith("\n") || acl === "" ? acl : `${acl}\n`;
  return `${base}\n${block}`;
}
