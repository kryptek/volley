import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidAgentId } from "volley-mcp/topics";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import {
  DEFAULT_KIND,
  KINDS,
  type Kind,
  ROLES,
  type Role,
  SIGNIN_ROLES,
  accountBlockEnd,
  accountBlockStart,
  aclBlock,
  tokenAclBlock,
  tokenBlockEnd,
  tokenBlockStart,
  tokenUser,
  withBlock,
  withoutBlock,
} from "./auth-roles";

/**
 * The account registry (`$VOLLEY_AUTH_DIR/accounts.json`) and one-time tokens
 * (`$VOLLEY_AUTH_DIR/tokens.json`) behind `volley auth add|rotate|revoke|list|token|signin-link|
 * redeem`. Passwords live only in the mosquitto password file; tokens only as a sha256 hash.
 */

/** One accounts.json entry (spec/schemas/account.schema.json). */
export interface Account {
  name: string;
  role: Role;
  kind: Kind;
  created: string;
  /** The device a redeemed token's account is bound to ("Desk on <device>"). */
  label?: string;
}

/** One tokens.json entry: the token itself is never stored. */
interface TokenEntry {
  id: string;
  kind: "admin" | "signin";
  role: Role;
  hash: string;
  created: string;
  expires_at: string;
  label?: string;
  used_at?: string;
}

/** What the account verbs need from `auth.ts`: the files, the side effects, the clock. */
export interface AccountContext {
  dir: string;
  passwdFile: string;
  aclFile: string;
  io: IO;
  /** Run mosquitto_passwd; false (after reporting) on failure. */
  passwd: (args: string[]) => Promise<boolean>;
  reload: () => Promise<void>;
  generatePassword: () => string;
  randomHex: (bytes: number) => string;
  readStdin: () => Promise<string>;
  /** Names an account may never take (fixed identities, reserved ids). */
  reserved: readonly string[];
}

export interface AccountFlags {
  role?: string;
  kind?: string;
  label?: string;
  ttl?: string;
  json: boolean;
}

/** One-time admin tokens live 10 minutes unless `--ttl` says otherwise. */
const DEFAULT_TOKEN_TTL_S = 600;
/** The longest a token (or sign-in link) may live: one day. */
const MAX_TOKEN_TTL_S = 86_400;
const TOKEN_ID_BYTES = 4;
const TOKEN_SECRET_BYTES = 16;
/**
 * How long a redeemed token's login outlives its redemption: the client that redeemed is still
 * connected as it until it has the answer, and a reload that drops the login disconnects it.
 */
const REDEEMED_LOGIN_GRACE_S = 60;
const TOKEN_RE = /^vly_(admin|signin)_([0-9a-f]{8})_([0-9a-f]{32})$/;
/** The account name a redeemed token mints: `<role>-<token id>`. */
const REDEEMED_NAME_RE = /^(admin|steer|watch)-[0-9a-f]{8}$/;
/**
 * Printable, single-line, at most 64 characters, and never mistaken for a flag: it lands in
 * JSON files and the Desk (volleyd's `isValidLabel` and account.schema.json say the same).
 */
const validLabel = (l: string) =>
  l.length >= 1 &&
  l.length <= 64 &&
  !l.startsWith("-") &&
  [...l].every((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f);

export const ACCOUNT_VERBS = [
  "add",
  "rotate",
  "revoke",
  "list",
  "token",
  "signin-link",
  "redeem",
] as const;
export type AccountVerb = (typeof ACCOUNT_VERBS)[number];

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function readJson<T>(path: string, key: string): T[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  const list = raw[key];
  if (!Array.isArray(list)) throw new Error(`${path}: expected a "${key}" array`);
  return list as T[];
}

/** Write to a temp file and rename it into place: a crash never leaves half a registry. */
function writeJson(path: string, key: string, list: unknown[]): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ [key]: list }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

const accountsFile = (dir: string) => join(dir, "accounts.json");
const tokensFile = (dir: string) => join(dir, "tokens.json");

export function readAccounts(dir: string): Account[] {
  return readJson<Account>(accountsFile(dir), "accounts");
}

function hasUser(passwdFile: string, user: string): boolean {
  return readFileSync(passwdFile, "utf-8")
    .split("\n")
    .some((l) => l.startsWith(`${user}:`));
}

function editAcl(aclFile: string, edit: (acl: string) => string): void {
  if (!existsSync(aclFile)) return;
  writeFileSync(aclFile, edit(readFileSync(aclFile, "utf-8")));
}

