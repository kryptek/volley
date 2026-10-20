/**
 * The Desk's machine-pairing ops (SPEC §4.6.14). `peer_invite` and
 * `peer_remove` create and revoke broker access, so they are admin ops: like
 * every account op (§4.6.10) they travel the Desk's admin channel
 * (`createAuthOps` in `control.ts`): the Desk's own
 * `volley/_system/auth/ops/<identity>`, answered on
 * `volley/_system/auth/replies/<correlation_id>` by `volleyd` only. This
 * module is a thin layer over that channel: the pairing code comes back in
 * `sealed`, opened with the session's reply key, which is WebCrypto's on
 * https or localhost and `lib/rsa.ts`'s on a plain-http LAN page.
 *
 * The broker grants an account-op topic only to an admin account, for its own
 * username, so a non-admin's request is dropped and nothing ever answers it.
 * `admin()` first uses what is already known: a role from sign-in, or one of
 * the fixed identities, which are never admins (§4.6.13). Otherwise it asks
 * the read-only `account_list` with a short wait and counts an answer as
 * proof (stored with the sign-in, as Setup & Security does) and a refusal as
 * a no; both are kept. No answer (volleyd down, or a non-admin's dropped
 * publish) is neither, and is not kept: the next ask asks again.
 */
import { type AuthAnswer, type AuthOps, rememberRole } from "./control";

/** The wait `volley peer invite` / `remove` use too: volleyd checks the account registry first. */
export const AUTH_OP_TIMEOUT_MS = 30_000;
/** The admin probe's wait: `account_list` is answered from a local file. */
export const ADMIN_PROBE_TIMEOUT_MS = 5000;
/** The identities `volley auth init` creates: none of them holds `admin` (SPEC §4.6.13). */
export const FIXED_IDENTITIES: ReadonlySet<string> = new Set(["desk", "coordinator", "volleyd"]);
/** volleyd's `peer_code_ttl_s` default: how long a code lasts when an answer leaves it out. */
const CODE_TTL_S = 600;

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

/**
 * Whether this page can make a reply key: WebCrypto (a secure context), or
 * `lib/rsa.ts`'s fallback, which needs only `crypto.getRandomValues` and
 * BigInt. A browser with neither cannot pair from the Desk.
 */
export function pairingSupported(): boolean {
  const c = globalThis.crypto;
  return (
    typeof c?.subtle?.generateKey === "function" ||
    (typeof c?.getRandomValues === "function" && typeof BigInt === "function")
  );
}

/** The command the new machine runs; `to` is this machine's ssh destination (`…` until it is known). */
export function joinCommand(code: string, to: string): string {
  return `volley peer join ${code} --to ${to.trim() || "…"}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createPeerOps(
  auth: AuthOps,
  opts: {
    /** The role the Desk's sign-in minted, when it knows it: no probe then. */
    role?: string | null;
    timeoutMs?: number;
    probeTimeoutMs?: number;
    now?: () => Date;
  } = {},
): PeerOps {
  const { identity } = auth;
  const timeoutMs = opts.timeoutMs ?? AUTH_OP_TIMEOUT_MS;
  const probeTimeoutMs = opts.probeTimeoutMs ?? ADMIN_PROBE_TIMEOUT_MS;
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

  /** `auth.request`, which never rejects here: a throw is an unsent request. */
  const ask = (op: string, fields: Record<string, unknown>, waitMs: number) =>
    auth
      .request(op, fields, { timeoutMs: waitMs })
      .catch((err: unknown): AuthAnswer => ({ ok: false, error: message(err), unsent: true }));

  const refusal = (a: AuthAnswer, what: string) => a.error ?? `volleyd refused ${what}`;

  return {
    known: () => known,
    admin() {
      if (known) return Promise.resolve(known);
      probe ??= ask("account_list", {}, probeTimeoutMs).then((a) => {
        probe = null;
        // A refusal is an answer; a timeout or an unsent publish is not.
        if (a.ok) {
          known = "admin";
          rememberRole(identity, "admin");
        } else if (!a.unanswered && !a.unsent) known = "not-admin";
        return known ?? "no-answer";
      });
      return probe;
    },
    async invite() {
      if (!pairingSupported()) {
        return {
          ok: false,
          error: "this browser cannot make the reply key pairing needs; use volley peer invite",
        };
      }
      const a = await ask("peer_invite", {}, timeoutMs);
      if (!a.ok) return { ok: false, error: refusal(a, "the pairing code") };
      const code = a.secret?.code;
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
      const a = await ask("peer_remove", { name }, timeoutMs);
      return a.ok ? { ok: true } : { ok: false, error: refusal(a, `removing ${name}`) };
    },
  };
}

/**
 * How often a Desk signed in as an admin tells volleyd it is in use: an `account_list`, which
 * volleyd counts as the account's `last_seen`. Well inside Settings › Broker accounts' stale limit
 * (a day), so a Desk that only watches is never offered for revoking.
 */
export const ADMIN_SEEN_EVERY_MS = 3_600_000;

/**
 * Check in with volleyd now and every `ADMIN_SEEN_EVERY_MS` while this Desk is an admin (an
 * unknown role is asked once, and that ask counts). Returns the stop function.
 */
export function keepAdminSeen(
  peer: PeerOps,
  auth: AuthOps,
  timers: {
    setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
    clearInterval: (t: ReturnType<typeof setInterval>) => void;
  } = globalThis,
): () => void {
  const checkIn = () => {
    const known = peer.known();
    if (known === "admin") {
      void auth.request("account_list", {}, { timeoutMs: ADMIN_PROBE_TIMEOUT_MS }).catch(() => {});
    } else if (known === null) void peer.admin();
  };
  checkIn();
  const t = timers.setInterval(checkIn, ADMIN_SEEN_EVERY_MS);
  return () => timers.clearInterval(t);
}
