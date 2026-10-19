import {
  constants,
  type JsonWebKeyInput,
  type KeyObject,
  createPublicKey,
  publicEncrypt,
} from "node:crypto";
import { isValidAgentId } from "volley-mcp/topics";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";

/**
 * Account management over the control channel (SPEC §4.6.10). The account registry and the
 * one-time tokens belong to `volley auth` (it owns the accounts' and tokens' broker logins and
 * `accounts.json` / `tokens.json`); the daemon only runs it through the fenced exec.
 *
 * Two kinds of request topic, both outside the mailbox so the broker ACL names the sender:
 *   - `volley/_system/auth/ops/<username>`: account ops. Only the admin role grants it, and
 *     only for its own username (`%u`), so the topic identifies the sender; the daemon
 *     also checks that username's role in the registry. Answered on
 *     `volley/_system/auth/replies/<correlation_id>`.
 *   - `volley-auth/redeem/<id>`: `token_redeem`, published by one-time token `<id>`'s own
 *     short-lived broker login (username `<id>`), answered on `volley-auth/redeem/<id>/reply`.
 *     The token is the credential; no account needed. The login may touch nothing else: its
 *     role grants only these two topics (`%u`) and nothing under `volley/`, hence the separate
 *     root.
 *
 * Every account may read the whole `volley/` tree, so a secret (a password, a sign-in token) is
 * never in a reply's clear text: it is sealed (RSA-OAEP, SHA-256) to the `reply_key` the request
 * carries, a public JWK whose private half only the requesting browser holds.
 */

export const AUTH_CHANNEL = "_system/auth";
/** Every token's redeem topic (`tokenRedeemTopic`); `+` stops short of the `/reply` level. */
export const TOKEN_REDEEM_FILTER = "volley-auth/redeem/+";
export const tokenRedeemTopic = (id: string) => `volley-auth/redeem/${id}`;
export const tokenReplyTopic = (id: string) => `volley-auth/redeem/${id}/reply`;
export const AUTH_OPS_FILTER = "volley/_system/auth/ops/+";
export const authOpsTopic = (username: string) => `volley/_system/auth/ops/${username}`;
export const authReplyTopic = (correlationId: string) =>
  `volley/_system/auth/replies/${correlationId}`;

/** A correlation id usable as a reply-topic level (a UUID fits). */
export const isValidCorrelationId = (id: string) => /^[A-Za-z0-9_-]{8,64}$/.test(id);

export const ACCOUNT_ROLES = ["admin", "steer", "watch", "supervisor", "peer"] as const;
export const ACCOUNT_KINDS = ["human", "device", "machine", "service"] as const;
/** Roles a sign-in link may grant: never an operator-level one. */
export const SIGNIN_ROLES = ["steer", "watch"] as const;

export type AccountOp =
  | "account_list"
  | "account_create"
  | "account_rotate"
  | "account_revoke"
  | "signin_link";
const ACCOUNT_OPS: readonly string[] = [
  "account_list",
  "account_create",
  "account_rotate",
  "account_revoke",
  "signin_link",
];

/** One accounts.json entry, as `volley auth list --json` prints it. */
export interface Account {
  name: string;
  role: string;
  kind: string;
  created: string;
  label?: string;
  last_seen?: string;
}

/** The answer on the reply topic (an `ack` envelope's payload). */
export interface AuthReply {
  text: "ACKED";
  acked_type: "query";
  op: string;
  ok: boolean;
  error?: string;
  result?: unknown;
  /** base64url RSA-OAEP ciphertext of the secret JSON, sealed to the request's `reply_key`. */
  sealed?: string;
}

/** A `_system` journal event an op produced. */
export interface AuthEvent {
  type:
    | "account_created"
    | "account_rotated"
    | "account_revoked"
    | "signin_link_issued"
    | "token_redeemed";
  data: Record<string, unknown>;
}

export interface AuthOutcome {
  reply: AuthReply;
  event?: AuthEvent;
}

type Fields = Record<string, unknown>;

/** A request's `reply_key` as a public key, or why it cannot seal a secret. */
export function replyKey(jwk: unknown): KeyObject | string {
  if (typeof jwk !== "object" || jwk === null || (jwk as { kty?: unknown }).kty !== "RSA") {
    return "reply_key must be an RSA public key (JWK) to seal the secret to";
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: jwk as JsonWebKeyInput["key"], format: "jwk" });
  } catch (e) {
    return `reply_key is not a usable RSA public key: ${(e as Error).message}`;
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < DAEMON_DEFAULTS.reply_key_min_bits) {
    return `reply_key must be at least ${DAEMON_DEFAULTS.reply_key_min_bits} bits`;
  }
  return key;
}

/** Seal `secret` to `key` (RSA-OAEP with SHA-256, what WebCrypto's RSA-OAEP decrypts). */
export function seal(key: KeyObject, secret: Fields): string {
  return publicEncrypt(
    { key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(JSON.stringify(secret)),
  ).toString("base64url");
}

/** Printable, single-line, at most 64 characters, and never mistaken for a flag. */
export const isValidLabel = (l: unknown): l is string =>
  typeof l === "string" &&
  l.length >= 1 &&
  l.length <= 64 &&
  !l.startsWith("-") &&
  [...l].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f);

