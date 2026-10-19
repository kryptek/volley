import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { LAYOUTS, type Layout, generateConfig, sameConfig } from "volley-cli/auth/config";
import { type AuthContext, type AuthDeps, realAuthDeps } from "volley-cli/auth/context";
import { defaultAuthDir } from "volley-cli/commands/auth";
import { DESK_PORT } from "volley-cli/commands/desk-serve";
import { realSetupDeps } from "volley-cli/commands/setup";
import type { IO } from "volley-cli/io";
import { PHONE_LABEL, newDeskPassword, planAccounts, planPhone } from "volley-cli/setup/accounts";
import { planDetect, planSecurity } from "volley-cli/setup/broker";
import { appendSetupLog, lastSetup, readSetupInstall } from "volley-cli/setup/journal";
import { planServices } from "volley-cli/setup/services";
import {
  type AnonymousProbe,
  type Change,
  type IssuedToken,
  type Planner,
  type SetupContext,
  type SetupDeps,
  type SetupExec,
  type StepName,
  type StepPlan,
  fencedExec,
  listenerUrls,
  setupFence,
} from "volley-cli/setup/step";
import {
  type AuthOutcome,
  adminRefusal,
  authReply,
  listAccounts,
  replyKey,
  seal,
} from "./accounts";
import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";
import { FenceError, mintSetupToken } from "./fence";

/**
 * The setup ops (SPEC §4.6.10): `setup_plan` and `setup_apply` run `volley setup`'s own planners
 * and steps (volley-cli's setup/) for the Desk. Nothing of a step lives here: this module builds
 * the planners' context with volleyd's deps, applies the remote policy (which changes only a
 * terminal may make), turns a `StepPlan` into the wire shape and journals. `desk_password` gives
 * the shared `desk` login a new password (no file keeps one), sealed to the admin who asked.
 *
 * Deps: every command goes through volleyd's fenced exec with a setup token (the fence's SETUP
 * rows), behind the terminal's own fence (volley-cli's `setupFence`). Nothing asks (`confirm` is
 * false, never `--yes`): the Desk is the confirmation, and a step is applied only by a
 * `setup_apply` naming its plan.
 *
 * The terminal-only policy is per change (`terminalOnly`): such a change is planned with
 * `terminal: { reason, command }`, never applied, and comes back in the report's `terminal`.
 * A broker restart is applied last, after the answer is published (`after`).
 */

export const SETUP_OPS: ReadonlySet<string> = new Set([
  "setup_plan",
  "setup_apply",
  "desk_password",
]);

const STEPS: [StepName, Planner][] = [
  ["detect", planDetect],
  ["security", planSecurity],
  ["accounts", planAccounts],
  ["services", planServices],
  ["phone", planPhone],
];
const STEP_NAMES = STEPS.map(([n]) => n as string);

/** A change only a terminal may make, and the command that makes it there. */
export interface TerminalOnly {
  reason: string;
  command: string;
}

type Fields = Record<string, unknown>;

export interface SetupOpsOptions {
  /** volleyd's fenced exec (`exec.ts`, or a test's fake). */
  exec: ExecFn;
  volleydHome: string;
  /** The broker the planners probe and log in to (volleyd's own). */
  brokerUrl: string;
  env: Record<string, string | undefined>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /**
   * Agents with a live retained status; null when it cannot tell. volleyd reads it with a short
   * registry scan (`registry_scan_ms`), not the terminal's 10 s collect, which would outlast the
   * Desk's wait for the plan.
   */
  liveAgents: () => Promise<number | null>;
  /** The broker's version as volleyd read it (`$SYS/broker/version`), or null. */
  brokerVersion: () => string | null;
  /** Overrides of the planners' deps (tests). */
  deps?: Partial<Omit<SetupDeps, "auth">> & { auth?: Partial<AuthDeps> };
  /** The auth dir (default: VOLLEY_AUTH_DIR, else the terminal's default for the layout). */
  authDir?: string;
  deskPort?: number;
}

