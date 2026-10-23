import { homedir } from "node:os";
import { join } from "node:path";
import { type Clock, dateOf, sleep, systemClock } from "../clock";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn } from "../exec";
import type { RemoteHost } from "../hosts/ssh-tmux";
import type { MachineRecord } from "../machines";
import { sessionsRunningIn } from "../procs";
import { readClaudeJson } from "../trust";
import type { NewEvent } from "../types";
import { type LoginIdentity, loginIdentity, readLoginIdentity } from "./identity";
import {
  type ClaudeAccount,
  ClaudeAccountError,
  LOCAL_MACHINE,
  PRIMARY_ACCOUNT,
  type SelectedAccount,
  addAccount,
  machineCandidates,
  markSignedIn,
  profileDir,
  readRegistry,
  selectAccount,
} from "./profiles";
import {
  remoteAccount,
  remoteAccountHost,
  remoteProfileDir,
  runRemoteSignin,
} from "./remote-signin";
import {
  type ProfileKeys,
  type ShareResult,
  SharingError,
  applySharing,
  planSharing,
  profileReady,
  readSharing,
  seedProfile,
  syncMcp,
} from "./sharing";
import { SUPERSEDED, type SigninEvent, parseAuthStatus, profileEnv, runSignin } from "./signin";
import { MODEL_FAMILIES, type Ranked } from "./usage";

const unranked = (account: string): Ranked => ({
  account,
  headroom: null,
  five_hour_pct: null,
  weekly_pct: null,
  agents: 0,
});

/**
 * The daemon's Claude account profiles: the control ops (`claude_accounts`,
 * `claude_account_add`, `claude_signin`, `claude_sync`), the background sign-ins, and the
 * profile preparation and account selection a spawn uses. The `_system` journal records the
 * registry changes and each sign-in's start and end — never its URL, which is published only on
 * the non-retained `volley/_system/claude/<acct>/signin` topic and kept in memory while the
 * sign-in runs (`claude_accounts` shows it to a client that attached late). `claude_signin` for
 * `primary@<name>` signs a paired machine's own default profile in (remote-signin.ts), and a
 * profile added with `machine: <name>` lives on that machine, signed in as `<acct>@<name>`.
 */

export const signinTopic = (acct: string) => `volley/_system/claude/${acct}/signin`;
export const SIGNIN_CHANNEL = "_system/claude";

export interface ClaudeServiceDeps {
  /** The profiles root (`claudeRoot()`). */
  root: string;
  /** The primary profile's directory (`~/.claude`): what `linked` / `copy` share from. */
  primaryDir?: string;
  /** The primary's `~/.claude.json`: where the MCP servers are synced from. */
  primaryJson: string;
  exec: ExecFn;
  /** Publish a sign-in event on its topic (non-retained). */
  publish: (topic: string, e: SigninEvent) => Promise<void>;
  journal: (ev: NewEvent) => Promise<void>;
  log: (line: string) => void;
  /** The sign-in poll's timers and wall clock (default: real). */
  clock?: Clock;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signinPollMs?: number;
  signinTimeoutMs?: number;
  /**
   * Usage metering's ranking of `candidates` (usage-record keys) for an agent of `model`
   * (claude/usage.ts rankAccounts): the balancing rule a spawn picks by.
   */
  rank?: (candidates: readonly string[], model: string | null) => Ranked[];
  /**
   * The primary's plan or sign-in state changed (`claude_accounts` asked): its usage record is
   * out of date.
   */
  onPrimaryPlan?: () => void;
  /** A paired machine by name, or why it cannot be reached: its sign-ins (`…@<name>`). */
  remote?: (name: string) => RemoteHost | string;
  /** Ports a sign-in forward never takes: the config's broker tunnels and the broker's own. */
  reservedPorts?: () => number[];
  /** How long a sign-in forward must stay up before its URL is published (tests). */
  forwardSettleMs?: number;
  /** A machine record's default-profile identity (`auth.claude_email/claude_org`), by name. */
  machineIdentity?: (name: string) => LoginIdentity;
  /** Every machine record (the supervisor's own and each paired machine's): `claude_accounts`. */
  machines?: () => MachineRecord[];
}

