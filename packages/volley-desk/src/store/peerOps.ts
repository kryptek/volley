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
 * `peer_doctor` (a Desk's Repair) is an admin op on the same channel; its run
 * can take minutes, so it waits far longer than the others. So are the
 * repository ops (§4.6.21, Settings › Repositories): `repo_add`, `repo_remove`,
 * `repo_list` and `repo_status`; `repo_add` answers once config is patched, and
 * each machine's clone then shows in its readiness verdict.
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
import type { MachineAddRow, RepoMachines, RepoVerdict } from "./types";

/** The wait `volley peer invite` / `remove` use too: volleyd checks the account registry first. */
export const AUTH_OP_TIMEOUT_MS = 30_000;
/** The admin probe's wait: `account_list` is answered from a local file. */
export const ADMIN_PROBE_TIMEOUT_MS = 5000;
/** The identities `volley auth init` creates: none of them holds `admin` (SPEC §4.6.13). */
export const FIXED_IDENTITIES: ReadonlySet<string> = new Set(["desk", "coordinator", "volleyd"]);
/** A doctor run can take minutes (a fix may check out and install volley): volleyd's own limit is 15. */
export const DOCTOR_TIMEOUT_MS = 16 * 60_000;
/**
 * `machine_add` runs every step of `volley machine add` on a bare box (install.sh may apt-get and
 * build for minutes): volleyd bounds each step at 20 minutes. The wait is for silence: each row
 * restarts it, so a run of several long steps is not cut off.
 */
export const MACHINE_ADD_TIMEOUT_MS = 25 * 60_000;
/** volleyd's `peer_code_ttl_s` default: how long a code lasts when an answer leaves it out. */
const CODE_TTL_S = 600;

export interface PeerOpResult {
  ok: boolean;
  error?: string;
}

/** What `peer_remove` answered: a drain (or a stop) volleyd started waits on `agents` live agents. */
export interface PeerRemoveResult extends PeerOpResult {
  removing?: "drain" | "now";
  agents?: number;
}

/** One check of a doctor report (SPEC §4.6.14): `fix` is the doctor's own text, on a failing one. */
export interface DoctorCheck {
  id: string;
  ok: boolean;
  severity: "block" | "warn";
  detail: string;
  fix?: string;
  /** The repository (`owner/name`) a per-repository check is about. */
  repo?: string;
}

/** `peer_doctor`'s answer: the report's checks and, for a dry run, the plan of what a fix would do. */
export type DoctorAnswer =
  | { ok: true; checks: DoctorCheck[]; plan: DoctorCheck[]; doctorAt?: string }
  | { ok: false; error: string };

/** `repo_add`'s answer: the canonical slug GitHub gave, its URL, the machines and their lines. */
export type RepoAddResult =
  | { ok: true; slug: string; url: string; machines: string[]; status: string[] }
  | { ok: false; error: string };

/** `repo_remove`'s answer: each clone left on disk (by machine), and what each machine said. */
export type RepoRemoveResult =
  | {
      ok: true;
      slug: string;
      machines: string[];
      clones: Record<string, string>;
      peers: Record<string, string>;
    }
  | { ok: false; error: string };

/** `repo_list`'s answer: every repository config names. */
export type RepoListResult =
  | { ok: true; repos: { slug: string; machines: RepoMachines; paths?: Record<string, string> }[] }
  | { ok: false; error: string };

/** `repo_status`'s answer: each repository's verdict entry per machine, and one line each. */
export type RepoStatusResult =
  | {
      ok: true;
      repos: { slug: string; machines: Record<string, RepoVerdict>; lines: string[] }[];
    }
  | { ok: false; error: string };

/** What Add a bare machine sends (`machine_add`): the box, a password or a key file, sudo, a name. */
export type MachineAddRequest = {
  address: string;
  sudo?: string;
  name?: string;
} & ({ password: string; key?: never } | { key: string; password?: never });

/** `machine_add`'s answer: the machine's readiness from its doctor, and its two sign-ins. */
export type MachineAddAnswer =
  | {
      ok: true;
      name: string;
      target: string;
      ready: boolean;
      signin: { gh: boolean; claude: boolean };
      checks: DoctorCheck[];
    }
  | { ok: false; error: string };

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
  /** A one-time pairing code (`peer_invite`); `forName` makes it re-pair that machine only. */
  invite(forName?: string): Promise<PeerInvite>;
  /**
   * Unpair `name` (`peer_remove`): revokes its account and clears its record. `drain` waits for
   * its agents to finish first; `now` stops them.
   */
  remove(name: string, mode?: "drain" | "now"): Promise<PeerRemoveResult>;
  /**
   * Run the machine's doctor over ssh (`peer_doctor`): a dry run, or its safe fixes. `reposAdd`
   * (`<owner/name>` or `<owner/name>=<path>`) with `clone` clones those repositories there.
   */
  doctor(
    name: string,
    opts: { fix: boolean; clone?: boolean; reposAdd?: string[] },
  ): Promise<DoctorAnswer>;
  /** Add a repository to every machine (or these), adopting existing clones at `paths`. */
  repoAdd(
    slug: string,
    opts?: { machines?: RepoMachines; paths?: Record<string, string> },
  ): Promise<RepoAddResult>;
  /** Remove a repository from every machine (or these); its clones stay on disk. */
  repoRemove(slug: string, machines?: string[]): Promise<RepoRemoveResult>;
  repoList(): Promise<RepoListResult>;
  repoStatus(slug?: string): Promise<RepoStatusResult>;
  /**
   * Make a bare box a paired machine (`machine_add`): volleyd runs `volley machine add`'s steps
   * over ssh, each row handed to `onRow` as it happens. The passwords go to volleyd only.
   */
  machineAdd(
    req: MachineAddRequest,
    onRow: (row: MachineAddRow) => void,
  ): Promise<MachineAddAnswer>;
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

/**
 * The command the new machine runs; `to` is this machine's ssh destination (`…` until it is
 * known). A re-pairing code (`invite --for`) joins as that machine, replacing its entry.
 */
export function joinCommand(code: string, to: string, repair?: string): string {
  const join = `volley peer join ${code} --to ${to.trim() || "…"}`;
  return repair ? `${join} --name ${repair} --replace` : join;
}

const asChecks = (v: unknown): DoctorCheck[] => (Array.isArray(v) ? (v as DoctorCheck[]) : []);

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const asRecord = (v: unknown): Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Object.fromEntries(
        Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"),
      )
    : {};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A `machine_add` progress payload as a row (`op` dropped), or null when it is not one. */
function asRow(p: Record<string, unknown>): MachineAddRow | null {
  const { step, total, title, state, line } = p;
  if (typeof step !== "number" || typeof title !== "string") return null;
  return {
    step,
    total: typeof total === "number" ? total : 7,
    title,
    state: state === "failed" ? "failed" : "running",
    ...(typeof line === "string" ? { line } : {}),
  };
}

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
    async invite(forName) {
      if (!pairingSupported()) {
        return {
          ok: false,
          error: "this browser cannot make the reply key pairing needs; use volley peer invite",
        };
      }
      const a = await ask("peer_invite", forName ? { for: forName } : {}, timeoutMs);
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
    async remove(name, mode) {
      const a = await ask("peer_remove", { name, ...(mode ? { [mode]: true } : {}) }, timeoutMs);
      if (!a.ok) return { ok: false, error: refusal(a, `removing ${name}`) };
      const r = (a.result ?? {}) as { removing?: unknown; agents?: unknown };
      return r.removing === "drain" || r.removing === "now"
        ? { ok: true, removing: r.removing, agents: typeof r.agents === "number" ? r.agents : 0 }
        : { ok: true };
    },
    async doctor(name, { fix, clone = false, reposAdd }) {
      const a = await ask(
        "peer_doctor",
        { name, fix, clone, ...(reposAdd?.length ? { repos_add: reposAdd } : {}) },
        DOCTOR_TIMEOUT_MS,
      );
      if (!a.ok) return { ok: false, error: refusal(a, `the doctor on ${name}`) };
      const r = (a.result ?? {}) as { checks?: unknown; plan?: unknown; doctor_at?: unknown };
      return {
        ok: true,
        checks: asChecks(r.checks),
        plan: asChecks(r.plan),
        ...(typeof r.doctor_at === "string" ? { doctorAt: r.doctor_at } : {}),
      };
    },
    async repoAdd(slug, { machines = "all", paths } = {}) {
      const fields = {
        slug,
        machines,
        ...(paths && Object.keys(paths).length > 0 ? { paths } : {}),
      };
      const a = await ask("repo_add", fields, timeoutMs);
      if (!a.ok) return { ok: false, error: refusal(a, `adding ${slug}`) };
      const r = (a.result ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        slug: typeof r.slug === "string" ? r.slug : slug,
        url: typeof r.url === "string" ? r.url : `https://github.com/${slug}`,
        machines: asStrings(r.machines),
        status: asStrings(r.status),
      };
    },
    async repoRemove(slug, machines) {
      const a = await ask("repo_remove", { slug, ...(machines ? { machines } : {}) }, timeoutMs);
      if (!a.ok) return { ok: false, error: refusal(a, `removing ${slug}`) };
      const r = (a.result ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        slug: typeof r.slug === "string" ? r.slug : slug,
        machines: asStrings(r.machines),
        clones: asRecord(r.clones),
        peers: asRecord(r.peers),
      };
    },
    async repoList() {
      const a = await ask("repo_list", {}, timeoutMs);
      if (!a.ok) return { ok: false, error: refusal(a, "the repository list") };
      const r = (a.result ?? {}) as { repos?: unknown };
      return { ok: true, repos: Array.isArray(r.repos) ? r.repos : [] };
    },
    async machineAdd(req, onRow) {
      const fields = {
        address: req.address,
        auth: req.key !== undefined ? { key: req.key } : { password_ref: req.password },
        ...(req.sudo ? { sudo_ref: req.sudo } : {}),
        ...(req.name ? { name: req.name } : {}),
      };
      const a = await auth
        .request("machine_add", fields, {
          timeoutMs: MACHINE_ADD_TIMEOUT_MS,
          onProgress: (p) => {
            const row = asRow(p);
            if (row) onRow(row);
          },
        })
        .catch((err: unknown): AuthAnswer => ({ ok: false, error: message(err), unsent: true }));
      if (!a.ok) return { ok: false, error: refusal(a, `adding ${req.address}`) };
      const r = (a.result ?? {}) as Record<string, unknown>;
      const signin = (r.signin ?? {}) as { gh?: unknown; claude?: unknown };
      return {
        ok: true,
        name: typeof r.name === "string" ? r.name : "",
        target: typeof r.target === "string" ? r.target : req.address,
        ready: r.ready === true,
        signin: { gh: signin.gh === true, claude: signin.claude === true },
        checks: asChecks(r.checks),
      };
    },
    async repoStatus(slug) {
      const a = await ask("repo_status", slug ? { slug } : {}, timeoutMs);
      if (!a.ok) return { ok: false, error: refusal(a, "the repository status") };
      const r = (a.result ?? {}) as { repos?: unknown };
      return { ok: true, repos: Array.isArray(r.repos) ? r.repos : [] };
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