/** An op's answer, plus what runs once it is published (the broker restart). */
export interface SetupOutcome extends AuthOutcome {
  after?: () => Promise<void>;
}

const refuse = (op: string, error: string): SetupOutcome => ({
  reply: authReply(op, { ok: false, error }),
});

// The start of each summary (the planners' wording) a terminal-only rule keys on.
const WRITE = "Write ";
const CREATE = "Create ";
const RESTART = "Restart the broker (";
const KEYCHAIN = "Store the coordinator's broker login in the macOS keychain";
const VOLLEYD_PASSWORD = "New password for volleyd,";
const VOLLEYD_SERVICE = "Install volleyd as a ";
/**
 * The accounts step's note in place of the keychain change when volleyd could not tell whether
 * the login is stored (it never reads the keychain): neither pending nor done. The Desk shows it
 * as a note, not a passed check, by these words.
 */
export const KEYCHAIN_UNCHECKED =
  "The macOS keychain can't be checked from the Desk; `volley setup` checks it in a terminal (and stores the coordinator's login there if it is missing)";

/** Every summary start `terminalOnly` keys on (a test proves the planners still make each). */
export const TERMINAL_ONLY_PREFIXES: readonly string[] = [
  WRITE,
  CREATE,
  RESTART,
  KEYCHAIN,
  VOLLEYD_PASSWORD,
  VOLLEYD_SERVICE,
];

/**
 * Which changes a Desk may not apply, keyed by the step, the change's summary (the planners'
 * wording) and the layout: anything that needs sudo or that the fence runs only on a brew layout
 * (a root-owned or containerised broker's config, state file and restart), volleyd's own service
 * or password (either would stop the volleyd answering), and the macOS keychain (the logged-in
 * session's).
 */
export function terminalOnly(
  step: StepName,
  summary: string,
  ctx: SetupContext,
): TerminalOnly | undefined {
  const layout = ctx.auth.layout;
  if (step === "security") {
    const stateFile = summary.startsWith(`${CREATE}${ctx.stateFile} `);
    const needsRoot =
      summary.startsWith(`${WRITE}${ctx.config} `) || stateFile || summary.startsWith(RESTART);
    if ((layout.name === "etc" || layout.name === "snap") && needsRoot) {
      const lan = ctx.lan === true ? " --lan" : ctx.lan === false ? " --no-lan" : "";
      return {
        reason: `it needs sudo: on this install (${layout.name}) the broker's config, its state file and its restart belong to root`,
        command: `sudo volley setup --step security${lan}`,
      };
    }
    if (layout.name === "container" && summary.startsWith(RESTART)) {
      return {
        reason: "the broker runs in a container: restart it from the host, then check again here",
        command: layout.restart,
      };
    }
    if (layout.name === "container" && stateFile) {
      return {
        reason:
          "the broker runs in a container: its state file is made with the broker's own tools, on the host",
        command: "volley setup --step security",
      };
    }
  }
  if (step === "accounts") {
    if (summary.startsWith(KEYCHAIN)) {
      return {
        reason:
          "the macOS keychain opens only in your logged-in session, which volleyd running as a service may not have",
        command: "volley setup --step accounts",
      };
    }
    if (summary.startsWith(VOLLEYD_PASSWORD)) {
      return {
        reason: "it changes volleyd's own password, which disconnects volleyd before it can answer",
        command: "volley setup --step accounts",
      };
    }
  }
  if (step === "services" && summary.startsWith(VOLLEYD_SERVICE)) {
    return {
      reason: "it installs and restarts volleyd itself, which would stop the volleyd answering",
      command: "volley setup --step services",
    };
  }
  return undefined;
}

const nonEmpty = (xs: readonly string[]) => xs.filter((x) => x !== "");

