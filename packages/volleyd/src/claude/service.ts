import { homedir } from "node:os";
import { join } from "node:path";
import { type Clock, dateOf, sleep, systemClock } from "../clock";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn } from "../exec";
import type { NewEvent } from "../types";
import {
  type ClaudeAccount,
  ClaudeAccountError,
  LOCAL_MACHINE,
  type SelectedAccount,
  addAccount,
  profileDir,
  readRegistry,
  selectAccount,
} from "./profiles";
import {
  type ShareResult,
  SharingError,
  applySharing,
  planSharing,
  readSharing,
  seedOnboarding,
  syncMcp,
} from "./sharing";
import { SUPERSEDED, type SigninEvent, parseAuthStatus, profileEnv, runSignin } from "./signin";

/**
 * The daemon's Claude account profiles: the control ops (`claude_accounts`,
 * `claude_account_add`, `claude_signin`, `claude_sync`), the background sign-ins, and the
 * profile preparation and account selection a spawn uses. The `_system` journal records the
 * registry changes and each sign-in's start and end — never its URL, which is published only on
 * the non-retained `volley/_system/claude/<acct>/signin` topic and kept in memory while the
 * sign-in runs (`claude_accounts` shows it to a client that attached late).
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
}

type Reply = { ok: boolean; error?: string; result?: unknown };

interface Pending {
  abort: AbortController;
  url?: Extract<SigninEvent, { type: "claude_signin_url" }>;
  /** Resolves with the URL event, or the terminal event if the sign-in ended first. */
  first: Promise<SigninEvent>;
  done: Promise<SigninEvent>;
}

export class ClaudeService {
  private readonly signins = new Map<string, Pending>();
  private readonly clock: Clock;
  constructor(private readonly d: ClaudeServiceDeps) {
    this.clock = d.clock ?? systemClock;
  }

  private get primaryDir(): string {
    return this.d.primaryDir ?? join(homedir(), ".claude");
  }

  /** The account a spawn runs under (profiles.ts selectAccount over the current registry). */
  select(want: { task?: string; wave?: string; configDefault?: string | null }): SelectedAccount {
    return selectAccount(this.d.root, () => readRegistry(this.d.root), want);
  }

  /**
   * Sharing (sharing.yaml), the onboarding seed and, for `mcp: copy`, the MCP servers sync:
   * before every spawn.
   */
  prepare(acct: { id: string; dir: string }): { shared: ShareResult[]; mcp_servers?: number } {
    const sharing = readSharing(this.d.root);
    const shared = applySharing(planSharing(sharing, this.primaryDir, acct.dir));
    seedOnboarding(join(acct.dir, ".claude.json"));
    if (sharing.mcp !== "copy") return { shared };
    const mcp = syncMcp(this.d.primaryJson, join(acct.dir, ".claude.json"));
    return { shared, mcp_servers: mcp.servers.length };
  }

  /** `claude_accounts`: the registry, each account's running sign-in, and the sharing modes. */
  list(): Reply {
    try {
      const accounts = readRegistry(this.d.root).accounts.map((a) => this.withSignin(a));
      return {
        ok: true,
        result: { root: this.d.root, accounts, sharing: readSharing(this.d.root) },
      };
    } catch (e) {
      if (e instanceof ClaudeAccountError || e instanceof SharingError)
        return { ok: false, error: e.message };
      throw e;
    }
  }

  private withSignin(a: ClaudeAccount) {
    const p = this.signins.get(a.id);
    const signin =
      p === undefined
        ? a.signed_in_at !== undefined
          ? { state: "signed_in" }
          : { state: "signed_out" }
        : {
            state: "pending",
            ...(p.url !== undefined
              ? { url: p.url.url, flow: p.url.flow, attach: p.url.attach }
              : {}),
          };
    return { ...a, dir: profileDir(this.d.root, a.id), signin };
  }

  /**
   * `claude_account_add { label, machine?, by }`: the profile dir and registry entry, then the
   * background sign-in. Answers once the sign-in URL is known (or the sign-in ended first).
   */
  async add(p: Record<string, unknown>, by: string): Promise<Reply> {
    const label = typeof p.label === "string" ? p.label : "";
    const machine = typeof p.machine === "string" && p.machine !== "" ? p.machine : LOCAL_MACHINE;
    if (label.trim() === "") return { ok: false, error: "claude_account_add needs a label" };
    if (machine !== LOCAL_MACHINE)
      return {
        ok: false,
        error: `machine '${machine}': this volleyd adds profiles on its own machine only; run \`volley claude add\` against the volleyd on '${machine}'`,
      };
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
    return this.answerSignin(acct.id, by, { account: acct });
  }

  /** `claude_signin { acct, by }`: sign an existing profile in (again). */
  async signin(p: Record<string, unknown>, by: string): Promise<Reply> {
    const acct = typeof p.acct === "string" ? p.acct : "";
    if (!readRegistry(this.d.root).accounts.some((a) => a.id === acct))
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
    return this.answerSignin(acct, by, {});
  }

  private async answerSignin(acct: string, by: string, extra: Record<string, unknown>) {
    const first = await this.startSignin(acct, by).first;
    if (first.type === "claude_signin_failed") return { ok: false, error: first.reason };
    return {
      ok: true,
      result: {
        ...extra,
        acct,
        topic: signinTopic(acct),
        ...(first.type === "claude_signin_url"
          ? { url: first.url, flow: first.flow, attach: first.attach }
          : { signed_in: true }),
      },
    };
  }

  private startSignin(acct: string, by: string): Pending {
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
    pending.done = runSignin({
      exec: this.d.exec,
      root: this.d.root,
      acct,
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
        const { type, ...data } = e;
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
      const r = this.prepare({ id: a.id, dir: profileDir(this.d.root, a.id) });
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
