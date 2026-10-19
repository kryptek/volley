import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockPath } from "../src/locks";
import {
  type RetireRequest,
  closableAfterRestart,
  retainedTopics,
  retireAgent,
} from "../src/retire";
import { SpawnError } from "../src/spawn-error";
import type { NewEvent } from "../src/types";
import { fakeExec } from "./helpers/fake-exec";

const ID = "w1-t1-implementer-1";

describe("retireAgent", () => {
  let home: string;
  let cleared: string[];
  let events: NewEvent[];
  let fake: ReturnType<typeof fakeExec>;
  const deps = () => ({
    exec: fake.exec,
    clearRetained: async (t: string) => {
      cleared.push(t);
    },
    journal: (ev: NewEvent) => {
      events.push(ev);
    },
    releaseLock: (p: string) => rmSync(p, { force: true }),
  });
  const req = (over: Partial<RetireRequest> = {}): RetireRequest => ({
    wave: "w1",
    task: "T1",
    role: "implementer",
    agentId: ID,
    namespace: "ns",
    status: "done",
    waveAgents: new Set([ID]),
    minted: true,
    ...over,
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "volleyd-retire-"));
    cleared = [];
    events = [];
    fake = fakeExec();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("after a terminal status: revokes, clears the retained records, releases the lock, journals", async () => {
    const path = lockPath(home, "/wt/w1/T1-implementer");
    await acquireLock(
      path,
      { wave: "w1", task: "T1", role: "implementer", attempt: 1, agent_id: ID, pid: 1, at: "x" },
      { status: async () => null, registered: async () => false, lastHeartbeat: () => null },
      { staleAfterMs: 1 },
    );
    await retireAgent(req({ lockPath: path }), deps());
    expect(fake.argvs()).toEqual([["volley", "auth", "rm-agent", ID]]);
    expect(cleared).toEqual([
      `volley/_system/registry/${ID}`,
      `volley/ns/${ID}/status`,
      `volley/ns/${ID}/progress`,
      `volley/ns/${ID}/result`,
      `volley/ns/${ID}/capability`,
      `volley/ns/${ID}/screen`,
      `volley/ns/${ID}/usage`,
    ]);
    expect(cleared).toEqual(retainedTopics("ns", ID));
    expect(existsSync(path)).toBe(false);
    expect(events).toEqual([
      {
        type: "agent_retired",
        task: "T1",
        data: {
          agent_id: ID,
          role: "implementer",
          status: "done",
          credentials_revoked: true,
          lock_released: true,
        },
      },
    ]);
  });

  it.each(["failed", "reaped", "moved", "stopped", "relaunched"])(
    "retires a %s agent too",
    async (status) => {
      await retireAgent(req({ status }), deps());
      expect(cleared).toHaveLength(7);
    },
  );

  it.each([["working"], ["blocked"], [null]])(
    "a %s agent → refused, nothing touched",
    async (status) => {
      const err = await retireAgent(req({ status }), deps()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpawnError);
      expect((err as SpawnError).code).toBe("RETIRE_REFUSED");
      expect(fake.calls).toEqual([]);
      expect(cleared).toEqual([]);
      expect(events).toEqual([]);
    },
  );

  it("another wave's agent → refused, nothing touched", async () => {
    const err = await retireAgent(
      req({ agentId: "w2-t1-implementer-1", waveAgents: new Set([ID]) }),
      deps(),
    ).catch((e: unknown) => e);
    expect((err as SpawnError).code).toBe("RETIRE_REFUSED");
    expect(fake.calls).toEqual([]);
    expect(cleared).toEqual([]);
  });

  it("does not release a lock that now names another agent", async () => {
    const path = lockPath(home, "/wt/w1/T1-implementer");
    await acquireLock(
      path,
      {
        wave: "w1",
        task: "T1",
        role: "implementer",
        attempt: 2,
        agent_id: "w1-t1-implementer-2",
        pid: 1,
        at: "x",
      },
      { status: async () => null, registered: async () => false, lastHeartbeat: () => null },
      { staleAfterMs: 1 },
    );
    await retireAgent(req({ lockPath: path }), deps());
    expect(existsSync(path)).toBe(true);
  });

  it("closes only its own workspace; a ref it cannot trust (closeWorkspace null) is left, journaled closed: false", async () => {
    const closed: string[] = [];
    await retireAgent(req({ workspace: "workspace:1" }), {
      ...deps(),
      closeWorkspace: async (ws: string) => {
        closed.push(ws);
      },
    });
    expect(closed).toEqual(["workspace:1"]);
    expect(events.at(-1)?.data).toMatchObject({ workspace: "workspace:1", workspace_closed: true });
    await retireAgent(req({ workspace: "workspace:2" }), { ...deps(), closeWorkspace: null });
    expect(closed).toEqual(["workspace:1"]);
    expect(events.at(-1)?.data).toMatchObject({
      workspace: "workspace:2",
      workspace_closed: false,
    });
  });
});

describe("closableAfterRestart (a workspace ref read back from the journal)", () => {
  const session = "w1-T1-implementer";
  it("a UUID or the agent's own tmux session (with a free-name suffix) is still its own", () => {
    expect(closableAfterRestart("0f8b5c1e-2d3a-4b5c-8d9e-0a1b2c3d4e5f", session)).toBe(true);
    expect(closableAfterRestart(session, session)).toBe(true);
    expect(closableAfterRestart(`${session}-2`, session)).toBe(true);
  });
  it("a short cmux ref, an index or another agent's session may name anyone's workspace now", () => {
    expect(closableAfterRestart("workspace:3", session)).toBe(false);
    expect(closableAfterRestart("3", session)).toBe(false);
    expect(closableAfterRestart("w1-T2-implementer", session)).toBe(false);
    expect(closableAfterRestart(`${session}-reviewer`, session)).toBe(false);
    expect(closableAfterRestart("", session)).toBe(false);
  });
});
