import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fetchIssue, renderIssueMd } from "../src/issue";
import { spawnAgent } from "../src/spawn";
import { SpawnError } from "../src/spawn-error";
import { fakeExec } from "./helpers/fake-exec";
import { FIXTURES, type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";

const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf-8");

describe("fetchIssue", () => {
  it("runs the fenced gh issue view in the repo and returns the issue", async () => {
    const fake = fakeExec().on(["gh", "issue", "view"], { stdout: fixture("gh-issue-42.json") });
    const issue = await fetchIssue(fake.exec, "/w/repo", 42);
    expect(fake.calls[0]?.argv).toEqual([
      "gh",
      "issue",
      "view",
      "42",
      "--json",
      "number,title,body,url",
    ]);
    expect(fake.calls[0]?.opts.cwd).toBe("/w/repo");
    expect(issue.number).toBe(42);
    expect(issue.title).toBe("Spawn agents into worktrees");
  });

  it("a reply for a different number → ISSUE_MISMATCH", async () => {
    const fake = fakeExec().on(["gh", "issue", "view"], {
      stdout: fixture("gh-issue-43-mismatch.json"),
    });
    const err = await fetchIssue(fake.exec, "/w/repo", 42).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("ISSUE_MISMATCH");
    expect((err as SpawnError).detail).toEqual({ requested: 42, received: 43 });
  });

  it("gh failing → ISSUE_FETCH_FAILED", async () => {
    const fake = fakeExec().on(["gh", "issue", "view"], { code: 1, stderr: "not found" });
    const err = await fetchIssue(fake.exec, "/w/repo", 42).catch((e: unknown) => e);
    expect((err as SpawnError).code).toBe("ISSUE_FETCH_FAILED");
  });
});

describe("ISSUE.md", () => {
  let env: SpawnEnv;
  afterEach(() => env.cleanup());

  it("has the title, url and the body verbatim", async () => {
    env = await makeSpawnEnv();
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("launched");
    const md = readFileSync(join(env.worktree, "ISSUE.md"), "utf-8");
    const issue = JSON.parse(fixture("gh-issue-42.json"));
    expect(md).toBe(renderIssueMd(issue));
    expect(md.startsWith("# #42 — Spawn agents into worktrees\n")).toBe(true);
    expect(md).toContain("https://github.com/example/repo/issues/42");
    expect(md).toContain(issue.body);
  });

  it("a mismatched reply refuses the spawn: journaled, lock released, nothing launched", async () => {
    env = await makeSpawnEnv({ issueFixture: "gh-issue-43-mismatch.json" });
    const err = await spawnAgent(env.request(), env.deps).catch((e: unknown) => e);
    expect((err as SpawnError).code).toBe("ISSUE_MISMATCH");
    expect(env.host.launches).toEqual([]);
    expect(env.host.fake.argvs(["volley"])).toEqual([]);
    const alarm = env.events.find((e) => e.type === "alarm_raised");
    expect(alarm?.data).toMatchObject({ code: "ISSUE_MISMATCH", requested: 42, received: 43 });
    // the lock is gone: a corrected retry is not SPAWN_LOCKED
    env.host.fake.on(["gh", "issue", "view"], { stdout: fixture("gh-issue-42.json") });
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
  });

  it("the issue number comes from the wave only, never from files in the worktree", async () => {
    env = await makeSpawnEnv();
    // Stale files from an earlier run claim another issue.
    mkdirSync(join(env.worktree, ".volley"), { recursive: true });
    writeFileSync(join(env.worktree, "ISSUE.md"), "# #77 — stale\n");
    writeFileSync(
      join(env.worktree, ".volley", "agent.json"),
      JSON.stringify({ agent_id: "old", issue: 77 }),
    );
    writeFileSync(join(env.repo, "ISSUE.md"), "# #78 — also stale\n");
    await spawnAgent(env.request(), env.deps);
    const views = env.host.fake.argvs(["gh", "issue", "view"]);
    expect(views).toEqual([["gh", "issue", "view", "42", "--json", "number,title,body,url"]]);
    expect(readFileSync(join(env.worktree, "ISSUE.md"), "utf-8")).toContain("# #42");
  });
});
