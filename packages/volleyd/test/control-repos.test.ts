import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addAccount, markSignedIn } from "../src/claude/profiles";
import { ControlClient } from "../src/control";
import { preconditionKey } from "../src/decisions";
import type { CloneProbe } from "../src/hosts/ssh-tmux";
import { readJournalFile } from "../src/journal";
import type { DoctorReport, MachineRepo } from "../src/machines";
import { eventually } from "./helpers/broker-wait";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { GREEN_DOCTOR, fakeSigninBox } from "./helpers/fake-host";
import { type Fleet, LOCAL, PEER, makeFleet } from "./helpers/fleet-env";
import { journalWait } from "./helpers/journal-wait";
import { tempDir } from "./helpers/tmp";

/**
 * Repositories (SPEC §4.6.21): repo_add / repo_remove / repo_list / repo_status end to end, on a
 * supervisor (`control`) and one paired box over fakes.
 */

const SLUG = "a/a";
const BOX_CLONE = "/srv/repos/a/a";
const BOX_PROFILE = "/path/to/home/.volley/claude/work";

const clone = (slug: string, path: string, exists = true): MachineRepo => ({
  slug,
  path,
  exists,
  managed: true,
  fetched_at: null,
  toolchain: { ok: true, missing: [], outdated: [] },
});
/** The box's doctor after an add: its clone of `a/a` at BOX_CLONE (absent: `exists: false`). */
const reportWith = (repos: MachineRepo[]): DoctorReport => ({
  ...GREEN_DOCTOR,
  versions: { peer: "0.4.0", volley: "0.4.0", bun: "1.3.1", git: "2.43.0" },
  repos,
});

let f: Fleet;
/** A fleet `setup` started and no afterEach closed yet. */
let live = false;
let localClone: string;
let claudeRoot: string;
/** recordTrust calls on the box: the root and the profile dir (undefined: the default). */
let trusts: { root: string; dir: string | undefined }[];

async function setup(o: { profile?: boolean } = {}): Promise<void> {
  const base = realpathSync(tempDir("volleyd-repos-"));
  const repoRoot = join(base, "managed");
  localClone = join(repoRoot, "a", "a");
  claudeRoot = join(base, "claude");
  mkdirSync(claudeRoot, { recursive: true });
  // The box has one signed-in profile beside its default one.
  if (o.profile !== false) {
    addAccount(claudeRoot, { label: "Work", machine: PEER }, "2026-10-19T09:00:00.000Z");
    markSignedIn(claudeRoot, "work", { dir: BOX_PROFILE }, "2026-10-19T09:00:00.000Z");
  }
  f = await makeFleet({
    repoRoot,
    claudeRoot,
    // The own doctor finds the own clone of a/a once it is there.
    localDoctor: (repo) =>
      repo === localClone ? { ...GREEN_DOCTOR, repo: { path: repo, exists: true } } : GREEN_DOCTOR,
  });
  live = true;
  f.exec
    .on(["gh", "repo", "view", SLUG], {
      stdout: JSON.stringify({
        nameWithOwner: SLUG,
        url: `https://github.com/${SLUG}`,
        visibility: "PUBLIC",
      }),
    })
    .on(["gh", "repo", "view", "no/such"], {
      code: 1,
      stderr: "GraphQL: Could not resolve to a Repository with the name 'no/such'.\n",
    })
    // The supervisor's own clone is there.
    .on(["git", "-C", localClone, "rev-parse", "--show-toplevel"], { stdout: `${localClone}\n` });
  const box = theBox();
  trusts = [];
  box.recordTrust = async (root, dir) => {
    trusts.push({ root, dir });
  };
  box.answers.doctor = reportWith([clone(SLUG, BOX_CLONE)]);
}

/** The fleet's box (created by its first PATH probe, before setup returns). */
function theBox() {
  const box = f.box();
  if (box === undefined) throw new Error("no box");
  return box;
}

afterEach(async () => {
  if (!live) return;
  live = false;
  await f.close();
});

const repoState = async (machine: string, slug = SLUG) =>
  (await f.verdict(machine))?.repos[slug]?.state;
const systemTypes = (type: string) => f.system().filter((e) => e.type === type);