/** What a sign-in run gets from the service: its stop signal, timers and publisher. */
interface SigninRun {
  signal: AbortSignal;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  timeoutMs: number;
  publish: (e: SigninEvent) => Promise<void>;
}

type Reply = { ok: boolean; error?: string; result?: unknown };

interface Pending {
  abort: AbortController;
  url?: UrlEvent;
  /** Resolves with the URL event, or the terminal event if the sign-in ended first. */
  first: Promise<SigninEvent>;
  done: Promise<SigninEvent>;
}

export class ClaudeService {
  private readonly signins = new Map<string, Pending>();
  private readonly clock: Clock;
  /** The primary's plan as `claude auth status` last said it; undefined: not known. */
  private primaryPlan: string | undefined;
  /** False once `claude auth status` said the primary is signed out: it then has no identity. */
  private primarySignedIn: boolean | undefined;
  private primaryAsk: Promise<void> | undefined;
  /** Each paired machine's HOME, once a sign-in there learned it: where its profiles are. */
  private readonly homes = new Map<string, string>();
  private versionAsk: Promise<string | undefined> | undefined;
  constructor(private readonly d: ClaudeServiceDeps) {
    // real clock: the default when the daemon injects no clock
    this.clock = d.clock ?? systemClock;
  }

  private get primaryDir(): string {
    return this.d.primaryDir ?? join(homedir(), ".claude");
  }

  /** The account a spawn runs under (profiles.ts selectAccount over the current registry). */
  select(want: {
    task?: string;
    wave?: string;
    configDefault?: string | null;
    machine?: string;
    model?: string | null;
  }): SelectedAccount {
    const rank = this.d.rank;
    return selectAccount(
      this.d.root,
      () => readRegistry(this.d.root),
      want,
      rank !== undefined ? (c) => rank(c, want.model ?? null) : undefined,
    );
  }

  /**
   * Accounts an agent on `machine` can start under, as usage-record keys: the primary, then every
   * signed-in profile kept for that machine (`primary@<name>`, `<id>@<name>` on a paired one).
   */
  candidates(machine: string = LOCAL_MACHINE): string[] {
    return machineCandidates({ version: 1, accounts: this.registry() }, machine);
  }

  /**
   * `claude_balance { model?, machine? }`: per machine (`local` and each of `machines`), the
   * candidates ranked for `model` (default: each family's ranking's pick) — pure over the
   * current records.
   */
  balance(p: Record<string, unknown>, machines: readonly string[]): Reply {
    const model = typeof p.model === "string" && p.model !== "" ? p.model : null;
    const only = typeof p.machine === "string" && p.machine !== "" ? p.machine : null;
    const rank = this.d.rank ?? ((c: readonly string[]) => c.map((account) => unranked(account)));
    const names = [LOCAL_MACHINE, ...machines.filter((m) => m !== LOCAL_MACHINE)];
    if (only !== null && !names.includes(only)) return { ok: false, error: `no machine '${only}'` };
    const out = names
      .filter((n) => only === null || n === only)
      .map((name) => {
        const cands = this.candidates(name);
        const picks: Record<string, string | null> = {};
        for (const f of model !== null ? [model] : MODEL_FAMILIES) {
          const key = model !== null ? "model" : f;
          picks[key] = rank(cands, model ?? f)[0]?.account ?? null;
        }
        return { name, candidates: rank(cands, model), picks };
      });
    return { ok: true, result: { ...(model !== null ? { model } : {}), machines: out } };
  }

  /** The registry account whose profile is `dir` (a usage sample's `config_dir`), if any. */
  accountForDir(dir: string): string | null {
    const canonical = dir.replace(/\/+$/, "");
    return this.registry().find((a) => profileDir(this.d.root, a.id) === canonical)?.id ?? null;
  }

