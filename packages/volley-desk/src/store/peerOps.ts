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
 * `admin()` therefore asks the read-only `account_list` once and counts an
 * answer as proof; no answer (or a refusal) means read-only.
 *
 * Every account may read the answer topics, so the pairing code comes back
 * sealed: the request carries `reply_key`, the public half of a fresh
 * RSA-OAEP (SHA-256, 2048-bit) key made in this browser with WebCrypto, and
 * only this page holds the private half that opens `sealed`.
 */
import type { SteerClient } from "../steer/transport";
import type { Envelope } from "./types";

/** volleyd's agent id: the only sender whose answer counts. */
const DAEMON = "volleyd";
/** The wait `volley peer invite` / `remove` use too: volleyd checks the account registry first. */
export const AUTH_OP_TIMEOUT_MS = 30_000;
/** volleyd's `peer_code_ttl_s` default: how long a code lasts when an answer leaves it out. */
const CODE_TTL_S = 600;

export const authOpsTopic = (username: string) => `volley/_system/auth/ops/${username}`;
export const authReplyTopic = (correlationId: string) =>
  `volley/_system/auth/replies/${correlationId}`;

export interface PeerOpResult {
  ok: boolean;
  error?: string;
}

export type PeerInvite =
  | { ok: true; code: string; expiresAt: string }
  | { ok: false; error: string };

export interface PeerOps {
  /** Whether this Desk's identity is an admin (volleyd answers its account ops); asked once. */
  admin(): Promise<boolean>;
  /** A one-time pairing code (`peer_invite`). */
  invite(): Promise<PeerInvite>;
  /** Unpair `name` (`peer_remove`): revokes its account and clears its record. */
  remove(name: string): Promise<PeerOpResult>;
}

/** An account op's answer (an `ack` payload). */
interface Answer {
  ok: boolean;
  error?: string;
  result?: unknown;
  sealed?: string;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

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

/** The command the new machine runs; `to` is this machine's ssh destination. */
export function joinCommand(code: string, to: string): string {
  return `volley peer join ${code} --to ${to.trim() || "<you>@<this-machine>"}`;
}

export function createPeerOps(
  client: SteerClient,
  opts: {
    identity: string;
    timeoutMs?: number;
    newId?: () => string;
    now?: () => Date;
  },
): PeerOps {
  const { identity } = opts;
  const timeoutMs = opts.timeoutMs ?? AUTH_OP_TIMEOUT_MS;
  const newId = opts.newId ?? (() => crypto.randomUUID());
  const now = opts.now ?? (() => new Date());
  let isAdmin: Promise<boolean> | null = null;

  const ask = (op: string, fields: Record<string, unknown>): Promise<Answer> => {
    const id = newId();
    const topic = authReplyTopic(id);
    return new Promise<Answer>((resolve) => {
      let off = () => {};
      const timer = setTimeout(
        () => done({ ok: false, error: `volleyd did not answer within ${timeoutMs / 1000}s` }),
        timeoutMs,
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
  };

  const refusal = (a: Answer, what: string) => a.error ?? `volleyd refused ${what}`;

  return {
    admin() {
      isAdmin ??= ask("account_list", {}).then((a) => a.ok);
      return isAdmin;
    },
    async invite() {
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
      const r = (a.result ?? {}) as { expires_at?: unknown; ttl_s?: unknown };
      const ttl = typeof r.ttl_s === "number" ? r.ttl_s : CODE_TTL_S;
      return {
        ok: true,
        code,
        expiresAt:
          typeof r.expires_at === "string"
            ? r.expires_at
            : new Date(now().getTime() + ttl * 1000).toISOString(),
      };
    },
    async remove(name) {
      const a = await ask("peer_remove", { name });
      return a.ok ? { ok: true } : { ok: false, error: refusal(a, `removing ${name}`) };
    },
  };
}