function parseTtl(flag: string | undefined): number | string {
  if (flag === undefined) return DEFAULT_TOKEN_TTL_S;
  const n = Number(flag);
  return Number.isInteger(n) && n > 0 && n <= MAX_TOKEN_TTL_S
    ? n
    : `--ttl must be a whole number of seconds in 1..${MAX_TOKEN_TTL_S}`;
}

/**
 * Remove the broker logins (and ACL blocks) of expired tokens, and of redeemed ones once their
 * grace has passed. The entries stay in tokens.json as a record. True when anything changed (the
 * caller reloads). volleyd runs this on a timer (`volley auth list`), so a token nobody redeems
 * stops being a login soon after it expires.
 */
async function pruneTokens(ctx: AccountContext, now: Date): Promise<boolean> {
  const list = readJson<TokenEntry>(tokensFile(ctx.dir), "tokens");
  let changed = false;
  for (const t of list) {
    const graceOver =
      t.used_at !== undefined &&
      Date.parse(t.used_at) + REDEEMED_LOGIN_GRACE_S * 1000 <= now.getTime();
    if (!graceOver && Date.parse(t.expires_at) > now.getTime()) continue;
    if (!(await dropTokenLogin(ctx, t.id))) continue;
    changed = true;
  }
  return changed;
}

/** Delete token `id`'s login and ACL block. False when there was nothing to delete. */
async function dropTokenLogin(ctx: AccountContext, id: string): Promise<boolean> {
  const acl = existsSync(ctx.aclFile) ? readFileSync(ctx.aclFile, "utf-8") : "";
  const inAcl = acl.includes(`\n${tokenBlockStart(id)}\n`);
  const inPasswd = hasUser(ctx.passwdFile, tokenUser(id));
  if (!inAcl && !inPasswd) return false;
  if (inPasswd && !(await ctx.passwd(["-D", ctx.passwdFile, tokenUser(id)]))) return false;
  editAcl(ctx.aclFile, (a) => withoutBlock(a, tokenBlockStart(id), tokenBlockEnd(id)));
  return true;
}

/** Why `name` cannot be a new account, or null. Grammar errors are usage errors (exit 2). */
function badName(name: string, reserved: readonly string[]): string | null {
  if (!isValidAgentId(name)) return `"${name}" does not match [a-z0-9][a-z0-9_-]{0,62}`;
  if (reserved.includes(name)) return `"${name}" is reserved`;
  if (name.startsWith("redeem-")) return `"${name}": the redeem- prefix is reserved for tokens`;
  if (REDEEMED_NAME_RE.test(name)) {
    return `"${name}": <role>-<8 hex digits> is reserved for redeemed tokens`;
  }
  return null;
}

/** Create account `name` and print its password once. */
async function createAccount(
  ctx: AccountContext,
  account: Account,
  json: boolean,
  extra: Record<string, unknown> = {},
): Promise<ExitCode> {
  const password = ctx.generatePassword();
  if (!(await ctx.passwd(["-b", ctx.passwdFile, account.name, password]))) return EXIT.ERROR;
  writeJson(accountsFile(ctx.dir), "accounts", [...readAccounts(ctx.dir), account]);
  editAcl(ctx.aclFile, (a) => withBlock(a, aclBlock(account.name, account.role)));
  await ctx.reload();
  ctx.io.stdout(
    json
      ? `${JSON.stringify({ username: account.name, password, role: account.role, ...extra })}\n`
      : `${password}\n`,
  );
  return EXIT.OK;
}

