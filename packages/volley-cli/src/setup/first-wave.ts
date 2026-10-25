import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SIM_BIN, simHome } from "volley-sim/env";
import { DEFAULT_MODEL } from "volleyd/config-defaults";
import { recordRepoTrust } from "volleyd/trust";
import { ADMIN_FILE, type AdminCredentials, readCredentials } from "../auth/context";
import {
  GH_REPO_VIEW,
  HELLO_ISSUE_TITLE,
  HELLO_README,
  ghIssueCreateArgv,
  ghRepoCreateArgv,
  ghRepoDeleteLine,
  gitAddReadmeArgv,
  gitCommitReadmeArgv,
  gitOriginArgv,
  gitPushDefaultArgv,
  gitPushReleaseArgv,
  helloRelease,
  helloRepoName,
  helloSuffix,
  helloWave,
  helloWaveYaml,
  issueNumberOf,
} from "./first-wave-repo";
import { readSetupInstall } from "./journal";
import { formatWall } from "./metrics";
import { GIT_IDENT_PROBE } from "./signin";
import type { SetupContext, StepPlan } from "./step";

/**
 * The last step of `volley setup`, `first-wave`: the proof that the install works end to end. It
 * makes a scratch private repository (`gh repo create volley-hello-<4> --private --clone`; or
 * takes the clone `--repo` names), files one issue ("Add HELLO.md"), pushes a release branch,
 * adds the repository to the fleet (`volley repo add <owner/name> --wait`: volleyd clones it
 * under `fleet.repo_root` and trusts it), writes `.volley/waves/hello-<4>.yaml` in that clone
 * (every run its own wave id), checks it (`volleyd validate`), submits it (`volleyd run …
 * --owner <coordinator>`), and follows `volley/_waves/hello-<4>/state` until the PR is merged,
 * the wave fails or blocks, or 15 minutes after the submit pass. `--simulated` (CI, the soak) runs it against volley-sim's fake `gh` and `claude`: the
 * origin is a bare repository under `$VOLLEY_SIM_HOME`, and the wave runs from the scratch clone
 * itself (volleyd cannot clone a simulated repository from GitHub).
 *
 * One question, "Run a 1-issue test wave now?" (Enter: yes), never under `--yes`, `--simulated`,
 * `--no-first-wave` or `--check`; declined, the step is skipped with the command to run later.
 * Once a test wave merged (`$VOLLEYD_HOME/first-wave.json`) a rerun has nothing to do.
 */

export const FIRST_WAVE_DEFAULTS = {
  /** How long the step follows the wave before it gives up. */
  timeout_ms: 15 * 60_000,
  /** How often it reads the wave's retained state. */
  poll_ms: 2000,
  /** Journal lines printed when the wave fails or blocks. */
  journal_tail: 10,
} as const;

export const FIRST_WAVE_QUESTION = "Run a 1-issue test wave now?";
export const FIRST_WAVE_LATER = "volley setup --step first-wave";

/** The step's flags: `--repo <path>`, `--issue <n>`, `--simulated`, `--no-first-wave`. */
export interface FirstWaveOptions {
  repo?: string;
  issue?: number;
  simulated?: boolean;
  skip?: boolean;
}

/** What setup-metrics.json records of the test wave. */
export interface FirstWaveMetrics {
  wall_ms: number;
  pr: string | null;
  merged: boolean;
}

/** The part of the retained wave state (wave-state.schema.json) the step reads. */
export interface WaveView {
  status: string;
  tasks: { id: string; stage: string; pr?: { url: string; number?: number } }[];
  open_decisions: string[];
}

/** `$VOLLEYD_HOME/first-wave.json`: the last test wave's outcome. */
export interface FirstWaveRecord extends FirstWaveMetrics {
  at: string;
  /** The wave's id (`hello-<4>`). */
  wave: string;
  /** The scratch repository setup made (absent for `--repo`): what to delete. */
  scratch?: string;
  /** The scratch repositories earlier runs made: still there to delete. */
  earlier?: string[];
  repo: string;
}

/** Every scratch repository a record names, the earliest first. */
const scratchesOf = (r: FirstWaveRecord | null): string[] =>
  r === null ? [] : [...(r.earlier ?? []), ...(r.scratch !== undefined ? [r.scratch] : [])];

export const firstWaveFile = (volleydHome: string) => join(volleydHome, "first-wave.json");

