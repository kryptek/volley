import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupPlan } from "../src/commands/cleanup";
import { Journal } from "../src/journal";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";
import { tempDir } from "./helpers/tmp";

/** Retiring an agent closes its workspace (cmux locally, the tmux session on an ssh host), journaled. */

describe("retire closes the agent's workspace", () => {
  let s: SupervisedEnv;
  afterEach(async () => s.cleanup());

  it("a failed agent: its workspace is closed and agent_retired says so", async () => {
    s = await makeSupervisedEnv();
    await s.status("failed", { reason: "gave up" });
    const r = await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(r.data).toMatchObject({ workspace: "workspace:1", workspace_closed: true });
    expect(s.host.closed).toEqual(["workspace:1"]);
  });

  it("a force-retired agent at stop: its workspace is closed too", async () => {
    const clock: FakeClock = fakeClock(Date.now());
    s = await makeSupervisedEnv({ daemon: { clock } });
    expect((await runCli(["stop", "w1", "--by", "t"], s.env.env)).exitCode).toBe(0);
    await clock.armed(30_000);
    await clock.advance(30_000);
    const r = await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(r.data).toMatchObject({ status: "stopped", workspace_closed: true });
    expect(s.host.closed).toEqual(["workspace:1"]);
  });
});

describe("cleanup after retires that closed workspaces", () => {
  it("skips the workspace of an agent whose retire closed it, not a later agent given the same ref", () => {
    const home = tempDir("volleyd-cleanup-");
    const j = Journal.open(join(home, "waves", "w1"));
    j.append({ type: "wave_submitted", data: { wave: { repo: "/repo" } } });
    const spawned = (agent_id: string, worktree: string) =>
      j.append({
        type: "agent_spawned",
        task: "T1",
        data: { agent_id, worktree, workspace: "workspace:1" },
      });
    const retired = (agent_id: string, workspace_closed: boolean) =>
      j.append({
        type: "agent_retired",
        task: "T1",
        data: { agent_id, workspace: "workspace:1", workspace_closed },
      });
    spawned("w1-t1-implementer-1", "/wt/a");
    retired("w1-t1-implementer-1", true);
    // cmux handed the closed ref to the next agent; its own close failed.
    spawned("w1-t1-spec_reviewer-1", "/wt/b");
    retired("w1-t1-spec_reviewer-1", false);
    const plan = cleanupPlan(home, "w1");
    expect(plan.targets.find((t) => t.worktree === "/wt/a")?.workspaces).toEqual([]);
    expect(plan.targets.find((t) => t.worktree === "/wt/b")?.workspaces).toEqual(["workspace:1"]);
  });
});