/** Everything one setup request shares: the planners' context and what the probes saw. */
interface Run {
  ctx: SetupContext;
  /** The first answer each URL's anonymous probe got (the detect step probes first). */
  probes: Map<string, AnonymousProbe>;
  /** What `volley auth` printed on stdout (passwords included: it never leaves this module). */
  out: { stdout: string; stderr: string };
  /** The token the accounts step issued, for `sealed`. */
  token?: IssuedToken;
  /** A planner asked the keychain, which volleyd never reads: whether it holds the login is unknown. */
  keychainAsked: boolean;
}

/**
 * The accounts plan without its keychain change when that change stands only for a read volleyd
 * refused: the login may well be stored, so it is a note. A keychain change planned without a
 * read (the coordinator's login is new or gets a new password) stays a terminal's change.
 */
function uncheckedKeychain(run: Run, name: StepName, plan: StepPlan): StepPlan {
  if (name !== "accounts" || !run.keychainAsked) return plan;
  const changes = plan.changes.filter((c) => !c.summary.startsWith(KEYCHAIN));
  if (changes.length === plan.changes.length) return plan;
  return { ...plan, found: [...plan.found, KEYCHAIN_UNCHECKED], changes };
}

export class SetupOps {
  private applying = false;

  constructor(private readonly o: SetupOpsOptions) {}

  /** A setup op from `sender` (the username the account-op topic names). */
  async handle(sender: string, p: Fields): Promise<SetupOutcome> {
    const op = typeof p.op === "string" ? p.op : "";
    if (op === "setup_apply") return this.apply(sender, p);
    if (op === "desk_password") return this.deskPassword(sender, p);
    const accounts = await listAccounts(this.o.exec);
    const why = typeof accounts === "string" ? accounts : adminRefusal(accounts, sender);
    if (why !== undefined) return refuse(op, why);
    const run = this.run(p);
    if (typeof run === "string") return refuse(op, run);
    const planned = await this.planSteps(run);
    const steps = planned.map(({ name, plan }) => this.wire(run, name, plan));
    const tcp = run.probes.get(run.ctx.tcpUrl);
    const ws = run.probes.get(run.ctx.wsUrl);
    const last = lastSetup(this.o.volleydHome);
    return {
      reply: authReply(op, {
        ok: true,
        result: {
          steps,
          ...(last !== undefined ? { last_setup: last } : {}),
          ...(tcp !== undefined && ws !== undefined
            ? {
                broker: {
                  accounts_required: tcp === "refused" && ws === "refused",
                  listeners: [
                    { port: portOf(run.ctx.tcpUrl), anonymous: tcp },
                    { port: portOf(run.ctx.wsUrl), anonymous: ws },
                  ],
                },
              }
            : {}),
        },
      }),
    };
  }

  /** The planners' context one request gets (`lan`, `repair` from it), or why there is none. */
  context(p: Fields = {}): SetupContext | string {
    const run = this.run(p);
    return typeof run === "string" ? run : run.ctx;
  }

  /**
   * `desk_password { reply_key }`: a new password for the shared `desk` login, sealed to the
   * admin who asked (an admin may already create an account of any role, so this adds no
   * privilege). No file keeps it, and the journal never names it.
   */
  private async deskPassword(sender: string, p: Fields): Promise<SetupOutcome> {
    const op = "desk_password";
    const key = replyKey(p.reply_key);
    if (typeof key === "string") return refuse(op, key);
    const accounts = await listAccounts(this.o.exec);
    const why = typeof accounts === "string" ? accounts : adminRefusal(accounts, sender);
    if (why !== undefined) return refuse(op, why);
    if (this.applying) {
      return refuse(op, "a setup_apply is still running: wait for its answer, then ask again");
    }
    const run = this.run(p);
    if (typeof run === "string") return refuse(op, run);
    let password: string;
    try {
      password = await newDeskPassword(run.ctx);
    } catch (e) {
      return refuse(op, e instanceof Error ? e.message : String(e));
    }
    return {
      reply: authReply(op, {
        ok: true,
        result: { username: "desk" },
        sealed: seal(key, { username: "desk", password }),
      }),
      event: { type: "desk_password_issued", data: { by: sender } },
    };
  }