  /**
   * The account record a usage probe login of `machine` (`local`: the supervisor's own) folds
   * into: `default` is `primary` here, `primary@<machine>` there; a profile is the registry's
   * account of that id on that machine (`<id>`, or `<id>@<machine>`). A login the registry does
   * not have on that machine: null (skipped).
   */
  accountForLogin(machine: string, profile: string): string | null {
    const local = machine === LOCAL_MACHINE;
    if (profile === "default")
      return local ? PRIMARY_ACCOUNT : remoteAccount(PRIMARY_ACCOUNT, machine);
    const a = this.registry().find((x) => x.id === profile && x.machine === machine);
    if (a === undefined) return null;
    return local ? a.id : remoteAccount(a.id, machine);
  }

  /**
   * An account's usage-record facts: a registry account's label, plan and identity; the primary's
   * plan once known and its identity; a paired machine's (`primary@<name>`) identity from its
   * machine record.
   */
  describe(acct: string): { label?: string; plan?: string } & LoginIdentity {
    if (acct === PRIMARY_ACCOUNT) return this.primaryFacts();
    const remote = remoteAccountHost(acct);
    if (remote?.acct === PRIMARY_ACCOUNT) return this.d.machineIdentity?.(remote.name) ?? {};
    const a = this.registry().find((x) =>
      remote === null
        ? x.id === acct && x.machine === LOCAL_MACHINE
        : x.id === remote.acct && x.machine === remote.name,
    );
    if (a === undefined) return {};
    return {
      label: a.label,
      ...(a.plan !== undefined ? { plan: a.plan } : {}),
      ...this.identityOf(a),
    };
  }

  /** The primary's plan and identity: none of it once `claude auth status` said it is signed out. */
  private primaryFacts(): { plan?: string } & LoginIdentity {
    if (this.primarySignedIn === false) return {};
    return {
      ...(this.primaryPlan !== undefined ? { plan: this.primaryPlan } : {}),
      ...readLoginIdentity(this.d.primaryJson),
    };
  }

  /**
   * A registry account's identity: its profile's `.claude.json` when readable (the file wins: it
   * is what Claude Code says now), else what the registry recorded at sign-in (always, for a
   * profile on a paired machine). A profile not signed in has none.
   */
  private identityOf(a: ClaudeAccount): LoginIdentity {
    if (a.signed_in_at === undefined) return {};
    const json =
      a.machine === LOCAL_MACHINE
        ? readClaudeJson(join(profileDir(this.d.root, a.id), ".claude.json"))
        : null;
    if (json !== null) return loginIdentity(json);
    return {
      ...(a.email !== undefined ? { email: a.email } : {}),
      ...(a.org !== undefined ? { org: a.org } : {}),
    };
  }

  /** The registry, or none when it cannot be read (usage metering never fails on it). */
  private registry(): ClaudeAccount[] {
    try {
      return readRegistry(this.d.root).accounts;
    } catch {
      return [];
    }
  }

  /**
   * Sharing (sharing.yaml), the onboarding seed (seedLocal) and, for `mcp: copy`, the MCP servers
   * sync: before every spawn.
   */
  async prepare(acct: {
    id: string;
    dir: string;
  }): Promise<{ shared: ShareResult[]; mcp_servers?: number }> {
    const sharing = readSharing(this.d.root);
    const shared = applySharing(planSharing(sharing, this.primaryDir, acct.dir));
    await this.seedLocal(acct);
    if (sharing.mcp !== "copy") return { shared };
    const mcp = syncMcp(this.d.primaryJson, join(acct.dir, ".claude.json"));
    return { shared, mcp_servers: mcp.servers.length };
  }

