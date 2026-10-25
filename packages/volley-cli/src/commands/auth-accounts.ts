import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidAgentId } from "volley-mcp/topics";
import { type AdminLink, type AuthContext, volleydHome } from "../auth/context";
import { DynsecError, classify, cmd } from "../auth/dynsec";
import {
  ACCOUNT_ROLE_MAP,
  DYNSEC_ADMIN_USER,
  FIXED_IDENTITIES,
  TOKEN_ID_RE,
  TOKEN_ROLES,
} from "../auth/roles";
import { EXIT, type ExitCode } from "../exit-codes";
import { readDeskPrivateUrl, readSetupInstall } from "../setup/journal";
import { encodeQr, renderQr } from "../setup/qr";
import {
  DEFAULT_KIND,
  KINDS,
  type Kind,
  ROLES,
  type Role,
  SIGNIN_ROLES,
  tokenUser,
} from "./auth-roles";
import { DESK_PORT } from "./desk-serve";

/**
 * The account registry (`$VOLLEY_AUTH_DIR/accounts.json`) and one-time tokens
 * (`$VOLLEY_AUTH_DIR/tokens.json`) behind `volley auth add|rotate|revoke|list|token|signin-link|
 * redeem`. Each account and each pending token is a broker login (a Dynamic Security client);
 * the broker keeps only salted password hashes, tokens.json only a sha256 of each token.
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

/** Run `fn` on the admin link (opened on first use, closed after). */
type WithAdmin = (fn: (link: AdminLink) => Promise<ExitCode>) => Promise<ExitCode>;

export interface AccountFlags {
  role?: string;
  kind?: string;
  label?: string;
  ttl?: string;
  json: boolean;
  /** token: the Desk the admin token's link opens (default: setup's record, else port 5199). */
  deskUrl?: string;
  /** token: the address other devices reach that Desk at (default: setup's record). */
  deskHost?: string;
}

/** One-time admin tokens live 10 minutes unless `--ttl` says otherwise. */
const DEFAULT_TOKEN_TTL_S = 600;
/** The longest a token (or sign-in link) may live: one day. */
const MAX_TOKEN_TTL_S = 86_400;
const TOKEN_ID_BYTES = 4;
const TOKEN_SECRET_BYTES = 16;
/**
 * How long a redeemed token's login outlives its redemption: the client that redeemed is still
 * connected as it until it has the answer, and deleting the login disconnects it at once.
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

function parseTtl(flag: string | undefined): number | string {
  if (flag === undefined) return DEFAULT_TOKEN_TTL_S;
  const n = Number(flag);
  return Number.isInteger(n) && n > 0 && n <= MAX_TOKEN_TTL_S
    ? n
    : `--ttl must be a whole number of seconds in 1..${MAX_TOKEN_TTL_S}`;
}

/** The tokens whose broker login should be gone: expired, or redeemed and past the grace. */
function prunable(dir: string, now: Date): TokenEntry[] {
  return readJson<TokenEntry>(tokensFile(dir), "tokens").filter((t) => {
    const graceOver =
      t.used_at !== undefined &&
      Date.parse(t.used_at) + REDEEMED_LOGIN_GRACE_S * 1000 <= now.getTime();
    return graceOver || Date.parse(t.expires_at) <= now.getTime();
  });
}

/**
 * Delete the broker logins of expired tokens, and of redeemed ones once their grace has passed,
 * in one control message (already deleted ones are not found, which is fine). The entries stay
 * in tokens.json as a record. volleyd runs `volley auth list` on a timer for this, so a token
 * nobody redeems stops being a login soon after it expires.
 */
async function pruneTokens(link: AdminLink, tokens: readonly TokenEntry[]): Promise<void> {
  const answers = await link.session.run(tokens.map((t) => cmd.deleteClient(tokenUser(t.id))));
  for (const r of answers) {
    const o = classify(r);
    if (o !== "ok" && o !== "missing") throw new DynsecError(`deleteClient: ${r.error}`);
  }
}

