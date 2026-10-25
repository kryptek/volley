import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupWave } from "../src/commands/cleanup";
import type { ExecFn, ExecOptions } from "../src/exec";
import { assertAllowed } from "../src/fence";
import { makeBufferIO } from "../src/io";
import { Journal, readJournalFile } from "../src/journal";
import { parseWaveFile } from "../src/wave-file";
import { tempDir } from "./helpers/tmp";

/** Merged agent branches are deleted under a per-branch token; nothing else is (#612 D4). */

const HEAD = "a".repeat(40);
const LATER = "b".repeat(40);

function setup(o: { stage?: "done" | "cancelled"; reviewer?: boolean } = {}) {
  const home = tempDir("volleyd-cleanup-branches-");
  const repo = join(home, "repo");
  const wave = parseWaveFile(
    `wave: w1\nrepo: ${repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement, merge_ready]\ntasks:\n  T1: { issue: 1 }\n`,
  );
  const j = Journal.open(join(home, "waves", "w1"));
  j.append({ type: "wave_submitted", data: { wave } });
  j.append({ type: "task_queued", task: "T1", data: { issue: 1 } });
  j.append({ type: "stage_entered", task: "T1", data: { stage: "implement" } });
  const spawn = (agent_id: string, role: string, extra: Record<string, unknown> = {}) => {
    j.append({
      type: "agent_spawned",
      task: "T1",
      data: {
        agent_id,
        role,
        host: "local",
        worktree: join(home, "wt", "w1", `T1-${role}`),
        branch: `w1/T1-${role}-1`,
        ...extra,
      },
    });
    j.append({ type: "agent_retired", task: "T1", data: { agent_id, workspace_closed: true } });
  };
  spawn("w1-t1-implementer-1", "implementer");
  if (o.reviewer === true)
    spawn("w1-t1-spec_reviewer-1", "spec_reviewer", { detached: true, start: HEAD });
  if ((o.stage ?? "done") === "done")
    j.append({
      type: "merged_by_supervisor",
      task: "T1",
      data: { task: "T1", pr: 7, head: HEAD, merge_sha: "c".repeat(40), by: "volleyd" },
    });
  j.append({ type: "stage_entered", task: "T1", data: { stage: o.stage ?? "done" } });
  return { home, repo };
}

/** A fake exec: `rev-parse --verify` reads `tip`, `rev-list --count` one commit; fence-checked. */
function fake(tip: string) {
  const calls: { argv: string[]; opts: ExecOptions }[] = [];
  const exec: ExecFn = async (argv, opts = {}) => {
    calls.push({ argv: [...argv], opts });
    assertAllowed(argv, opts);
    const has = (x: string) => argv.includes(x);
    if (has("--verify")) return { code: 0, stdout: `${tip}\n`, stderr: "", timedOut: false };
    if (has("rev-list")) return { code: 0, stdout: "1\n", stderr: "", timedOut: false };
    if (argv[0] === "ps") return { code: 0, stdout: "", stderr: "", timedOut: false };
    if (argv[0] === "gh" && argv[2] === "repos/acme/demo")
      return { code: 0, stdout: "main\n", stderr: "", timedOut: false };
    if (argv[0] === "gh") return { code: 0, stdout: "0\n", stderr: "", timedOut: false };
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { calls, exec };
}

const deletes = (calls: { argv: string[]; opts: ExecOptions }[]) =>
  calls.filter((c) => c.argv.includes("branch") && c.argv.includes("-D"));

describe("cleanup deletes merged agent branches, only at the merged head", () => {
  it("a done task whose branch is at the merged head: git -C <repo> branch -D with its token", async () => {
    const { home, repo } = setup();
    const fx = fake(HEAD);
    const io = makeBufferIO();
    expect(await cleanupWave(home, "w1", { yes: true, force: false, exec: fx.exec }, io)).toBe(0);
    const d = deletes(fx.calls);
    expect(d.map((c) => c.argv)).toEqual([
      ["git", "-C", repo, "branch", "-D", "w1/T1-implementer-1"],
    ]);
    expect(d[0]?.opts.branchDelete).toMatchObject({ repo, branch: "w1/T1-implementer-1" });
    expect(io.readStdout()).toContain("deleted branch w1/T1-implementer-1\n");
    expect(io.readStdout()).toMatch(/cleaned w1: 1 branch; kept 1\n/);
    // journaled, with the counts
    const cleaned = readJournalFile(join(home, "waves", "w1", "journal.jsonl")).at(-1);
    expect(cleaned?.type).toBe("wave_cleaned");
    expect(cleaned?.data).toMatchObject({ removed: { branches: 1 }, dry_run: false });
  });

  it("a tip past the merged head keeps the branch with the count, and no delete", async () => {
    const { home } = setup();
    const fx = fake(LATER);
    const io = makeBufferIO();
    await cleanupWave(home, "w1", { yes: true, force: false, exec: fx.exec }, io);
    expect(deletes(fx.calls)).toEqual([]);
    expect(io.readStdout()).toContain(
      "kept branch w1/T1-implementer-1: 1 commit after the merged head\n",
    );
  });

  it("a cancelled task's branch is kept, unmerged", async () => {
    const { home } = setup({ stage: "cancelled" });
    const fx = fake(HEAD);
    const io = makeBufferIO();
    await cleanupWave(home, "w1", { yes: true, force: false, exec: fx.exec }, io);
    expect(deletes(fx.calls)).toEqual([]);
    expect(io.readStdout()).toMatch(/kept branch w1\/T1-implementer-1: unmerged/);
  });

  it("a detached reviewer worktree has no branch line", async () => {
    const { home } = setup({ reviewer: true });
    const fx = fake(HEAD);
    const io = makeBufferIO();
    await cleanupWave(home, "w1", { yes: true, force: false, exec: fx.exec }, io);
    expect(io.readStdout()).not.toContain("spec_reviewer-1");
    expect(deletes(fx.calls)).toHaveLength(1);
  });

  it("the dry run says what it would delete and deletes nothing", async () => {
    const { home } = setup();
    const fx = fake(HEAD);
    const io = makeBufferIO();
    await cleanupWave(home, "w1", { yes: false, force: false, exec: fx.exec }, io);
    expect(deletes(fx.calls)).toEqual([]);
    expect(io.readStdout()).toContain("would delete branch w1/T1-implementer-1\n");
  });

  it("the release branch, fully merged, prints the git push --delete line and never runs it", async () => {
    const home = tempDir("volleyd-cleanup-release-");
    const wave = parseWaveFile(
      "wave: w1\nrepo: acme/demo\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement, merge_ready]\ntasks:\n  T1: { issue: 1 }\n",
    );
    Journal.open(join(home, "waves", "w1")).append({ type: "wave_submitted", data: { wave } });
    const fx = fake(HEAD);
    const io = makeBufferIO();
    await cleanupWave(home, "w1", { yes: true, force: false, exec: fx.exec }, io);
    expect(io.readStdout()).toContain(
      "kept release branch release/w1: merged into main — git push origin --delete release/w1\n",
    );
    expect(fx.calls.map((c) => c.argv)).toContainEqual([
      "gh",
      "api",
      "repos/acme/demo/compare/main...release/w1",
      "--jq",
      ".ahead_by",
    ]);
    expect(fx.calls.some((c) => c.argv.includes("push") || c.argv.includes("DELETE"))).toBe(false);
  });
});
