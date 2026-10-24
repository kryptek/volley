/**
 * The Desk's side of volleyd's account and token ops (SPEC §4.6.10), and the
 * setup ops the Settings › Setup & Security wizard drives.
 *
 * **Account ops** (`account_list`, `account_create`, `account_rotate`,
 * `account_revoke`, `signin_link`, and the setup ops below) are not mailbox
 * ops: anyone who may steer can write volleyd's mailbox, so the mailbox cannot
 * say who sent a request. An admin publishes `{ op, ..., reply_key }` in an
 * envelope with `channel: "_system/auth"`, `type: "query"` and a fresh
 * `correlation_id` on `volley/_system/auth/ops/<its username>` (the broker
 * grants that topic only to admin accounts, for their own username), and
 * volleyd answers on `volley/_system/auth/replies/<correlation_id>`. Every
 * account may read the answers, so a secret in one (a password, a sign-in
 * token) is only in `sealed`: RSA-OAEP (SHA-256) ciphertext for `reply_key`,
 * the public half of a key pair this browser made and never shares
 * (`newReplyKey`). `createAuthOps` sends a request and opens the answer.
 *
 * **Token redemption.** A one-time token (`vly_admin_<id>_<secret>` from
 * `volley auth token`, `vly_signin_<id>_<secret>` from a sign-in link,
 * `<desk>#signin=<token>`) is also the password of a short-lived broker login
 * named `<id>`, which may only write `volley-auth/redeem/<id>` and read its
 * `/reply`. `redeemToken` connects as that login, publishes `token_redeem`
 * and returns the account volleyd minted for this browser.
 *
 * **Setup ops** (SPEC §4.6.10, `setup-result.schema.json`). The wizard
 * mirrors `volley setup`'s five steps (detect → security → accounts →
 * services → phone), and volleyd runs setup's own planners for it. They are
 * admin ops, so they travel the account-op topic:
 * - `setup_plan { lan?, repair? }` plans every step fresh: what it found, the
 *   changes it would make (a change only a terminal can make carries
 *   `terminal: { reason, command }`), blocked / skipped, and a `plan_id` per
 *   step. `lan` feeds the security plan the way `--lan` / `--no-lan` do, and
 *   the security step reports the choice it planned for (`lan: { planned,
 *   current }`), so the diff the Desk shows is the one it applies; `repair` is
 *   `--repair` (no new admin token, no phone link). `broker` carries the
 *   detect step's probes as data (`accounts_required`, `listeners`).
 * - `setup_apply { step, plan_id, lan?, repair? }` applies exactly the plan the
 *   person saw: volleyd plans the step again and refuses with `plan changed`
 *   when its `plan_id` differs, so the Desk shows the new plan instead. Its
 *   report is `{ lines, problems, terminal?, restarting? }`; the one-time admin
 *   token the accounts step issues over the Desk is only in `sealed: { token }`.
 *   Applying can take a minute (the Desk build, `volley auth`), hence
 *   `SETUP_APPLY_TIMEOUT_MS`. A broker restart drops this browser's connection
 *   too, and an answer published while it reconnects is lost (QoS 1, not
 *   retained): the wizard keeps listening after the timeout (`onLate`), and
 *   re-plans once it is back rather than assuming the step failed.
 * - `admin_token` issues a one-time admin token: `{ token_id, expires_at }`,
 *   the token sealed (a volleyd that prints it in its terminal instead answers
 *   without `sealed`).
 * - `desk_password` gives the shared `desk` login (which no file keeps) a new
 *   password: `{ username: "desk" }`, the password sealed (`{ username,
 *   password }`), shown once.
 * A volleyd that does not run setup answers `unknown op` (`isUnknownOp`), and
 * the wizard points at `volley setup` in a terminal instead.
 */
import { newId as defaultNewId } from "../lib/id";
import { generateRsaKey, oaepDecrypt, publicJwk } from "../lib/rsa";
import type { SteerClient } from "../steer/transport";
import { CREDENTIALS_STORAGE_KEY } from "./context";
import {
  AuthFailedError,
  type BrokerCredentials,
  type TokenClient,
  createTokenClient,
} from "./mqtt-client";
import type { Envelope } from "./types";

