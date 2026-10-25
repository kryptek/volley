import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureOwnedDir } from "../auth/context";
import { scrub } from "../peer/doctor";
import type { FirstWaveMetrics } from "./first-wave";
import type { SetupContext, SetupDeps, StepName } from "./step";

/**
 * `$VOLLEYD_HOME/setup-metrics.json`: what one `volley setup` run cost the person, so the
 * one-command install's targets are measurable: its wall time, the questions they saw (a
 * confirmation, a hidden prompt, a typed answer: none under `--yes`), the browser sign-ins and
 * sudo prompts it ran, and each step's time and change count. Every run writes it (one that
 * stopped too); counts and step names only, scrubbed of anything token-shaped all the same.
 */

export interface SetupMetrics {
  started_at: string;
  finished_at: string;
  wall_ms: number;
  questions: number;
  sign_ins: number;
  sudo_prompts: number;
  steps: { name: StepName; ms: number; changes: number }[];
  /** The test wave (the first-wave step), when one ran: its wall time, PR and whether it merged. */
  first_wave?: FirstWaveMetrics;
}

export const setupMetricsFile = (volleydHome: string) => join(volleydHome, "setup-metrics.json");

/** The counters of one run. `clock` is milliseconds (injected: tests pin it). */
export class SetupMeter {
  readonly startedAt: Date;
  private readonly start: number;
  questions = 0;
  signIns = 0;
  sudoPrompts = 0;
  readonly steps: SetupMetrics["steps"] = [];
  /** Set by the first-wave step once its wave ended (or gave up). */
  firstWave?: FirstWaveMetrics;

  constructor(
    private readonly now: () => Date,
    private readonly clock: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.start = clock();
  }

  /**
   * `deps` counting what the person sees: a question only when someone is at the terminal to
   * see it (`interactive`), a sudo prompt for each command run through sudo there (`sudo -n`
   * never prompts).
   */
  wrap(deps: SetupDeps): SetupDeps {
    const seen = () => {
      if (deps.interactive) this.questions++;
    };
    const { askSecret, ask } = deps;
    return {
      ...deps,
      confirm: async (q, defaultYes) => {
        seen();
        return deps.confirm(q, defaultYes);
      },
      ...(askSecret !== undefined
        ? {
            askSecret: async (p: string) => {
              seen();
              return askSecret(p);
            },
          }
        : {}),
      ...(ask !== undefined
        ? {
            ask: async (p: string) => {
              seen();
              return ask(p);
            },
          }
        : {}),
      exec: async (argv, opts) => {
        if (argv[0] === "sudo" && argv[1] !== "-n" && deps.interactive) this.sudoPrompts++;
        return deps.exec(argv, opts);
      },
    };
  }

  signIn(): void {
    this.signIns++;
  }

  /** Start timing a step (from its planning to its last check); call the result when it ends. */
  begin(name: StepName): (changes: number) => void {
    const t0 = this.clock();
    let ended = false;
    return (changes) => {
      if (ended) return;
      ended = true;
      this.steps.push({ name, ms: Math.max(0, Math.round(this.clock() - t0)), changes });
    };
  }

  /** The run's metrics so far. */
  done(): SetupMetrics {
    return {
      started_at: this.startedAt.toISOString(),
      finished_at: this.now().toISOString(),
      wall_ms: this.elapsed(),
      questions: this.questions,
      sign_ins: this.signIns,
      sudo_prompts: this.sudoPrompts,
      steps: [...this.steps],
      ...(this.firstWave !== undefined ? { first_wave: { ...this.firstWave } } : {}),
    };
  }

  elapsed(): number {
    return Math.max(0, Math.round(this.clock() - this.start));
  }
}

/** `<m> m <s> s`. */
export function formatWall(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} m ${s % 60} s`;
}

/**
 * `Setup complete in 2 m 5 s (1 question, 2 sign-ins, 0 sudo)`, then the test wave's outcome when
 * one ran: `; test wave merged in 1 m 40 s: <PR URL>`.
 */
export function completeLine(m: SetupMetrics): string {
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const w = m.first_wave;
  const wave =
    w === undefined
      ? ""
      : `; test wave ${w.merged ? "merged" : "not merged"} in ${formatWall(w.wall_ms)}${w.pr !== null ? `: ${w.pr}` : ""}`;
  return `Setup complete in ${formatWall(m.wall_ms)} (${n(m.questions, "question", "questions")}, ${n(m.sign_ins, "sign-in", "sign-ins")}, ${m.sudo_prompts} sudo)${wave}`;
}

/** Write the run's metrics (0600, the invoking user's under sudo). A record, not a gate. */
export function writeSetupMetrics(ctx: SetupContext, m: SetupMetrics): void {
  const file = setupMetricsFile(ctx.volleydHome);
  try {
    const invoker = ctx.auth.deps.invokingUser(ctx.auth.env);
    const owner = typeof invoker === "object" ? invoker : null;
    ensureOwnedDir(ctx.auth.deps, ctx.volleydHome, owner);
    writeFileSync(file, `${JSON.stringify(scrub(m), null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    if (owner !== null) ctx.auth.deps.chown(file, owner.uid, owner.gid);
  } catch {
    // A record, not a gate.
  }
}
