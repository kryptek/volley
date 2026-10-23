import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realRepoDeps, runRepo } from "volley-cli/commands/repo";
import { makeBufferIO } from "volley-cli/io";
import type { DoctorReport, MachineRepo } from "../src/machines";
import { repoStateLine } from "../src/repos";
import type { TaskState } from "../src/types";
import { eventually } from "./helpers/broker-wait";
import { NS } from "./helpers/daemon-env";
import { GREEN_DOCTOR } from "./helpers/fake-host";
import { type Fleet, LOCAL, PEER, VERSION, makeFleet } from "./helpers/fleet-env";
import { tempDir } from "./helpers/tmp";

/**
 * Repositories end to end (SPEC §4.6.21, epic #395): the supervisor's own machine (`control`) and
 * one paired box, two repositories. `a/a` is on both, `b/b` on the box only; placement keeps each
 * wave on a machine with a ready clone of its repository, a toolchain the box lacks keeps `a/a`'s
 * waves off it (and only those), a legacy `hosts.box.repo` migrates and its first wave spawns, a
 * `local → auto` resubmit places the admitted task, and `volley repo status` prints the lines the
 * Desk reads from the same verdicts.
 */

const A = "a/a";
const B = "b/b";

const clone = (slug: string, path: string, missing: string[] = []): MachineRepo => ({
  slug,
  path,
  exists: true,
  managed: true,
  fetched_at: null,
  toolchain: { ok: missing.length === 0, missing, outdated: [] },
});
const report = (repos: MachineRepo[]): DoctorReport => ({
  ...GREEN_DOCTOR,
  versions: { peer: VERSION, volley: VERSION, bun: "1.3.1", git: "2.43.0" },
  repos,
});
const view = (slug: string) =>
  JSON.stringify({ nameWithOwner: slug, url: `https://github.com/${slug}`, visibility: "PUBLIC" });

let f: Fleet;
let live = false;
/** The supervisor's own managed clone of a/a (it never holds one of b/b). */
let localA: string;
/**
 * The box's managed clones: `fleet.repo_root` is absolute here, so each is at the same path on
 * every machine.
 */
let BOX_A: string;
let BOX_B: string;

afterEach(async () => {
  if (!live) return;
  live = false;
  await f.close();
});

/**
 * The fleet without a legacy `hosts.box.repo` (unless `legacy`), both repositories known to gh,
 * the supervisor's clone of a/a in place. `f.repo` is the supervisor's checkout of b/b: a wave on
 * b/b names that path (the supervisor is not a b/b machine), and gh reads b/b there.
 */
async function setup(o: { legacy?: boolean } = {}): Promise<void> {
  const base = realpathSync(tempDir("volleyd-fleet-repos-"));
  const repoRoot = join(base, "managed");
  localA = join(repoRoot, "a", "a");
  BOX_A = localA;
  BOX_B = join(repoRoot, "b", "b");
  mkdirSync(localA, { recursive: true });
  f = await makeFleet({
    repoRoot,
    ...(o.legacy === true ? {} : { boxRepo: null }),
    localDoctor: (repo) =>
      repo === localA ? { ...GREEN_DOCTOR, repo: { path: repo, exists: true } } : GREEN_DOCTOR,
  });
  live = true;
  f.exec
    .on(["gh", "repo", "view", A], { stdout: view(A) })
    .on(["gh", "repo", "view", B], { stdout: view(B) })
    // A submit's `gh repo view` runs in the wave's clone.
    .on(["gh", "repo", "view", "--json"], (_argv, opts) => ({
      stdout: view(opts.cwd === localA ? A : B),
    }))
    .on(["git", "-C", localA, "rev-parse", "--show-toplevel"], { stdout: `${localA}\n` })
    .on(["git", "-C", localA, "rev-parse", "--verify"], { stdout: `${"1".repeat(40)}\n` })
    .on(["git", "-C", localA, "fetch"], {})
    // The box's clone of b/b (its git runs on the same fake exec).
    .on(["git", "-C", BOX_B, "rev-parse", "--show-toplevel"], { stdout: `${BOX_B}\n` });
}

function theBox() {
  const box = f.box();
  if (box === undefined) throw new Error("no box");
  return box;
}

const repoState = async (machine: string, slug: string) =>
  (await f.verdict(machine))?.repos[slug]?.state;

