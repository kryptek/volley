import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isValidAgentId } from "volley-mcp/topics";
import { listAccounts, replyKey, seal, volleyAuth } from "./accounts";
import { DAEMON_DEFAULTS, REMOTE_HOST_DEFAULTS } from "./config-defaults";
import type { PatchResult } from "./config-store";
import type { ExecFn } from "./exec";
import type { MachineRecord } from "./machines";
import type { PathError } from "./schemas";
import type { NewEvent, RemoteHostConfig } from "./types";

/**
 * Machines + pairing (SPEC §4.6.14): the control ops behind `volley peer`.
 *
 *   - `peer_invite {reply_key, ttl_s?}` → a one-time pairing code `XXXX-XXXX`, sealed to the
 *     request's `reply_key` (every account may read the answers). Only a salted scrypt
 *     hash of it is kept, in `$VOLLEYD_HOME/peer-codes.json` (mode 0600), so it survives a restart.
 *   - `peer_join {code, name, target, volley_dir, repo?, worktree_root?, port?, os?, cores?,
 *     reply_key}` → burns the code, creates a `peer` account named `name` (`volley auth add`),
 *     adds `hosts.<name>` with `tunnel.supervise: false` (the machine keeps its own tunnel as a
 *     service), records the name in `$VOLLEYD_HOME/peers.json`, and answers with the broker's
 *     address and the sealed `{username, password}`.
 *   - `peer_remove {name}` → revokes the peer account, removes `hosts.<name>` and clears the
 *     machine's retained record; the machine's tunnel service stops at its next check. Only a
 *     paired machine (or a `peer` account): a host configured by hand is never removed.
 *   - `peers` → the paired machines' records and names.
 *
 * `peer_invite` and `peer_remove` are admin ops: the daemon answers them only on the account-op
 * topic, after the same admin check as the account ops (accounts.ts `adminRefusal`). The code is
 * the credential for a join: anyone may send one, but a wrong code counts, and
 * `peer_join_max_failures` wrong codes revoke every outstanding code.
 */

/** Unambiguous upper-case letters and digits (no I, L, O, 0, 1). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);
/** Names a peer may not take: the daemon's own host and the fixed broker identities. */
const RESERVED_NAMES = new Set(["local", "volleyd", "desk", "coordinator"]);

export const isPairingCode = (c: string) => CODE_RE.test(c);

/** The code as hashed: upper case, without the dash or spaces. */
export const normalizeCode = (c: string) => c.toUpperCase().replace(/[\s-]/g, "");

/** A fresh code, `XXXX-XXXX`. */
export function newPairingCode(): string {
  const pick = () =>
    Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)] as string).join("");
  return `${pick()}-${pick()}`;
}

interface StoredCode {
  salt: string;
  hash: string;
  expires_at: string;
  by: string;
}

const hashCode = (code: string, salt: Buffer) => scryptSync(normalizeCode(code), salt, 32);

export interface PeerReply {
  ok: boolean;
  error?: string;
  result?: unknown;
  /** base64url RSA-OAEP of the secret (`{code}` / `{username, password}`), to the reply_key. */
  sealed?: string;
  rejected?: PathError[];
}

export interface PeerDeps {
  /** Runs `volley auth` (accounts.ts): the peer account is created and revoked there. */
  exec: ExecFn;
  now: () => number;
  /** The pairing-code store (`$VOLLEYD_HOME/peer-codes.json`). */
  file: string;
  /** The paired machines' names (`$VOLLEYD_HOME/peers.json`): what `remove` and `list` trust. */
  pairedFile: string;
  /** volleyd's namespace: the peer's agents and its service publish there. */
  namespace: string;
  /** The broker as the supervisor's machine reaches it (the peer's tunnel forwards to it). */
  broker: () => { host: string; port: number };
  /** The configured `hosts` (global layer). */
  hosts: () => Record<string, RemoteHostConfig>;
  setHost: (name: string, host: RemoteHostConfig, by: string) => PatchResult;
  removeHost: (name: string, by: string) => PatchResult;
  /** Clear the machine's retained record and forget its health. */
  clearMachine: (name: string) => Promise<void>;
  machines: () => MachineRecord[];
  journal: (ev: NewEvent) => unknown;
  /** Tests: deterministic codes. */
  randomCode?: () => string;
}

type Fields = Record<string, unknown>;
const refuse = (error: string): PeerReply => ({ ok: false, error });
const isAbsolute = (p: unknown): p is string =>
  typeof p === "string" && p.startsWith("/") && !/[\n\r]/.test(p) && p.length <= 1024;

