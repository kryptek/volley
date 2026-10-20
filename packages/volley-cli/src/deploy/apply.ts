import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { deskStamp, readBundleVersion, writeDeskStamp } from "../setup/desk-build";
import { deskEnvLeaks } from "../setup/services";
import type { SetupExec } from "../setup/step";
import {
  type Command,
  type PlanContext,
  type PlanStep,
  type Ref,
  deployPlan,
  deskDir,
  git,
  refLabel,
  resolveTag,
} from "./plan";

/**
 * `volley deploy`'s apply: stash (when asked), fetch, resolve the tag, then the plan's steps
 * through the fenced exec. Any failure after the checkout repeats the same steps at the previous
 * ref (never stashing or fetching); a rollback that fails too returns the commands to run by hand.
 */

export interface ApplyDeps {
  /** The fenced exec (`deployFence`). */
  exec: SetupExec;
  /** The environment the commands inherit (the Desk build drops VITE_VOLLEY_BROKER_*). */
  env: Record<string, string | undefined>;
  now: () => Date;
  /** One summary line per step. */
  report: (line: string) => void;
  /** The Desk answers and serves `version` (null: any); null when healthy, else why not. */
  deskHealthy: (base: string, version: string | null) => Promise<string | null>;
  /** volleyd's retained status is live and newer than `since`; null when healthy, else why not. */
  volleydHealthy: (since: Date) => Promise<string | null>;
}

export interface ApplyContext extends Omit<PlanContext, "target" | "fetch"> {
  /** What the checkout was at before the deploy (the rollback's target). */
  from: Ref;
  /** The tag asked for, or "latest". */
  requested: string;
}

export interface StepOutcome {
  title: string;
  ok: boolean;
  why?: string;
}

export interface DeployResult {
  ok: boolean;
  from: string;
  /** The tag deployed (or asked for, when it did not resolve). */
  to: string;
  steps: StepOutcome[];
  failed?: { step: string; why: string };
  /** A failure after the checkout put the previous ref back. */
  rolledBack: boolean;
  rollbackFailed?: { step: string; why: string; byHand: string[] };
}

/** The last non-empty line a failed command printed (stderr first). */
const lastLine = (r: { stdout: string; stderr: string }, argv: readonly string[]) =>
  (r.stderr.trim() || r.stdout.trim()).split("\n").at(-1)?.trim() || `\`${argv.join(" ")}\` failed`;

const shell = (c: Command) => `${c.cwd !== undefined ? `cd ${c.cwd} && ` : ""}${c.argv.join(" ")}`;

/** Run `steps`; the first failure, or null. `version`: what the checkout must report (null: any). */
async function runSteps(
  ctx: PlanContext,
  steps: PlanStep[],
  version: { cli: string | null; bundle: string | null },
  deps: ApplyDeps,
  out: StepOutcome[],
  prefix: string,
): Promise<{ step: string; why: string } | null> {
  let restartedAt: Date | null = null;
  for (const step of steps) {
    const why = await runStep(ctx, step, version, deps, () => {
      restartedAt ??= deps.now();
      return restartedAt;
    });
    out.push({ title: step.title, ok: why === null, ...(why !== null ? { why } : {}) });
    deps.report(
      why === null ? `ok      ${prefix}${step.title}` : `FAILED  ${prefix}${step.title}: ${why}`,
    );
    if (why !== null) return { step: step.title, why };
  }
  return null;
}

async function runStep(
  ctx: PlanContext,
  step: PlanStep,
  version: { cli: string | null; bundle: string | null },
  deps: ApplyDeps,
  restarted: () => Date,
): Promise<string | null> {
  const dist = join(deskDir(ctx.repo), "dist");
  let env = deps.env;
  if (step.id === "build") {
    const leaks = deskEnvLeaks(deskDir(ctx.repo));
    if (leaks.length > 0) {
      return `${leaks.join(", ")} in packages/volley-desk set VITE_VOLLEY_BROKER_*: Vite would build that broker URL or login into the page; remove those lines`;
    }
    // Vite inlines VITE_* into the bundle: never a broker URL or a dev login.
    const {
      VITE_VOLLEY_BROKER_URL: _u,
      VITE_VOLLEY_BROKER_USERNAME: _n,
      VITE_VOLLEY_BROKER_PASSWORD: _p,
      ...rest
    } = deps.env;
    env = rest;
  }
  if (step.id === "restart") restarted();
  if (step.id === "health") {
    const since = restarted();
    const problems = await Promise.all([
      deps.volleydHealthy(since),
      deps.deskHealthy(`http://127.0.0.1:${ctx.deskPort}`, version.bundle),
    ]);
    const bad = problems.filter((p): p is string => p !== null);
    return bad.length === 0 ? null : bad.join("; ");
  }
  for (const c of step.commands) {
    const r = await deps.exec(c.argv, { ...(c.cwd !== undefined ? { cwd: c.cwd } : {}), env });
    if (r.code !== 0) return lastLine(r, c.argv);
    if (step.id === "self-check" && c.argv[2] === "--version" && version.cli !== null) {
      const v = r.stdout.trim();
      if (v !== version.cli) return `volley --version is ${v || "empty"}, not ${version.cli}`;
    }
  }
  if (step.id === "build") {
    if (!existsSync(join(dist, "index.html")))
      return `the build wrote no ${join(dist, "index.html")}`;
    writeDeskStamp(dist, deskStamp(ctx.repo));
  }
  if (step.id === "self-check") {
    if (!existsSync(join(dist, "index.html")))
      return `no ${join(dist, "index.html")} after the build`;
    const bundle = readBundleVersion(dist);
    if (version.bundle !== null && bundle !== version.bundle) {
      return `the Desk bundle is ${bundle ?? "missing version.json"}, not ${version.bundle}`;
    }
  }
  return null;
}