describe("the coordinator's repository ops on ops/coordinator (#613)", () => {
  it("repo_add by slug and repo_remove go through, journaled by coordinator", async () => {
    await setup();
    const r = await f.adminOp({ op: "repo_add", slug: SLUG }, "coordinator");
    expect(r).toMatchObject({ ok: true });
    expect(systemTypes("repo_added").map((e) => e.data)).toEqual([
      { by: "coordinator", slug: SLUG, machines: "all" },
    ]);
    expect((await f.adminOp({ op: "repo_list" }, "coordinator"))?.ok).toBe(true);
    expect((await f.adminOp({ op: "repo_status" }, "coordinator"))?.ok).toBe(true);
    const removed = await f.adminOp({ op: "repo_remove", slug: SLUG }, "coordinator");
    expect(removed).toMatchObject({ ok: true });
  });

  it("repo_add with paths, pairing and archive are refused; an admin keeps every op", async () => {
    await setup();
    const adopt = await f.adminOp(
      { op: "repo_add", slug: SLUG, paths: { [PEER]: BOX_CLONE } },
      "coordinator",
    );
    expect(adopt).toMatchObject({ ok: false });
    expect(adopt?.error).toContain("adopting a clone at a path (--path) is an admin's");
    for (const op of ["peer_invite", "machine_add", "archive"]) {
      const r = await f.adminOp({ op, for: "box-z", wave: "w-x" }, "coordinator");
      expect(r).toMatchObject({ ok: false });
      expect(r?.error).toMatch(/needs the admin role/);
    }
    expect(systemTypes("repo_added")).toEqual([]);
    const admin = await f.adminOp({ op: "repo_add", slug: SLUG, paths: { [PEER]: BOX_CLONE } });
    expect(admin).toMatchObject({ ok: true });
  });
});