/** Why `name` cannot be a new account, or null. Grammar errors are usage errors (exit 2). */
function badName(name: string, reserved: readonly string[]): string | null {
  if (!isValidAgentId(name)) return `"${name}" does not match [a-z0-9][a-z0-9_-]{0,62}`;
  if (reserved.includes(name)) return `"${name}" is reserved`;
  if (TOKEN_ID_RE.test(name))
    return `"${name}": 8 hex digits are reserved for one-time token logins`;
  if (REDEEMED_NAME_RE.test(name)) {
    return `"${name}": <role>-<8 hex digits> is reserved for redeemed tokens`;
  }
  return null;
}

/** Create account `name` (a login holding its role's roles) and print its password once. */
async function createAccount(
  ctx: AuthContext,
  link: AdminLink,
  account: Account,
  json: boolean,
  extra: Record<string, unknown> = {},
): Promise<ExitCode> {
  const password = ctx.deps.generatePassword();
  const [r] = await link.session.run([
    cmd.createClient(
      account.name,
      password,
      ACCOUNT_ROLE_MAP[account.role],
      `Volley ${account.role} account`,
    ),
  ]);
  if (r === undefined || classify(r) === "exists") {
    ctx.io.stderr(`volley auth: "${account.name}" already has a broker login\n`);
    return EXIT.ERROR;
  }
  if (classify(r) !== "ok") throw new DynsecError(`createClient ${account.name}: ${r.error}`);
  writeJson(accountsFile(ctx.dir), "accounts", [...readAccounts(ctx.dir), account]);
  ctx.io.stdout(
    json
      ? `${JSON.stringify({ username: account.name, password, role: account.role, ...extra })}\n`
      : `${password}\n`,
  );
  return EXIT.OK;
}

/** Where a sign-in link may point: this machine's Desk, its LAN host, its private address. */
interface DeskAt {
  url: string;
  host?: string;
  /** `https://<name>`: the Desk served on the tailnet (`volley desk install --tailscale`). */
  privateUrl?: string;
}

/**
 * The Desk `volley setup` recorded (its port, LAN address and private address), else this
 * machine's on 5199.
 */
function deskOf(ctx: AuthContext): DeskAt {
  const home = volleydHome(ctx.env);
  const saved = readSetupInstall(home);
  const privateUrl = readDeskPrivateUrl(home);
  return {
    url: `http://localhost:${saved?.desk_port ?? DESK_PORT}/`,
    ...(saved?.desk_host !== undefined ? { host: saved.desk_host } : {}),
    ...(privateUrl !== null ? { privateUrl } : {}),
  };
}

/**
 * A sign-in token as what the device opens: the link to the Desk at its private address when it is
 * served on the tailnet, else on the LAN address `volley setup` recorded (`#signin=<token>`, which
 * the Desk redeems), and its QR code, like setup's phone step; the LAN link beside a private one.
 */
function signinLines(desk: DeskAt, token: string): string[] {
  const port = new URL(desk.url).port || "80";
  const host =
    desk.host?.includes(":") && !desk.host.startsWith("[") ? `[${desk.host}]` : desk.host;
  const lan =
    host !== undefined ? `http://${host}:${port}/#signin=${token}` : `${desk.url}#signin=${token}`;
  const url = desk.privateUrl !== undefined ? `${desk.privateUrl}/#signin=${token}` : lan;
  return [
    "Open this link on the device (or scan it) to open the Desk, signed in:",
    "",
    renderQr(encodeQr(url)),
    `  ${url}`,
    "",
    ...(desk.privateUrl !== undefined
      ? [
          "(on your private network: the device needs the Tailscale app, signed in to your account)",
          `On your LAN: ${lan}`,
          "",
        ]
      : []),
    ...(host === undefined && desk.privateUrl === undefined
      ? [
          "(this link names localhost: on another device use this machine's address instead, or run `volley setup` so links name it)",
          "",
        ]
      : []),
  ];
}