const reply = (op: string, r: Omit<AuthReply, "text" | "acked_type" | "op">): AuthReply => ({
  text: "ACKED",
  acked_type: "query",
  op,
  ...r,
});
const refuse = (op: string, error: string): AuthOutcome => ({
  reply: reply(op, { ok: false, error }),
});

/** `volley auth <args>` through the fenced exec; the parsed JSON stdout, or its error line. */
export async function volleyAuth(
  exec: ExecFn,
  args: string[],
  input?: string,
): Promise<{ ok: true; out: Fields | null } | { ok: false; error: string }> {
  const r = await exec(["volley", "auth", ...args], {
    timeoutMs: DAEMON_DEFAULTS.auth_exec_timeout_ms,
    ...(input !== undefined ? { input } : {}),
  });
  if (r.code !== 0) {
    const line = r.stderr.trim().split("\n").pop() ?? "";
    const error = line.replace(/^volley auth( [a-z-]+)?: /, "");
    return { ok: false, error: error === "" ? `volley auth ${args[0]} exited ${r.code}` : error };
  }
  if (r.stdout.trim() === "") return { ok: true, out: null };
  try {
    return { ok: true, out: JSON.parse(r.stdout) as Fields };
  } catch {
    return { ok: false, error: `volley auth ${args[0]} printed no JSON` };
  }
}

/** Every account, from `volley auth list --json`. */
export async function listAccounts(exec: ExecFn): Promise<Account[] | string> {
  const r = await volleyAuth(exec, ["list", "--json"]);
  if (!r.ok) return r.error;
  const list = r.out?.accounts;
  return Array.isArray(list) ? (list as Account[]) : "volley auth list printed no accounts";
}

/**
 * Answer one account op from `sender` (the username the ops topic names). Refused unless the
 * sender's account has the admin role.
 */
export async function accountOp(
  exec: ExecFn,
  sender: string,
  p: Fields,
  lastSeen: (name: string) => string | undefined = () => undefined,
): Promise<AuthOutcome> {
  const op = typeof p.op === "string" ? p.op : "";
  const accounts = await listAccounts(exec);
  if (typeof accounts === "string") return refuse(op, accounts);
  const me = accounts.find((a) => a.name === sender);
  if (me === undefined)
    return refuse(op, `"${sender}" has no account; account ops need the admin role`);
  if (me.role !== "admin") {
    return refuse(op, `"${sender}" has role ${me.role}; account ops need the admin role`);
  }
  if (op === "token_redeem") {
    return refuse(op, "token_redeem is answered only on volley-auth/redeem/<token id>");
  }
  if (!ACCOUNT_OPS.includes(op)) return refuse(op, `unknown op '${op}'`);

  if (op === "account_list") {
    const result = accounts.map((a) => {
      const seen = lastSeen(a.name);
      return seen === undefined ? a : { ...a, last_seen: seen };
    });
    return { reply: reply(op, { ok: true, result: { accounts: result } }) };
  }

  if (op === "signin_link") return signinLink(exec, sender, p);

  const name = p.name;
  if (typeof name !== "string" || !isValidAgentId(name)) {
    return refuse(op, "name must match [a-z0-9][a-z0-9_-]{0,62}");
  }
  if (op === "account_revoke") {
    const r = await volleyAuth(exec, ["revoke", name]);
    if (!r.ok) return refuse(op, r.error);
    return {
      reply: reply(op, { ok: true, result: { name } }),
      event: { type: "account_revoked", data: { by: sender, name } },
    };
  }

  const args: string[] = [];
  if (op === "account_create") {
    if (!(ACCOUNT_ROLES as readonly unknown[]).includes(p.role)) {
      return refuse(op, `role must be one of ${ACCOUNT_ROLES.join(", ")}`);
    }
    if (p.kind !== undefined && !(ACCOUNT_KINDS as readonly unknown[]).includes(p.kind)) {
      return refuse(op, `kind must be one of ${ACCOUNT_KINDS.join(", ")}`);
    }
    args.push("add", name, "--role", p.role as string);
    if (p.kind !== undefined) args.push("--kind", p.kind as string);
  } else {
    // mosquitto disconnects a client whose password changes, before the answer is published:
    // rotating your own account would lose the new password.
    if (name === sender) {
      return refuse(
        op,
        "cannot rotate your own account over the control channel (the new password disconnects you " +
          "before the answer); run `volley auth rotate` in a terminal or ask another admin",
      );
    }
    args.push("rotate", name);
  }
  const key = replyKey(p.reply_key);
  if (typeof key === "string") return refuse(op, key);
  const r = await volleyAuth(exec, [...args, "--json"]);
  if (!r.ok) return refuse(op, r.error);
  const creds = credentials(r.out);
  if (creds === null) return refuse(op, `volley auth ${args[0]} printed no credentials`);
  const role = typeof r.out?.role === "string" ? r.out.role : undefined;
  return {
    reply: reply(op, {
      ok: true,
      result: { name, ...(role !== undefined ? { role } : {}) },
      sealed: seal(key, creds),
    }),
    event:
      op === "account_create"
        ? {
            type: "account_created",
            data: {
              by: sender,
              name,
              role: p.role,
              ...(p.kind !== undefined ? { kind: p.kind } : {}),
            },
          }
        : { type: "account_rotated", data: { by: sender, name } },
  };
}