export const DAEMON_AGENT_ID = "volleyd";
export const AUTH_CHANNEL = "_system/auth";
export const AUTH_TIMEOUT_MS = 10_000;
/** A redemption runs `volley auth redeem` (a broker round trip or two) before it answers. */
export const REDEEM_TIMEOUT_MS = 20_000;
/** `setup_apply` runs a step's changes (a broker restart, `volley auth`, the Desk build) before it answers. */
export const SETUP_APPLY_TIMEOUT_MS = 120_000;
/** How long a request that timed out still listens for its answer (`onLate`). */
export const LATE_ANSWER_MS = 10 * 60_000;

export const authOpsTopic = (username: string) => `volley/_system/auth/ops/${username}`;
export const authReplyTopic = (correlationId: string) =>
  `volley/_system/auth/replies/${correlationId}`;
export const tokenRedeemTopic = (id: string) => `volley-auth/redeem/${id}`;
export const tokenReplyTopic = (id: string) => `volley-auth/redeem/${id}/reply`;

/** `auth-request.schema.json`'s token grammar. */
const TOKEN = /^vly_(admin|signin)_([0-9a-f]{8})_[0-9a-f]{32}$/;

/** A token's kind and id (its broker login's username); `null` when it is not a Volley token. */
export function parseToken(token: string): { kind: "admin" | "signin"; id: string } | null {
  const m = TOKEN.exec(token.trim());
  return m ? { kind: m[1] as "admin" | "signin", id: m[2] as string } : null;
}

/** The token a sign-in link carries in its fragment (`#signin=<token>`), or `null`. */
export function signinTokenFromHash(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("signin");
  return token !== null && token !== "" ? token : null;
}

/** The link a sign-in token travels in: `<link_base>#signin=<token>` (SPEC §4.6.10). */
export const signinLink = (linkBase: string, token: string) => `${linkBase}#signin=${token}`;

/** This page without its fragment: the `desk_url` a sign-in link opens. */
export function deskUrl(loc: Pick<Location, "origin" | "pathname" | "search">): string {
  return `${loc.origin}${loc.pathname}${loc.search}`;
}

/** The label a redeemed account is bound to: "Desk on <device>". */
export function deviceLabel(ua: string): string {
  const device = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  return device === null ? "Desk on this browser" : `Desk on ${device}`;
}

// ------------------------------------------------------------- session role

/**
 * What the stored sign-in may do: the account's role, kept next to the
 * credentials (`{ username, password, role?, label? }`) when the Desk learnt
 * it (a redeemed token, or an `account_list` volleyd answered). Only the role
 * of `identity`, the account actually in use: credentials from the build
 * (`VITE_VOLLEY_BROKER_*`) win over a stored sign-in, whose role is then not
 * this session's. Admin-only sections key off it; volleyd checks the role
 * again on every op.
 */
export function readSessionRole(
  identity: string | null,
  storage: Pick<Storage, "getItem"> | null = local(),
): string | null {
  if (identity === null) return null;
  try {
    const c = JSON.parse(storage?.getItem(CREDENTIALS_STORAGE_KEY) ?? "null") as {
      username?: unknown;
      role?: unknown;
    } | null;
    return c?.username === identity && typeof c.role === "string" ? c.role : null;
  } catch {
    return null;
  }
}

/** Record `role` on the stored sign-in of `username` (nothing when another one is stored). */
export function rememberRole(
  username: string,
  role: string,
  storage: Pick<Storage, "getItem" | "setItem"> | null = local(),
): void {
  try {
    const c = JSON.parse(storage?.getItem(CREDENTIALS_STORAGE_KEY) ?? "null") as Record<
      string,
      unknown
    > | null;
    if (c?.username !== username || c.role === role) return;
    storage?.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify({ ...c, role }));
  } catch {
    // Storage blocked: the role is asked again next time.
  }
}

const FIRST_RUN_KEY = "volley-desk:first-run";

/** An admin token was just redeemed: the Desk opens Settings › Setup & Security once. */
export function markFirstRun(storage: Pick<Storage, "setItem"> | null = session()): void {
  try {
    storage?.setItem(FIRST_RUN_KEY, "setup");
  } catch {
    // Storage blocked: setup stays one click away in Settings.
  }
}