/** Issue a one-time token: hash in tokens.json, a login named by its id whose password it is. */
async function issueToken(
  ctx: AuthContext,
  link: AdminLink,
  now: Date,
  kind: "admin" | "signin",
  role: Role,
  ttlS: number,
  label: string | undefined,
  json: boolean,
  desk: DeskAt = { url: `http://localhost:${DESK_PORT}/` },
): Promise<ExitCode> {
  const taken = new Set(readJson<TokenEntry>(tokensFile(ctx.dir), "tokens").map((t) => t.id));
  for (let tries = 0; ; tries++) {
    let id = ctx.deps.randomHex(TOKEN_ID_BYTES);
    while (taken.has(id)) id = ctx.deps.randomHex(TOKEN_ID_BYTES);
    const token = `vly_${kind}_${id}_${ctx.deps.randomHex(TOKEN_SECRET_BYTES)}`;
    const expiresAt = new Date(now.getTime() + ttlS * 1000).toISOString();
    const [r] = await link.session.run([cmd.createClient(tokenUser(id), token, TOKEN_ROLES)]);
    if (r !== undefined && classify(r) === "exists" && tries < 3) {
      taken.add(id);
      continue;
    }
    if (r === undefined || classify(r) !== "ok") {
      throw new DynsecError(`createClient ${tokenUser(id)}: ${r?.error ?? "no answer"}`);
    }
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
    if (json) {
      ctx.io.stdout(
        `${JSON.stringify({ token, username: tokenUser(id), expires_at: expiresAt })}\n`,
      );
    } else {
      const minutes = ttlS % 60 === 0 ? `${ttlS / 60} minutes` : `${ttlS} seconds`;
      ctx.io.stdout(
        [
          kind === "admin"
            ? "One-time admin token (single use):"
            : `One-time ${role} sign-in token${label !== undefined ? ` for "${label}"` : ""} (single use):`,
          "",
          `  ${token}`,
          "",
          // The Desk's sign-in form takes a username and password: a token works as a link.
          ...(kind === "admin"
            ? [
                ...(desk.privateUrl !== undefined
                  ? [`On your private network: ${desk.privateUrl}/#signin=${token}`]
                  : []),
                `Open the Desk with it on this machine: ${desk.url}#signin=${token}`,
                desk.host !== undefined
                  ? `From another device: http://${desk.host}:${new URL(desk.url).port || "80"}/#signin=${token}`
                  : "(from another device, use this machine's address instead of localhost)",
                "",
              ]
            : signinLines(desk, token)),
          `It expires in ${minutes} (${expiresAt}). Only its hash is stored.`,
          "",
        ].join("\n"),
      );
    }
    return EXIT.OK;
  }
}

/** Redeem a token read from stdin for a fresh account bound to `label`. */
async function redeem(
  ctx: AuthContext,
  link: AdminLink,
  now: Date,
  label: string,
  json: boolean,
): Promise<ExitCode> {
  const token = (await ctx.deps.readStdin()).trim();
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
  // Never delete the token's login here: the client asking is connected as that login, and
  // deleting it disconnects that client before it hears the answer. The login can only ask to be
  // redeemed; pruneTokens deletes it after REDEEMED_LOGIN_GRACE_S.
  if (Date.parse(entry.expires_at) <= now.getTime()) {
    ctx.io.stderr(`volley auth: token ${entry.id} expired at ${entry.expires_at}\n`);
    return EXIT.ERROR;
  }
  const name = `${entry.role}-${entry.id}`;
  if (readAccounts(ctx.dir).some((a) => a.name === name) || (await hasLogin(link, name))) {
    ctx.io.stderr(`volley auth: "${name}" already exists; token ${entry.id} was not used\n`);
    return EXIT.ERROR;
  }
  // Burn first: a crash after this leaves an unusable token, never a reusable one.
  entry.used_at = now.toISOString();
  writeJson(tokensFile(ctx.dir), "tokens", list);
  return createAccount(
    ctx,
    link,
    { name, role: entry.role, kind: "device", created: now.toISOString(), label },
    json,
    { label, token_id: entry.id },
  );
}

/** Whether the broker has a login named `username`. */
async function hasLogin(link: AdminLink, username: string): Promise<boolean> {
  const [r] = await link.session.run([cmd.getClient(username)]);
  if (r === undefined) return false;
  const o = classify(r);
  if (o === "missing") return false;
  if (o !== "ok") throw new DynsecError(`getClient ${username}: ${r.error}`);
  return true;
}