function credentials(out: Fields | null): { username: string; password: string } | null {
  return typeof out?.username === "string" && typeof out.password === "string"
    ? { username: out.username, password: out.password }
    : null;
}

/**
 * `signin_link {role, label, ttl_s?, desk_url?}` → a single-use token, sealed. Only `{token}` is
 * sealed: RSA-OAEP with SHA-256 fits at most 190 bytes under a 2048-bit key, which a token plus a
 * real Desk URL overflows. The client builds the link, `<result.link_base>#signin=<token>`.
 */
async function signinLink(exec: ExecFn, sender: string, p: Fields): Promise<AuthOutcome> {
  const op = "signin_link";
  if (!(SIGNIN_ROLES as readonly unknown[]).includes(p.role)) {
    return refuse(op, `a sign-in link grants only ${SIGNIN_ROLES.join(" or ")}`);
  }
  if (!isValidLabel(p.label)) return refuse(op, "label must be 1..64 printable characters");
  const ttl = p.ttl_s ?? DAEMON_DEFAULTS.signin_link_ttl_s;
  if (
    typeof ttl !== "number" ||
    !Number.isInteger(ttl) ||
    ttl < 1 ||
    ttl > DAEMON_DEFAULTS.token_max_ttl_s
  ) {
    return refuse(
      op,
      `ttl_s must be a whole number of seconds in 1..${DAEMON_DEFAULTS.token_max_ttl_s}`,
    );
  }
  let base: string | null = null;
  if (p.desk_url !== undefined) {
    base = deskBase(p.desk_url);
    if (base === null) return refuse(op, "desk_url must be an http(s) URL without a fragment");
  }
  const key = replyKey(p.reply_key);
  if (typeof key === "string") return refuse(op, key);
  const r = await volleyAuth(exec, [
    "signin-link",
    "--role",
    p.role as string,
    "--label",
    p.label,
    "--ttl",
    String(ttl),
    "--json",
  ]);
  if (!r.ok) return refuse(op, r.error);
  const token = r.out?.token;
  if (typeof token !== "string") return refuse(op, "volley auth signin-link printed no token");
  const expiresAt = r.out?.expires_at;
  const tokenId = token.split("_")[2];
  return {
    reply: reply(op, {
      ok: true,
      result: {
        role: p.role,
        label: p.label,
        expires_at: expiresAt,
        ...(base !== null ? { link_base: base } : {}),
      },
      sealed: seal(key, { token }),
    }),
    event: {
      type: "signin_link_issued",
      data: { by: sender, role: p.role, label: p.label, token_id: tokenId, expires_at: expiresAt },
    },
  };
}

/** `desk_url` without a fragment (the link's base), or null when it is not an http(s) URL. */
export function deskBase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.hash !== "" || raw.includes("#")) {
    return null;
  }
  return `${u.origin}${u.pathname}${u.search}`;
}

/**
 * `token_redeem {token, label, reply_key}` from token `topicId`'s redeem topic. Only that token
 * is redeemed there: the broker lets only its own login write the topic.
 */
export async function redeemToken(exec: ExecFn, topicId: string, p: Fields): Promise<AuthOutcome> {
  const op = "token_redeem";
  if (p.op !== op) return refuse(String(p.op ?? ""), "only token_redeem is answered here");
  if (typeof p.token !== "string" || p.token === "" || p.token.includes("\n")) {
    return refuse(op, "token is required");
  }
  if (
    !p.token.startsWith(`vly_admin_${topicId}_`) &&
    !p.token.startsWith(`vly_signin_${topicId}_`)
  ) {
    return refuse(op, `only token ${topicId} is redeemed on ${tokenRedeemTopic(topicId)}`);
  }
  if (!isValidLabel(p.label)) return refuse(op, "label must be 1..64 printable characters");
  const key = replyKey(p.reply_key);
  if (typeof key === "string") return refuse(op, key);
  // The token goes on stdin: argv is visible to every local user in the process list.
  const r = await volleyAuth(exec, ["redeem", "--label", p.label, "--json"], `${p.token}\n`);
  if (!r.ok) return refuse(op, r.error);
  const creds = credentials(r.out);
  if (creds === null) return refuse(op, "volley auth redeem printed no credentials");
  const role = r.out?.role;
  return {
    reply: reply(op, {
      ok: true,
      result: { username: creds.username, role, label: p.label },
      sealed: seal(key, creds),
    }),
    event: {
      type: "token_redeemed",
      data: {
        // The redeeming login: the token id is its username (SPEC §4.6.10).
        by: String(r.out?.token_id ?? ""),
        name: creds.username,
        role,
        label: p.label,
      },
    },
  };
}
