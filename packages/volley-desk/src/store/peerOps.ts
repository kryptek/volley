/**
 * The Desk's machine-pairing ops (SPEC §4.6.14). `peer_invite` and
 * `peer_remove` create and revoke broker access, so they are admin ops: like
 * every account op (§4.6.10) they go to the Desk's own
 * `volley/_system/auth/ops/<identity>` (QoS 1, not retained) as a `query` on
 * channel `_system/auth` with a fresh `correlation_id`, never to volleyd's
 * mailbox, and volleyd answers on `volley/_system/auth/replies/<correlation_id>`
 * with an `ack` that is accepted only from `volleyd`.
 *
 * The broker grants an account-op topic only to an admin account, for its own
 * username, so a non-admin's request is dropped and nothing ever answers it.
 * `admin()` first uses what is already known: a role from sign-in, or one of
 * the fixed identities, which are never admins (§4.6.13). Otherwise it asks
 * the read-only `account_list` with a short wait and counts an answer as
 * proof and a refusal as a no; both are kept. No answer (volleyd down, or a
 * non-admin's dropped publish) is neither, and is not kept: the next ask asks
 * again.
 *
 * Every account may read the answer topics, so the pairing code comes back
 * sealed: the request carries `reply_key`, the public half of a fresh
 * RSA-OAEP (SHA-256, 2048-bit) key made in this browser with WebCrypto, and
 * only this page holds the private half that opens `sealed`. WebCrypto exists
 * only in a secure context (https or localhost): on a plain-http page the
 * Desk cannot pair (`pairingSupported()`), and nothing here throws.
 */
import type { SteerClient } from "../steer/transport";
import type { Envelope } from "./types";

/** volleyd's agent id: the only sender whose answer counts. */
const DAEMON = "volleyd";
/** The wait `volley peer invite` / `remove` use too: volleyd checks the account registry first. */
export const AUTH_OP_TIMEOUT_MS = 30_000;
/** The admin probe's wait: `account_list` is answered from a local file. */
export const ADMIN_PROBE_TIMEOUT_MS = 5000;
/** The identities `volley auth init` creates: none of them holds `admin` (SPEC §4.6.13). */
export const FIXED_IDENTITIES: ReadonlySet<string> = new Set(["desk", "coordinator", "volleyd"]);
/** volleyd's `peer_code_ttl_s` default: how long a code lasts when an answer leaves it out. */
const CODE_TTL_S = 600;

export const authOpsTopic = (username: string) => `volley/_system/auth/ops/${username}`;
export const authReplyTopic = (correlationId: string) =>
  `volley/_system/auth/replies/${correlationId}`;

export interface PeerOpResult {
  ok: boolean;
  error?: string;
}

/** What `admin()` found: a definite yes or no, or volleyd did not answer. */
export type AdminStatus = "admin" | "not-admin" | "no-answer";

export type PeerInvite =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; error: string };

export interface PeerOps {
  /** The definite admin answer already known (sign-in role, fixed identity, a past answer), else `null`. */
  known(): Exclude<AdminStatus, "no-answer"> | null;
  /** Whether this Desk's identity is an admin; asks volleyd until it gets a definite answer. */
  admin(): Promise<AdminStatus>;
  /** A one-time pairing code (`peer_invite`). */
  invite(): Promise<PeerInvite>;
  /** Unpair `name` (`peer_remove`): revokes its account and clears its record. */
  remove(name: string): Promise<PeerOpResult>;
}

