import { join } from "node:path";
import type { AdminCredentials, AuthContext, AuthDeps } from "../auth/context";

/**
 * What every `volley setup` step shares. A step is a planner: it reads the machine's state and
 * returns what it found and the changes it would make, each with its own executor. Planning
 * never changes anything; the command shows the plan, asks (or takes `--yes`), then applies.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Every external command `volley setup` runs (broker restart, service managers, the keychain,
 * the hooks installer, the Desk build) goes through this one seam: argv only, never a shell,
 * and only what `setupFence` allows. `input` is written to the command's stdin (a secret goes
 * there, never on argv, where `ps` shows it); without it stdin stays the terminal's.
 */
export type SetupExec = (
  argv: readonly string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined>; input?: string },
) => Promise<ExecResult>;

/**
 * The broker's two listeners as setup probes them: the mqtt:// URL itself and the WebSocket
 * listener on the same host's port 9001; or why setup cannot use the URL.
 */
export function listenerUrls(url: string): { tcpUrl: string; wsUrl: string } | { error: string } {
  let broker: URL;
  try {
    broker = new URL(url);
  } catch {
    return { error: `not a broker URL: ${url}` };
  }
  if (broker.protocol !== "mqtt:" && broker.protocol !== "tcp:") {
    return {
      error: `${broker.protocol === "mqtts:" || broker.protocol === "wss:" ? "TLS is not supported by `volley setup` yet" : "the broker URL must be mqtt://"} (got ${url})`,
    };
  }
  // An IPv6 hostname keeps its brackets (WHATWG URL).
  return { tcpUrl: url, wsUrl: `ws://${broker.hostname}:9001` };
}

/** What an anonymous MQTT CONNECT to a listener got. */
export type AnonymousProbe = "refused" | "accepted" | "unreachable";

export interface SetupDeps {
  auth: AuthDeps;
  exec: SetupExec;
  /** Try an anonymous CONNECT to `url` (mqtt:// or ws://). */
  probeAnonymous: (url: string) => Promise<AnonymousProbe>;
  /** Agents with a live (non-terminal) retained status, read with `creds`; null when it cannot tell. */
  liveAgents: (url: string, creds: AdminCredentials) => Promise<number | null>;
  /**
   * Ask a yes/no question (Enter takes `defaultYes`, false unless given); false when there is
   * nobody to answer (not `interactive`).
   */
  confirm: (question: string, defaultYes?: boolean) => Promise<boolean>;
  /** Whether a person is at the terminal to answer `confirm`. */
  interactive: boolean;
  sleep: (ms: number) => Promise<void>;
  platform: NodeJS.Platform;
  uid: number;
  /** The address a phone on the LAN reaches this machine at. */
  lanHost: () => string;
  /** This Volley checkout (bun.lock's directory), or null. */
  repoRoot: string | null;
  /** The `bun` the services run (a stable PATH entry, not a versioned install). */
  bun: string;
}

export interface SetupContext {
  auth: AuthContext;
  deps: SetupDeps;
  /** The mosquitto.conf to manage and the Dynamic Security state file. */
  config: string;
  stateFile: string;
  /** The broker's two listeners, as the probes reach them. */
  tcpUrl: string;
  wsUrl: string;
  /** The user's home (services, Claude Code settings). */
  home: string;
  volleydHome: string;
  /** Re-check and fix only: no new one-time admin token, no phone link. */
  repair: boolean;
  /** `--yes`: apply without asking (and so ask nothing else either). */
  yes: boolean;
  /**
   * `--lan` (true) / `--no-lan` (false): whether devices on the LAN may reach the broker's
   * WebSocket listener. Unset: keep what the config has, else ask (no under `--yes`).
   */
  lan?: boolean;
  deskHost: string;
  deskPort: number;
  /**
   * Where the accounts step's one-time admin token goes. Unset (the terminal): printed on
   * stdout. volleyd sets it to seal the token to the Desk that asked (`setup_apply`).
   */
  deliverToken?: (t: IssuedToken) => void;
}

/** A one-time admin token as `volley auth token --json` prints it. */
export interface IssuedToken {
  token: string;
  token_id: string;
  expires_at: string;
}

export interface Change {
  /** One line: what will change. */
  summary: string;
  /** Shown before the confirmation: a diff, the commands it runs. Never a secret. */
  detail?: string;
  /** Make the change; returns the lines to report. Throws on failure. */
  apply: () => Promise<string[]>;
}

export type StepName = "detect" | "security" | "accounts" | "services" | "phone";

