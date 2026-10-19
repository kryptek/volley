import { afterEach, describe, expect, it } from "vitest";
import { type FakeClock, fakeClock } from "./helpers/fake-clock";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

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