  /**
   * Claude Code's version on this machine (`claude --version`), else the one the primary profile
   * recorded (`lastOnboardingVersion`): what a seeded profile records. Asked once.
   */
  claudeVersion(): Promise<string | undefined> {
    this.versionAsk ??= (async () => {
      try {
        const r = await this.d.exec(["claude", "--version"], {
          timeoutMs: DAEMON_DEFAULTS.claude_auth_status_timeout_ms,
        });
        const v = /\b\d+\.\d+\.\d+\S*/.exec(r.stdout)?.[0];
        if (r.code === 0 && v !== undefined) return v;
      } catch {} // no `claude` here
      const own = readClaudeJson(this.d.primaryJson)?.lastOnboardingVersion;
      return typeof own === "string" && own !== "" ? own : undefined;
    })();
    return this.versionAsk;
  }

  /**
   * Make a local profile ready to run agents unattended (sharing.ts seedProfile) unless it is,
   * and only while no agent session runs in it: Claude Code rewrites `.claude.json` from memory,
   * so a write under a running session would be lost. Null: nothing to do, or put off.
   */
  private async seedLocal(acct: { id: string; dir: string }): Promise<ProfileKeys | null> {
    const missing = profileReady(acct.dir);
    if (missing[".claude.json"].length === 0 && missing["settings.json"].length === 0) return null;
    const running = await sessionsRunningIn(this.d.exec, acct.dir).catch(() => 0);
    if (running > 0) {
      this.d.log(
        `profile ${acct.id}: onboarding keys missing while ${running} session(s) run; re-checked at the next spawn`,
      );
      return null;
    }
    const v = await this.claudeVersion();
    return seedProfile(acct.dir, v !== undefined ? { claudeVersion: v } : {});
  }

  /**
   * Seed a profile on the machine it lives on: a local one in place, a paired machine's through
   * its host (RemoteHost.seedProfile). Its agent's session must have ended: callers are a
   * sign-in that just completed, a spawn before its launch, and the first-run repair after the
   * stuck session was closed. Returns the keys written, per file.
   */
  async seedProfile(acct: { id: string; dir: string; machine: string }): Promise<ProfileKeys> {
    const v = await this.claudeVersion();
    if (acct.machine === LOCAL_MACHINE)
      return seedProfile(acct.dir, v !== undefined ? { claudeVersion: v } : {});
    const host = this.d.remote?.(acct.machine) ?? `no paired machine '${acct.machine}'`;
    if (typeof host === "string") throw new Error(host);
    return host.seedProfile(acct.dir, v);
  }