export class PeerService {
  /** Wrong codes since the last revoke-all. */
  private failures = 0;

  constructor(readonly deps: PeerDeps) {}

  async invite(p: Fields, by: string): Promise<PeerReply> {
    const key = replyKey(p.reply_key);
    if (typeof key === "string") return refuse(key);
    const ttl = p.ttl_s ?? DAEMON_DEFAULTS.peer_code_ttl_s;
    if (
      typeof ttl !== "number" ||
      !Number.isInteger(ttl) ||
      ttl < 1 ||
      ttl > DAEMON_DEFAULTS.peer_code_ttl_s
    ) {
      return refuse(
        `ttl_s must be a whole number of seconds in 1..${DAEMON_DEFAULTS.peer_code_ttl_s}`,
      );
    }
    const code = (this.deps.randomCode ?? newPairingCode)();
    const salt = randomBytes(16);
    const expiresAt = new Date(this.deps.now() + ttl * 1000).toISOString();
    this.write([
      ...this.live(),
      {
        salt: salt.toString("base64url"),
        hash: hashCode(code, salt).toString("base64url"),
        expires_at: expiresAt,
        by,
      },
    ]);
    this.deps.journal({ type: "peer_invited", data: { by, expires_at: expiresAt } });
    return { ok: true, result: { expires_at: expiresAt, ttl_s: ttl }, sealed: seal(key, { code }) };
  }

  async join(p: Fields, by: string): Promise<PeerReply> {
    const name = p.name;
    if (typeof name !== "string" || !isValidAgentId(name) || RESERVED_NAMES.has(name)) {
      return refuse(
        `name must match [a-z0-9][a-z0-9_-]{0,62} and not be one of ${[...RESERVED_NAMES].join(", ")}`,
      );
    }
    if (typeof p.target !== "string" || p.target === "" || p.target.startsWith("-")) {
      return refuse("target (how the supervisor's machine reaches this one over ssh) is required");
    }
    if (!isAbsolute(p.volley_dir)) return refuse("volley_dir must be an absolute path");
    for (const k of ["repo", "worktree_root"] as const) {
      if (p[k] !== undefined && !isAbsolute(p[k])) return refuse(`${k} must be an absolute path`);
    }
    const port = p.port ?? REMOTE_HOST_DEFAULTS.remote_port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65535) {
      return refuse("port must be a whole number in 1024..65535");
    }
    const key = replyKey(p.reply_key);
    if (typeof key === "string") return refuse(key);
    if (typeof p.code !== "string") return refuse("code is required");
    if (Object.hasOwn(this.deps.hosts(), name)) {
      return refuse(`a host named "${name}" is already configured; remove it first`);
    }
    if (!this.burn(p.code)) return refuse("invalid or expired pairing code");

