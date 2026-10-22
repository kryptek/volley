import { randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { derivedMaxAgents } from "volley-cli/peer/machine";
import { isValidAgentId } from "volley-mcp/topics";
import { listAccounts, replyKey, seal, volleyAuth } from "./accounts";
import { DAEMON_DEFAULTS, REMOTE_HOST_DEFAULTS } from "./config-defaults";
import type { PatchResult } from "./config-store";
import type { ExecFn } from "./exec";
import { isCloneUrl } from "./fence";
import type { RemoteHost } from "./hosts/ssh-tmux";
import type { DoctorReport, MachineRecord } from "./machines";
import type { PathError } from "./schemas";
import type { NewEvent, RemoteHostConfig } from "./types";

/**
 * Machines + pairing (SPEC §4.6.14): the control ops behind `volley peer`.
 *
 *   - `peer_invite {reply_key, ttl_s?}` → a one-time pairing code `XXXX-XXXX`, sealed to the
 *     request's `reply_key` (every account may read the answers). Only a salted scrypt
 *     hash of it is kept, in `$VOLLEYD_HOME/peer-codes.json` (mode 0600), so it survives a restart.
 *   - `peer_join {code, name, target, volley_dir, repo?, worktree_root?, port?, os?, cores?,
 *     memory_total_mb?, reply_key}` → burns the code, creates a `peer` account named `name`
 *     (`volley auth add`), adds `hosts.<name>` with `tunnel.supervise: false` (the machine keeps
 *     its own tunnel as a service) and `max_agents` derived from `cores` and `memory_total_mb`
 *     (`derivedMaxAgents`; unknown: unset), records the name in `$VOLLEYD_HOME/peers.json`, and answers with the broker's
 *     address and the sealed `{username, password}`.
 *   - `peer_invite {reply_key, ttl_s?, for}` → a code bound to the paired machine `for`: it
 *     re-pairs that machine only. `peer_join {..., name: <for>, replace: true}` with it rotates the
 *     peer account's password and rewrites `hosts.<name>` (the join's fields; a hand-set
 *     `max_agents` or `drain` stays) instead of refusing the configured name, and journals
 *     `peer_joined { replaced: true }`. An unbound code for a configured name is still refused.
 *   - `peer_remove {name}` → revokes the peer account, removes `hosts.<name>` and clears the
 *     machine's retained record; the machine's tunnel service stops at its next check. Only a
 *     paired machine (or a `peer` account): a host configured by hand is never removed.
 *   - `peer_remove {name, drain: true}` on a machine with live agents → sets `hosts.<name>.drain`
 *     (nothing new is placed there), answers at once and journals `peer_drain_started`; the
 *     daemon finishes the removal (`finishRemoval`, `peer_removed`) once no agent runs there.
 *     `{name, now: true}` likewise, but the daemon stops those agents (`stop_grace_s`) and opens
 *     their respawn decisions first. With no live agent either removes at once.
 *   - `peers` → the paired machines' records and names.
 *   - `peer_doctor {name, fix?, clone?}` → runs `volley peer doctor --json [--fix --yes
 *     [--clone --origin <url>]]` on the configured host `name` over ssh (the Desk's Repair) and
 *     answers with the doctor's report; without `fix`, also its `plan` (each failing check with
 *     its fix), so the sheet shows what a fix would do before anyone runs it. `<url>` is the
 *     running wave's origin as the supervisor's own clone reports it (`cloneUrl`); with none
 *     known, `clone` is refused.
 *
 * `peer_invite`, `peer_remove` and `peer_doctor` are admin ops: the daemon answers them only on the account-op
 * topic, after the same admin check as the account ops (accounts.ts `adminRefusal`). The code is
 * the credential for a join: anyone may send one, but a wrong code counts, and
 * `peer_join_max_failures` wrong codes revoke every outstanding code.
 */

/** Unambiguous upper-case letters and digits (no I, L, O, 0, 1). */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = new RegExp(`^[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);
/**
 * Names a peer may not take: the two a wave file's `host:` reserves (the daemon's own host, and
 * `auto` for placement, SPEC §4.6.15) and the fixed broker identities.
 */
const RESERVED_NAMES = new Set(["local", "auto", "volleyd", "desk", "coordinator"]);

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
  /** `invite --for`: the paired machine this code re-pairs (and the only name it joins as). */
  for?: string;
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
  /** Clear the machine's retained record and readiness verdict, and forget its health. */
  clearMachine: (name: string) => Promise<void>;
  /** The supervisor's own machine name (SPEC §4.6.15): never a peer's. */
  localName?: () => string;
  /** `hosts.<name>.drain: true` (a drain or remove-now in progress); omitted: not supported. */
  setDrain?: (name: string, by: string) => PatchResult;
  /** The live supervised agents on machine `name` (a drain waits for them). */
  liveAgents?: (name: string) => string[];
  /** The configured host `name` as a remote host (`peer_doctor`); a string: why it cannot be. */
  remote?: (name: string) => RemoteHost | string;
  machines: () => MachineRecord[];
  journal: (ev: NewEvent) => unknown;
  /** Tests: deterministic codes. */
  randomCode?: () => string;
}

type Fields = Record<string, unknown>;
const refuse = (error: string): PeerReply => ({ ok: false, error });
/** A finite number field, else undefined. */
const num = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isFinite(x) ? x : undefined;
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
    const bound = p.for;
    if (bound !== undefined) {
      if (typeof bound !== "string" || !isValidAgentId(bound)) {
        return refuse("for must be a machine name ([a-z0-9][a-z0-9_-]{0,62})");
      }
      if (!Object.hasOwn(this.paired(), bound)) {
        return refuse(`no paired machine named "${bound}" to re-pair`);
      }
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
        ...(bound !== undefined ? { for: bound } : {}),
      },
    ]);
    const forField = bound !== undefined ? { for: bound } : {};
    this.deps.journal({ type: "peer_invited", data: { by, expires_at: expiresAt, ...forField } });
    return {
      ok: true,
      result: { expires_at: expiresAt, ttl_s: ttl, ...forField },
      sealed: seal(key, { code }),
    };
  }

  async join(p: Fields, by: string): Promise<PeerReply> {
    const name = p.name;
    if (typeof name !== "string" || !isValidAgentId(name) || RESERVED_NAMES.has(name)) {
      return refuse(
        `name must match [a-z0-9][a-z0-9_-]{0,62} and not be one of ${[...RESERVED_NAMES].join(", ")}`,
      );
    }
    if (name === this.deps.localName?.()) {
      return refuse(`"${name}" is the supervisor's own machine name (fleet.local_name)`);
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
    const configured = Object.hasOwn(this.deps.hosts(), name);
    const taken = refuse(
      `a host named "${name}" is already configured; remove it first, or re-pair it with a code from \`volley peer invite --for ${name}\` and \`volley peer join --replace\``,
    );
    if (configured && p.replace !== true) return taken;
    // Matched, not yet burned: a refusal below leaves the code usable.
    const entry = this.match(p.code);
    if (entry === null) return refuse("invalid or expired pairing code");
    if (entry.for !== undefined && entry.for !== name) {
      return refuse(`this pairing code re-pairs ${entry.for} only (join with --name ${entry.for})`);
    }
    const replacing = entry.for === name && p.replace === true;
    if (configured && !replacing) return taken;
    let existing = false;
    if (replacing) {
      const accounts = await listAccounts(this.deps.exec);
      if (typeof accounts === "string") return refuse(accounts);
      const account = accounts.find((a) => a.name === name);
      if (account !== undefined && account.role !== "peer") {
        return refuse(`"${name}" is a ${account.role} account, not a peer: not replaced`);
      }
      existing = account !== undefined;
    }
    this.consume(entry);

    // Re-pairing an existing account rotates its password; anything else is a new account.
    const created = await volleyAuth(
      this.deps.exec,
      existing
        ? ["rotate", name, "--json"]
        : ["add", name, "--role", "peer", "--kind", "machine", "--json"],
    );
    if (!created.ok) return refuse(`${created.error} (the code is used up: ask for a new one)`);
    const username = created.out?.username;
    const password = created.out?.password;
    if (typeof username !== "string" || typeof password !== "string") {
      if (!existing) await volleyAuth(this.deps.exec, ["revoke", name]);
      return refuse(`volley auth ${existing ? "rotate" : "add"} printed no credentials`);
    }
    // Sized from the machine (SPEC §4.6.15); a max_agents already configured (a re-pairing's
    // hand-set value) stays, and an unknown size leaves it unset (4).
    const sized =
      this.deps.hosts()[name]?.max_agents === undefined
        ? derivedMaxAgents(num(p.cores), num(p.memory_total_mb))
        : null;
    const host: RemoteHostConfig = {
      target: p.target,
      ...(p.repo !== undefined ? { repo: p.repo as string } : {}),
      ...(p.worktree_root !== undefined ? { worktree_root: p.worktree_root as string } : {}),
      volley_dir: p.volley_dir,
      tunnel: { remote_port: port, supervise: false },
      ...(sized !== null ? { max_agents: sized } : {}),
    };
    const applied = this.deps.setHost(name, host, by);
    if (!applied.applied) {
      // Never revoke an account this join did not create (a re-pairing keeps the old machine's).
      if (!existing) await volleyAuth(this.deps.exec, ["revoke", name]);
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
        ...(typeof p.memory_total_mb === "number" ? { memory_total_mb: p.memory_total_mb } : {}),
        ...(sized !== null ? { max_agents: sized } : {}),
        ...(replacing ? { replaced: true } : {}),
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
    for (const k of ["drain", "now"] as const) {
      if (p[k] !== undefined && typeof p[k] !== "boolean")
        return refuse(`${k} must be true or false`);
    }
    if (p.drain === true && p.now === true) {
      return refuse(
        "drain and now exclude each other: drain lets the running agents finish, now stops them",
      );
    }
    const mode: RemovalMode | null = p.drain === true ? "drain" : p.now === true ? "now" : null;
    if (mode !== null && Object.hasOwn(this.removals(), name)) {
      return refuse(`"${name}" is being removed already`);
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
    const agents = mode !== null && isHost ? (this.deps.liveAgents?.(name) ?? []) : [];
    if (mode !== null && agents.length > 0) return this.startRemoval(name, mode, agents, by);
    return this.removeNow(name, by, account);
  }

  /**
   * A drain or remove-now on a machine with live agents: nothing new is placed there from now on
   * (`hosts.<name>.drain`), the removal is remembered (it survives a restart) and journaled as
   * `peer_drain_started`, and the answer comes at once. The daemon calls `finishRemoval` once no
   * agent runs there.
   */
  private startRemoval(name: string, mode: RemovalMode, agents: string[], by: string): PeerReply {
    if (this.deps.setDrain === undefined) return refuse(`${mode} is not supported here`);
    const r = this.deps.setDrain(name, by);
    if (!r.applied) {
      return refuse(`hosts.${name}.drain not set: ${r.rejected.map((e) => e.reason).join("; ")}`);
    }
    const at = new Date(this.deps.now()).toISOString();
    this.writeFile(this.paired(), { ...this.removals(), [name]: { by, mode, at } });
    this.deps.journal({ type: "peer_drain_started", data: { by, name, mode, agents } });
    return {
      ok: true,
      result: { name, removing: mode, agents: agents.length, revoked: false, host_removed: false },
    };
  }

  /** Removals started with `drain` or `now` that have not finished, by machine name. */
  removals(): Record<string, PendingRemoval> {
    return this.readFile().removing;
  }

  /**
   * Finish a drain or remove-now: the removal itself, by whoever asked for it. A refusal (the
   * account could not be revoked, say) leaves it pending, for the next sweep to try again.
   */
  async finishRemoval(name: string): Promise<PeerReply> {
    const pending = this.removals()[name];
    if (pending === undefined) return refuse(`"${name}" is not being removed`);
    const accounts = await listAccounts(this.deps.exec);
    if (typeof accounts === "string") return refuse(accounts);
    return this.removeNow(
      name,
      pending.by,
      accounts.find((a) => a.name === name && a.role === "peer"),
    );
  }

  /**
   * Revoke the peer `account` (if any), drop the host entry and the pairing, clear the record,
   * journal `peer_removed`.
   */
  private async removeNow(
    name: string,
    by: string,
    account: { name: string } | undefined,
  ): Promise<PeerReply> {
    const paired = this.paired();
    const wasPaired = Object.hasOwn(paired, name);
    const isHost = Object.hasOwn(this.deps.hosts(), name);
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
    if (Object.hasOwn(this.removals(), name)) {
      const { [name]: _done, ...rest } = this.removals();
      this.writeFile(this.paired(), rest);
    }
    await this.deps.clearMachine(name);
    const data = { by, name, revoked: account !== undefined, host_removed: isHost };
    this.deps.journal({ type: "peer_removed", data });
    return { ok: true, result: { name, revoked: data.revoked, host_removed: isHost } };
  }

  /**
   * `peer_doctor`'s request, checked before anything runs: the host to run it on, or the refusal.
   * The run itself (`runDoctor`) is an ssh round-trip of up to `peer_doctor_timeout_ms`, so the
   * daemon awaits it outside its queue. `origin` is the wave repo's normalised origin
   * (`<host>/<path>`) the box's doctor clones from with `clone`; null when none is known.
   */
  doctorRequest(p: Fields, origin: string | null): PeerReply | DoctorRun {
    const name = p.name;
    if (typeof name !== "string" || !isValidAgentId(name)) {
      return refuse("name must match [a-z0-9][a-z0-9_-]{0,62}");
    }
    if (p.fix !== undefined && typeof p.fix !== "boolean")
      return refuse("fix must be true or false");
    if (p.clone !== undefined && typeof p.clone !== "boolean") {
      return refuse("clone must be true or false");
    }
    const fix = p.fix === true;
    const clone = p.clone === true;
    if (clone && !fix) return refuse("clone needs fix: true (the doctor clones only as a fix)");
    if (!Object.hasOwn(this.deps.hosts(), name))
      return refuse(`no configured host named "${name}"`);
    const url = clone ? cloneUrl(origin) : null;
    if (clone && url === null) {
      return refuse(
        `the wave repo's origin is not known (${origin === null ? "no running wave's clone reports one" : `${origin} cannot be cloned over https`}): clone it on "${name}" by hand, or repair while the wave runs`,
      );
    }
    const host = this.deps.remote?.(name) ?? "remote hosts are not available";
    if (typeof host === "string") return refuse(host);
    return { name, fix, clone, host, ...(url !== null ? { origin: url } : {}) };
  }

  /** Run a checked `peer_doctor` on its box: the report (and the plan without `fix`), or why not. */
  async runDoctor({ name, fix, host, origin }: DoctorRun): Promise<PeerReply> {
    let report: DoctorReport;
    try {
      report = await host.runDoctor({ fix, ...(origin !== undefined ? { clone: origin } : {}) });
    } catch (e) {
      return refuse(e instanceof Error ? e.message : String(e));
    }
    return {
      ok: true,
      result: { name, fix, ...report, ...(fix ? {} : { plan: doctorPlan(report) }) },
    };
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
    return this.readFile().peers;
  }

  /** `peers.json`: the paired machines, and the removals in progress (`removing`). */
  private readFile(): {
    peers: Record<string, PairedMachine>;
    removing: Record<string, PendingRemoval>;
  } {
    const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {});
    if (!existsSync(this.deps.pairedFile)) return { peers: {}, removing: {} };
    try {
      const f = JSON.parse(readFileSync(this.deps.pairedFile, "utf-8")) as {
        peers?: unknown;
        removing?: unknown;
      };
      return {
        peers: obj(f.peers) as Record<string, PairedMachine>,
        removing: obj(f.removing) as Record<string, PendingRemoval>,
      };
    } catch {
      return { peers: {}, removing: {} };
    }
  }

  private writePaired(peers: Record<string, PairedMachine>): void {
    this.writeFile(peers, this.removals());
  }

  private writeFile(
    peers: Record<string, PairedMachine>,
    removing: Record<string, PendingRemoval>,
  ): void {
    writeJson(this.deps.pairedFile, {
      peers,
      ...(Object.keys(removing).length > 0 ? { removing } : {}),
    });
  }

  /** The outstanding code `code` is, or null; a wrong one counts towards revoking them all. */
  private match(code: string): StoredCode | null {
    const n = normalizeCode(code);
    const found = isPairingCode(`${n.slice(0, 4)}-${n.slice(4)}`)
      ? this.live().find((c) =>
          timingSafeEqual(
            hashCode(n, Buffer.from(c.salt, "base64url")),
            Buffer.from(c.hash, "base64url"),
          ),
        )
      : undefined;
    if (found !== undefined) return found;
    this.failures++;
    if (this.failures >= DAEMON_DEFAULTS.peer_join_max_failures) {
      this.failures = 0;
      this.write([]);
    }
    return null;
  }

  /** Burn a matched code. */
  private consume(entry: StoredCode): void {
    this.write(this.live().filter((c) => c.hash !== entry.hash));
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

/** A checked `peer_doctor` request (`doctorRequest`), ready to run. */
export interface DoctorRun {
  name: string;
  fix: boolean;
  clone: boolean;
  host: RemoteHost;
  /** With `clone`: the URL the doctor clones from (`--origin`). */
  origin?: string;
}

/**
 * The URL a box's doctor clones the wave repo from: `https://` + a normalised origin
 * (`<host>/<path>`, volley-cli's `normalizeOrigin`), which `gh auth setup-git` signs git in to.
 * Null when there is none, or it has a port (ssh or https cannot be told apart), or the fence
 * would refuse it.
 */
export function cloneUrl(origin: string | null | undefined): string | null {
  if (origin === null || origin === undefined || /^[^/]*:/.test(origin)) return null;
  const url = `https://${origin}`;
  return isCloneUrl(url) ? url : null;
}

/** What a fix would change: each failing check with its fix text, in the doctor's order. */
export function doctorPlan(
  r: DoctorReport,
): { id: string; severity: string; detail: string; fix: string }[] {
  return r.checks.flatMap((c) =>
    !c.ok && typeof c.fix === "string"
      ? [{ id: c.id, severity: c.severity, detail: c.detail, fix: c.fix }]
      : [],
  );
}

/** One `peers.json` entry. */
export interface PairedMachine {
  target: string;
  joined_at: string;
}

/** `drain`: the running agents finish; `now`: the daemon stops them (`stop_grace_s`). */
export type RemovalMode = "drain" | "now";

/** A `peer_remove { drain | now }` that has not finished (`peers.json` `removing`). */
export interface PendingRemoval {
  by: string;
  mode: RemovalMode;
  /** When it was asked for (the grace of `now` counts from it). */
  at: string;
}

/** Atomically, mode 0600. */
function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