export function readFirstWave(volleydHome: string): FirstWaveRecord | null {
  try {
    const j = JSON.parse(readFileSync(firstWaveFile(volleydHome), "utf-8")) as FirstWaveRecord;
    return typeof j === "object" && j !== null && typeof j.merged === "boolean" ? j : null;
  } catch {
    return null;
  }
}

function writeFirstWave(volleydHome: string, r: FirstWaveRecord): void {
  try {
    mkdirSync(volleydHome, { recursive: true });
    writeFileSync(firstWaveFile(volleydHome), `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A record, not a gate.
  }
}

/** How the wave stands: still going, or how it ended. */
export type WaveOutcome =
  | { end: "done"; pr: string | null }
  | { end: "failed" | "blocked"; why: string; pr: string | null }
  | null;

/** Whether `s` has ended, and how: merged (`complete`), stopped, or a task blocked. */
export function waveOutcome(s: WaveView | null): WaveOutcome {
  if (s === null) return null;
  const pr = s.tasks.find((t) => t.pr !== undefined)?.pr?.url ?? null;
  if (s.status === "complete") return { end: "done", pr };
  if (s.status === "stopped" || s.status === "archived") {
    return { end: "failed", why: `the wave was ${s.status}`, pr };
  }
  const stuck = s.tasks.find((t) => t.stage === "blocked" || t.stage === "cancelled");
  if (stuck !== undefined) return { end: "blocked", why: `task ${stuck.id} is ${stuck.stage}`, pr };
  return null;
}

/** The journal's last `n` events, one line each (`#12 agent_spawned T1`). */
export function journalTail(volleydHome: string, wave: string, n: number): string[] {
  let text: string;
  try {
    text = readFileSync(join(volleydHome, "waves", wave, "journal.jsonl"), "utf-8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .map((l) => {
      try {
        const e = JSON.parse(l) as { seq?: number; type?: string; task?: string };
        return `#${e.seq ?? "?"} ${e.type ?? "?"}${e.task !== undefined ? ` ${e.task}` : ""}`;
      } catch {
        return l.slice(0, 120);
      }
    });
}

/** Setup runs against volley-sim: `--simulated`, or in a shell `eval "$(volley sim env)"` set up. */
export const simulated = (ctx: SetupContext) =>
  ctx.firstWave?.simulated === true || ctx.auth.env.VOLLEY_SIMULATED === "1";

/**
 * The services' environment (`serviceEnv`) with the simulator on, as `volley sim env` turns it on,
 * when setup itself runs simulated: the test wave's spawns are volleyd's, so its gh and claude must
 * be the fakes. Only then: a setup run without the simulator writes the units without it.
 */
export function withSimulator(
  ctx: SetupContext,
  env: Record<string, string>,
): Record<string, string> {
  if (!simulated(ctx)) return env;
  return {
    ...env,
    PATH: `${SIM_BIN}:${env.PATH ?? ""}`,
    VOLLEY_SIM_HOME: simHome(ctx.auth.env),
    VOLLEY_SIMULATED: "1",
  };
}

/**
 * The environment the step's commands run with: the broker, the auth dir and $VOLLEYD_HOME
 * setup uses (so `volleyd run` reads the coordinator's login from coordinator.json); under
 * `--simulated` the fakes first on PATH, as `eval "$(volley sim env)"` would put them. No git
 * identity is injected: the scaffold commits as the machine's git does (the Sign-ins step).
 */
export function firstWaveEnv(ctx: SetupContext): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...ctx.auth.env,
    VOLLEY_BROKER_URL: ctx.tcpUrl,
    VOLLEY_AUTH_DIR: ctx.auth.dir,
    VOLLEYD_HOME: ctx.volleydHome,
  };
  if (ctx.firstWave?.simulated !== true) return env;
  return {
    ...env,
    PATH: `${SIM_BIN}:${env.PATH ?? ""}`,
    VOLLEY_SIM_HOME: simHome(env),
    VOLLEY_SIMULATED: "1",
  };
}

/** `volley` and `volleyd` as setup runs them: this checkout's CLIs under setup's `bun`. */
export const volleyCli = (repoRoot: string) =>
  join(repoRoot, "packages", "volley-cli", "src", "cli.ts");
export const volleydCli = (repoRoot: string) =>
  join(repoRoot, "packages", "volleyd", "src", "cli.ts");

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** The `first-wave` step. */
export async function planFirstWave(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "first-wave", title: "Test wave", found: [], changes: [] };
  const o = ctx.firstWave ?? {};
  if (o.skip === true) {
    plan.skipped = `--no-first-wave: run \`${FIRST_WAVE_LATER}\` to run it later`;
    return plan;
  }
  if (ctx.auth.deps.invokingUser(ctx.auth.env) !== null) {
    plan.skipped = `running as root, and the test wave is your user's (its GitHub login, its coordinator): run \`${FIRST_WAVE_LATER}\` as that user (without sudo)`;
    return plan;
  }
  const record = readFirstWave(ctx.volleydHome);
  if (record?.merged === true && o.repo === undefined) {
    plan.found.push(
      `Test wave: ${record.pr ?? "its PR"} merged (${record.at.slice(0, 10)}, in ${formatWall(record.wall_ms)})`,
    );
    plan.row = `merged ${record.pr ?? ""}`.trim();
    return plan;
  }
  if (ctx.check === true) {
    plan.skipped = `not run by --check: \`${FIRST_WAVE_LATER}\` runs it`;
    plan.row = record === null ? "not run yet" : "the last test wave did not merge";
    return plan;
  }
  const { deps } = ctx;
  if (deps.repoRoot === null) {
    plan.blocked =
      "no Volley checkout to run `volley repo add` and `volleyd run` from (run setup from the checkout)";
    return plan;
  }
  const coordinator = ctx.coordinator ?? readSetupInstall(ctx.volleydHome)?.coordinator;
  if (coordinator === undefined) {
    plan.blocked = `no coordinator name yet (the wave's owner): run \`volley setup --step claude-code\` first`;
    return plan;
  }
  const env = firstWaveEnv(ctx);
  // The scratch README is a commit: git must have an identity here (no silent injected one).
  if ((await deps.exec(GIT_IDENT_PROBE, { cwd: ctx.home, env })).code !== 0) {
    plan.blocked =
      "git has no commit identity (user.name/user.email) for the scratch repository's README commit: run `volley setup --step signin` (it sets one from your GitHub account), or set one yourself";
    return plan;
  }
  if (deps.waveState === undefined) {
    plan.blocked = "this setup cannot read the wave's state from the broker";
    return plan;
  }
  if (o.repo !== undefined) {
    const origin = await deps.exec(gitOriginArgv(o.repo), { env });
    if (origin.code !== 0) {
      plan.blocked = `${o.repo} has no origin remote: \`volleyd validate\` refuses a wave whose repo has none while require_fresh_base is on (BASE_STALE: volleyd fetches the release branch before every worktree it cuts). Add one (\`git remote add origin …\`), or run without --repo for a scratch repository`;
      return plan;
    }
    plan.found.push(`Repository: ${o.repo} (origin ${firstLine(origin.stdout)})`);
  }
  if (record !== null && !record.merged) {
    plan.found.push(`The last test wave did not merge (${record.at.slice(0, 10)})`);
  }
  for (const s of scratchesOf(record)) {
    plan.found.push(`Scratch repository of an earlier test wave: ${s} (${ghRepoDeleteLine(s)})`);
  }
  if (o.simulated === true) plan.found.push("Simulated: volley-sim's gh and claude, no GitHub");

  // The one question (Enter: yes); never asked under --yes or --simulated.
  if (!ctx.yes && o.simulated !== true) {
    if (!(await deps.confirm(FIRST_WAVE_QUESTION, true))) {
      plan.skipped = `declined: run \`${FIRST_WAVE_LATER}\` to run it later`;
      return plan;
    }
  }
  plan.confirmed = true;

  const suffix = helloSuffix(deps.random);
  const name = helloRepoName(suffix);
  const wave = helloWave(suffix);
  const release = helloRelease(new Date(now(ctx)), wave);
  const issue = o.issue !== undefined ? `issue #${o.issue}` : `a new issue "${HELLO_ISSUE_TITLE}"`;
  plan.changes.push({
    summary:
      o.repo !== undefined
        ? `Run a 1-issue test wave on ${o.repo} (${issue}), merged by volleyd`
        : `Create the private repository ${name}, file ${issue} and run a 1-issue test wave on it, merged by volleyd`,
    detail: [
      ...(o.repo === undefined
        ? [
            `${ghRepoCreateArgv(name).join(" ")}, a README commit pushed`,
            `gh issue create "${HELLO_ISSUE_TITLE}"`,
          ]
        : o.issue === undefined
          ? [`gh issue create "${HELLO_ISSUE_TITLE}"`]
          : []),
      o.repo !== undefined
        ? `the release branch ${release} pushed, cut from ${o.repo}'s checked-out commit (HEAD)`
        : `the release branch ${release} pushed`,
      ...(o.repo === undefined && o.simulated !== true
        ? ["volley repo add <owner/name> --wait (cloned under fleet.repo_root, trusted)"]
        : []),
      `.volley/waves/${wave}.yaml (model ${DEFAULT_MODEL}, merge: auto), volleyd validate, volleyd run --owner ${coordinator}`,
      `followed until merged (at most ${FIRST_WAVE_DEFAULTS.timeout_ms / 60_000} minutes from the submit)`,
    ].join("\n"),
    apply: () => runFirstWave(ctx, { ...o, coordinator, name, wave, env }),
  });
  return plan;
}