export interface StepPlan {
  step: StepName;
  title: string;
  /** What the step found (always printed). */
  found: string[];
  changes: Change[];
  /** Why this step (and so every later one) cannot run now. */
  blocked?: string;
  /** Why this step is left out of this run (the later ones still run). */
  skipped?: string;
  /** Checks after the changes; returns the problems left. */
  verify?: () => Promise<string[]>;
}

export type Planner = (ctx: SetupContext) => Promise<StepPlan>;

/** The broker's WebSocket listener as a phone on the LAN reaches it (the Desk's host). */
export function lanWsUrl(ctx: SetupContext): string {
  const host =
    ctx.deskHost.includes(":") && !ctx.deskHost.startsWith("[")
      ? `[${ctx.deskHost}]`
      : ctx.deskHost;
  return `ws://${host}:${new URL(ctx.wsUrl).port || "9001"}`;
}

/** What setup's exec may run besides the layout's restart: the fence's inputs. */
export interface FenceInputs {
  restart: string;
  repoRoot: string | null;
  bun: string;
}

/**
 * The authority fence over `volley setup`'s exec: the exact commands its steps run, nothing
 * else. Throws on any other argv. Read-only probes and the changes alike go through it.
 */
export function setupFence({ restart, repoRoot, bun }: FenceInputs) {
  const repo = (...p: string[]) => (repoRoot === null ? null : join(repoRoot, ...p));
  const hooks = repo("packages", "volley-hooks", "scripts", "install.sh");
  const volleyd = repo("packages", "volleyd", "src", "cli.ts");
  const desk = repo("packages", "volley-desk");
  return (argv: readonly string[], opts?: { cwd?: string }): void => {
    const [a0, a1, a2] = argv;
    const line = argv.join(" ");
    const ok =
      line === restart ||
      (a0 === "launchctl" && ["print", "bootout", "bootstrap"].includes(a1 ?? "")) ||
      (a0 === "systemctl" &&
        a1 === "--user" &&
        ["daemon-reload", "enable", "restart", "is-active"].includes(a2 ?? "")) ||
      (a0 === "security" &&
        (a1 === "find-generic-password" || (a1 === "-i" && argv.length === 2))) ||
      (a0 === "bash" &&
        hooks !== null &&
        a1 === hooks &&
        (argv.length === 2 || (argv.length === 3 && a2 === "--dry-run"))) ||
      (a0 === bun && volleyd !== null && a1 === volleyd && a2 === "install") ||
      (a0 === bun &&
        a1 === "run" &&
        a2 === "build" &&
        argv.length === 3 &&
        desk !== null &&
        opts?.cwd === desk);
    if (!ok) throw new Error(`volley setup does not run \`${line}\``);
  };
}

/** `exec` behind `fence`: a refused command throws before anything is spawned. */
export function fencedExec(exec: SetupExec, fence: ReturnType<typeof setupFence>): SetupExec {
  return async (argv, opts) => {
    fence(argv, opts);
    return exec(argv, opts);
  };
}

/**
 * A unified diff of `before` → `after` with three lines of context (`---`/`+++` headers named
 * after `path`). Empty when they are equal.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const a = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const b = after === "" ? [] : after.replace(/\n$/, "").split("\n");
  // Longest common subsequence table, from the end.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  type Op = { t: " " | "-" | "+"; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] as string, ai: i++, bi: j++ });
    } else if (
      i < a.length &&
      (j >= b.length ||
        ((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number))
    ) {
      ops.push({ t: "-", line: a[i] as string, ai: i++, bi: j });
    } else {
      ops.push({ t: "+", line: b[j] as string, ai: i, bi: j++ });
    }
  }
  const CONTEXT = 3;
  const out = [`--- ${path}${before === "" ? " (new file)" : ""}`, `+++ ${path}`];
  let k = 0;
  while (k < ops.length) {
    if ((ops[k] as Op).t === " ") {
      k++;
      continue;
    }
    // A hunk: from CONTEXT lines before this change to CONTEXT after the last change near it.
    const start = Math.max(0, k - CONTEXT);
    let end = k;
    for (let m = k; m < ops.length; m++) {
      if ((ops[m] as Op).t !== " ") end = m;
      else if (m - end > CONTEXT * 2) break;
    }
    const stop = Math.min(ops.length, end + CONTEXT + 1);
    const hunk = ops.slice(start, stop);
    const first = hunk[0] as Op;
    const aLen = hunk.filter((o) => o.t !== "+").length;
    const bLen = hunk.filter((o) => o.t !== "-").length;
    out.push(
      `@@ -${aLen === 0 ? first.ai : first.ai + 1},${aLen} +${bLen === 0 ? first.bi : first.bi + 1},${bLen} @@`,
    );
    for (const o of hunk) out.push(`${o.t}${o.line}`);
    k = stop;
  }
  return out.join("\n");
}