/** Whether to open setup now; true once per `markFirstRun`. */
export function takeFirstRun(
  storage: Pick<Storage, "getItem" | "removeItem"> | null = session(),
): boolean {
  try {
    if (storage?.getItem(FIRST_RUN_KEY) !== "setup") return false;
    storage.removeItem(FIRST_RUN_KEY);
    return true;
  } catch {
    return false;
  }
}

function local(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- reply key

/** A key pair for one browser session: the public JWK goes out as `reply_key`. */
export interface ReplyKey {
  jwk: JsonWebKey;
  /** Decrypt a `sealed` answer (base64url RSA-OAEP ciphertext of a JSON object). */
  open(sealed: string): Promise<Record<string, unknown>>;
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * An RSA-OAEP key pair, 2048 bits, SHA-256: what volleyd seals to
 * (`reply_key_min_bits`). WebCrypto when the page has it; a phone on plain
 * http (an insecure context, where `crypto.subtle` is missing) gets the same
 * key made by `lib/rsa.ts` instead.
 */
export async function newReplyKey(
  subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<ReplyKey> {
  if (subtle === undefined) return fallbackReplyKey();
  const pair = await subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    // The private half stays inside WebCrypto; a public key is always exportable.
    false,
    ["encrypt", "decrypt"],
  );
  const pub = await subtle.exportKey("jwk", pair.publicKey);
  // The public members only (never `d`, `p`, `q`, …), whatever the browser adds.
  const jwk: JsonWebKey = { alg: "RSA-OAEP-256", ext: true };
  for (const k of ["kty", "n", "e"] as const) {
    const v = pub[k];
    if (v !== undefined) jwk[k] = v;
  }
  return {
    jwk,
    async open(sealed) {
      const plain = await subtle.decrypt(
        { name: "RSA-OAEP" },
        pair.privateKey,
        fromBase64url(sealed),
      );
      return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    },
  };
}

async function fallbackReplyKey(): Promise<ReplyKey> {
  // Let the busy state paint first: making the primes takes a moment on a phone.
  await new Promise((r) => setTimeout(r, 0));
  const key = generateRsaKey(2048);
  return {
    jwk: publicJwk(key),
    async open(sealed) {
      const plain = oaepDecrypt(key, fromBase64url(sealed));
      return JSON.parse(new TextDecoder().decode(plain)) as Record<string, unknown>;
    },
  };
}

function authEnvelope(r: {
  agentId: string;
  correlationId: string;
  payload: Record<string, unknown>;
  now: Date;
}): Envelope {
  return {
    schema_version: "0.1",
    agent_id: r.agentId,
    parent_id: null,
    channel: AUTH_CHANNEL,
    type: "query",
    wall_time: r.now.toISOString(),
    correlation_id: r.correlationId,
    payload: r.payload,
  };
}

/** volleyd's answer, when `env` is its ack for `correlationId`. */
function answerOf(
  env: Partial<Envelope> | null,
  correlationId: string,
  type: "ack" | "progress" = "ack",
): Record<string, unknown> | null {
  // Only volleyd may answer (SPEC §4.4); the ACL lets no one else write the answer topics.
  if (env?.agent_id !== DAEMON_AGENT_ID || env.type !== type) return null;
  if (env.correlation_id !== correlationId) return null;
  const p = env.payload;
  return typeof p === "object" && p !== null ? (p as Record<string, unknown>) : null;
}

function parseJson(text: string): Partial<Envelope> | null {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null ? (v as Partial<Envelope>) : null;
  } catch {
    return null;
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------- token redemption

export type RedeemResult =
  /** `role` is null when volleyd's answer did not say (a sign-in link may grant `steer` or `watch`). */
  | { ok: true; username: string; password: string; role: string | null; label: string }
  | { ok: false; error: string };

export interface RedeemRequest {
  /** The broker the Desk signs in to (its WebSocket listener). */
  url: string;
  token: string;
  /** The redeemed account's label ("Desk on iPhone"). */
  label: string;
}

/** Redeem a one-time token over its own login; see the header. Never rejects. */
export async function redeemToken(req: Parameters<typeof redeemOnce>[0]): Promise<RedeemResult> {
  try {
    return await redeemOnce(req);
  } catch (err) {
    return { ok: false, error: `the sign-in could not finish in this browser (${message(err)})` };
  }
}

async function redeemOnce(
  req: RedeemRequest & {
    connect?: (url: string, auth: BrokerCredentials) => TokenClient;
    timeoutMs?: number;
    newId?: () => string;
    now?: () => Date;
    replyKey?: () => Promise<ReplyKey>;
  },
): Promise<RedeemResult> {
  const parsed = parseToken(req.token);
  if (parsed === null)
    return { ok: false, error: "the link does not carry a Volley sign-in token" };
  const timeoutMs = req.timeoutMs ?? REDEEM_TIMEOUT_MS;
  const key = await (req.replyKey ?? newReplyKey)();
  const client = (req.connect ?? createTokenClient)(req.url, {
    username: parsed.id,
    password: req.token.trim(),
  });
  try {
    try {
      await client.connect();
    } catch (err) {
      return {
        ok: false,
        error:
          err instanceof AuthFailedError
            ? "the broker refused this link: it was used already or it has expired"
            : `could not reach the broker at ${req.url} (${message(err)})`,
      };
    }
    const correlationId = (req.newId ?? defaultNewId)();
    const replies = tokenReplyTopic(parsed.id);
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<Record<string, unknown> | null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      off = client.onMessage((topic, text) => {
        if (topic !== replies) return;
        const p = answerOf(parseJson(text), correlationId);
        if (p !== null) resolve(p);
      });
    });
    try {
      // Subscribe before publishing so a fast answer is not missed.
      await client.subscribe(replies);
      await client.publish(
        tokenRedeemTopic(parsed.id),
        JSON.stringify(
          authEnvelope({
            agentId: parsed.id,
            correlationId,
            payload: {
              op: "token_redeem",
              token: req.token.trim(),
              label: req.label,
              reply_key: key.jwk,
            },
            now: (req.now ?? (() => new Date()))(),
          }),
        ),
      );
    } catch (err) {
      clearTimeout(timer);
      off();
      return { ok: false, error: `could not send the sign-in request (${message(err)})` };
    }
    const p = await answer;
    clearTimeout(timer);
    off();
    if (p === null) {
      return {
        ok: false,
        error: `volleyd did not answer within ${timeoutMs / 1000}s: is the supervisor running?`,
      };
    }
    if (p.ok !== true) {
      return {
        ok: false,
        error: typeof p.error === "string" ? p.error : "volleyd refused the link",
      };
    }
    let secret: Record<string, unknown>;
    try {
      secret = await key.open(String(p.sealed ?? ""));
    } catch {
      return { ok: false, error: "volleyd's answer could not be opened with this browser's key" };
    }
    if (typeof secret.username !== "string" || typeof secret.password !== "string") {
      return { ok: false, error: "volleyd's answer carried no login" };
    }
    const role = (p.result as { role?: unknown } | undefined)?.role;
    return {
      ok: true,
      username: secret.username,
      password: secret.password,
      role: typeof role === "string" ? role : parsed.kind === "admin" ? "admin" : null,
      label: req.label,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

// ---------------------------------------------------------------- account ops

/** An answer to an account op, with its sealed secret opened. */
export interface AuthAnswer {
  ok: boolean;
  error?: string;
  result?: unknown;
  /** The decrypted `sealed` field (`{ username, password }`, `{ token }`). */
  secret?: Record<string, unknown>;
  /** No answer in time: volleyd may still have acted. */
  unanswered?: true;
  /** The request never reached the broker. */
  unsent?: true;
}

export interface AuthRequestOptions {
  timeoutMs?: number;
  /**
   * Called with the answer if it arrives after the timeout (up to `LATE_ANSWER_MS`): a step
   * that took longer, or an answer held up by a broker restart. Its sealed secret is opened
   * as usual, so a single-use token is never dropped.
   */
  onLate?: (answer: AuthAnswer) => void;
  /**
   * Called with each `progress` envelope volleyd publishes for this request before its answer
   * (a long op's rows: `machine_add`).
   */
  onProgress?: (payload: Record<string, unknown>) => void;
}

export interface AuthOps {
  /** The admin's username: the request topic and the envelopes' sender. */
  identity: string;
  request(
    op: string,
    fields?: Record<string, unknown>,
    opts?: AuthRequestOptions,
  ): Promise<AuthAnswer>;
}

/** volleyd refused the op as one it does not know (an older volleyd: setup ops, `admin_token`). */
export const isUnknownOp = (a: AuthAnswer) => !a.ok && /^unknown op\b/.test(a.error ?? "");

/** volleyd refused `setup_apply` because the step's plan is no longer the one shown. */
export const isPlanChanged = (a: AuthAnswer) => !a.ok && /^plan changed\b/.test(a.error ?? "");

export function createAuthOps(
  client: SteerClient,
  opts: {
    identity: string;
    timeoutMs?: number;
    lateMs?: number;
    newId?: () => string;
    now?: () => Date;
    replyKey?: () => Promise<ReplyKey>;
  },
): AuthOps {
  const timeout = opts.timeoutMs ?? AUTH_TIMEOUT_MS;
  const lateMs = opts.lateMs ?? LATE_ANSWER_MS;
  const newId = opts.newId ?? defaultNewId;
  const now = opts.now ?? (() => new Date());
  // One key pair per session, made on first use; its private half never leaves this object.
  let key: Promise<ReplyKey> | null = null;
  const replyKey = () => {
    key ??= (opts.replyKey ?? newReplyKey)();
    return key;
  };

  /** volleyd's answer payload as an `AuthAnswer`, its sealed secret opened with `k`. */
  const toAnswer = async (p: Record<string, unknown>, k: ReplyKey): Promise<AuthAnswer> => {
    const answer: AuthAnswer = {
      ok: p.ok === true,
      ...(typeof p.error === "string" ? { error: p.error } : {}),
      ...(p.result !== undefined ? { result: p.result } : {}),
    };
    if (answer.ok && typeof p.sealed === "string") {
      try {
        answer.secret = await k.open(p.sealed);
      } catch {
        return { ok: false, error: "volleyd's answer could not be opened with this browser's key" };
      }
    }
    return answer;
  };

  return {
    identity: opts.identity,
    async request(op, fields = {}, { timeoutMs = timeout, onLate, onProgress } = {}) {
      let k: ReplyKey;
      try {
        k = await replyKey();
      } catch (err) {
        key = null;
        return {
          ok: false,
          error: `this browser could not make its reply key (${message(err)})`,
          unsent: true,
        };
      }
      const correlationId = newId();
      const replies = authReplyTopic(correlationId);
      // Either volleyd's answer payload or the failure that stands in for it.
      const got = await new Promise<{ answer: Record<string, unknown> } | { failed: AuthAnswer }>(
        (resolve) => {
          let off = () => {};
          let settled = false;
          let late: ReturnType<typeof setTimeout> | undefined;
          const timer = setTimeout(() => {
            settled = true;
            resolve({
              failed: {
                ok: false,
                error: `volleyd did not answer within ${timeoutMs / 1000}s`,
                unanswered: true,
              },
            });
            // Keep listening for a late answer only when someone will take it.
            if (onLate === undefined) off();
            else late = setTimeout(() => off(), lateMs);
          }, timeoutMs);
          function done(r: { answer: Record<string, unknown> } | { failed: AuthAnswer }) {
            clearTimeout(timer);
            clearTimeout(late);
            off();
            if (!settled) {
              settled = true;
              resolve(r);
            } else if ("answer" in r && onLate !== undefined) {
              void toAnswer(r.answer, k).then(onLate);
            }
          }
          // Listen before publishing so a fast answer is not missed.
          off = client.onMessage((m) => {
            if (m.topic !== replies) return;
            if (!settled && onProgress !== undefined) {
              const row = answerOf(m.envelope, correlationId, "progress");
              if (row !== null) {
                onProgress(row);
                return;
              }
            }
            const p = answerOf(m.envelope, correlationId);
            if (p !== null) done({ answer: p });
          });
          const env = authEnvelope({
            agentId: opts.identity,
            correlationId,
            payload: { op, ...fields, reply_key: k.jwk },
            now: now(),
          });
          client
            .publish(authOpsTopic(opts.identity), JSON.stringify(env))
            .catch((err: unknown) =>
              done({ failed: { ok: false, error: message(err), unsent: true } }),
            );
        },
      );
      if ("failed" in got) return got.failed;
      return toAnswer(got.answer, k);
    },
  };
}

/** One registry account, as `account_list` returns it. */
export interface BrokerAccount {
  name: string;
  role: string;
  kind: string;
  created: string;
  label?: string;
  last_seen?: string;
}

export function parseAccounts(result: unknown): BrokerAccount[] | null {
  const list = (result as { accounts?: unknown } | undefined)?.accounts;
  if (!Array.isArray(list)) return null;
  return list.filter(
    (a): a is BrokerAccount =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as BrokerAccount).name === "string" &&
      typeof (a as BrokerAccount).role === "string",
  );
}

// ----------------------------------------------------------------- setup ops

/** `volley setup`'s five steps, in order (O3). */
export const SETUP_STEPS = ["detect", "security", "accounts", "services", "phone"] as const;
export type SetupStepName = (typeof SETUP_STEPS)[number];

/** A change volleyd will not make for the Desk, and the terminal command that makes it. */
export interface TerminalOnly {
  reason: string;
  command: string;
}

export interface SetupChange {
  summary: string;
  detail?: string;
  /** Only a terminal can make it (it needs `sudo`, or it would stop volleyd itself). */
  terminal?: TerminalOnly;
}

/** One step's plan, as `volley setup` prints it before asking. */
export interface SetupStepPlan {
  step: SetupStepName;
  title: string;
  /** What the step found (always shown). */
  found: string[];
  /** What volleyd notes but cannot check itself (the keychain): neither a check nor a change. */
  notes?: string[];
  /** What applying it changes; empty when it is already done. */
  changes: SetupChange[];
  /** Why this step (and every later one) cannot run now. */
  blocked?: string;
  /** Why this step is left out (the later ones still run). */
  skipped?: string;
  /** Names this plan; `setup_apply` sends it back so volleyd applies exactly this plan. */
  plan_id?: string;
  /**
   * The security step's LAN reach: the choice this plan was made for (`planned`) and what
   * the broker config has now (`current`, null when it is not Volley's config). Absent when
   * the layout leaves no choice (a container binds every interface).
   */
  lan?: { planned: boolean; current: boolean | null };
}

export type AnonymousProbe = "refused" | "accepted" | "unreachable";

export interface SetupPlan {
  steps: SetupStepPlan[];
  /** When setup last ran (its log's newest entry). */
  last_setup?: string;
  /** The detect step's probes, as data: whether only accounts can connect, and each listener. */
  broker?: {
    accounts_required: boolean;
    listeners: { port: number; anonymous: AnonymousProbe }[];
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const PROBES: readonly unknown[] = ["refused", "accepted", "unreachable"];

function parseTerminal(v: unknown): TerminalOnly | undefined {
  const t = v as { reason?: unknown; command?: unknown } | undefined;
  return typeof t?.reason === "string" && typeof t.command === "string"
    ? { reason: t.reason, command: t.command }
    : undefined;
}

function parseBroker(v: unknown): SetupPlan["broker"] | undefined {
  const b = v as { accounts_required?: unknown; listeners?: unknown } | undefined;
  if (typeof b?.accounts_required !== "boolean" || !Array.isArray(b.listeners)) return undefined;
  return {
    accounts_required: b.accounts_required,
    listeners: (b.listeners as { port?: unknown; anonymous?: unknown }[])
      .filter((l) => typeof l?.port === "number" && PROBES.includes(l.anonymous))
      .map((l) => ({ port: l.port as number, anonymous: l.anonymous as AnonymousProbe })),
  };
}

/** `setup_plan`'s result, the steps in setup's order; `null` when it is not one. */
export function parseSetupPlan(result: unknown): SetupPlan | null {
  const r = result as { steps?: unknown; last_setup?: unknown; broker?: unknown } | undefined;
  if (!Array.isArray(r?.steps)) return null;
  const steps: SetupStepPlan[] = [];
  for (const raw of r.steps as Record<string, unknown>[]) {
    if (!(SETUP_STEPS as readonly unknown[]).includes(raw?.step)) continue;
    const changes = Array.isArray(raw.changes)
      ? (raw.changes as Record<string, unknown>[])
          .filter((c) => typeof c?.summary === "string")
          .map((c) => {
            const terminal = parseTerminal(c.terminal);
            return {
              summary: c.summary as string,
              ...(typeof c.detail === "string" && c.detail !== "" ? { detail: c.detail } : {}),
              ...(terminal !== undefined ? { terminal } : {}),
            };
          })
      : [];
    const lan = raw.lan as { planned?: unknown; current?: unknown } | undefined;
    const notes = strings(raw.notes).filter((n) => n !== "");
    steps.push({
      step: raw.step as SetupStepName,
      title: typeof raw.title === "string" ? raw.title : String(raw.step),
      found: strings(raw.found),
      ...(notes.length > 0 ? { notes } : {}),
      changes,
      ...(typeof raw.blocked === "string" ? { blocked: raw.blocked } : {}),
      ...(typeof raw.skipped === "string" ? { skipped: raw.skipped } : {}),
      ...(typeof raw.plan_id === "string" ? { plan_id: raw.plan_id } : {}),
      ...(typeof lan?.planned === "boolean"
        ? {
            lan: {
              planned: lan.planned,
              current: typeof lan.current === "boolean" ? lan.current : null,
            },
          }
        : {}),
    });
  }
  steps.sort((a, b) => SETUP_STEPS.indexOf(a.step) - SETUP_STEPS.indexOf(b.step));
  const broker = parseBroker(r.broker);
  return {
    steps,
    ...(typeof r.last_setup === "string" ? { last_setup: r.last_setup } : {}),
    ...(broker !== undefined ? { broker } : {}),
  };
}

/** `setup_apply`'s report for one step. */
export interface SetupApplied {
  /** What each change reported. */
  lines: string[];
  /** Checks that failed after the changes. */
  problems: string[];
  /** The changes volleyd left for a terminal, with the command for each. */
  terminal: (TerminalOnly & { summary: string })[];
  /** The broker restarts after this answer: the Desk reconnects, then re-plans. */
  restarting: boolean;
  /** The one-time admin token the step issued (the accounts step), opened from `sealed`. */
  token?: string;
}

export function parseSetupApplied(a: AuthAnswer): SetupApplied {
  const r = a.result as
    | { lines?: unknown; problems?: unknown; terminal?: unknown; restarting?: unknown }
    | undefined;
  const token = a.secret?.token;
  const terminal = Array.isArray(r?.terminal)
    ? (r.terminal as { summary?: unknown }[]).flatMap((t) => {
        const only = parseTerminal(t);
        return only !== undefined && typeof t.summary === "string"
          ? [{ summary: t.summary, ...only }]
          : [];
      })
    : [];
  return {
    lines: strings(r?.lines),
    problems: strings(r?.problems),
    terminal,
    restarting: r?.restarting === true,
    ...(typeof token === "string" ? { token } : {}),
  };
}

/**
 * Whether the broker refuses anonymous clients: `broker.accounts_required` when volleyd sent
 * it, else every listener the detect step probed refuses them; `null` when it cannot tell.
 */
export function accountsRequired(plan: SetupPlan): boolean | null {
  if (plan.broker !== undefined) return plan.broker.accounts_required;
  const probes = listenerProbes(plan);
  return probes.length === 0 ? null : probes.every((l) => l.anonymous === "refused");
}

/** Each listener and what it does with an anonymous client (`broker`, else the detect step's lines). */
export function listenerProbes(plan: SetupPlan): { port: number; anonymous: AnonymousProbe }[] {
  if (plan.broker !== undefined) return plan.broker.listeners;
  const found = plan.steps.find((s) => s.step === "detect")?.found ?? [];
  return found.flatMap((f): { port: number; anonymous: AnonymousProbe }[] => {
    const m =
      /^Listener (\d+): (refuses|accepts) anonymous clients$|^Listener (\d+): not listening$/.exec(
        f,
      );
    if (m === null) return [];
    return m[1] !== undefined
      ? [{ port: Number(m[1]), anonymous: m[2] === "refuses" ? "refused" : "accepted" }]
      : [{ port: Number(m[3]), anonymous: "unreachable" }];
  });
}

/** The phone step's label (O3's `PHONE_LABEL`): the account a phone link mints is bound to it. */
export const PHONE_LABEL = "Desk on phone";
