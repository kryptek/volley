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
 * the hooks installer, the Desk build) goes through this one seam: argv only, never a shell.
 */
export type SetupExec = (
  argv: readonly string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined> },
) => Promise<ExecResult>;

/** What an anonymous MQTT CONNECT to a listener got. */
export type AnonymousProbe = "refused" | "accepted" | "unreachable";

export interface SetupDeps {
  auth: AuthDeps;
  exec: SetupExec;
  /** Try an anonymous CONNECT to `url` (mqtt:// or ws://). */
  probeAnonymous: (url: string) => Promise<AnonymousProbe>;
  /** Agents in the broker's registry, read with `creds`; null when it cannot tell. */
  liveAgents: (url: string, creds: AdminCredentials) => Promise<number | null>;
  /** Ask a yes/no question; false when there is nobody to answer. */
  confirm: (question: string) => Promise<boolean>;
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
  deskHost: string;
  deskPort: number;
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