/** a/a on every machine, b/b on the box only; the box's clones as `boxRepos` reports them. */
async function addBoth(boxRepos: MachineRepo[]): Promise<void> {
  theBox().answers.doctor = report(boxRepos);
  expect(await f.adminOp({ op: "repo_add", slug: A })).toMatchObject({
    ok: true,
    result: { slug: A, machines: [LOCAL, PEER] },
  });
  expect(await f.adminOp({ op: "repo_add", slug: B, machines: [PEER] })).toMatchObject({
    ok: true,
    result: { slug: B, machines: [PEER] },
  });
  // The box's heartbeats carry its clones from now on (30 s on: its verdict is republished).
  await f.tick(29_500);
  await f.beat({ repos: boxRepos });
  await eventually(async () => {
    await f.tick(0);
    return (
      (await repoState(LOCAL, A)) === "ready" &&
      (await repoState(PEER, B)) === "ready" &&
      (await repoState(PEER, A)) !== undefined &&
      (await repoState(PEER, A)) !== "cloning"
    );
  });
}

/** The task's placement once it is placed (or why it waits), from the wave's state. */
async function placed(wave: string, task = "T1"): Promise<TaskState> {
  let t: TaskState | undefined;
  await eventually(async () => {
    await f.tick(0);
    t = await f.task(wave, task);
    return t?.placement !== undefined && t.placement !== null;
  });
  return t as TaskState;
}

const spawnedOn = (wave: string, task = "T1") =>
  f.journal(wave).find((e) => e.type === "agent_spawned" && e.task === task)?.data.host;

async function spawned(wave: string, task = "T1"): Promise<unknown> {
  await eventually(async () => {
    await f.tick(0);
    return spawnedOn(wave, task) !== undefined;
  });
  return spawnedOn(wave, task);
}

describe("two repositories on a supervisor and one paired box (#439)", () => {
  it("a/a's wave places on either machine; b/b's only on the box", async () => {
    await setup();
    await addBoth([clone(A, BOX_A), clone(B, BOX_B)]);

    // Wave A: both machines eligible for a/a; the box preferred, so it runs there.
    await f.submit(
      "wa",
      "placement: auto\nplacement_prefer: [box]\n",
      "  T1: { issue: 42 }\n",
      undefined,
      A,
    );
    const a = await placed("wa");
    expect(a.placement).toMatchObject({ host: PEER, by: "auto" });
    expect(a.placement?.candidates.map((c) => [c.host, c.score !== null])).toEqual([
      [PEER, true],
      [LOCAL, true],
    ]);
    expect(await spawned("wa")).toBe(PEER);

    // Wave B: the supervisor has no clone of b/b, so only the box can take it.
    await f.submit("wb", "placement: auto\n", "  T1: { issue: 42 }\n");
    const b = await placed("wb");
    expect(b.placement).toMatchObject({ host: PEER, by: "auto" });
    // Its checkout is the supervisor's (the wave runs from it), not a b/b machine's clone.
    expect(b.placement?.candidates.find((c) => c.host === LOCAL)?.line).toBe(
      `ineligible: no ready clone of ${B} (blocked: ${B} is not assigned to ${LOCAL}: add it (Settings → Repositories, or volley repo add ${B} --machine ${LOCAL}))`,
    );
    expect(await spawned("wb")).toBe(PEER);
  });

  it("the box missing java for a/a is skipped for a/a's wave with the reason; b/b's still places there", async () => {
    await setup();
    await addBoth([clone(A, BOX_A, ["java"]), clone(B, BOX_B)]);
    expect(await repoState(PEER, A)).toBe("blocked");
    expect((await f.verdict(PEER))?.repos[A]?.reasons).toEqual([
      `java not installed (needed by ${A})`,
    ]);
    // The machine stays ready: one repository's toolchain blocks that repository only.
    expect((await f.verdict(PEER))?.ready).toBe(true);

    await f.submit(
      "wa",
      "placement: auto\nplacement_prefer: [box]\n",
      "  T1: { issue: 42 }\n",
      undefined,
      A,
    );
    const a = await placed("wa");
    expect(a.placement).toMatchObject({ host: LOCAL, by: "auto" });
    expect(a.placement?.candidates.find((c) => c.host === PEER)?.line).toBe(
      `ineligible: no ready clone of ${A} (blocked: java not installed (needed by ${A}))`,
    );
    expect(await spawned("wa")).toBe("local");

    await f.submit("wb", "placement: auto\n", "  T1: { issue: 42 }\n");
    expect((await placed("wb")).placement).toMatchObject({ host: PEER, by: "auto" });
    expect(await spawned("wb")).toBe(PEER);
  });

  it("volley repo status prints the lines the Desk reads from each machine's verdict", async () => {
    await setup();
    await addBoth([clone(A, BOX_A, ["java"]), clone(B, BOX_B)]);
    const io = makeBufferIO();
    const auth = tempDir("volleyd-fleet-repos-auth-");
    const code = await runRepo(
      {
        argv: ["status"],
        env: {
          VOLLEY_BROKER_URL: f.env.broker.url,
          VOLLEY_NAMESPACE: NS,
          VOLLEY_AUTH_DIR: auth,
          VOLLEYD_HOME: f.env.home,
          HOME: auth,
        },
        io,
      },
      realRepoDeps(),
    );
    expect(io.readStderr()).toBe("");
    expect(code).toBe(0);
    // The Desk's machine cards and Settings › Repositories read the retained verdicts.
    const local = await f.verdict(LOCAL);
    const box = await f.verdict(PEER);
    const expected = [
      A,
      `  ${repoStateLine(LOCAL, local?.repos[A])}`,
      `  ${repoStateLine(PEER, box?.repos[A])}`,
      B,
      `  ${repoStateLine(PEER, box?.repos[B])}`,
      "",
    ].join("\n");
    expect(io.readStdout()).toBe(expected);
    expect(io.readStdout()).toContain(`${LOCAL}: ready (${localA})`);
    expect(io.readStdout()).toContain(`${PEER}: blocked (java not installed (needed by ${A}))`);
    expect(io.readStdout()).toContain(`${PEER}: ready (${BOX_B})`);
  });
});

