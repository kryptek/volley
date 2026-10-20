import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupPlan } from "../src/commands/cleanup";
import { Journal } from "../src/journal";
import { retiredMarkerPath } from "../src/retire";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";
import { tempDir } from "./helpers/tmp";

/** Retiring an agent closes its workspace (cmux locally, the tmux session on an ssh host), journaled. */

describe("retire closes the agent's workspace", () => {
  let s: SupervisedEnv;
  afterEach(async () => s.cleanup());

  /** The implementer's worktree, from its agent_spawned record. */
  const worktreeOf = () =>
    String(
      s.journal().find((e) => e.type === "agent_spawned" && e.data.agent_id === AGENT)?.data
        .worktree,
    );

  it("a failed agent: its session is ended (journaled before agent_retired), its marker written", async () => {
    s = await makeSupervisedEnv();
    await s.status("failed", { reason: "gave up" });
    const r = await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(r.data).toMatchObject({ workspace: "workspace:1", workspace_closed: true });
    expect(s.host.closed).toEqual(["workspace:1"]);
    const types = s.journal().map((e) => e.type);
    const ended = s.journal().find((e) => e.type === "agent_session_closed");
    expect(ended?.data).toEqual({
      agent_id: AGENT,
      workspace: "workspace:1",
      how: "close-workspace",
      pids: [],
    });
    expect(types.indexOf("agent_session_closed")).toBeLessThan(types.indexOf("agent_retired"));
    expect(s.host.sessionsEnded).toEqual([{ workspace: "workspace:1", worktree: worktreeOf() }]);
    const marker = JSON.parse(readFileSync(retiredMarkerPath(worktreeOf()), "utf-8"));
    expect(marker).toMatchObject({ agent_id: AGENT, status: "failed" });
    expect(typeof marker.at).toBe("string");
  });

  it("retire_close_session: false keeps the session open, still writes the marker", async () => {
    s = await makeSupervisedEnv({ config: "retire_close_session: false" });
    await s.status("failed", { reason: "gave up" });
    const r = await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(r.data).toMatchObject({ workspace: "workspace:1", workspace_closed: false });
    expect(s.journal().some((e) => e.type === "agent_session_closed")).toBe(false);
    expect(s.host.closed).toEqual([]);
    expect(s.host.sessionsEnded).toEqual([]);
    expect(existsSync(retiredMarkerPath(worktreeOf()))).toBe(true);
  });

  it("after a restart, the short journaled ref is not trusted: the workspace is re-found by title", async () => {
    s = await makeSupervisedEnv();
    await s.daemon.stop();
    s.host.workspaceTitles["w1 T1 implementer"] = "workspace:7";
    await s.restart();
    await s.event("reconciled");
    await s.settled();
    await s.status("failed", { reason: "gave up after the restart" });
    const r = await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(s.host.finds).toEqual([{ name: "w1 T1 implementer" }]);
    expect(s.host.closed).toEqual(["workspace:7"]);
    expect(r.data).toMatchObject({ workspace: "workspace:1", workspace_closed: true });
    const ended = s.journal().find((e) => e.type === "agent_session_closed");
    expect(ended?.data).toMatchObject({ workspace: "workspace:7", how: "close-workspace" });
  });

  it("after a restart, a title nobody holds: no workspace is closed, the processes still are", async () => {
    s = await makeSupervisedEnv();
    await s.daemon.stop();
    await s.restart();
    await s.event("reconciled");
    await s.settled();
    await s.status("failed", { reason: "gave up after the restart" });
    const r = await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(s.host.closed).toEqual([]);
    expect(s.host.sessionsEnded).toEqual([{ workspace: null, worktree: worktreeOf() }]);
    expect(r.data).toMatchObject({ workspace: "workspace:1", workspace_closed: false });
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