  private async apply(sender: string, p: Fields): Promise<SetupOutcome> {
    const op = "setup_apply";
    const step = p.step;
    if (typeof step !== "string" || !STEP_NAMES.includes(step)) {
      return refuse(op, `step must be one of ${STEP_NAMES.join(", ")}`);
    }
    if (step === "phone") {
      return refuse(
        op,
        `the phone's sign-in link is not made by setup_apply: ask signin_link (role steer, label "${PHONE_LABEL}") for it`,
      );
    }
    if (typeof p.plan_id !== "string" || p.plan_id === "") {
      return refuse(op, "plan_id is required: the step's plan_id from the setup_plan answer shown");
    }
    const key = replyKey(p.reply_key);
    if (typeof key === "string") return refuse(op, key);
    if (this.applying) {
      return refuse(
        op,
        "another setup_apply is still running: wait for its answer, then plan again",
      );
    }
    this.applying = true;
    let after: (() => Promise<void>) | undefined;
    try {
      const accounts = await listAccounts(this.o.exec);
      const why = typeof accounts === "string" ? accounts : adminRefusal(accounts, sender);
      if (why !== undefined) return refuse(op, why);
      const run = this.run(p);
      if (typeof run === "string") return refuse(op, run);
      const planned = await this.planSteps(run, step as StepName);
      const target = planned[planned.length - 1] as { name: StepName; plan: StepPlan };
      const earlier = planned.slice(0, -1).find(({ plan }) => plan.blocked !== undefined);
      if (earlier !== undefined) {
        return refuse(
          op,
          `${earlier.plan.title} is blocked (${firstLine(earlier.plan.blocked)}): fix that step first`,
        );
      }
      const { plan } = target;
      if (plan.blocked !== undefined) {
        return refuse(op, `${plan.title} is blocked: ${firstLine(plan.blocked)}`);
      }
      if (plan.skipped !== undefined) {
        return refuse(op, `${plan.title} is skipped: ${plan.skipped}`);
      }
      if (this.wire(run, target.name, plan).plan_id !== p.plan_id) {
        return refuse(
          op,
          `plan changed: ${plan.title} would now make other changes than the plan shown; plan again`,
        );
      }
      const r = await this.applyStep(run, sender, target.name, plan);
      after = "after" in r ? r.after : undefined;
      return {
        reply: authReply(op, {
          ok: r.error === undefined,
          ...(r.error !== undefined ? { error: r.error } : {}),
          ...(r.error === undefined ? { result: r.result } : {}),
          ...(run.token !== undefined ? { sealed: seal(key, { token: run.token.token }) } : {}),
        }),
        ...(r.applied.length > 0
          ? {
              event: {
                type: "setup_step_applied",
                data: { by: sender, step: target.name, summaries: r.applied },
              },
            }
          : {}),
        ...(after !== undefined ? { after } : {}),
      };
    } finally {
      // A deferred restart keeps the step running until it is done.
      if (after === undefined) this.applying = false;
    }
  }