describe("repo_add (admin)", () => {
  it("journals the wave a registration was made for; an id that is no wave id is refused (#612 D5)", async () => {
    await setup();
    const bad = await f.adminOp({ op: "repo_add", slug: SLUG, wave: "Not A Wave" });
    expect(bad).toMatchObject({ ok: false });
    expect(bad?.error).toMatch(/^wave/);
    expect(systemTypes("repo_added")).toEqual([]);
    // The wave need not be submitted yet: setup's first wave registers its repository first.
    const r = await f.adminOp({ op: "repo_add", slug: SLUG, wave: "w-demo" });
    expect(r).toMatchObject({ ok: true });
    expect(systemTypes("repo_added").map((e) => e.data)).toEqual([
      { by: "admin-1", slug: SLUG, machines: "all", wave: "w-demo" },
    ]);
  });

  it("carries the repository's workflows as ci: { workflows } (#602); absent when unreadable", async () => {
    await setup();
    f.exec.on(["gh", "api", `repos/${SLUG}/actions/workflows?per_page=100`], {
      stdout: JSON.stringify({ total_count: 0, workflows: [] }),
    });
    const r = await f.adminOp({ op: "repo_add", slug: SLUG });
    expect(r).toMatchObject({ ok: true, result: { slug: SLUG, ci: { workflows: 0 } } });
    f.exec.on(["gh", "api", `repos/${SLUG}/actions/workflows?per_page=100`], { code: 1 });
    const again = await f.adminOp({ op: "repo_add", slug: SLUG });
    expect(again?.ok).toBe(true);
    expect(again?.result).not.toHaveProperty("ci");
  });

  it("validates with gh, patches config, runs the box's doctor with the add and a clone, trusts every profile, journals and republishes readiness", async () => {
    await setup();
    const r = await f.adminOp({ op: "repo_add", slug: SLUG });
    expect(r).toMatchObject({
      ok: true,
      op: "repo_add",
      result: { slug: SLUG, machines: [LOCAL, PEER], url: `https://github.com/${SLUG}` },
    });
    expect(f.exec.argvs(["gh", "repo", "view"])).toContainEqual([
      "gh",
      "repo",
      "view",
      SLUG,
      "--json",
      "nameWithOwner,url,visibility",
    ]);
    const cfg = await f.client.request("config_get", { path: "repos" });
    expect(cfg.result).toEqual({ [SLUG]: { machines: "all" } });

    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready" && (await repoState(LOCAL)) === "ready";
    });
    // The box: added and cloned (no clone reported yet), over the doctor's ssh channel.
    expect(f.box()?.doctorRuns.at(-1)).toEqual({ fix: true, repos_add: [SLUG] });
    // Trusted in the box's default profile and in its signed-in profile.
    expect(trusts).toEqual([
      { root: BOX_CLONE, dir: undefined },
      { root: BOX_CLONE, dir: BOX_PROFILE },
    ]);
    // The own machine: never cloned by volleyd, its clone trusted in its primary profile.
    const own = JSON.parse(readFileSync(f.claudeJson, "utf-8")) as {
      projects: Record<string, { hasTrustDialogAccepted?: boolean }>;
    };
    expect(own.projects[localClone]?.hasTrustDialogAccepted).toBe(true);

    expect(systemTypes("repo_added").map((e) => e.data)).toEqual([
      { by: "admin-1", slug: SLUG, machines: "all" },
    ]);
    const runs = systemTypes("repo_clone_run").map((e) => e.data);
    expect(runs).toContainEqual({
      machine: PEER,
      slug: SLUG,
      ok: true,
      cloned: true,
      path: BOX_CLONE,
    });
    expect(runs).toContainEqual({
      machine: LOCAL,
      slug: SLUG,
      ok: true,
      cloned: false,
      path: localClone,
    });
    const box = systemTypes("repo_trusted").find((e) => e.data.machine === PEER);
    expect(box?.data).toEqual({
      machine: PEER,
      repo: SLUG,
      root: BOX_CLONE,
      accounts: ["primary", "work"],
      keys: [
        preconditionKey({ machine: `dev@${PEER}`, root: BOX_CLONE }),
        preconditionKey({ machine: `dev@${PEER}`, profile: BOX_PROFILE, root: BOX_CLONE }),
      ],
    });

    // repo_status: the same state lines on every machine.
    const st = await f.adminOp({ op: "repo_status", slug: SLUG });
    expect(st).toMatchObject({
      ok: true,
      result: {
        repos: [
          {
            slug: SLUG,
            machines: { [LOCAL]: { state: "ready" }, [PEER]: { state: "ready" } },
            lines: [`${LOCAL}: ready (${localClone})`, `${PEER}: ready (${BOX_CLONE})`],
          },
        ],
      },
    });
    // repo_list, on the mailbox too (a read).
    const list = await f.client.request("repo_list", {});
    expect(list.result).toEqual({ repos: [{ slug: SLUG, machines: "all" }] });

    // A second add of the same slug changes nothing: no config change, no doctor run.
    const changes = systemTypes("config_changed").length;
    const doctorRuns = f.box()?.doctorRuns.length;
    expect(await f.adminOp({ op: "repo_add", slug: SLUG })).toMatchObject({ ok: true });
    await f.tick(0);
    await f.waits.settled();
    expect(systemTypes("config_changed")).toHaveLength(changes);
    expect(f.box()?.doctorRuns).toHaveLength(doctorRuns ?? 0);
    expect(trusts).toHaveLength(2);
  });

  it("refuses a slug gh does not know, a malformed one, an unknown machine and a relative path for the own machine, before anything changes", async () => {
    await setup();
    expect(await f.adminOp({ op: "repo_add", slug: "no/such" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Could not resolve to a Repository"),
    });
    expect(await f.adminOp({ op: "repo_add", slug: "https://github.com/a/a" })).toMatchObject({
      ok: false,
      error: "slug must be a GitHub <owner/name>",
    });
    expect(await f.adminOp({ op: "repo_add", slug: SLUG, machines: ["nope"] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('no machine named "nope"'),
    });
    // The supervisor's own machine adopts by path too (#616), an absolute one.
    expect(
      await f.adminOp({ op: "repo_add", slug: SLUG, paths: { [LOCAL]: "srv/a" } }),
    ).toMatchObject({ ok: false, error: `paths.${LOCAL} must be an absolute path` });
    expect(systemTypes("repo_added")).toEqual([]);
    expect((await f.client.request("config_get", { path: "repos" })).result).toEqual({});
  });

  it("an adopted path goes to hosts.<m>.repos and the box's doctor adopts it", async () => {
    await setup();
    theBox().answers.doctor = reportWith([{ ...clone(SLUG, "/srv/mine"), managed: false }]);
    const r = await f.adminOp({
      op: "repo_add",
      slug: SLUG,
      machines: [PEER],
      paths: { [PEER]: "/srv/mine" },
    });
    expect(r).toMatchObject({ ok: true, result: { machines: [PEER] } });
    expect((await f.client.request("config_get", { path: `hosts.${PEER}.repos` })).result).toEqual({
      [SLUG]: "/srv/mine",
    });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready";
    });
    expect(f.box()?.doctorRuns.at(-1)).toEqual({ fix: true, repos_add: [`${SLUG}=/srv/mine`] });
    expect(trusts.map((t) => t.root)).toEqual(["/srv/mine", "/srv/mine"]);
  });

  it("a box whose ssh fails stays blocked with the error, and is retried on its next up", async () => {
    await setup();
    const box = theBox();
    box.answers.doctor = new Error("ssh: connect to host box port 22: Connection refused");
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [PEER] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "blocked";
    });
    expect((await f.verdict(PEER))?.repos[SLUG]?.reasons).toEqual([
      "ssh: connect to host box port 22: Connection refused",
    ]);
    expect(systemTypes("repo_clone_run").at(-1)?.data).toMatchObject({
      machine: PEER,
      slug: SLUG,
      ok: false,
      error: "ssh: connect to host box port 22: Connection refused",
    });
    expect(trusts).toEqual([]);

    // The box goes down and comes back: the add runs again.
    box.answers.doctor = reportWith([clone(SLUG, BOX_CLONE)]);
    await f.lwt();
    await f.beat();
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready";
    });
    expect(trusts).toHaveLength(2);
    expect(systemTypes("repo_clone_run").at(-1)?.data).toMatchObject({ machine: PEER, ok: true });
  });

  it("the box's lines name its own clone, never the supervisor's absolute repo_root (#596)", async () => {
    // setup's repo_root is absolute, the supervisor's own, as `<VOLLEYD_HOME>/repos` is installed.
    await setup();
    const boxClone = "/path/to/box-home/.volley/repos/a/a";
    const box = theBox();
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    box.answers.doctor = async () => {
      await held;
      return reportWith([clone(SLUG, boxClone)]);
    };
    const r = await f.adminOp({ op: "repo_add", slug: SLUG });
    // The supervisor's own clone path is never a line about the box.
    expect(JSON.stringify(r)).not.toContain(`${PEER}: cloning (${localClone})`);
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "cloning";
    });
    const cloning = await f.adminOp({ op: "repo_status", slug: SLUG });
    expect(cloning).toMatchObject({
      result: { repos: [{ lines: expect.arrayContaining([`${PEER}: cloning`]) }] },
    });
    release();
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready" && (await repoState(LOCAL)) === "ready";
    });
    const st = await f.adminOp({ op: "repo_status", slug: SLUG });
    expect(st).toMatchObject({
      result: {
        repos: [{ lines: [`${LOCAL}: ready (${localClone})`, `${PEER}: ready (${boxClone})`] }],
      },
    });
    expect(trusts.map((t) => t.root)).toEqual([boxClone, boxClone]);
  });

  it("a second add that meets the first's run on the box runs once that run ends", async () => {
    await setup();
    f.exec.on(["gh", "repo", "view", "b/b"], {
      stdout: JSON.stringify({
        nameWithOwner: "b/b",
        url: "https://github.com/b/b",
        visibility: "PUBLIC",
      }),
    });
    const box = theBox();
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const both = reportWith([clone(SLUG, BOX_CLONE), clone("b/b", "/srv/repos/b/b")]);
    box.answers.doctor = async () => {
      await held;
      return both;
    };
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [PEER] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "cloning";
    });
    await f.adminOp({ op: "repo_add", slug: "b/b", machines: [PEER] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER, "b/b")) === "blocked";
    });
    box.answers.doctor = both;
    release();
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready" && (await repoState(PEER, "b/b")) === "ready";
    });
    expect(box.doctorRuns.map((r) => r.repos_add)).toEqual([[SLUG], ["b/b"]]);
  });

  it("a blocked run runs again once the box reports a newer doctor run (a clone made by hand)", async () => {
    await setup();
    const box = theBox();
    box.answers.doctor = reportWith([clone(SLUG, BOX_CLONE, false)]);
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [PEER] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "blocked";
    });
    const runs = box.doctorRuns.length;
    // A beat carrying the same doctor run retries nothing (30 s on: its verdict is republished).
    await f.tick(29_500);
    await f.beat();
    await f.waits.settled();
    expect(box.doctorRuns).toHaveLength(runs);
    // The owner cloned it by hand: the box's next doctor run reports it.
    box.answers.doctor = reportWith([clone(SLUG, BOX_CLONE)]);
    await f.beat({ doctor_at: "2026-10-23T12:00:00.000Z", repos: [clone(SLUG, BOX_CLONE)] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready";
    });
    expect(trusts).toHaveLength(2);
  });

  it("an add again after a failure shows the new run, not the old blocked, until it ends", async () => {
    await setup();
    const box = theBox();
    box.answers.doctor = new Error("ssh: timed out");
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [PEER] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "blocked";
    });
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    box.answers.doctor = async () => {
      await held;
      return reportWith([clone(SLUG, BOX_CLONE)]);
    };
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [PEER] });
    const st = await f.adminOp({ op: "repo_status", slug: SLUG });
    expect(st).toMatchObject({
      result: { repos: [{ machines: { [PEER]: { state: "cloning" } } }] },
    });
    release();
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready";
    });
  });

  it("a run still in flight when its repository is removed records nothing and is not retried", async () => {
    await setup();
    const box = theBox();
    let release = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    box.answers.doctor = async () => {
      await held;
      return reportWith([clone(SLUG, BOX_CLONE)]);
    };
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [PEER] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "cloning";
    });
    await f.adminOp({ op: "repo_remove", slug: SLUG });
    release();
    await f.tick(0);
    await f.waits.settled();
    expect(trusts).toEqual([]);
    expect(systemTypes("repo_trusted")).toEqual([]);
    expect(systemTypes("repo_clone_run").filter((e) => e.data.ok === true)).toEqual([]);
    // Its next up adds nothing back to the box.
    const runs = box.doctorRuns.length;
    await f.lwt();
    await f.beat();
    await f.waits.settled();
    expect(box.doctorRuns).toHaveLength(runs);
  });

  it("the own machine without a clone is blocked with the command to make one", async () => {
    await setup();
    f.exec.on(["git", "-C", localClone, "rev-parse", "--show-toplevel"], {
      code: 128,
      stderr: "fatal: cannot change to it\n",
    });
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [LOCAL] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(LOCAL)) === "blocked";
    });
    expect((await f.verdict(LOCAL))?.repos[SLUG]?.reasons[0]).toContain(
      `gh repo clone ${SLUG} ${localClone}`,
    );
  });

  it("a spawn into a root repo_add trusted opens no repo_untrusted, even when the box's file does not say so", async () => {
    // Agents start under the box's default profile.
    await setup({ profile: false });
    const box = theBox();
    // The wave's clone on the box is hosts.box.repo; the add adopts it there.
    const repo = (await f.client.request("config_get", { path: `hosts.${PEER}.repo` }))
      .result as string;
    box.answers.doctor = reportWith([{ ...clone(SLUG, repo), managed: false }]);
    box.readTrust = async () => ({});
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [PEER], paths: { [PEER]: repo } });
    await eventually(async () => {
      await f.tick(0);
      return systemTypes("repo_trusted").length === 1;
    });
    await f.submit("w1", "", `  T1: { issue: 42, host: ${PEER} }\n`);
    await eventually(async () => {
      await f.tick();
      return (box.launches.length ?? 0) > 0;
    });
    expect(f.journal("w1").filter((e) => e.type === "decision_opened")).toEqual([]);
  });

  it("a restart keeps what repo_add trusted and what it left blocked", async () => {
    await setup();
    theBox().answers.doctor = new Error("ssh: timed out");
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [PEER] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "blocked";
    });
    await f.restart();
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "blocked";
    });
    expect((await f.verdict(PEER))?.repos[SLUG]?.reasons).toEqual(["ssh: timed out"]);
  });
});

