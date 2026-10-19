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
 * **Setup ops.** The wizard mirrors `volley setup`'s five steps (broker →
 * security → accounts → services → phone): `setup_plan` returns each step's
 * plan as the terminal prints it (what it found, the changes it would make,
 * blocked / skipped), `setup_apply { step, lan? }` applies one step and
 * returns its report, with the one-time admin token, if the step issued one,
 * sealed. They are admin ops, so they travel the account-op topic. A volleyd
 * that does not run setup answers `unknown op` (`isUnknownOp`), and the
 * wizard points at `volley setup` in a terminal instead.
 */
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
 * it (a redeemed token, or an `account_list` volleyd answered). Admin-only
 * sections key off it; volleyd checks the role again on every op.
 */
export function readSessionRole(storage: Pick<Storage, "getItem"> | null = local()): string | null {
  try {
    const role = (
      JSON.parse(storage?.getItem(CREDENTIALS_STORAGE_KEY) ?? "null") as {
        role?: unknown;
      } | null
    )?.role;
    return typeof role === "string" ? role : null;
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
    // Only the public half is ever exported.
    true,
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
): Record<string, unknown> | null {
  // Only volleyd may answer (SPEC §4.4); the ACL lets no one else write the answer topics.
  if (env?.agent_id !== DAEMON_AGENT_ID || env.type !== "ack") return null;
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

/**
 * A fresh correlation id (32 hex digits, within the reply topic's `[A-Za-z0-9_-]{8,64}`).
 * `crypto.randomUUID` exists only in a secure context, which a phone on plain http is not;
 * `getRandomValues` exists on every page.
 */
export function newCorrelationId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------- token redemption

export type RedeemResult =
  | { ok: true; username: string; password: string; role: string; label: string }
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
    const correlationId = (req.newId ?? newCorrelationId)();
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
      role: typeof role === "string" ? role : parsed.kind === "admin" ? "admin" : "steer",
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

export interface AuthOps {
  /** The admin's username: the request topic and the envelopes' sender. */
  identity: string;
  request(
    op: string,
    fields?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<AuthAnswer>;
}

/** volleyd refused the op as one it does not know (an older volleyd: setup ops, `admin_token`). */
export const isUnknownOp = (a: AuthAnswer) => !a.ok && /^unknown op\b/.test(a.error ?? "");

export function createAuthOps(
  client: SteerClient,
  opts: {
    identity: string;
    timeoutMs?: number;
    newId?: () => string;
    now?: () => Date;
    replyKey?: () => Promise<ReplyKey>;
  },
): AuthOps {
  const timeout = opts.timeoutMs ?? AUTH_TIMEOUT_MS;
  const newId = opts.newId ?? newCorrelationId;
  const now = opts.now ?? (() => new Date());
  // One key pair per session, made on first use; its private half never leaves this object.
  let key: Promise<ReplyKey> | null = null;
  const replyKey = () => {
    key ??= (opts.replyKey ?? newReplyKey)();
    return key;
  };

  return {
    identity: opts.identity,
    async request(op, fields = {}, { timeoutMs = timeout } = {}) {
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
          const timer = setTimeout(
            () =>
              done({
                failed: {
                  ok: false,
                  error: `volleyd did not answer within ${timeoutMs / 1000}s`,
                  unanswered: true,
                },
              }),
            timeoutMs,
          );
          function done(r: { answer: Record<string, unknown> } | { failed: AuthAnswer }) {
            clearTimeout(timer);
            off();
            resolve(r);
          }
          // Listen before publishing so a fast answer is not missed.
          off = client.onMessage((m) => {
            if (m.topic !== replies) return;
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
      const p = got.answer;
      const answer: AuthAnswer = {
        ok: p.ok === true,
        ...(typeof p.error === "string" ? { error: p.error } : {}),
        ...(p.result !== undefined ? { result: p.result } : {}),
      };
      if (answer.ok && typeof p.sealed === "string") {
        try {
          answer.secret = await k.open(p.sealed);
        } catch {
          return {
            ok: false,
            error: "volleyd's answer could not be opened with this browser's key",
          };
        }
      }
      return answer;
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

/** One step's plan, as `volley setup` prints it before asking. */
export interface SetupStepPlan {
  step: SetupStepName;
  title: string;
  /** What the step found (always shown). */
  found: string[];
  /** What applying it changes; empty when it is already done. */
  changes: { summary: string; detail?: string }[];
  /** Why this step (and every later one) cannot run now. */
  blocked?: string;
  /** Why this step is left out (the later ones still run). */
  skipped?: string;
}

export interface SetupPlan {
  steps: SetupStepPlan[];
  /** When setup last ran (its log's newest entry). */
  last_setup?: string;
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** `setup_plan`'s result, the steps in setup's order; `null` when it is not one. */
export function parseSetupPlan(result: unknown): SetupPlan | null {
  const r = result as { steps?: unknown; last_setup?: unknown } | undefined;
  if (!Array.isArray(r?.steps)) return null;
  const steps: SetupStepPlan[] = [];
  for (const raw of r.steps as Record<string, unknown>[]) {
    if (!(SETUP_STEPS as readonly unknown[]).includes(raw?.step)) continue;
    const changes = Array.isArray(raw.changes)
      ? (raw.changes as Record<string, unknown>[])
          .filter((c) => typeof c?.summary === "string")
          .map((c) => ({
            summary: c.summary as string,
            ...(typeof c.detail === "string" && c.detail !== "" ? { detail: c.detail } : {}),
          }))
      : [];
    steps.push({
      step: raw.step as SetupStepName,
      title: typeof raw.title === "string" ? raw.title : String(raw.step),
      found: strings(raw.found),
      changes,
      ...(typeof raw.blocked === "string" ? { blocked: raw.blocked } : {}),
      ...(typeof raw.skipped === "string" ? { skipped: raw.skipped } : {}),
    });
  }
  steps.sort((a, b) => SETUP_STEPS.indexOf(a.step) - SETUP_STEPS.indexOf(b.step));
  return {
    steps,
    ...(typeof r.last_setup === "string" ? { last_setup: r.last_setup } : {}),
  };
}

/** `setup_apply`'s report for one step. */
export interface SetupApplied {
  /** What each change reported. */
  lines: string[];
  /** Checks that failed after the changes. */
  problems: string[];
  /** The one-time admin token the step issued (the accounts step), opened from `sealed`. */
  token?: string;
}

export function parseSetupApplied(a: AuthAnswer): SetupApplied {
  const r = a.result as { lines?: unknown; problems?: unknown } | undefined;
  const token = a.secret?.token;
  return {
    lines: strings(r?.lines),
    problems: strings(r?.problems),
    ...(typeof token === "string" ? { token } : {}),
  };
}

/** The phone step's label (O3's `PHONE_LABEL`): the account a phone link mints is bound to it. */
export const PHONE_LABEL = "Desk on phone";
