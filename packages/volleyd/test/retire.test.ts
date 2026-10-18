import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockPath } from "../src/locks";
import { type RetireRequest, retainedTopics, retireAgent } from "../src/retire";
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

  it("after a terminal status: revokes, clears the five retained records, releases the lock, journals", async () => {
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
      `volley/ns/${ID}/result`,
      `volley/ns/${ID}/capability`,
      `volley/ns/${ID}/screen`,
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

  it.each(["failed", "reaped"])("retires a %s agent too", async (status) => {
    await retireAgent(req({ status }), deps());
    expect(cleared).toHaveLength(5);
  });

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
});