describe("repo_remove (admin)", () => {
  it("drops config and tells the box, never deleting a clone: the answer names its path", async () => {
    await setup();
    await f.adminOp({ op: "repo_add", slug: SLUG, machines: [PEER] });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready";
    });
    const r = await f.adminOp({ op: "repo_remove", slug: SLUG, machines: [PEER] });
    expect(r).toMatchObject({
      ok: true,
      result: {
        slug: SLUG,
        machines: [PEER],
        clones: { [PEER]: BOX_CLONE },
        peers: { [PEER]: "removed" },
      },
    });
    expect(f.box()?.doctorRuns.at(-1)).toEqual({ fix: false, repos_remove: [SLUG] });
    expect((await f.client.request("config_get", { path: "repos" })).result).toEqual({});
    expect(systemTypes("repo_removed").at(-1)?.data).toEqual({
      by: "admin-1",
      slug: SLUG,
      machines: [PEER],
      clones: { [PEER]: BOX_CLONE },
    });
    expect(await f.adminOp({ op: "repo_remove", slug: "b/b" })).toMatchObject({
      ok: false,
      error: "b/b is not a configured repository",
    });
  });

  it("removing one machine from `all` keeps the others", async () => {
    await setup();
    await f.adminOp({ op: "repo_add", slug: SLUG });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready";
    });
    await f.adminOp({ op: "repo_remove", slug: SLUG, machines: [PEER] });
    expect((await f.client.request("config_get", { path: "repos" })).result).toEqual({
      [SLUG]: { machines: [LOCAL] },
    });
  });

  it("repo_add and repo_remove are refused on the mailbox (admin ops)", async () => {
    await setup();
    expect(await f.client.request("repo_add", { slug: SLUG })).toMatchObject({
      ok: false,
      error: expect.stringContaining("answered only on volley/_system/auth/ops/"),
    });
  });
});

