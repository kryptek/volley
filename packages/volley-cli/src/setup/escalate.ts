import { existsSync } from "node:fs";
import { join } from "node:path";
import { LAYOUTS, type LayoutName } from "../auth/config";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { planSecurity } from "./broker";
import type { SetupContext, StepPlan } from "./step";

/**
 * On a Linux install whose broker files are root's (the snap, /etc/mosquitto), `volley setup` run
 * as the user cannot write the config, create the state file or restart the broker. Before its
 * step loop it runs the three broker steps through sudo itself, announced first, then continues
 * as the user: the user's own re-plan of those steps finds them in place (#577 hands the auth dir
 * and volleyd's files back to the sudo user).
 */

/** The steps that run as root, in order. */
export const ROOT_STEPS = ["detect", "security", "accounts"] as const;

/** The installs whose config, state file and restart are root's. */
const ROOT_LAYOUTS: readonly LayoutName[] = ["snap", "etc"];

/** How the messages name an install. */
const installName = (layout: LayoutName) => (layout === "etc" ? "/etc/mosquitto" : layout);

/** Whether this run must take the broker steps through sudo (before planning them as the user). */
export function brokerStepsNeedRoot(w: {
  platform: NodeJS.Platform;
  uid: number;
  layout: LayoutName;
  steps: readonly string[];
  check?: boolean;
  peer?: boolean;
}): boolean {
  return (
    w.check !== true &&
    w.peer !== true &&
    w.platform === "linux" &&
    w.uid !== 0 &&
    ROOT_LAYOUTS.includes(w.layout) &&
    w.steps.includes("security")
  );
}

export interface RootStepFlags {
  bun: string;
  repoRoot: string;
  lan: boolean;
  brokerUrl: string;
  dir: string;
  /** Only what the user gave: the child redetects nothing else. */
  layout?: string;
  config?: string;
  stateFile?: string;
  repair?: boolean;
  /** sudo may ask for the password (no `-n`). */
  prompt?: boolean;
}

const cliOf = (repoRoot: string) => join(repoRoot, "packages", "volley-cli", "src", "cli.ts");

/**
 * `sudo [-n] <bun> <cli> setup --step detect --step security --step accounts --yes --lan|--no-lan
 * --broker-url <url> --dir <dir> […]`: everything resolved, nothing left to root's environment
 * (no `-E`: sudo's env_reset and secure_path stand).
 */
export function rootStepArgv(f: RootStepFlags): string[] {
  return [
    "sudo",
    ...(f.prompt === true ? [] : ["-n"]),
    f.bun,
    cliOf(f.repoRoot),
    "setup",
    ...ROOT_STEPS.flatMap((s) => ["--step", s]),
    "--yes",
    f.lan ? "--lan" : "--no-lan",
    "--broker-url",
    f.brokerUrl,
    "--dir",
    f.dir,
    ...fileFlags(f),
  ];
}

const ABS_PATH = /^\/[^\n\0]*$/;
/** Flags the child may take, each with its value's check (null: no value). */
const ROOT_FLAGS: Record<string, ((v: string) => boolean) | null> = {
  "--yes": null,
  "--lan": null,
  "--no-lan": null,
  "--repair": null,
  "--broker-url": (v) => /^mqtt:\/\/[^\s@]+$/.test(v),
  "--dir": (v) => ABS_PATH.test(v),
  "--layout": (v) => Object.hasOwn(LAYOUTS, v),
  "--config": (v) => ABS_PATH.test(v),
  "--state-file": (v) => ABS_PATH.test(v),
};

/**
 * The fence's rule for the broker steps under sudo: `sudo`, optional `-n`, this `bun`, this
 * checkout's CLI, `setup`, then only the flags above (each once) and `--step` among the three.
 */
export function isRootStepCommand(
  argv: readonly string[],
  { bun, repoRoot }: { bun: string; repoRoot: string | null },
): boolean {
  if (repoRoot === null || argv[0] !== "sudo") return false;
  const at = argv[1] === "-n" ? 2 : 1;
  if (argv[at] !== bun || argv[at + 1] !== cliOf(repoRoot) || argv[at + 2] !== "setup") {
    return false;
  }
  const seen = new Set<string>();
  const steps = new Set<string>();
  const rest = argv.slice(at + 3);
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] as string;
    if (flag === "--step") {
      const step = rest[++i] ?? "";
      if (!(ROOT_STEPS as readonly string[]).includes(step) || steps.has(step)) return false;
      steps.add(step);
      continue;
    }
    if (!Object.hasOwn(ROOT_FLAGS, flag) || seen.has(flag)) return false;
    seen.add(flag);
    const valid = ROOT_FLAGS[flag];
    if (valid != null && !valid(rest[++i] ?? "")) return false;
  }
  // The three broker steps, each once: never a full `volley setup` as root.
  return steps.size === ROOT_STEPS.length && !(seen.has("--lan") && seen.has("--no-lan"));
}