/** Issue a one-time token: hash in tokens.json, a `redeem-<id>` login whose password it is. */
async function issueToken(
  ctx: AccountContext,
  now: Date,
  kind: "admin" | "signin",
  role: Role,
  ttlS: number,
  label: string | undefined,
  json: boolean,
): Promise<ExitCode> {
  const taken = new Set(readJson<TokenEntry>(tokensFile(ctx.dir), "tokens").map((t) => t.id));
  let id = ctx.randomHex(TOKEN_ID_BYTES);
  while (taken.has(id)) id = ctx.randomHex(TOKEN_ID_BYTES);
  const token = `vly_${kind}_${id}_${ctx.randomHex(TOKEN_SECRET_BYTES)}`;
  const expiresAt = new Date(now.getTime() + ttlS * 1000).toISOString();
  if (!(await ctx.passwd(["-b", ctx.passwdFile, tokenUser(id), token]))) return EXIT.ERROR;
  const entry: TokenEntry = {
    id,
    kind,
    role,
    hash: sha256(token),
    created: now.toISOString(),
    expires_at: expiresAt,
    ...(label !== undefined ? { label } : {}),
  };
  writeJson(tokensFile(ctx.dir), "tokens", [
    ...readJson<TokenEntry>(tokensFile(ctx.dir), "tokens"),
    entry,
  ]);
  editAcl(ctx.aclFile, (a) => withBlock(a, tokenAclBlock(id)));
  await ctx.reload();
  if (json) {
    ctx.io.stdout(`${JSON.stringify({ token, username: tokenUser(id), expires_at: expiresAt })}\n`);
  } else {
    const minutes = ttlS % 60 === 0 ? `${ttlS / 60} minutes` : `${ttlS} seconds`;
    ctx.io.stdout(
      [
        kind === "admin"
          ? "One-time admin token (single use; paste it into the Desk's sign-in):"
          : `One-time ${role} sign-in token${label !== undefined ? ` for "${label}"` : ""} (single use):`,
        "",
        `  ${token}`,
        "",
        `It expires in ${minutes} (${expiresAt}). Only its hash is stored.`,
        "",
      ].join("\n"),
    );
  }
  return EXIT.OK;
}

/** Redeem a token read from stdin for a fresh account bound to `label`. */
async function redeem(
  ctx: AccountContext,
  now: Date,
  label: string,
  json: boolean,
): Promise<ExitCode> {
  const token = (await ctx.readStdin()).trim();
  const list = readJson<TokenEntry>(tokensFile(ctx.dir), "tokens");
  const m = TOKEN_RE.exec(token);
  const entry = m === null ? undefined : list.find((t) => t.id === m[2]);
  const hash = Buffer.from(sha256(token), "hex");
  if (
    m === null ||
    entry === undefined ||
    entry.kind !== m[1] ||
    !timingSafeEqual(hash, Buffer.from(entry.hash, "hex"))
  ) {
    ctx.io.stderr("volley auth: invalid token\n");
    return EXIT.ERROR;
  }
  if (entry.used_at !== undefined) {
    ctx.io.stderr(`volley auth: token ${entry.id} was already used at ${entry.used_at}\n`);
    return EXIT.ERROR;
  }
  // Never drop the token's login (nor reload for it) here: the client asking is connected as
  // that login, and mosquitto disconnects it on the reload before it hears the answer. The
  // login can only ask to be redeemed; pruneTokens removes it after REDEEMED_LOGIN_GRACE_S.
  if (Date.parse(entry.expires_at) <= now.getTime()) {
    ctx.io.stderr(`volley auth: token ${entry.id} expired at ${entry.expires_at}\n`);
    return EXIT.ERROR;
  }
  const name = `${entry.role}-${entry.id}`;
  if (readAccounts(ctx.dir).some((a) => a.name === name) || hasUser(ctx.passwdFile, name)) {
    ctx.io.stderr(`volley auth: "${name}" already exists; token ${entry.id} was not used\n`);
    return EXIT.ERROR;
  }
  // Burn first: a crash after this leaves an unusable token, never a reusable one.
  entry.used_at = now.toISOString();
  writeJson(tokensFile(ctx.dir), "tokens", list);
  return createAccount(
    ctx,
    { name, role: entry.role, kind: "device", created: now.toISOString(), label },
    json,
    { label, token_id: entry.id },
  );
}