/** Names an account may never take: the fixed identities, the admin, reserved ids. */
export const RESERVED_ACCOUNT_NAMES = [...FIXED_IDENTITIES, DYNSEC_ADMIN_USER] as const;

/** `volley auth add|rotate|revoke|list|token|signin-link|redeem`. */
export async function accountVerb(
  ctx: AuthContext,
  verb: AccountVerb,
  name: string | undefined,
  flags: AccountFlags,
  withAdmin: WithAdmin,
  reserved: readonly string[] = RESERVED_ACCOUNT_NAMES,
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
  const ttl = parseTtl(flags.ttl);
  if ((verb === "token" || verb === "signin-link") && typeof ttl === "string") return usage(ttl);
  if (verb === "add") {
    const why = badName(name as string, reserved);
    if (why !== null) return usage(why);
    if (flags.role === undefined || !(ROLES as readonly string[]).includes(flags.role)) {
      return usage(`--role must be one of ${ROLES.join(", ")}`);
    }
    if (flags.kind !== undefined && !(KINDS as readonly string[]).includes(flags.kind)) {
      return usage(`--kind must be one of ${KINDS.join(", ")}`);
    }
  }
  if (verb === "signin-link") {
    if (flags.role === undefined || !(SIGNIN_ROLES as readonly string[]).includes(flags.role)) {
      return usage(`--role must be one of ${SIGNIN_ROLES.join(", ")}`);
    }
    if (flags.label === undefined) return usage("needs --label <device>");
  }
  if (verb === "redeem" && flags.label === undefined) return usage("needs --label <device>");

  const now = io.now();
  mkdirSync(ctx.dir, { recursive: true, mode: 0o700 });
  // `list` needs the broker only when a token login is due for removal.
  if (verb === "list" && prunable(ctx.dir, now).length === 0) return listAccounts(ctx, flags.json);

  return withAdmin(async (link) => {
    // Not before a redemption: deleting the asking client's login would disconnect it.
    if (verb !== "redeem") {
      const due = prunable(ctx.dir, now);
      if (due.length > 0) await pruneTokens(link, due);
    }
    switch (verb) {
      case "add": {
        const n = name as string;
        if (readAccounts(ctx.dir).some((a) => a.name === n) || (await hasLogin(link, n))) {
          io.stderr(`volley auth: "${n}" already exists; use rotate for a new password\n`);
          return EXIT.ERROR;
        }
        const r = flags.role as Role;
        return createAccount(
          ctx,
          link,
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
        const password = ctx.deps.generatePassword();
        // setClientPassword disconnects the account's sessions (they sign in again).
        const [r] = await link.session.run([cmd.setClientPassword(account.name, password)]);
        if (r === undefined || classify(r) !== "ok") {
          throw new DynsecError(`setClientPassword ${account.name}: ${r?.error ?? "no answer"}`);
        }
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
        const [r] = await link.session.run([cmd.deleteClient(n)]);
        if (r === undefined || !["ok", "missing"].includes(classify(r))) {
          throw new DynsecError(`deleteClient ${n}: ${r?.error ?? "no answer"}`);
        }
        writeJson(
          accountsFile(ctx.dir),
          "accounts",
          accounts.filter((a) => a.name !== n),
        );
        return EXIT.OK;
      }
      case "list":
        return listAccounts(ctx, flags.json);
      case "token":
        return issueToken(ctx, link, now, "admin", "admin", ttl as number, undefined, flags.json, {
          ...deskOf(ctx),
          ...(flags.deskUrl !== undefined ? { url: flags.deskUrl } : {}),
          ...(flags.deskHost !== undefined ? { host: flags.deskHost } : {}),
        });
      case "signin-link":
        return issueToken(
          ctx,
          link,
          now,
          "signin",
          flags.role as Role,
          ttl as number,
          flags.label,
          flags.json,
          deskOf(ctx),
        );
      case "redeem":
        return redeem(ctx, link, now, flags.label as string, flags.json);
    }
  });
}

function listAccounts(ctx: AuthContext, json: boolean): ExitCode {
  const { io } = ctx;
  const accounts = readAccounts(ctx.dir);
  if (json) {
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