  /** After a sign-in: seed the profile, and say why not (the sign-in itself stands). */
  private async seedAfterSignin(acct: { id: string; dir: string; machine: string }) {
    try {
      const keys = await this.seedProfile(acct);
      const all = [...keys[".claude.json"], ...keys["settings.json"]];
      if (all.length > 0) this.d.log(`profile ${acct.id}: prepared (${all.join(", ")})`);
    } catch (e) {
      this.d.log(
        `profile ${acct.id}: not prepared after its sign-in: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** A local profile's sign-in run, which prepares the profile once it is signed in. */
  private localSignin(acct: string) {
    return (r: SigninRun) =>
      runSignin({
        ...r,
        exec: this.d.exec,
        root: this.d.root,
        acct,
        publish: async (e) => {
          if (e.type === "claude_signin_done")
            await this.seedAfterSignin({
              id: acct,
              dir: profileDir(this.d.root, acct),
              machine: LOCAL_MACHINE,
            });
          await r.publish(e);
        },
      });
  }

  /**
   * The primary's plan, from `claude auth status` of Claude Code's default profile (no
   * `CLAUDE_CONFIG_DIR`, as a primary agent runs). Never guessed: a profile that is not logged in,
   * says no plan, or does not answer has none. Concurrent asks share one run.
   */
  private askPrimary(): Promise<void> {
    this.primaryAsk ??= (async () => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "CLAUDE_CONFIG_DIR"),
      );
      let plan: string | undefined;
      let signedIn: boolean | undefined;
      try {
        const r = await this.d.exec(["claude", "auth", "status"], {
          env,
          timeoutMs: DAEMON_DEFAULTS.claude_auth_status_timeout_ms,
        });
        const status = parseAuthStatus(r.stdout);
        plan = status?.loggedIn === true ? status.plan : undefined;
        signedIn = status?.loggedIn;
      } catch {
        plan = undefined; // no `claude` here
      }
      // Signing out drops the identity too: the usage record changes even when the plan did not.
      if (plan === this.primaryPlan && signedIn === this.primarySignedIn) return;
      this.primaryPlan = plan;
      this.primarySignedIn = signedIn;
      this.d.onPrimaryPlan?.();
    })().finally(() => {
      this.primaryAsk = undefined;
    });
    return this.primaryAsk;
  }

  /**
   * `claude_accounts`: the registry, each account's running sign-in, the sharing modes, the
   * primary (`{ plan?, email?, org? }`: Claude Code's default profile, never in the registry), and
   * every machine record's Claude login (`machines`).
   */
  async list(): Promise<Reply> {
    await this.askPrimary();
    try {
      const accounts = readRegistry(this.d.root).accounts.map((a) => this.withSignin(a));
      return {
        ok: true,
        result: {
          root: this.d.root,
          accounts,
          primary: this.primaryFacts(),
          machines: (this.d.machines?.() ?? []).map(machineLogin),
          remote_signins: this.remoteSignins(),
          sharing: readSharing(this.d.root),
        },
      };
    } catch (e) {
      if (e instanceof ClaudeAccountError || e instanceof SharingError)
        return { ok: false, error: e.message };
      throw e;
    }
  }

  private withSignin(a: ClaudeAccount) {
    const p = this.signins.get(signinKey(a));
    const signin =
      p === undefined
        ? a.signed_in_at !== undefined
          ? { state: "signed_in" }
          : { state: "signed_out" }
        : pendingSignin(p);
    const { email: _e, org: _o, ...rest } = a;
    return { ...rest, ...this.identityOf(a), ...this.dirOf(a), signin };
  }

  /** A profile's dir: here, or on its paired machine once a sign-in there learned its HOME. */
  private dirOf(a: ClaudeAccount): { dir?: string } {
    if (a.machine === LOCAL_MACHINE) return { dir: profileDir(this.d.root, a.id) };
    const home = this.homes.get(a.machine);
    return home !== undefined ? { dir: remoteProfileDir(home, a.id) } : {};
  }

  /** Paired machines' sign-ins still waiting (every `<acct>@<name>`, its own or a profile). */
  private remoteSignins() {
    return [...this.signins]
      .filter(([acct]) => remoteAccountHost(acct) !== null)
      .map(([acct, p]) => ({ acct, ...pendingSignin(p) }));
  }

  /**
   * `claude_account_add { label, machine?, by }`: the profile dir and registry entry, then the
   * background sign-in. Answers once the sign-in URL is known (or the sign-in ended first).
   */
  async add(p: Record<string, unknown>, by: string): Promise<Reply> {
    const label = typeof p.label === "string" ? p.label : "";
    const machine = typeof p.machine === "string" && p.machine !== "" ? p.machine : LOCAL_MACHINE;
    if (label.trim() === "") return { ok: false, error: "claude_account_add needs a label" };
    const host =
      machine === LOCAL_MACHINE
        ? null
        : (this.d.remote?.(machine) ?? `no paired machine '${machine}'`);
    if (typeof host === "string") return { ok: false, error: host };
    let acct: ClaudeAccount;
    try {
      acct = addAccount(this.d.root, { label, machine }, dateOf(this.clock).toISOString());
    } catch (e) {
      if (e instanceof ClaudeAccountError) return { ok: false, error: e.message };
      throw e;
    }
    await this.d.journal({
      type: "claude_account_added",
      data: { acct: acct.id, label: acct.label, machine: acct.machine, by },
    });
    if (host !== null) return this.remoteProfileSignin(acct, host, by, { account: acct });
    return this.answerSignin(acct.id, by, { account: acct }, this.localSignin(acct.id));
  }

  /**
   * `claude_signin { acct, by }`: sign an existing profile in (again), a paired machine's own
   * default profile (`primary@<name>`), or a profile the supervisor created there
   * (`<acct>@<name>`).
   */
  async signin(p: Record<string, unknown>, by: string): Promise<Reply> {
    const acct = typeof p.acct === "string" ? p.acct : "";
    const remote = remoteAccountHost(acct);
    if (remote?.acct === PRIMARY_ACCOUNT) return this.remoteSignin(acct, remote.name, by);
    const accounts = readRegistry(this.d.root).accounts;
    if (remote !== null) {
      const a = accounts.find((x) => x.id === remote.acct && x.machine === remote.name);
      if (a === undefined) return { ok: false, error: `unknown Claude account '${acct}'` };
      const host = this.d.remote?.(remote.name) ?? `no paired machine '${remote.name}'`;
      if (typeof host === "string") return { ok: false, error: host };
      // As here: a signed-in profile would end the new sign-in at its first poll.
      const home =
        this.homes.get(remote.name) ??
        (await host
          .run([{ argv: ["printenv", "HOME"] }], {
            timeoutMs: DAEMON_DEFAULTS.claude_auth_status_timeout_ms,
          })
          .then((r) => (r.code === 0 ? r.stdout.trim() : ""))
          .catch(() => ""));
      if (home.startsWith("/") && !home.includes("\n")) {
        this.homes.set(remote.name, home);
        const dir = remoteProfileDir(home, a.id);
        const status = await host
          .run([{ argv: ["claude", "auth", "status"], env: { CLAUDE_CONFIG_DIR: dir } }], {
            timeoutMs: DAEMON_DEFAULTS.claude_auth_status_timeout_ms,
          })
          .catch(() => null);
        if (parseAuthStatus(status?.stdout ?? "")?.loggedIn === true)
          return {
            ok: false,
            error: `Claude account '${acct}' is already signed in; to sign it in as another Claude account, run \`ssh ${host.spec.target} CLAUDE_CONFIG_DIR=${dir} claude auth logout\` first`,
          };
      }
      return this.remoteProfileSignin(a, host, by, {});
    }
    if (!accounts.some((a) => a.id === acct && a.machine === LOCAL_MACHINE))
      return { ok: false, error: `unknown Claude account '${acct}'` };
    // A signed-in profile would end the new sign-in at its first poll, before any login.
    const dir = profileDir(this.d.root, acct);
    const status = await this.d.exec(["claude", "auth", "status"], {
      env: profileEnv(process.env, dir),
      timeoutMs: DAEMON_DEFAULTS.claude_auth_status_timeout_ms,
    });
    if (parseAuthStatus(status.stdout)?.loggedIn === true)
      return {
        ok: false,
        error: `Claude account '${acct}' is already signed in; to sign it in as another Claude account, run \`CLAUDE_CONFIG_DIR=${dir} claude auth logout\` first`,
      };
    return this.answerSignin(acct, by, {}, this.localSignin(acct));
  }

  /**
   * `claude_signin { acct: "primary@<name>" }`: Claude Code's own login on the paired machine,
   * its callback forwarded to this machine (remote-signin.ts). Refused for a machine that is not
   * configured, or whose Claude Code is already signed in.
   */
  private async remoteSignin(acct: string, name: string, by: string): Promise<Reply> {
    const host = this.d.remote?.(name) ?? `no paired machine '${name}'`;
    if (typeof host === "string") return { ok: false, error: host };
    const status = await host
      .run([{ argv: ["claude", "auth", "status"] }], {
        timeoutMs: DAEMON_DEFAULTS.claude_auth_status_timeout_ms,
      })
      .catch(() => null);
    if (parseAuthStatus(status?.stdout ?? "")?.loggedIn === true)
      return {
        ok: false,
        error: `Claude Code on '${name}' is already signed in; to sign it in as another Claude account, run \`ssh ${host.spec.target} claude auth logout\` first`,
      };
    return this.answerSignin(acct, by, {}, (r) =>
      runRemoteSignin({
        ...r,
        host,
        exec: this.d.exec,
        reservedPorts: this.d.reservedPorts?.() ?? [],
        ...(this.d.forwardSettleMs !== undefined ? { settleMs: this.d.forwardSettleMs } : {}),
      }),
    );
  }

  /**
   * A profile on a paired machine (`<acct>@<name>`): Claude Code's own login there under
   * `<home>/.volley/claude/<acct>`, as `primary@<name>`'s is (remote-signin.ts). Its done event
   * records the plan and identity in the registry before it is published.
   */
  private remoteProfileSignin(
    a: ClaudeAccount,
    host: RemoteHost,
    by: string,
    extra: Record<string, unknown>,
  ): Promise<Reply> {
    return this.answerSignin(remoteAccount(a.id, a.machine), by, extra, (r) =>
      runRemoteSignin({
        ...r,
        host,
        exec: this.d.exec,
        reservedPorts: this.d.reservedPorts?.() ?? [],
        ...(this.d.forwardSettleMs !== undefined ? { settleMs: this.d.forwardSettleMs } : {}),
        acct: a.id,
        profile: true,
        onHome: (home) => this.homes.set(a.machine, home),
        publish: async (e) => {
          if (e.type === "claude_signin_done") {
            const { type: _t, acct: _a, ...facts } = e;
            const home = this.homes.get(a.machine);
            markSignedIn(
              this.d.root,
              a.id,
              { ...facts, ...(home !== undefined ? { dir: remoteProfileDir(home, a.id) } : {}) },
              new Date(r.now()).toISOString(),
            );
            // Its sign-in session has ended: nothing runs in the profile yet.
            if (home !== undefined)
              await this.seedAfterSignin({
                id: a.id,
                dir: remoteProfileDir(home, a.id),
                machine: a.machine,
              });
          }
          await r.publish(e);
        },
      }),
    );
  }

  private async answerSignin(
    acct: string,
    by: string,
    extra: Record<string, unknown>,
    run: (r: SigninRun) => Promise<SigninEvent>,
  ) {
    const first = await this.startSignin(acct, by, run).first;
    if (first.type === "claude_signin_failed") return { ok: false, error: first.reason };
    return {
      ok: true,
      result: {
        ...extra,
        acct,
        topic: signinTopic(acct),
        ...(first.type === "claude_signin_url" ? urlFields(first) : { signed_in: true }),
      },
    };
  }

  private startSignin(
    acct: string,
    by: string,
    run: (r: SigninRun) => Promise<SigninEvent>,
  ): Pending {
    this.signins.get(acct)?.abort.abort(SUPERSEDED);
    const abort = new AbortController();
    let first!: (e: SigninEvent) => void;
    const pending: Pending = {
      abort,
      first: new Promise<SigninEvent>((r) => {
        first = r;
      }),
      done: Promise.resolve() as unknown as Promise<SigninEvent>,
    };
    this.signins.set(acct, pending);
    this.d
      .journal({ type: "claude_signin_started", data: { acct, by } })
      .catch((e: unknown) =>
        this.d.log(`claude sign-in ${acct}: ${e instanceof Error ? e.message : String(e)}`),
      );
    pending.done = run({
      signal: abort.signal,
      now: this.d.now ?? this.clock.now,
      // The daemon stopping ends a wait at once.
      sleep: this.d.sleep ?? ((ms) => sleep(this.clock, ms, abort.signal)),
      pollMs: this.d.signinPollMs ?? DAEMON_DEFAULTS.claude_signin_poll_ms,
      timeoutMs: this.d.signinTimeoutMs ?? DAEMON_DEFAULTS.claude_signin_timeout_ms,
      publish: async (e) => {
        if (e.type === "claude_signin_url") pending.url = e;
        first(e);
        await this.d.publish(signinTopic(acct), e);
      },
    })
      .catch(
        (e: unknown): SigninEvent => ({
          type: "claude_signin_failed",
          acct,
          reason: e instanceof Error ? e.message : String(e),
        }),
      )
      .then(async (e) => {
        first(e);
        if (this.signins.get(acct) === pending) this.signins.delete(acct);
        // The login's identity stays out of the journal: the registry and the records carry it.
        const { type, ...data } = e.type === "claude_signin_done" ? withoutIdentity(e) : e;
        if (type !== "claude_signin_url") await this.d.journal({ type, data });
        this.d.log(`claude sign-in ${acct}: ${type}`);
        return e;
      });
    return pending;
  }

  /** `claude_sync { acct?, by }`: re-apply sharing and re-sync the MCP servers (all accounts). */
  async sync(p: Record<string, unknown>, by: string): Promise<Reply> {
    const want = typeof p.acct === "string" && p.acct !== "" ? p.acct : undefined;
    const accounts = readRegistry(this.d.root).accounts.filter(
      (a) => a.machine === LOCAL_MACHINE && (want === undefined || a.id === want),
    );
    if (want !== undefined && accounts.length === 0)
      return { ok: false, error: `unknown Claude account '${want}' on this machine` };
    const out: Record<string, unknown>[] = [];
    for (const a of accounts) {
      const r = await this.prepare({ id: a.id, dir: profileDir(this.d.root, a.id) });
      const shared = Object.fromEntries(r.shared.map((s) => [s.item, s.result]));
      await this.d.journal({
        type: "claude_profile_synced",
        data: {
          acct: a.id,
          shared,
          ...(r.mcp_servers !== undefined ? { mcp_servers: r.mcp_servers } : {}),
          by,
        },
      });
      out.push({
        acct: a.id,
        shared,
        ...(r.mcp_servers !== undefined ? { mcp_servers: r.mcp_servers } : {}),
      });
    }
    return { ok: true, result: { synced: out } };
  }

  /** Stop every running sign-in (the daemon stopping); waits for them to end. */
  async stop(): Promise<void> {
    const all = [...this.signins.values()];
    for (const p of all) p.abort.abort();
    await Promise.all(all.map((p) => p.done));
  }
}