/** The silent probe: whether sudo runs without a password (decided by its exit code alone). */
export const SUDO_PROBE = ["sudo", "-n", "true"] as const;

/** `sudo is needed to:` and one line per reason, in install.sh's style. */
export function sudoReasons(r: {
  layout: LayoutName;
  config: string;
  stateFile: string;
  restart: string;
  dir: string;
  /** What this run writes (default: all of it). */
  writes?: { config: boolean; stateFile: boolean; dir: boolean };
}): string[] {
  const w = r.writes ?? { config: true, stateFile: true, dir: true };
  const files = [
    ...(w.config ? [`write ${r.config}`] : []),
    ...(w.stateFile ? [`create ${r.stateFile}`] : []),
  ];
  return [
    "sudo is needed to:",
    ...(files.length > 0
      ? [
          `  - ${files.join(" and ")} (the ${installName(r.layout)} install keeps ${files.length === 1 ? "it" : "them"} as root's)`,
        ]
      : []),
    `  - restart the broker (${r.restart})`,
    ...(w.dir ? [`  - create the Volley auth dir ${r.dir}`] : []),
  ];
}

/** A word as a shell reads it back. */
const shellWord = (w: string) => (/^[\w./:@=,+-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);

/** The run's optional flags the child takes too: the files it planned with, and `--repair`. */
const fileFlags = (f: Pick<RootStepFlags, "layout" | "config" | "stateFile" | "repair">) => [
  ...(f.layout !== undefined ? ["--layout", f.layout] : []),
  ...(f.config !== undefined ? ["--config", f.config] : []),
  ...(f.stateFile !== undefined ? ["--state-file", f.stateFile] : []),
  ...(f.repair === true ? ["--repair"] : []),
];

/** The command a person runs by hand when this run cannot ask for sudo's password. */
export function manualRootCommand(
  volley: string,
  lan: boolean,
  flags: Pick<RootStepFlags, "layout" | "config" | "stateFile" | "repair"> = {},
): string {
  return [
    `sudo ${volley} setup ${ROOT_STEPS.map((s) => `--step ${s}`).join(" ")} --yes ${lan ? "--lan" : "--no-lan"}`,
    ...fileFlags(flags).map(shellWord),
  ].join(" ");
}

/** `volley setup <the run's own flags>`, as a shell reads it back. */
const rerunCommand = (argv: readonly string[]) =>
  ["volley setup", ...argv.map(shellWord)].join(" ");

/** Why the run stops without a terminal: the one command to run, then the rerun. */
export function noTerminalMessage(m: {
  layout: LayoutName;
  volley: string;
  lan: boolean;
  argv: readonly string[];
  flags?: Pick<RootStepFlags, "layout" | "config" | "stateFile" | "repair">;
}): string[] {
  return [
    `volley setup: Security: the broker's config and state file are root's on this install (${installName(m.layout)}), and sudo needs your password, which this run cannot ask for. In a terminal, run:`,
    `  ${manualRootCommand(m.volley, m.lan, m.flags)}`,
    `then run \`${rerunCommand(m.argv)}\` again.`,
  ];
}

const PERMISSION = /\b(EACCES|EPERM)\b/;

export type Escalation =
  | "ran"
  | "not-needed"
  | { stop: ExitCode; event: "blocked" | "declined" | "failed"; summary: string };

/**
 * Pre-plan Security as the user (which settles `ctx.lan`, asking the LAN question once); when it
 * has changes, or cannot read the broker's files, run the broker steps as root: announced, asked
 * once (not under `--yes`), `sudo -n` first, then `sudo` at a terminal.
 */
export async function runBrokerStepsAsRoot(
  ctx: SetupContext,
  io: IO,
  opts: {
    /** `--layout`, `--config`, `--state-file` as the user gave them. */
    flags: { layout?: string; config?: string; stateFile?: string };
    /** The run's own argv (the rerun the no-terminal message names). */
    argv: readonly string[];
  },
): Promise<Escalation> {
  const { deps, auth } = ctx;
  const layout = auth.layout;
  /** The user's plan of Security, or the permission error that stops it (null: another error). */
  const preplan = async (): Promise<StepPlan | { denied: string } | null> => {
    try {
      const p = await planSecurity(ctx);
      return p.blocked !== undefined && PERMISSION.test(p.blocked) ? { denied: p.blocked } : p;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      const code = String((e as { code?: unknown }).code ?? why);
      return PERMISSION.test(code) ? { denied: why } : null; // the loop's own planning reports it
    }
  };
  const first = await preplan();
  if (first === null) return "not-needed";
  const plan = "denied" in first ? null : first;
  if (plan !== null && (plan.blocked !== undefined || plan.changes.length === 0)) {
    return "not-needed";
  }
  const lan = ctx.lan ?? false;
  const exists = deps.exists ?? existsSync;
  const volley = exists(join(ctx.home, ".volley", "bin", "volley"))
    ? "~/.volley/bin/volley"
    : "volley";
  const picked = {
    ...(opts.flags.layout !== undefined ? { layout: opts.flags.layout } : {}),
    ...(opts.flags.config !== undefined ? { config: opts.flags.config } : {}),
    ...(opts.flags.stateFile !== undefined ? { stateFile: opts.flags.stateFile } : {}),
    ...(ctx.repair ? { repair: true } : {}),
  };
  const message = noTerminalMessage({
    layout: layout.name,
    volley,
    lan,
    argv: opts.argv,
    flags: picked,
  });
  const blocked = (): Escalation => {
    io.stderr(`${message.join("\n")}\n`);
    return {
      stop: EXIT.ERROR,
      event: "blocked",
      summary: `${manualRootCommand(volley, lan, picked)}; then ${rerunCommand(opts.argv)}`,
    };
  };
  if (deps.repoRoot === null) return blocked();

  const has = (prefix: string) => plan?.changes.some((c) => c.summary.startsWith(prefix)) ?? true;
  for (const line of sudoReasons({
    layout: layout.name,
    config: ctx.config,
    stateFile: ctx.stateFile,
    restart: layout.restart,
    dir: auth.dir,
    writes: {
      config: has(`Write ${ctx.config}`),
      stateFile: has(`Create ${ctx.stateFile}`),
      dir: !exists(auth.dir),
    },
  })) {
    io.stdout(`${line}\n`);
  }
  const flags: RootStepFlags = {
    bun: deps.bun,
    repoRoot: deps.repoRoot,
    lan,
    brokerUrl: auth.url,
    dir: auth.dir,
    ...picked,
  };
  const shown = rootStepArgv({ ...flags, prompt: true });
  io.stdout(`Running: ${shown.map(shellWord).join(" ")}\n`);
  // One question for all three steps: the child's --yes answers their own.
  if (!ctx.yes && !(await deps.confirm("Run these steps with sudo?", true))) {
    io.stdout(
      `  Nothing was changed. Rerun \`volley setup\` to continue${deps.interactive ? "" : " (not a terminal: pass --yes to apply)"}.\n`,
    );
    return { stop: EXIT.ERROR, event: "declined", summary: "the broker steps through sudo" };
  }
  // Passwordless sudo (a cloud image, or install.sh's fresh timestamp) asks nothing. The probe
  // decides by its exit code, as install.sh's does: sudo translates its own messages.
  const passwordless = (await deps.exec(SUDO_PROBE)).code === 0;
  if (!passwordless && !deps.interactive) return blocked();
  // The child gets the terminal: its output as it runs, and sudo's one prompt when it needs one.
  const r = await deps.exec(passwordless ? rootStepArgv(flags) : shown, { tty: true });
  if (r.code !== 0) {
    io.stderr(
      `volley setup: Security: the broker steps under sudo failed (exit ${r.code}): see the output above\n`,
    );
    const code = (Object.values(EXIT) as number[]).includes(r.code)
      ? (r.code as ExitCode)
      : EXIT.ERROR;
    return { stop: code, event: "failed", summary: `sudo … setup exited ${r.code}` };
  }
  // Root's run leaves a file it keeps as root's: the rest of setup must still read them as you.
  const after = "denied" in first ? await preplan() : null;
  if (after !== null && "denied" in after) {
    io.stderr(
      `volley setup: Security: the broker steps ran as root, but you still cannot read the broker's files (${after.denied}). Make them readable (sudo chmod a+r ${ctx.config}), then run \`${rerunCommand(opts.argv)}\` again.\n`,
    );
    return { stop: EXIT.ERROR, event: "failed", summary: after.denied };
  }
  return "ran";
}