describe("repo_probe (admin)", () => {
  it("answers each state the box's clone is in, journaling nothing and patching no config", async () => {
    await setup();
    const box = theBox();
    const answers: Record<string, CloneProbe> = {
      "/srv/found": {
        state: "found",
        root: "/srv/found",
        origin: "https://github.com/Example-Org/Example-Repo.git",
        slug: "example-org/example-repo",
      },
      "/srv/missing": { state: "missing" },
      "/srv/plain": { state: "not_git" },
      "/srv/bare": { state: "no_origin", root: "/srv/bare" },
    };
    box.answers.clone = (path) => answers[path] ?? new Error(`unexpected ${path}`);
    const before = f.system().length;
    const changes = systemTypes("config_changed").length;
    for (const [path, probe] of Object.entries(answers)) {
      const r = await f.adminOp({ op: "repo_probe", machine: PEER, path });
      expect(r).toMatchObject({
        ok: true,
        op: "repo_probe",
        result: { machine: PEER, path, ...probe },
      });
      expect(r?.result).toEqual({ machine: PEER, path, ...probe });
    }
    expect(box.cloneProbes).toEqual(Object.keys(answers));
    expect(f.system()).toHaveLength(before);
    expect(systemTypes("config_changed")).toHaveLength(changes);
    expect((await f.client.request("config_get", { path: "repos" })).result).toEqual({});
  });

  it("refuses an unknown host and a path that is not absolute, on the supervisor's own machine too", async () => {
    await setup();
    const probe = (machine: string, path: unknown) =>
      f.adminOp({ op: "repo_probe", machine, path });
    expect(await probe(LOCAL, "srv/a")).toMatchObject({
      ok: false,
      error: "path must be an absolute path",
    });
    expect(await probe("nope", "/srv/a")).toMatchObject({
      ok: false,
      error: 'no configured host named "nope"',
    });
    for (const path of ["srv/a", "/srv/../etc", "/srv/a\nb", 7]) {
      expect(await probe(PEER, path)).toMatchObject({
        ok: false,
        error: "path must be an absolute path",
      });
    }
    expect(theBox().cloneProbes).toEqual([]);
  });

  it("answers ok: false with ssh's reason when the box cannot be reached", async () => {
    await setup();
    theBox().answers.clone = () =>
      new Error("ssh to dev@peer-a failed (clone probe): Connection refused");
    expect(await f.adminOp({ op: "repo_probe", machine: PEER, path: "/srv/a" })).toMatchObject({
      ok: false,
      op: "repo_probe",
      error: "ssh to dev@peer-a failed (clone probe): Connection refused",
    });
  });

  it("is refused on the mailbox (an admin op)", async () => {
    await setup();
    expect(await f.client.request("repo_probe", { machine: PEER, path: "/srv/a" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("answered only on volley/_system/auth/ops/"),
    });
    expect(theBox().cloneProbes).toEqual([]);
  });
});

describe("a profile signed in later (claude_signin_done)", () => {
  let env: DaemonEnv;
  afterEach(() => env.cleanup());

  it("trusts every repository assigned to its machine in that profile, one repo_trusted each", async () => {
    env = await makeDaemonEnv();
    const PROFILE = "/path/to/home/.volley/claude/work";
    writeFileSync(
      join(env.home, "config.yaml"),
      "hosts:\n  peer-a:\n    target: dev@peer-a\n    volley_dir: /opt/volley\n    repos:\n      a/a: /srv/a\n      b/b: /srv/b\n    tunnel: { remote_port: 21883, supervise: false }\n",
    );
    const b = fakeSigninBox({
      signInAfter: 3,
      files: {
        [`${PROFILE}/.claude.json`]: JSON.stringify({
          userID: "c0ffee",
          oauthAccount: { emailAddress: "owner@example.com", organizationName: "Example Org" },
        }),
      },
    });
    const root = join(tempDir("volleyd-claude-"), "claude");
    const daemon = await env.start({
      claude: { root, exec: b.exec, signinPollMs: 20, signinTimeoutMs: 5000, forwardSettleMs: 20 },
      spawner: { remoteExec: b.exec },
    });
    const waits = journalWait(env.home, () => daemon);
    const client = await ControlClient.connect(env.broker.url, NS);
    try {
      await client.request("claude_account_add", { label: "Work", machine: "peer-a" });
      await waits.event("_system", "claude_signin_done");
      const trusted = () =>
        readJournalFile(join(env.home, "waves", "_system", "journal.jsonl")).filter(
          (e) => e.type === "repo_trusted",
        );
      await eventually(() => trusted().length === 2);
      expect(trusted().map((e) => e.data)).toEqual([
        {
          machine: "peer-a",
          repo: "a/a",
          root: "/srv/a",
          accounts: ["work"],
          keys: [preconditionKey({ machine: "dev@peer-a", profile: PROFILE, root: "/srv/a" })],
        },
        {
          machine: "peer-a",
          repo: "b/b",
          root: "/srv/b",
          accounts: ["work"],
          keys: [preconditionKey({ machine: "dev@peer-a", profile: PROFILE, root: "/srv/b" })],
        },
      ]);
      // Written in that profile's own .claude.json on the box.
      const cfg = JSON.parse(b.box.files.get(`${PROFILE}/.claude.json`) ?? "{}") as {
        projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
      };
      expect(cfg.projects?.["/srv/a"]?.hasTrustDialogAccepted).toBe(true);
      expect(cfg.projects?.["/srv/b"]?.hasTrustDialogAccepted).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("repo_check (#610)", () => {
  /** a/a added and ready on both machines; its workflows readable. */
  async function added(): Promise<void> {
    await setup();
    f.exec.on(["gh", "api", `repos/${SLUG}/actions/workflows?per_page=100`], {
      stdout: JSON.stringify({ workflows: [{ id: 1, state: "active" }] }),
    });
    expect(await f.adminOp({ op: "repo_add", slug: SLUG })).toMatchObject({ ok: true });
    await eventually(async () => {
      await f.tick(0);
      return (await repoState(PEER)) === "ready" && (await repoState(LOCAL)) === "ready";
    });
  }

  it("repo_add's result carries the repository half as checks (repo.exists, ci.mode), and still ci.workflows", async () => {
    await added();
    const r = await f.adminOp({ op: "repo_add", slug: SLUG });
    expect(r?.result).toMatchObject({
      ci: { workflows: 1 },
      checks: [
        { id: "repo.exists", ok: true, severity: "block", detail: `GitHub knows it as ${SLUG}` },
        { id: "ci.mode", ok: true, severity: "warn", detail: "workflows (1)" },
      ],
    });
  });

  it("a read on the mailbox: the repository lines, one block per holder from a fresh doctor (no fix), ready_on", async () => {
    await added();
    const runs = theBox().doctorRuns.length;
    const r = await f.client.request("repo_check", { slug: SLUG }, { timeoutMs: 20_000 });
    expect(r.ok).toBe(true);
    const res = r.result as {
      repository: { id: string }[];
      machines: Record<string, { from: string; ready: boolean; checks: { id: string }[] }>;
      ready_on: string[];
      summary: string;
    };
    expect(res.repository.map((c) => c.id)).toEqual(["repo.exists", "ci.mode"]);
    expect(Object.keys(res.machines)).toEqual([LOCAL, PEER]);
    expect(res.machines[PEER]).toMatchObject({ from: "doctor", ready: true });
    expect(theBox().doctorRuns.slice(runs)).toEqual([{ fix: false }]);
    expect(res.ready_on).toEqual([LOCAL, PEER]);
    expect(res.summary).toBe(`ready for a wave on: ${LOCAL}, ${PEER}.`);
  });

  it("a box whose doctor is busy is judged from its last record, saying so", async () => {
    await added();
    let release!: () => void;
    const busy = new Promise<void>((r) => {
      release = r;
    });
    theBox().answers.doctor = async () => {
      await busy;
      return reportWith([clone(SLUG, BOX_CLONE)]);
    };
    const before = theBox().doctorRuns.length;
    const repair = f.adminOp({ op: "peer_doctor", name: PEER });
    // Repair's run is in progress (the box's doctor has been called) before the check asks.
    await eventually(async () => theBox().doctorRuns.length > before);
    const r = await f.client.request("repo_check", { slug: SLUG }, { timeoutMs: 20_000 });
    release();
    await repair;
    expect((r.result as { machines: Record<string, unknown> }).machines[PEER]).toMatchObject({
      from: "record",
      note: "a doctor run is in progress",
    });
  });

  it("fix: true is refused on the mailbox; an admin's runs the box's doctor with --fix and the repository added", async () => {
    await added();
    const refused = await f.client.request("repo_check", { slug: SLUG, fix: true });
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("only on volley/_system/auth/ops/");
    const runs = theBox().doctorRuns.length;
    const r = await f.adminOp({ op: "repo_check", slug: SLUG, fix: true });
    expect(r?.ok).toBe(true);
    expect(theBox().doctorRuns.slice(runs)).toEqual([{ fix: true, repos_add: [SLUG] }]);
  });

  it("--machine naming a box that holds no clone says so, rather than dropping it silently", async () => {
    await added();
    const r = await f.client.request(
      "repo_check",
      { slug: "b/b", machines: [PEER] },
      { timeoutMs: 20_000 },
    );
    const res = r.result as { machines: object; summary: string };
    expect(Object.keys(res.machines)).toEqual([]);
    expect(res.summary).toContain(`${PEER} holds no clone of b/b`);
    expect(res.summary).toContain(`volley repo add b/b --machine ${PEER}`);
  });

  it("--machine narrows; a malformed slug or branch is refused", async () => {
    await added();
    const r = await f.client.request(
      "repo_check",
      { slug: SLUG, machines: [PEER] },
      { timeoutMs: 20_000 },
    );
    expect(Object.keys((r.result as { machines: object }).machines)).toEqual([PEER]);
    expect((await f.client.request("repo_check", { slug: "nope" })).error).toBe(
      "slug must be a GitHub <owner/name>",
    );
    expect(
      (await f.client.request("repo_check", { slug: SLUG, release_branch: "--x" })).error,
    ).toBe("release_branch must be a branch name");
  });
});