    const created = await volleyAuth(this.deps.exec, [
      "add",
      name,
      "--role",
      "peer",
      "--kind",
      "machine",
      "--json",
    ]);
    if (!created.ok) return refuse(`${created.error} (the code is used up: ask for a new one)`);
    const username = created.out?.username;
    const password = created.out?.password;
    if (typeof username !== "string" || typeof password !== "string") {
      await volleyAuth(this.deps.exec, ["revoke", name]);
      return refuse("volley auth add printed no credentials");
    }
    const host: RemoteHostConfig = {
      target: p.target,
      ...(p.repo !== undefined ? { repo: p.repo as string } : {}),
      ...(p.worktree_root !== undefined ? { worktree_root: p.worktree_root as string } : {}),
      volley_dir: p.volley_dir,
      tunnel: { remote_port: port, supervise: false },
    };
    const applied = this.deps.setHost(name, host, by);
    if (!applied.applied) {
      await volleyAuth(this.deps.exec, ["revoke", name]);
      const why = applied.rejected.map((r) => `${r.path}: ${r.reason}`).join("; ");
      return { ...refuse(`hosts.${name} rejected: ${why}`), rejected: applied.rejected };
    }
    this.writePaired({
      ...this.paired(),
      [name]: { target: p.target, joined_at: new Date(this.deps.now()).toISOString() },
    });
    this.deps.journal({
      type: "peer_joined",
      data: {
        by,
        name,
        target: p.target,
        ...(typeof p.os === "string" ? { os: p.os } : {}),
        ...(typeof p.cores === "number" ? { cores: p.cores } : {}),
      },
    });
    return {
      ok: true,
      result: {
        name,
        namespace: this.deps.namespace,
        broker: this.deps.broker(),
        remote_port: port,
      },
      sealed: seal(key, { username, password }),
    };
  }

  async remove(p: Fields, by: string): Promise<PeerReply> {
    const name = p.name;
    if (typeof name !== "string" || !isValidAgentId(name)) {
      return refuse("name must match [a-z0-9][a-z0-9_-]{0,62}");
    }
    const accounts = await listAccounts(this.deps.exec);
    if (typeof accounts === "string") return refuse(accounts);
    const account = accounts.find((a) => a.name === name);
    if (account !== undefined && account.role !== "peer") {
      return refuse(`"${name}" is a ${account.role} account, not a peer: not revoked`);
    }
    const paired = this.paired();
    const wasPaired = Object.hasOwn(paired, name);
    const configured = Object.hasOwn(this.deps.hosts(), name);
    if (account === undefined && !wasPaired) {
      return refuse(
        configured
          ? `"${name}" is a configured host, not a paired machine: not removed`
          : `no peer named "${name}"`,
      );
    }
    // A peer account's or a paired machine's host entry; never one configured by hand alone.
    const isHost = configured;
    if (account !== undefined) {
      const r = await volleyAuth(this.deps.exec, ["revoke", name]);
      if (!r.ok) return refuse(r.error);
    }
    if (isHost) {
      const r = this.deps.removeHost(name, by);
      if (!r.applied) {
        return refuse(`hosts.${name} not removed: ${r.rejected.map((e) => e.reason).join("; ")}`);
      }
    }
    if (wasPaired) {
      const { [name]: _gone, ...rest } = paired;
      this.writePaired(rest);
    }
    await this.deps.clearMachine(name);
    const data = { by, name, revoked: account !== undefined, host_removed: isHost };
    this.deps.journal({ type: "peer_removed", data });
    return { ok: true, result: { name, revoked: data.revoked, host_removed: isHost } };
  }

  list(): PeerReply {
    const paired = Object.keys(this.paired());
    return {
      ok: true,
      result: {
        machines: this.deps.machines().filter((m) => paired.includes(m.name)),
        hosts: paired,
      },
    };
  }

  /** Names this daemon paired (`peer_join`), with when and how it reaches them. */
  paired(): Record<string, PairedMachine> {
    if (!existsSync(this.deps.pairedFile)) return {};
    try {
      const peers = (JSON.parse(readFileSync(this.deps.pairedFile, "utf-8")) as { peers?: unknown })
        .peers;
      return typeof peers === "object" && peers !== null && !Array.isArray(peers)
        ? (peers as Record<string, PairedMachine>)
        : {};
    } catch {
      return {};
    }
  }

  private writePaired(peers: Record<string, PairedMachine>): void {
    writeJson(this.deps.pairedFile, { peers });
  }

  /** Burn the code if it is outstanding; a wrong one counts towards revoking them all. */
  private burn(code: string): boolean {
    const codes = this.live();
    const n = normalizeCode(code);
    const idx = isPairingCode(`${n.slice(0, 4)}-${n.slice(4)}`)
      ? codes.findIndex((c) =>
          timingSafeEqual(
            hashCode(n, Buffer.from(c.salt, "base64url")),
            Buffer.from(c.hash, "base64url"),
          ),
        )
      : -1;
    if (idx >= 0) {
      codes.splice(idx, 1);
      this.write(codes);
      return true;
    }
    this.failures++;
    if (this.failures >= DAEMON_DEFAULTS.peer_join_max_failures) {
      this.failures = 0;
      this.write([]);
    }
    return false;
  }

  /** The unexpired codes on disk. */
  private live(): StoredCode[] {
    if (!existsSync(this.deps.file)) return [];
    let codes: unknown;
    try {
      codes = (JSON.parse(readFileSync(this.deps.file, "utf-8")) as { codes?: unknown }).codes;
    } catch {
      return [];
    }
    const now = this.deps.now();
    return Array.isArray(codes)
      ? (codes as StoredCode[]).filter((c) => Date.parse(c.expires_at) > now)
      : [];
  }

  private write(codes: StoredCode[]): void {
    writeJson(this.deps.file, { codes });
  }
}

/** One `peers.json` entry. */
export interface PairedMachine {
  target: string;
  joined_at: string;
}

/** Atomically, mode 0600. */
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