/** The root package.json's version in the checkout as it is now, or null. */
function checkoutVersion(repo: string): string | null {
  try {
    const v = (
      JSON.parse(readFileSync(join(repo, "package.json"), "utf-8")) as { version?: unknown }
    ).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function applyDeploy(ctx: ApplyContext, deps: ApplyDeps): Promise<DeployResult> {
  const { from, requested, stash, ...base } = ctx;
  const steps: StepOutcome[] = [];
  const result = (r: Omit<DeployResult, "from" | "steps">): DeployResult => ({
    from: refLabel(from),
    steps,
    ...r,
  });

  // Before the checkout: a failure here changes nothing (a stash stays, named in the report).
  const prepPlan: PlanContext = {
    ...base,
    target: from,
    fetch: true,
    ...(stash !== undefined ? { stash } : {}),
  };
  const prep = deployPlan(prepPlan).filter((s) => s.id === "stash" || s.id === "fetch");
  const prepFailed = await runSteps(prepPlan, prep, { cli: null, bundle: null }, deps, steps, "");
  if (prepFailed !== null) {
    return result({ ok: false, to: requested, failed: prepFailed, rolledBack: false });
  }
  const resolveTitle = `resolve ${requested === "latest" ? "the newest tag" : requested}`;
  const listed = await deps.exec(git(base.repo, "tag", "--list", "v*"));
  let tag: string;
  try {
    if (listed.code !== 0) throw new Error(lastLine(listed, ["git", "tag", "--list"]));
    tag = resolveTag(
      listed.stdout.split("\n").map((t) => t.trim()),
      requested,
    );
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    steps.push({ title: resolveTitle, ok: false, why });
    deps.report(`FAILED  ${resolveTitle}: ${why}`);
    return result({
      ok: false,
      to: requested,
      failed: { step: resolveTitle, why },
      rolledBack: false,
    });
  }
  steps.push({ title: `resolve ${tag}`, ok: true });
  deps.report(`ok      resolve ${tag}`);

  const forward: PlanContext = { ...base, target: { kind: "tag", name: tag }, fetch: false };
  const version = tag.replace(/^v/, "");
  const failed = await runSteps(
    forward,
    deployPlan(forward),
    { cli: version, bundle: version },
    deps,
    steps,
    "",
  );
  if (failed === null) return result({ ok: true, to: tag, rolledBack: false });
  // The checkout itself failed: HEAD never moved, so there is nothing to roll back.
  if (steps.at(-1)?.title === deployPlan(forward).find((s) => s.id === "checkout")?.title) {
    return result({ ok: false, to: tag, failed, rolledBack: false });
  }

  deps.report(`rolling back to ${refLabel(from)}`);
  const back: PlanContext = { ...base, target: from, fetch: false };
  const backSteps = deployPlan(back);
  const rollbackSteps: StepOutcome[] = [];
  // The version the previous ref reports is read after its checkout; its build may predate
  // version.json, so the Desk's bundle is taken as it is.
  const [checkoutStep, ...rest] = backSteps;
  let backFailed = await runSteps(
    back,
    checkoutStep !== undefined ? [checkoutStep] : [],
    { cli: null, bundle: null },
    deps,
    rollbackSteps,
    "rollback: ",
  );
  if (backFailed === null) {
    backFailed = await runSteps(
      back,
      rest,
      { cli: checkoutVersion(base.repo), bundle: null },
      deps,
      rollbackSteps,
      "rollback: ",
    );
  }
  steps.push(...rollbackSteps.map((s) => ({ ...s, title: `rollback: ${s.title}` })));
  if (backFailed === null) return result({ ok: false, to: tag, failed, rolledBack: true });
  return result({
    ok: false,
    to: tag,
    failed,
    rolledBack: false,
    rollbackFailed: {
      ...backFailed,
      byHand: backSteps
        .filter((s) => s.id !== "self-check" && s.id !== "health")
        .flatMap((s) => s.commands.map(shell)),
    },
  });
}