const now = (ctx: SetupContext) => (ctx.deps.now ?? Date.now)();

async function runFirstWave(
  ctx: SetupContext,
  o: FirstWaveOptions & {
    coordinator: string;
    name: string;
    wave: string;
    env: Record<string, string | undefined>;
  },
): Promise<string[]> {
  const { deps } = ctx;
  const repoRoot = deps.repoRoot as string;
  const t0 = now(ctx);
  const x = async (
    argv: string[],
    opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
  ) => {
    const r = await deps.exec(argv, {
      env: opts.env ?? o.env,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
    });
    if (r.code !== 0) {
      throw new Error(
        `\`${argv.slice(0, 4).join(" ")}\` exited ${r.code}: ${firstLine(r.stderr) || firstLine(r.stdout)}`,
      );
    }
    return r.stdout;
  };
  const lines: string[] = [];
  const release = helloRelease(new Date(t0), o.wave);
  const earlier = scratchesOf(readFirstWave(ctx.volleydHome));
  let clone: string;
  let scratch: string | undefined;
  if (o.repo === undefined) {
    const work = join(ctx.volleydHome, "first-wave");
    mkdirSync(work, { recursive: true });
    await x(ghRepoCreateArgv(o.name), { cwd: work });
    clone = join(work, o.name);
    scratch = (await x(GH_REPO_VIEW, { cwd: clone })).trim();
    ctx.firstWaveScratch = scratch;
    writeFileSync(join(clone, "README.md"), HELLO_README);
    await x(gitAddReadmeArgv(clone));
    await x(gitCommitReadmeArgv(clone));
    await x(gitPushDefaultArgv(clone));
    lines.push(`Created ${scratch} (private), its clone ${clone}`);
  } else {
    clone = o.repo;
  }
  const slug = scratch ?? (await x(GH_REPO_VIEW, { cwd: clone })).trim();
  let issue = o.issue;
  if (issue === undefined) {
    const out = await x(ghIssueCreateArgv(slug));
    const n = issueNumberOf(out);
    if (n === null) throw new Error(`gh issue create printed no issue URL: ${firstLine(out)}`);
    issue = n;
    lines.push(`Filed ${slug}#${n} "${HELLO_ISSUE_TITLE}"`);
  }
  await x(gitPushReleaseArgv(clone, release));
  lines.push(`Pushed ${release}`);

  // A scratch repository joins the fleet: volleyd clones it under fleet.repo_root and trusts it.
  // Simulated, the wave runs from the scratch clone (volleyd cannot clone it from GitHub).
  let waveRepo = clone;
  if (scratch !== undefined && o.simulated !== true) {
    let admin: AdminCredentials | null = null;
    try {
      admin = readCredentials(join(ctx.auth.dir, ADMIN_FILE));
    } catch {
      // `volley repo add` says it needs an admin login.
    }
    const adminEnv = {
      ...o.env,
      ...(admin !== null
        ? { VOLLEY_AUTH_USERNAME: admin.username, VOLLEY_AUTH_PASSWORD: admin.password }
        : {}),
    };
    await x([deps.bun, volleyCli(repoRoot), "repo", "add", scratch, "--wait"], { env: adminEnv });
    const status = JSON.parse(
      await x([deps.bun, volleyCli(repoRoot), "repo", "status", scratch, "--json"]),
    ) as { repos?: { machines?: Record<string, { state: string; path?: string }> }[] };
    const here = Object.values(status.repos?.[0]?.machines ?? {}).find(
      (m) => m.state === "ready" && m.path !== undefined && existsSync(join(m.path, ".git")),
    );
    if (here?.path === undefined) {
      throw new Error(`volley repo add left no ready clone of ${scratch} on this machine`);
    }
    waveRepo = here.path;
    lines.push(`Added ${scratch} to the fleet: ${waveRepo} (ready)`);
  } else if (scratch !== undefined) {
    // No `volley repo add` (the add volleyd takes as the owner's consent): setup trusts the
    // scratch clone it just made, or the wave waits on a repo_untrusted decision.
    recordRepoTrust(join(ctx.home, ".claude.json"), clone);
    lines.push(`Trusted ${clone} for Claude Code (the scratch clone setup made)`);
  }

  const file = join(waveRepo, ".volley", "waves", `${o.wave}.yaml`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    helloWaveYaml({ wave: o.wave, repo: waveRepo, release, model: DEFAULT_MODEL, issue }),
  );
  await x([deps.bun, volleydCli(repoRoot), "validate", file]);
  await x([deps.bun, volleydCli(repoRoot), "run", file, "--owner", o.coordinator]);
  lines.push(`Submitted ${file} (owner ${o.coordinator})`);

  // The cap counts from the submit: the repository's setup does not eat into the wave's time.
  const until = now(ctx) + FIRST_WAVE_DEFAULTS.timeout_ms;
  const waveState = deps.waveState as NonNullable<typeof deps.waveState>;
  let end: WaveOutcome = null;
  let last: WaveView | null = null;
  let readError: string | null = null;
  for (;;) {
    try {
      last = await waveState(o.wave);
    } catch (e) {
      last = null;
      readError = e instanceof Error ? e.message : String(e);
    }
    end = waveOutcome(last);
    if (end !== null || now(ctx) >= until) break;
    await deps.sleep(FIRST_WAVE_DEFAULTS.poll_ms);
  }
  const wall = Math.max(0, now(ctx) - t0);
  const pr = end?.pr ?? last?.tasks.find((t) => t.pr !== undefined)?.pr?.url ?? null;
  const merged = end?.end === "done";
  ctx.metrics?.firstWave?.({ wall_ms: wall, pr, merged });
  writeFirstWave(ctx.volleydHome, {
    at: new Date(t0).toISOString(),
    wall_ms: wall,
    pr,
    merged,
    wave: o.wave,
    repo: waveRepo,
    ...(scratch !== undefined ? { scratch } : {}),
    ...(earlier.length > 0 ? { earlier } : {}),
  });
  const deletes = [...earlier, ...(scratch !== undefined ? [scratch] : [])].map(ghRepoDeleteLine);
  if (end?.end === "done") {
    lines.push(`Merged ${pr ?? "the PR"} in ${formatWall(wall)}`);
    if (scratch !== undefined) {
      lines.push(
        `Delete the scratch repository when you no longer want it: ${ghRepoDeleteLine(scratch)} (and its clones: ${clone}${waveRepo !== clone ? `, ${waveRepo}` : ""})`,
      );
    }
    for (const s of earlier)
      lines.push(`An earlier test wave's scratch repository: ${ghRepoDeleteLine(s)}`);
    return lines;
  }
  const why =
    end === null
      ? `did not finish within ${FIRST_WAVE_DEFAULTS.timeout_ms / 60_000} minutes${last === null && readError !== null ? ` (reading its state: ${readError})` : ""}`
      : `${end.end}: ${end.why}`;
  const tail = journalTail(ctx.volleydHome, o.wave, FIRST_WAVE_DEFAULTS.journal_tail);
  const decisions = last?.open_decisions ?? [];
  throw new Error(
    [
      `the test wave ${why}${pr !== null ? ` (PR ${pr})` : ""}`,
      ...(tail.length > 0 ? ["  journal (last events):", ...tail.map((l) => `    ${l}`)] : []),
      `  open decisions: ${decisions.length > 0 ? decisions.join(", ") : "none"}`,
      `  follow it with \`volleyd status ${o.wave}\`; rerun \`${FIRST_WAVE_LATER}\` once it is fixed (a rerun runs a wave of its own)${deletes.length > 0 ? `; delete the scratch repositories with ${deletes.join(", ")}` : ""}`,
    ].join("\n"),
  );
}