  /** Apply `plan`'s changes a Desk may make, in order; the restart is left to `after`. */
  private async applyStep(run: Run, sender: string, name: StepName, plan: StepPlan) {
    const { ctx } = run;
    const by = `desk:${sender}`;
    const log = (event: string, summary?: string) =>
      appendSetupLog(ctx, { step: name, event, ...(summary !== undefined ? { summary } : {}), by });
    const leftover: (TerminalOnly & { summary: string })[] = [];
    const now: Change[] = [];
    let restart: Change | undefined;
    for (const c of plan.changes) {
      const t = terminalOnly(name, c.summary, ctx);
      if (t !== undefined) leftover.push({ summary: c.summary, ...t });
      else if (c.summary.startsWith(RESTART)) restart = c;
      else now.push(c);
    }
    const lines: string[] = [];
    const applied: string[] = [];
    if (plan.changes.length === 0) {
      log("done");
      return { applied, result: { step: name, lines, problems: [], terminal: leftover } };
    }
    if (now.length === 0 && restart === undefined) {
      // Every change is a terminal's: nothing happened here, so setup.log has nothing to say.
      return { applied, result: { step: name, lines, problems: [], terminal: leftover } };
    }
    log("planned", plan.changes.map((c) => c.summary).join("; "));
    for (const c of now) {
      const before = run.out.stdout.length;
      try {
        lines.push(...nonEmpty(await c.apply()));
      } catch (e) {
        const msg = this.failure(run, e);
        log("failed", `${c.summary}: ${msg}`);
        return { applied, error: `${plan.title}: ${c.summary}: ${msg}` };
      }
      log("applied", c.summary);
      applied.push(c.summary);
      lines.push(...unshownPasswords(run.out.stdout.slice(before)));
    }
    let problems: string[] = [];
    let after: (() => Promise<void>) | undefined;
    if (restart !== undefined) {
      const r = restart;
      applied.push(r.summary);
      lines.push(
        `The broker restarts after this answer (${ctx.auth.layout.restart}); the Desk reconnects on its own.`,
      );
      after = async () => {
        try {
          await r.apply();
          log("applied", r.summary);
          const left = leftover.length === 0 ? ((await plan.verify?.()) ?? []) : [];
          if (left.length > 0) log("failed", left.join("; "));
          else if (leftover.length === 0) log("verified");
        } catch (e) {
          log("failed", `${r.summary}: ${this.failure(run, e)}`);
        } finally {
          this.applying = false;
        }
      };
    } else if (leftover.length === 0) {
      // With changes left for a terminal the step is not done yet: its checks would only say so.
      problems = (await plan.verify?.()) ?? [];
      log(problems.length > 0 ? "failed" : "verified", problems.join("; ") || undefined);
    }
    return {
      applied,
      ...(after !== undefined ? { after } : {}),
      result: {
        step: name,
        lines: nonEmpty(lines),
        problems: nonEmpty(problems),
        terminal: leftover,
        ...(after !== undefined ? { restarting: true } : {}),
      },
    };
  }

  /** A change's failure, with `volley auth`'s own error line when it says "its error is above". */
  private failure(run: Run, e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    const err = run.out.stderr.trim().split("\n").pop() ?? "";
    return msg.includes("(its error is above)")
      ? msg.replace("(its error is above)", err !== "" ? `: ${err}` : "").replace(" :", ":")
      : msg;
  }

  /** Every step's plan up to `upto` (all five without it), in order; a planner's throw blocks it. */
  private async planSteps(run: Run, upto?: StepName) {
    const out: { name: StepName; plan: StepPlan }[] = [];
    for (const [name, planner] of STEPS) {
      let plan: StepPlan;
      try {
        plan = uncheckedKeychain(run, name, await planner(run.ctx));
      } catch (e) {
        const title = name === "detect" ? "Broker" : name[0]?.toUpperCase() + name.slice(1);
        plan = {
          step: name,
          title,
          found: [],
          changes: [],
          blocked: e instanceof Error ? e.message : String(e),
        };
      }
      out.push({ name, plan });
      if (name === upto) break;
    }
    return out;
  }

