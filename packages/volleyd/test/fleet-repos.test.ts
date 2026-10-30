import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
import { runCli } from "./helpers/run-cli";
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
/** Each own doctor run: its clone and the expected email the daemon passed (#638). */
let ownRuns: { repo: string | null; gitEmail?: { slug: string; email: string } }[] = [];

async function setup(o: { legacy?: boolean } = {}): Promise<void> {
  ownRuns = [];
  const base = realpathSync(tempDir("volleyd-fleet-repos-"));
  const repoRoot = join(base, "managed");
  localA = join(repoRoot, "a", "a");
  BOX_A = localA;
  BOX_B = join(repoRoot, "b", "b");
  mkdirSync(localA, { recursive: true });
  f = await makeFleet({
    repoRoot,
    ...(o.legacy === true ? {} : { boxRepo: null }),
    // The own doctor finds each clone it runs on (a/a's managed one, the checkout of b/b).
    localDoctor: (repo, opts) => {
      ownRuns.push({ repo, ...(opts?.gitEmail !== undefined ? { gitEmail: opts.gitEmail } : {}) });
      return repo !== null ? { ...GREEN_DOCTOR, repo: { path: repo, exists: true } } : GREEN_DOCTOR;
    },
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

describe("#638: the own doctor learns a repository's expected email", () => {
  it("runs with the email for a clone whose repository expects one, and without it otherwise", async () => {
    await setup();
    await addBoth([clone(A, BOX_A), clone(B, BOX_B)]);
    expect(
      await f.adminOp({ op: "repo_add", slug: A, git_email: "dev@example.com" }),
    ).toMatchObject({ ok: true });
    ownRuns = [];
    await eventually(async () => {
      await f.tick(30_000);
      return ownRuns.some((r) => r.repo === localA);
    });
    expect(ownRuns.find((r) => r.repo === localA)?.gitEmail).toEqual({
      slug: A,
      email: "dev@example.com",
    });
    expect(ownRuns.filter((r) => r.repo !== localA).every((r) => r.gitEmail === undefined)).toBe(
      true,
    );
  });
});

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
    // Its checkout is the supervisor's (the wave runs from it), not yet a b/b machine's clone at
    // its own admission (the submit adopts it right after, #616: a later wave sees it).
    expect(b.placement?.candidates.find((c) => c.host === LOCAL)?.line).toBe(
      `ineligible: no ready clone of ${B} (blocked: ${B} is not assigned to ${LOCAL}: add it (Settings → Repositories, or volley repo add ${B} --machine ${LOCAL}))`,
    );
    expect(await spawned("wb")).toBe(PEER);
  });

  it("a wave names b/b by its owner/name: kept as the slug, placed and spawned on the box (#448)", async () => {
    await setup();
    await addBoth([clone(A, BOX_A), clone(B, BOX_B)]);

    // No checkout of b/b on the supervisor, none configured for it: only the box holds one.
    await f.submit("wb2", "placement: auto\n", "  T1: { issue: 42 }\n", undefined, B);
    const b = await placed("wb2");
    expect(b.placement).toMatchObject({ host: PEER, by: "auto" });
    expect(b.placement?.candidates.find((c) => c.host === LOCAL)?.line).toBe(
      `ineligible: no ready clone of ${B} (blocked: ${B} is not assigned to ${LOCAL}: add it (Settings → Repositories, or volley repo add ${B} --machine ${LOCAL}))`,
    );
    expect(await spawned("wb2")).toBe(PEER);
    const ev = f.journal("wb2").find((e) => e.type === "agent_spawned");
    expect(JSON.stringify(ev?.data)).toContain(BOX_B);
    const state = (await f.state("wb2")) as { repo?: string; github?: { slug?: string } };
    expect(state.repo).toBe(B);
    expect(state.github?.slug).toBe(B);
    expect(f.journal("wb2").some((e) => e.data?.alarm === "repo_visibility_unknown")).toBe(false);
  });

  it("a task of a box-only owner/name wave pinned to host: local is refused at submit (#448)", async () => {
    await setup();
    await addBoth([clone(A, BOX_A), clone(B, BOX_B)]);
    await expect(
      f.submit("wb3", "placement: auto\n", "  T1: { issue: 42, host: local }\n", undefined, B),
    ).rejects.toThrow(
      `tasks.T1.host: no clone of ${B} on ${LOCAL}: drop its host: local (or set host: auto) so it runs on ${PEER}, or add the clone (volley repo add ${B} --machine ${LOCAL})`,
    );
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

describe("one spawn path for readiness and the spawn (#608)", () => {
  it("adopting a/a on the box at another path moves the verdict and the spawn together", async () => {
    await setup();
    await addBoth([clone(A, BOX_A), clone(B, BOX_B)]);
    expect(await repoState(PEER, A)).toBe("ready");
    const mine = "/srv/mine-a";
    f.exec.on(["git", "-C", mine, "rev-parse", "--show-toplevel"], { stdout: `${mine}\n` });
    // Config adopts a/a there; the box still reports its managed clone: the two disagree.
    theBox().answers.doctor = report([clone(A, BOX_A), clone(B, BOX_B)]);
    await f.adminOp({ op: "repo_add", slug: A, machines: [PEER], paths: { [PEER]: mine } });
    await f.beat({ repos: [clone(A, BOX_A), clone(B, BOX_B)] });
    await eventually(async () => {
      await f.tick(0);
      return (await f.verdict(PEER))?.repos[A]?.reasons[0]?.startsWith("the supervisor") === true;
    });
    expect((await f.verdict(PEER))?.repos[A]).toMatchObject({
      state: "blocked",
      path: BOX_A,
      reasons: [`the supervisor would spawn in ${mine} but ${PEER} reports its clone at ${BOX_A}`],
    });
    // The box reports the adopted clone: ready, and its spawn runs there.
    await f.beat({ repos: [{ ...clone(A, mine), managed: false }, clone(B, BOX_B)] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER, A)) === "ready";
    });
    expect((await f.verdict(PEER))?.repos[A]?.path).toBe(mine);
    await f.submit("wa", "", `  T1: { issue: 42, host: ${PEER} }\n`, undefined, A);
    expect(await spawned("wa")).toBe(PEER);
    const ev = f.journal("wa").find((e) => e.type === "agent_spawned");
    expect((ev?.data.remote as { repo?: string } | undefined)?.repo).toBe(mine);
  });
});

describe("a legacy hosts.box.repo (D10) and a local → auto resubmit (D11)", () => {
  it("migrates when the box's record reports its origin, and the first wave still spawns there", async () => {
    await setup({ legacy: true });
    expect((await f.client.request("config_get", { path: `hosts.${PEER}.repo` })).result).toBe(
      f.repo,
    );
    // The box's clone there is b/b's, as its record says (readiness probes it, #608).
    theBox().answers.clone = (path) => ({
      state: "found",
      root: path,
      slug: path === f.repo ? B : A,
    });
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

describe("the supervisor's own clones join the repository registry (#616)", () => {
  const waveYaml = (wave: string, head = "placement: local\n") =>
    `wave: ${wave}\nrepo: ${f.repo}\nrelease_branch: release/${wave}\nmodel: claude-opus-5-5\npipeline: [implement]\n${head}tasks:\n  T1: { issue: 42 }\n`;
  const sys = (type: string) => f.system().filter((e) => e.type === type);
  /** `fleet.repos` as the retained effective config says it. */
  const fleetRepos = async () =>
    (
      (await f.env.retained("volley/_waves/_config")) as {
        payload?: { fleet?: { repos?: Record<string, string> } };
      } | null
    )?.payload?.fleet?.repos;
  /**
   * `fleet.repos` once it says `want`: the daemon publishes a config change from a job queued
   * behind the op that made it, so the retained config can land just after the reply.
   */
  const settledRepos = async (want: Record<string, string> | undefined) => {
    await eventually(async () => {
      await f.tick(0);
      return JSON.stringify(await fleetRepos()) === JSON.stringify(want);
    });
    return fleetRepos();
  };

  /** The fleet, its sessions held: a wave's agent launches but never publishes (no race at close). */
  async function start(): Promise<void> {
    await setup();
    f.holdSessions(true);
  }

  /** b/b held by the box only (config names it), its clone ready there. */
  async function boxHoldsB(): Promise<void> {
    theBox().answers.doctor = report([clone(B, BOX_B)]);
    expect(await f.adminOp({ op: "repo_add", slug: B, machines: [PEER] })).toMatchObject({
      ok: true,
    });
    await f.tick(29_500);
    await f.beat({ repos: [clone(B, BOX_B)] });
  }

  it("a submit from a clone of a registered repository adopts it: config, journal, note, list, readiness, placement: auto", async () => {
    await start();
    await boxHoldsB();
    const before = sys("config_changed").length;
    const r = await f.client.request("run", { wave_yaml: waveYaml("wb") });
    expect(r.error).toBeUndefined();
    const note = `adopted ${f.repo} as ${LOCAL}'s clone of ${B}`;
    expect((r as { notes?: string[] }).notes).toEqual([note]);
    expect(await settledRepos({ [B]: f.repo })).toEqual({ [B]: f.repo });
    expect(sys("config_changed")).toHaveLength(before + 1);
    expect(sys("repo_added").at(-1)?.data).toEqual({
      by: "wave wb",
      slug: B,
      machines: [LOCAL],
      paths: { [LOCAL]: f.repo },
    });
    await eventually(async () => {
      await f.tick(0);
      return sys("repo_clone_run").some((e) => e.data.machine === LOCAL);
    });
    expect(sys("repo_clone_run").find((e) => e.data.machine === LOCAL)?.data).toMatchObject({
      machine: LOCAL,
      slug: B,
      ok: true,
      cloned: false,
      path: f.repo,
    });
    const list = (await f.client.request("repo_list", {})).result as {
      repos: { slug: string; paths?: Record<string, string> }[];
    };
    expect(list.repos.find((x) => x.slug === B)?.paths).toEqual({ [LOCAL]: f.repo });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(LOCAL, B)) === "ready";
    });
    const reasons = JSON.stringify((await f.verdict(LOCAL))?.reasons ?? []);
    expect(reasons).not.toContain("is not assigned");

    // A later wave with placement: auto has the supervisor's machine among its candidates.
    await f.submit("wb2", "placement: auto\n", "  T1: { issue: 42 }\n");
    const t = await placed("wb2");
    expect(t.placement?.candidates.find((c) => c.host === LOCAL)?.score).not.toBeNull();

    // A new version of the same wave (and the other wave) changes nothing.
    const after = sys("config_changed").length;
    const again = await f.client.request("run", {
      wave_yaml: `${waveYaml("wb")}  T2: { issue: 43 }\n`,
    });
    expect(again.error).toBeUndefined();
    expect((again as { notes?: string[] }).notes).toBeUndefined();
    expect(sys("config_changed")).toHaveLength(after);
  });

  it("volleyd run prints the note", async () => {
    await start();
    await boxHoldsB();
    const file = join(f.env.home, "wb.yaml");
    writeFileSync(file, waveYaml("wb"));
    const r = await runCli(["run", file], f.env.env);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`note: adopted ${f.repo} as ${LOCAL}'s clone of ${B}\n`);
  });

  it("a clone of a repository config does not name is not registered (D6)", async () => {
    await start();
    const before = sys("config_changed").length;
    const r = await f.client.request("run", { wave_yaml: waveYaml("wb") });
    expect(r.error).toBeUndefined();
    expect((r as { notes?: string[] }).notes).toBeUndefined();
    expect(sys("config_changed")).toHaveLength(before);
    expect(sys("repo_added")).toEqual([]);
    expect(await fleetRepos()).toBeUndefined();
  });

  it("the supervisor already holding a managed clone is left alone", async () => {
    await start();
    theBox().answers.doctor = report([clone(B, BOX_B)]);
    await f.adminOp({ op: "repo_add", slug: B, machines: [LOCAL, PEER] });
    const before = sys("config_changed").length;
    const r = await f.client.request("run", { wave_yaml: waveYaml("wb") });
    expect(r.error).toBeUndefined();
    expect((r as { notes?: string[] }).notes).toBeUndefined();
    expect(sys("config_changed")).toHaveLength(before);
    expect(await fleetRepos()).toBeUndefined();
    expect(f.logs).toContain(`${B}: the wave runs from ${f.repo}, the registry has ${BOX_B}`);
  });

  it("a repo_add from the coordinator never adopts the clone a wave runs from", async () => {
    await start();
    expect((await f.client.request("run", { wave_yaml: waveYaml("wb") })).error).toBeUndefined();
    theBox().answers.doctor = report([clone(B, BOX_B)]);
    const added = (await f.adminOp({ op: "repo_add", slug: B }, "coordinator")) as {
      ok: boolean;
      result: { status: string[] };
    };
    expect(added.ok).toBe(true);
    expect(added.result.status.join("\n")).not.toContain("adopted from wave");
    expect(sys("repo_added").at(-1)?.data.paths).toBeUndefined();
    expect(await fleetRepos()).toBeUndefined();
  });

  it("gh failing: the clone's origin names the repository", async () => {
    await start();
    await boxHoldsB();
    f.exec
      .on(["gh", "repo", "view", "--json"], { code: 1, stderr: "gh: not logged in\n" })
      .on(["git", "-C", f.repo, "remote", "get-url", "origin"], {
        stdout: "git@github.com:b/b.git\n",
      });
    const r = await f.client.request("run", { wave_yaml: waveYaml("wb") });
    expect(r.error).toBeUndefined();
    expect(await settledRepos({ [B]: f.repo })).toEqual({ [B]: f.repo });
  });

  it("no gh and no origin: nothing is adopted", async () => {
    await start();
    await boxHoldsB();
    f.exec.on(["gh", "repo", "view", "--json"], { code: 1, stderr: "gh: not logged in\n" });
    const r = await f.client.request("run", { wave_yaml: waveYaml("wb") });
    expect(r.error).toBeUndefined();
    expect(await fleetRepos()).toBeUndefined();
  });

  it("repo_add adopts the clone a known wave runs from; paths, repo_probe and repo_remove take the supervisor's machine", async () => {
    await start();
    // The wave first (b/b not named yet: nothing adopted), then the add.
    expect((await f.client.request("run", { wave_yaml: waveYaml("wb") })).error).toBeUndefined();
    expect(await fleetRepos()).toBeUndefined();
    theBox().answers.doctor = report([clone(B, BOX_B)]);
    const added = (await f.adminOp({ op: "repo_add", slug: B })) as {
      ok: boolean;
      result: { status: string[] };
    };
    expect(added.ok).toBe(true);
    expect(added.result.status).toContain(`${LOCAL}: ready (${f.repo}, adopted from wave wb)`);
    expect(await settledRepos({ [B]: f.repo })).toEqual({ [B]: f.repo });

    // repo_probe on the supervisor's machine reads the clone here.
    f.exec.on(["git", "-C", f.repo, "remote", "get-url", "origin"], {
      stdout: "https://github.com/b/b.git\n",
    });
    expect(await f.adminOp({ op: "repo_probe", machine: LOCAL, path: f.repo })).toMatchObject({
      ok: true,
      result: {
        machine: LOCAL,
        path: f.repo,
        state: "found",
        root: f.repo,
        origin: "https://github.com/b/b.git",
        slug: B,
      },
    });

    // repo_remove drops fleet.repos and deletes nothing.
    const removed = await f.adminOp({ op: "repo_remove", slug: B, machines: [LOCAL] });
    expect(removed).toMatchObject({ ok: true, result: { clones: { [LOCAL]: f.repo } } });
    expect(await settledRepos(undefined)).toBeUndefined();

    // --path for the supervisor's machine is accepted.
    const mine = join(f.env.home, "mine-b");
    f.exec.on(["git", "-C", mine, "rev-parse", "--show-toplevel"], { stdout: `${mine}\n` });
    expect(
      await f.adminOp({ op: "repo_add", slug: B, machines: [LOCAL], paths: { [LOCAL]: mine } }),
    ).toMatchObject({ ok: true });
    expect(await settledRepos({ [B]: mine })).toEqual({ [B]: mine });
  });
});