/** An account op's answer (an `ack` payload). */
interface Answer {
  ok: boolean;
  /** volleyd answered (an `ack`), as opposed to a timeout or an unsent request. */
  answered?: boolean;
  error?: string;
  result?: unknown;
  sealed?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A fresh UUID v4 (the envelope's `correlation_id` format) from
 * `crypto.getRandomValues`, which, unlike `crypto.randomUUID`, also exists on
 * a plain-http page.
 */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Whether this page can make a reply key: WebCrypto is there only in a secure context. */
export function pairingSupported(): boolean {
  return (
    globalThis.isSecureContext !== false &&
    typeof globalThis.crypto?.subtle?.generateKey === "function"
  );
}

/** A fresh reply key: the public JWK (just `kty`, `n`, `e`) and the private key that opens answers. */
async function replyKeyPair(): Promise<{ jwk: Record<string, unknown>; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const { kty, n, e } = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { jwk: { kty, n, e }, privateKey: pair.privateKey };
}

function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Open `sealed` with `key`; `null` when it is missing or not ours. */
async function unseal(
  key: CryptoKey,
  sealed: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (sealed === undefined) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, fromBase64url(sealed));
    const v = JSON.parse(new TextDecoder().decode(plain)) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The command the new machine runs; `to` is this machine's ssh destination (`…` until it is known). */
export function joinCommand(code: string, to: string): string {
  return `volley peer join ${code} --to ${to.trim() || "…"}`;
}

export function createPeerOps(
  client: SteerClient,
  opts: {
    identity: string;
    /** The role the Desk's sign-in minted, when it knows it: no probe then. */
    role?: string | null;
    timeoutMs?: number;
    probeTimeoutMs?: number;
    newId?: () => string;
    now?: () => Date;
  },
): PeerOps {
  const { identity } = opts;
  const timeoutMs = opts.timeoutMs ?? AUTH_OP_TIMEOUT_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? ADMIN_PROBE_TIMEOUT_MS;
  const makeId = opts.newId ?? newId;
  const now = opts.now ?? (() => new Date());
  let known: Exclude<AdminStatus, "no-answer"> | null =
    typeof opts.role === "string"
      ? opts.role === "admin"
        ? "admin"
        : "not-admin"
      : FIXED_IDENTITIES.has(identity)
        ? "not-admin"
        : null;
  let probe: Promise<AdminStatus> | null = null;

  const ask = (op: string, fields: Record<string, unknown>, waitMs = timeoutMs): Promise<Answer> =>
    new Promise<Answer>((resolve) => {
      let id: string;
      try {
        id = makeId();
      } catch (err) {
        resolve({ ok: false, error: message(err) });
        return;
      }
      const topic = authReplyTopic(id);
      let off = () => {};
      const timer = setTimeout(
        () => done({ ok: false, error: `volleyd did not answer within ${waitMs / 1000}s` }),
        waitMs,
      );
      function done(a: Answer) {
        clearTimeout(timer);
        off();
        resolve(a);
      }
      // Listen before publishing so a fast answer is not missed.
      off = client.onMessage((m) => {
        const env = m.envelope;
        if (
          m.topic !== topic ||
          env?.type !== "ack" ||
          env.agent_id !== DAEMON ||
          env.correlation_id !== id
        ) {
          return;
        }
        const p = (env.payload ?? {}) as Record<string, unknown>;
        done({
          ok: p.ok === true,
          answered: true,
          ...(typeof p.error === "string" ? { error: p.error } : {}),
          ...(p.result !== undefined ? { result: p.result } : {}),
          ...(typeof p.sealed === "string" ? { sealed: p.sealed } : {}),
        });
      });
      const req: Envelope = {
        schema_version: "0.1",
        agent_id: identity,
        parent_id: null,
        channel: "_system/auth",
        type: "query",
        wall_time: now().toISOString(),
        correlation_id: id,
        payload: { op, ...fields },
      };
      client
        .publish(authOpsTopic(identity), JSON.stringify(req))
        .catch((err: unknown) => done({ ok: false, error: message(err) }));
    });

  const refusal = (a: Answer, what: string) => a.error ?? `volleyd refused ${what}`;

  return {
    known: () => known,
    admin() {
      if (known) return Promise.resolve(known);
      probe ??= ask("account_list", {}, probeTimeoutMs).then((a) => {
        probe = null;
        // A refusal is an answer; a timeout or an unsent publish is not.
        if (a.ok) known = "admin";
        else if (a.answered) known = "not-admin";
        return known ?? "no-answer";
      });
      return probe;
    },
    async invite() {
      if (!pairingSupported()) {
        return {
          ok: false,
          error: "pairing from the Desk needs https or localhost; use volley peer invite",
        };
      }
      let key: Awaited<ReturnType<typeof replyKeyPair>>;
      try {
        key = await replyKeyPair();
      } catch (err) {
        return { ok: false, error: `this browser cannot make a reply key: ${message(err)}` };
      }
      const a = await ask("peer_invite", { reply_key: key.jwk });
      if (!a.ok) return { ok: false, error: refusal(a, "the pairing code") };
      const code = (await unseal(key.privateKey, a.sealed))?.code;
      if (typeof code !== "string") {
        return { ok: false, error: "volleyd's answer carried no pairing code" };
      }
      // Counted on this browser's clock from when the answer came: volleyd's may be minutes off.
      const r = (a.result ?? {}) as { expires_at?: unknown; ttl_s?: unknown };
      const local = (ttl: number) => new Date(now().getTime() + ttl * 1000).toISOString();
      return {
        ok: true,
        code,
        expiresAt:
          typeof r.ttl_s === "number"
            ? local(r.ttl_s)
            : typeof r.expires_at === "string"
              ? r.expires_at
              : local(CODE_TTL_S),
      };
    },
    async remove(name) {
      const a = await ask("peer_remove", { name });
      return a.ok ? { ok: true } : { ok: false, error: refusal(a, `removing ${name}`) };
    },
  };
}