  /** One step as `setup-result.schema.json` `$defs/step` has it. */
  private wire(run: Run, name: StepName, plan: StepPlan) {
    const changes = plan.changes.map((c) => {
      const terminal = terminalOnly(name, c.summary, run.ctx);
      return {
        summary: c.summary,
        ...(c.detail !== undefined && c.detail !== "" ? { detail: c.detail } : {}),
        ...(terminal !== undefined ? { terminal } : {}),
      };
    });
    const lan = name === "security" ? lanState(run.ctx) : undefined;
    const digest = createHash("sha256")
      .update(
        JSON.stringify({
          changes,
          blocked: plan.blocked ?? null,
          skipped: plan.skipped ?? null,
          lan: lan?.planned ?? null,
        }),
      )
      .digest("hex")
      .slice(0, 16);
    return {
      step: name,
      title: plan.title,
      found: nonEmpty(plan.found),
      changes,
      ...(plan.blocked !== undefined ? { blocked: plan.blocked } : {}),
      ...(plan.skipped !== undefined ? { skipped: plan.skipped } : {}),
      plan_id: `${name}-${digest}`,
      ...(lan !== undefined ? { lan } : {}),
    };
  }

  /** The planners' context for one request (`lan`, `repair` from it), or why there is none. */
  private run(p: Fields): Run | string {
    const o = this.o;
    // `volley auth init` finds volleyd's files through VOLLEYD_HOME: this volleyd's own home.
    const env: Record<string, string | undefined> = { ...o.env, VOLLEYD_HOME: o.volleydHome };
    const listeners = listenerUrls(o.brokerUrl);
    if ("error" in listeners) {
      return `volleyd's broker URL is not one setup can use (${listeners.error}): run \`volley setup\` in a terminal`;
    }
    const real = realSetupDeps(env);
    const given = { ...real, ...o.deps };
    // The install the terminal's `volley setup` used (its --layout / --config / --dir), else
    // the layout volleyd detects: never plan against another install than setup's.
    const saved = readSetupInstall(o.volleydHome);
    const layout: Layout =
      saved !== null
        ? {
            ...LAYOUTS[saved.layout],
            config: saved.config,
            stateFile: saved.state_file,
            authDir: saved.auth_dir,
          }
        : (o.deps?.auth?.layout ?? realAuthDeps.layout)();
    const home = env.HOME ?? homedir();
    const brew = layout.name === "brew-arm64" || layout.name === "brew-intel";
    const setup = mintSetupToken({
      restart: brew ? layout.restart : null,
      ctrl: brew ? { bin: layout.ctrl, stateFile: layout.stateFile } : null,
      repoRoot: given.repoRoot,
      bun: given.bun,
      home,
      uid: given.uid,
    });
    // volleyd's exec, with the setup token: the fence allows the SETUP rows and nothing else.
    const limit = DAEMON_DEFAULTS.setup_apply_timeout_ms;
    const fenced: SetupExec = async (argv, opts) => {
      try {
        const r = await o.exec(argv, { ...opts, setup, timeoutMs: limit });
        // The step's error is the command's stderr: say that it was killed, not just how it ended.
        const killed = `(killed after ${Math.round(limit / 1000)} s)`;
        return r.timedOut
          ? { ...r, stderr: r.stderr.trim() === "" ? killed : `${r.stderr.trim()} ${killed}` }
          : r;
      } catch (e) {
        if (e instanceof FenceError) throw e;
        return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
      }
    };
    const out = { stdout: "", stderr: "" };
    const io: IO = {
      stdout: (s) => {
        out.stdout += s;
      },
      stderr: (s) => {
        out.stderr += s;
      },
      now: o.now,
    };
    const authDeps: AuthDeps = {
      ...realAuthDeps,
      mosquittoVersion: async (binary) => {
        const v = o.brokerVersion();
        if (v !== null) return `mosquitto version ${v}`;
        if (binary !== "mosquitto") return null;
        const r = await fenced(["mosquitto", "-h"]);
        const text = `${r.stdout}\n${r.stderr}`;
        return r.code === 127 || !/version/.test(text) ? null : text;
      },
      ctrlInit: async (ctrl, stateFile, user, password) => {
        const r = await fenced([ctrl, "dynsec", "init", stateFile, user, password]);
        return { code: r.code, stderr: r.stderr };
      },
      restart: async () => ({
        code: 1,
        stderr: "volleyd restarts the broker only as a setup step",
      }),
      ...o.deps?.auth,
      layout: () => layout,
    };
    // The keychain is the logged-in session's: never volleyd's (its change is terminal-only, and
    // a plan that could only ask turns it into a note: `uncheckedKeychain`).
    const desk: SetupExec = (argv, opts) => {
      if (argv[0] !== "security") return fenced(argv, opts);
      run.keychainAsked = true;
      return Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "the keychain is read from a terminal",
      });
    };
    const exec = fencedExec(
      desk,
      setupFence({ restart: layout.restart, repoRoot: given.repoRoot, bun: given.bun }),
    );
    const probes = new Map<string, AnonymousProbe>();
    const deps: SetupDeps = {
      ...given,
      auth: authDeps,
      exec,
      probeAnonymous: async (url) => {
        const r = await given.probeAnonymous(url);
        if (!probes.has(url)) probes.set(url, r);
        return r;
      },
      liveAgents: () => o.liveAgents(),
      confirm: async () => false,
      interactive: false,
      sleep: o.sleep,
    };
    const auth: AuthContext = {
      dir: o.authDir ?? saved?.auth_dir ?? env.VOLLEY_AUTH_DIR ?? defaultAuthDir(layout),
      layout,
      url: o.brokerUrl,
      io,
      env,
      deps: authDeps,
    };
    const run: Run = {
      probes,
      out,
      keychainAsked: false,
      ctx: {
        auth,
        deps,
        config: layout.config,
        stateFile: layout.stateFile,
        ...listeners,
        home,
        volleydHome: o.volleydHome,
        repair: p.repair === true,
        yes: false,
        ...(typeof p.lan === "boolean" ? { lan: p.lan } : {}),
        deskHost: deps.lanHost(),
        deskPort: o.deskPort ?? DESK_PORT,
        deliverToken: (t) => {
          run.token = t;
        },
      },
    };
    return run;
  }
}