/** `volley auth add|rotate|revoke|list|token|signin-link|redeem`. */
export async function accountVerb(
  ctx: AccountContext,
  verb: AccountVerb,
  name: string | undefined,
  flags: AccountFlags,
): Promise<ExitCode> {
  const { io } = ctx;
  const usage = (msg: string): ExitCode => {
    io.stderr(`volley auth ${verb}: ${msg}\n`);
    return EXIT.USAGE;
  };
  const takesName = verb === "add" || verb === "rotate" || verb === "revoke";
  if (takesName !== (name !== undefined)) {
    return usage(takesName ? "needs an account name" : "takes no account name");
  }
  if (flags.role !== undefined && verb !== "add" && verb !== "signin-link") {
    return usage("--role only applies to add and signin-link");
  }
  if (flags.kind !== undefined && verb !== "add") return usage("--kind only applies to add");
  if (flags.ttl !== undefined && verb !== "token" && verb !== "signin-link") {
    return usage("--ttl only applies to token and signin-link");
  }
  if (flags.label !== undefined && verb !== "signin-link" && verb !== "redeem") {
    return usage("--label only applies to signin-link and redeem");
  }
  if (flags.label !== undefined && !validLabel(flags.label)) {
    return usage("--label must be 1..64 printable characters, not starting with -");
  }
  if (!existsSync(ctx.passwdFile)) {
    io.stderr(`volley auth: ${ctx.passwdFile} does not exist; run \`volley auth init\` first\n`);
    return EXIT.ERROR;
  }
  const now = io.now();
  // Not before a redemption: a reload could disconnect the client waiting for its answer.
  if (verb !== "redeem" && (await pruneTokens(ctx, now))) await ctx.reload();

  switch (verb) {
    case "add": {
      const n = name as string;
      const why = badName(n, ctx.reserved);
      if (why !== null) return usage(why);
      const role = flags.role;
      if (role === undefined || !(ROLES as readonly string[]).includes(role)) {
        return usage(`--role must be one of ${ROLES.join(", ")}`);
      }
      if (flags.kind !== undefined && !(KINDS as readonly string[]).includes(flags.kind)) {
        return usage(`--kind must be one of ${KINDS.join(", ")}`);
      }
      if (readAccounts(ctx.dir).some((a) => a.name === n) || hasUser(ctx.passwdFile, n)) {
        io.stderr(`volley auth: "${n}" already exists; use rotate for a new password\n`);
        return EXIT.ERROR;
      }
      const r = role as Role;
      return createAccount(
        ctx,
        {
          name: n,
          role: r,
          kind: (flags.kind as Kind) ?? DEFAULT_KIND[r],
          created: now.toISOString(),
        },
        flags.json,
      );
    }
    case "rotate": {
      const account = readAccounts(ctx.dir).find((a) => a.name === name);
      if (account === undefined) {
        io.stderr(`volley auth: no account "${name}"\n`);
        return EXIT.ERROR;
      }
      const password = ctx.generatePassword();
      if (!(await ctx.passwd(["-b", ctx.passwdFile, account.name, password]))) return EXIT.ERROR;
      await ctx.reload();
      io.stdout(
        flags.json
          ? `${JSON.stringify({ username: account.name, password, role: account.role })}\n`
          : `${password}\n`,
      );
      return EXIT.OK;
    }
    case "revoke": {
      const accounts = readAccounts(ctx.dir);
      if (!accounts.some((a) => a.name === name)) {
        io.stderr(`volley auth: no account "${name}"\n`);
        return EXIT.ERROR;
      }
      const n = name as string;
      if (hasUser(ctx.passwdFile, n) && !(await ctx.passwd(["-D", ctx.passwdFile, n]))) {
        return EXIT.ERROR;
      }
      editAcl(ctx.aclFile, (a) => withoutBlock(a, accountBlockStart(n), accountBlockEnd(n)));
      writeJson(
        accountsFile(ctx.dir),
        "accounts",
        accounts.filter((a) => a.name !== n),
      );
      await ctx.reload();
      return EXIT.OK;
    }
    case "list": {
      const accounts = readAccounts(ctx.dir);
      if (flags.json) {
        io.stdout(`${JSON.stringify({ accounts })}\n`);
        return EXIT.OK;
      }
      if (accounts.length === 0) {
        io.stdout("No accounts. Add one with `volley auth add <name> --role <role>`.\n");
        return EXIT.OK;
      }
      const width = Math.max(4, ...accounts.map((a) => a.name.length));
      io.stdout(
        [
          `${"NAME".padEnd(width)}  ROLE        KIND     CREATED                   LABEL`,
          ...accounts.map((a) =>
            `${a.name.padEnd(width)}  ${a.role.padEnd(10)}  ${a.kind.padEnd(7)}  ${a.created.padEnd(24)}  ${a.label ?? ""}`.trimEnd(),
          ),
          "",
        ].join("\n"),
      );
      return EXIT.OK;
    }
    case "token": {
      const ttl = parseTtl(flags.ttl);
      if (typeof ttl === "string") return usage(ttl);
      return issueToken(ctx, now, "admin", "admin", ttl, undefined, flags.json);
    }
    case "signin-link": {
      const role = flags.role;
      if (role === undefined || !(SIGNIN_ROLES as readonly string[]).includes(role)) {
        return usage(`--role must be one of ${SIGNIN_ROLES.join(", ")}`);
      }
      if (flags.label === undefined) return usage("needs --label <device>");
      const ttl = parseTtl(flags.ttl);
      if (typeof ttl === "string") return usage(ttl);
      return issueToken(ctx, now, "signin", role as Role, ttl, flags.label, flags.json);
    }
    case "redeem":
      if (flags.label === undefined) return usage("needs --label <device>");
      return redeem(ctx, now, flags.label, flags.json);
  }
}
