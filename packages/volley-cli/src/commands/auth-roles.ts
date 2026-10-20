/**
 * Account roles (`volley auth add <name> --role <role>`) and the topics accounts and one-time
 * tokens use. Each account is a broker login holding its role's shared roles
 * (`ACCOUNT_ROLE_MAP` in ../auth/roles.ts); a one-time token is a login named by its id holding
 * `volley-token`. volleyd's accounts.ts keeps the same lists (a test checks they agree).
 */

/** The roles an account can hold. Agent logins come from `add-agent` / volleyd, not here. */
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

/** Where an admin sends account control ops: its role pins the last level to its username. */
export const authOpsTopic = (user: string) => `volley/_system/auth/ops/${user}`;
/**
 * Where token `id`'s login sends its redemption request, and where volleyd answers it. They live
 * outside `volley/` so a token login, which may subscribe to nothing under `volley/`, is
 * confined to these two topics; its role grants them with `%u` (the login's username is the
 * token id).
 */
export const tokenRedeemTopic = (id: string) => `volley-auth/redeem/${id}`;
export const tokenReplyTopic = (id: string) => `volley-auth/redeem/${id}/reply`;

/** The broker login a one-time token carries: its id, so `%u` names its two topics. */
export const tokenUser = (id: string) => id;