type UrlEvent = Extract<SigninEvent, { type: "claude_signin_url" }>;

/** The account a registry profile's sign-in runs as: its id here, `<id>@<machine>` there. */
const signinKey = (a: ClaudeAccount) =>
  a.machine === LOCAL_MACHINE ? a.id : remoteAccount(a.id, a.machine);

/** The URL fields of a sign-in's URL event, as a reply or `claude_accounts` shows them. */
const urlFields = (e: UrlEvent) => ({
  url: e.url,
  flow: e.flow,
  attach: e.attach,
  ...(e.manual_url !== undefined ? { manual_url: e.manual_url } : {}),
});

/** A done event without the login's identity: as the journal records it. */
function withoutIdentity(e: Extract<SigninEvent, { type: "claude_signin_done" }>) {
  const { email: _email, org: _org, ...rest } = e;
  return rest;
}

/** A machine record's Claude login as `claude_accounts` shows it: state, plan and identity. */
function machineLogin(r: MachineRecord) {
  const a = r.auth;
  return {
    name: r.name,
    ...(r.kind !== undefined ? { kind: r.kind } : {}),
    claude: a?.claude ?? "unknown",
    ...(typeof a?.claude_plan === "string" ? { plan: a.claude_plan } : {}),
    ...(a?.claude_email !== undefined ? { email: a.claude_email } : {}),
    ...(a?.claude_org !== undefined ? { org: a.claude_org } : {}),
    tunnel: r.tunnel,
  };
}

/** A running sign-in as `claude_accounts` shows it: pending, with its URL once known. */
const pendingSignin = (p: Pending) => ({
  state: "pending",
  ...(p.url !== undefined ? urlFields(p.url) : {}),
});