const portOf = (url: string) => Number(new URL(url).port || (url.startsWith("ws") ? 80 : 1883));

const firstLine = (s: string | undefined) => (s ?? "").split("\n")[0] ?? "";

/** The security step's LAN choice: planned (what `planSecurity` settled) and the config's now. */
function lanState(ctx: SetupContext): { planned: boolean; current: boolean | null } | undefined {
  const layout = { ...ctx.auth.layout, stateFile: ctx.stateFile };
  const local = generateConfig(layout);
  const open = generateConfig({ ...layout, wsBind: "" });
  if (local === open || ctx.lan === undefined) return undefined;
  const text = existsSync(ctx.config) ? readFileSync(ctx.config, "utf-8") : "";
  // sameConfig: the header may name `volley setup` or `volley auth init`, either is in place.
  return {
    planned: ctx.lan,
    current: sameConfig(text, open) ? true : sameConfig(text, local) ? false : null,
  };
}

/**
 * The logins `volley auth init` minted whose password no file keeps (`desk`): it printed them
 * once, on the stdout this module never shows. Says so, never the password.
 */
export function unshownPasswords(stdout: string): string[] {
  const at = stdout.indexOf("New passwords (shown ONCE");
  if (at === -1) return [];
  const users = stdout
    .slice(at)
    .split("\n")
    .slice(1)
    .map((l) => /^ {2}(\S+)\s+\S+$/.exec(l)?.[1])
    .filter((u): u is string => u !== undefined && u !== "coordinator" && u !== "volleyd");
  if (users.length === 0) return [];
  return [
    `The new login${users.length === 1 ? "" : "s"} ${users.join(", ")} got a password the Desk does not show (no file keeps it): Setup & Security › New desk password issues one, shown once; or sign devices in with a one-time token or a sign-in link.`,
  ];
}