describe("a legacy hosts.box.repo (D10) and a local → auto resubmit (D11)", () => {
  it("migrates when the box's record reports its origin, and the first wave still spawns there", async () => {
    await setup({ legacy: true });
    expect((await f.client.request("config_get", { path: `hosts.${PEER}.repo` })).result).toBe(
      f.repo,
    );
    await f.beat({ repo: { path: f.repo, exists: true, origin: `github.com/${B}` } });
    await eventually(async () => {
      await f.tick(0);
      const r = await f.client.request("config_get", { path: `hosts.${PEER}.repos` });
      return JSON.stringify(r.result) === JSON.stringify({ [B]: f.repo });
    });
    expect((await f.client.request("config_get", { path: `hosts.${PEER}.repo` })).result).toBe(
      undefined,
    );
    expect(f.system().filter((e) => e.type === "config_changed")).toHaveLength(1);

    await f.submit("wb", "placement: auto\n", "  T1: { issue: 42 }\n");
    expect((await placed("wb")).placement).toMatchObject({ host: PEER, by: "auto" });
    expect(await spawned("wb")).toBe(PEER);
    expect(theBox().spec.repo).toBe(f.repo);
  });

  it("a local → auto resubmit gives the admission back and places the task on the box", async () => {
    await setup();
    await addBoth([clone(A, BOX_A), clone(B, BOX_B)]);
    // Admitted on the supervisor's machine, but its launch is refused: admitted, never spawned.
    f.local.launchOutcome = "refused";
    await f.submit("wa", "placement: local\n", "  T1: { issue: 42 }\n", undefined, A);
    await eventually(async () => {
      await f.tick(0);
      return f.journal("wa").some((e) => e.type === "spawn_failed" && e.task === "T1");
    });
    f.local.launchOutcome = "ok";

    await f.submit(
      "wa",
      "placement: auto\nplacement_prefer: [box]\n",
      "  T1: { issue: 42 }\n",
      undefined,
      A,
    );
    expect(f.journal("wa").filter((e) => e.type === "task_admission_returned")).toMatchObject([
      { task: "T1", data: { from_host: "local", to_host: "auto" } },
    ]);
    // Past the refused launch's backoff (spawn_retry_base_ms, 30 s), within the box's
    // heartbeat timeout (machine_down_after_ms, 90 s).
    await f.tick(40_000);
    expect(await spawned("wa")).toBe(PEER);
    expect(
      f
        .journal("wa")
        .filter((e) => e.type === "task_placed")
        .map((e) => e.data.host),
    ).toEqual([PEER]);
    expect(theBox().spec.repo).toBe(BOX_A);
  });
});
