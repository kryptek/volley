import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupWave, ledgerOf, runCleanup } from "../src/commands/cleanup";
import { type ExecFn, exec } from "../src/exec";
import { assertAllowed, mintConsentToken } from "../src/fence";
import { makeBufferIO } from "../src/io";
import { Journal, readJournalFile } from "../src/journal";
import { replay } from "../src/reducer";
import type { WaveState } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { tempDir } from "./helpers/tmp";

/** The managed clone volleyd made for a wave-owned registration goes with the wave (#612 D10). */

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).toString();

/** A home with config (repo_root, local_name), a pushed clone at the managed path, its journals. */
function setup() {
  const home = tempDir("volleyd-cleanup-clones-");
  const root = join(home, "repos");
  writeFileSync(join(home, "config.yaml"), `fleet:\n  repo_root: ${root}\n  local_name: testbox\n`);
  const origin = join(home, "origin.git");
  mkdirSync(origin);
  git(origin, "init", "-q", "--bare", "-b", "main");
  const seed = join(home, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q", "-b", "main");
  writeFileSync(join(seed, "README.md"), "hi\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "init");
  git(seed, "push", "-q", origin, "main");
  const clone = join(root, "acme", "demo");
  mkdirSync(join(root, "acme"), { recursive: true });
  git(join(root, "acme"), "clone", "-q", origin, "demo");
  const wave = parseWaveFile(
    "wave: w1\nrepo: acme/demo\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement, merge_ready]\ntasks:\n  T1: { issue: 1 }\n",
  );
  Journal.open(join(home, "waves", "w1")).append({ type: "wave_submitted", data: { wave } });
  const sys = Journal.open(join(home, "waves", "_system"));
  sys.append({
    type: "repo_added",
    data: { by: "coordinator", slug: "acme/demo", machines: ["testbox"], wave: "w1" },
  });
  sys.append({
    type: "repo_clone_run",
    data: { machine: "testbox", slug: "acme/demo", ok: true, cloned: true, path: clone },
  });
  return { home, clone };
}

const system = (home: string) => readJournalFile(join(home, "waves", "_system", "journal.jsonl"));

describe("cleanup removes a managed clone only when nothing in it is unpushed", () => {
  it("clean and fully pushed: rm -rf with its token, then repo_clone_removed", async () => {
    const { home, clone } = setup();
    const io = makeBufferIO();
    expect(await cleanupWave(home, "w1", { yes: true, force: false }, io)).toBe(0);
    expect(existsSync(clone)).toBe(false);
    expect(io.readStdout()).toContain(`removed clone ${clone} on testbox\n`);
    expect(system(home).at(-1)).toMatchObject({
      type: "repo_clone_removed",
      data: { machine: "testbox", slug: "acme/demo", path: clone, wave: "w1" },
    });
    // the daemon removes the registration; without it, it is kept and says so
    expect(io.readStdout()).toContain("kept repo acme/demo: daemon down\n");
  });

  it("the registration's repo_remove runs after the clone is gone", async () => {
    const { home, clone } = setup();
    const { state, events } = (() => {
      const ev = readJournalFile(join(home, "waves", "w1", "journal.jsonl"));
      return { state: replay(ev).state as WaveState, events: ev };
    })();
    const order: string[] = [];
    const ledger = ledgerOf({
      state,
      events,
      system: system(home),
      clones: { repo_root: join(home, "repos"), localName: "testbox" },
    });
    const io = makeBufferIO();
    const run = await runCleanup(
      "w1",
      ledger,
      {
        exec,
        consent: mintConsentToken("volleyd cleanup w1 --yes"),
        localName: "testbox",
        journalSystem: (ev) => {
          order.push(`${ev.type}:${existsSync(clone)}`);
        },
        removeRepo: async (slug) => {
          order.push(`repo_remove ${slug}:${existsSync(clone)}`);
          return null;
        },
      },
      io,
    );
    expect(order).toEqual(["repo_clone_removed:false", "repo_remove acme/demo:false"]);
    expect(run.removed).toMatchObject({ clones: 1, repos: 1 });
  });

  it("an unpushed commit keeps the clone, naming the branch and the count", async () => {
    const { home, clone } = setup();
    writeFileSync(join(clone, "x.txt"), "x\n");
    git(clone, "add", ".");
    git(clone, "commit", "-qm", "local");
    const io = makeBufferIO();
    await cleanupWave(home, "w1", { yes: true, force: false }, io);
    expect(existsSync(clone)).toBe(true);
    expect(io.readStdout()).toContain(
      `kept clone ${clone}: 1 unpushed commit on main (on testbox)\n`,
    );
    expect(system(home).some((e) => e.type === "repo_clone_removed")).toBe(false);
  });

  it("a dirty tree and a stash each keep it, with their reason", async () => {
    const dirty = setup();
    writeFileSync(join(dirty.clone, "README.md"), "changed\n");
    const io = makeBufferIO();
    await cleanupWave(dirty.home, "w1", { yes: true, force: false }, io);
    expect(existsSync(dirty.clone)).toBe(true);
    expect(io.readStdout()).toContain("dirty work tree");

    const stashed = setup();
    writeFileSync(join(stashed.clone, "README.md"), "changed\n");
    git(stashed.clone, "stash", "-q");
    const io2 = makeBufferIO();
    await cleanupWave(stashed.home, "w1", { yes: true, force: false }, io2);
    expect(existsSync(stashed.clone)).toBe(true);
    expect(io2.readStdout()).toContain(`kept clone ${stashed.clone}: stash (on testbox)\n`);
  });

  it("an unpushed agent branch the ledger proved merged does not block", async () => {
    const { home, clone } = setup();
    const head = git(clone, "rev-parse", "HEAD").trim();
    git(clone, "branch", "w1/T1-implementer-1");
    const j = Journal.open(join(home, "waves", "w1"));
    j.append({ type: "task_queued", task: "T1", data: { issue: 1 } });
    j.append({
      type: "agent_spawned",
      task: "T1",
      data: {
        agent_id: "w1-t1-implementer-1",
        role: "implementer",
        host: "local",
        worktree: join(home, "wt", "w1", "T1-implementer"),
        branch: "w1/T1-implementer-1",
      },
    });
    j.append({ type: "agent_retired", task: "T1", data: { agent_id: "w1-t1-implementer-1" } });
    j.append({ type: "merged_by_supervisor", task: "T1", data: { task: "T1", head } });
    j.append({ type: "stage_entered", task: "T1", data: { stage: "done" } });
    // the wave's repo is the clone itself, so the branch is deleted there first
    const { state, events } = (() => {
      const ev = readJournalFile(join(home, "waves", "w1", "journal.jsonl"));
      return { state: replay(ev).state as WaveState, events: ev };
    })();
    const ledger = ledgerOf({
      state,
      events,
      system: system(home),
      clones: { repo_root: join(home, "repos"), localName: "testbox" },
      localRepo: clone,
    });
    const io = makeBufferIO();
    await runCleanup(
      "w1",
      ledger,
      { exec, consent: mintConsentToken("volleyd cleanup w1 --yes"), localName: "testbox" },
      io,
    );
    expect(io.readStdout()).toContain("deleted branch w1/T1-implementer-1\n");
    expect(existsSync(clone)).toBe(false);
  });

  it("the dry run removes nothing", async () => {
    const { home, clone } = setup();
    const io = makeBufferIO();
    await cleanupWave(home, "w1", { yes: false, force: false }, io);
    expect(existsSync(clone)).toBe(true);
    expect(io.readStdout()).toContain(`would remove clone ${clone} on testbox\n`);
  });
});

describe("a managed clone on a paired machine (#612 D2, D10)", () => {
  const BOX_CLONE = "/path/to/box-home/.volley/repos/acme/demo";
  const VD = "/path/to/box-volley";

  /** A fake ssh that answers the clone checks; every script is fence-checked. */
  const box = (unpushed: number) => {
    const steps: string[][] = [];
    const run: ExecFn = async (argv, opts = {}) => {
      assertAllowed(argv, opts);
      const step = opts.remote?.steps[0]?.argv ?? [...argv];
      steps.push(step);
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "", timedOut: false });
      if (step.includes("for-each-ref")) return ok("main\n");
      if (step.includes("rev-list")) return ok(`${unpushed}\n`);
      if (step.includes("peer"))
        return ok(
          `${JSON.stringify({ worktrees: [], branches: [], clones: [{ clone: BOX_CLONE, removed: true }] })}\n`,
        );
      return ok();
    };
    return { steps, run };
  };

  const ledgerFor = () => {
    const home = tempDir("volleyd-cleanup-box-clone-");
    const wave = parseWaveFile(
      "wave: w1\nrepo: acme/demo\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement, merge_ready]\ntasks:\n  T1: { issue: 1 }\n",
    );
    const j = Journal.open(join(home, "waves", "w1"));
    j.append({ type: "wave_submitted", data: { wave } });
    const sys = Journal.open(join(home, "waves", "_system"));
    sys.append({
      type: "repo_added",
      data: { by: "c", slug: "acme/demo", machines: "all", wave: "w1" },
    });
    sys.append({
      type: "repo_clone_run",
      data: { machine: "box", slug: "acme/demo", ok: true, cloned: true, path: BOX_CLONE },
    });
    const ev = readJournalFile(join(home, "waves", "w1", "journal.jsonl"));
    return ledgerOf({
      state: replay(ev).state as WaveState,
      events: ev,
      system: system(home),
      clones: { repo_root: "~/.volley/repos", localName: "athena" },
    });
  };

  const deps = (run: ExecFn) => ({
    exec: run,
    consent: mintConsentToken("volleyd cleanup w1 --yes"),
    localName: "athena",
    hosts: { box: { target: "dev@box", volley_dir: VD } },
  });

  it("the read-only checks on the box come first, then peer cleanup --clone … --yes", async () => {
    const b = box(0);
    const io = makeBufferIO();
    const run = await runCleanup("w1", ledgerFor(), deps(b.run), io);
    const peer = b.steps.findIndex((s) => s.includes("peer"));
    expect(b.steps.slice(0, peer).map((s) => s[3])).toEqual([
      "rev-parse",
      "status",
      "stash",
      "for-each-ref",
      "rev-list",
    ]);
    expect(b.steps[peer]).toEqual([
      "bun",
      `${VD}/packages/volley-cli/src/cli.ts`,
      "peer",
      "cleanup",
      "--json",
      "--clone",
      BOX_CLONE,
      "--yes",
    ]);
    expect(io.readStdout()).toContain(`removed clone ${BOX_CLONE} on box\n`);
    expect(run.removed.clones).toBe(1);
  });

  it("an unpushed commit there keeps it, and no --clone step runs", async () => {
    const b = box(1);
    const io = makeBufferIO();
    await runCleanup("w1", ledgerFor(), deps(b.run), io);
    expect(b.steps.some((s) => s.includes("--clone"))).toBe(false);
    expect(io.readStdout()).toContain(
      `kept clone ${BOX_CLONE}: 1 unpushed commit on main (on box)\n`,
    );
  });
});
