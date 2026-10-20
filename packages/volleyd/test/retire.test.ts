import { existsSync, rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockPath } from "../src/locks";
import {
  CREDENTIALS_DELETED,
  type RetireRequest,
  closableAfterRestart,
  reapAndRevoke,
  retainedTopics,
  retireAgent,
  withJointRevokes,
} from "../src/retire";
import { SpawnError } from "../src/spawn-error";
import type { NewEvent } from "../src/types";
import { type MemoryCredentials, memoryCredentials } from "./helpers/fake-dynsec";
import { tempDir } from "./helpers/tmp";

const ID = "w1-t1-implementer-1";

describe("the delete path (reapAndRevoke) and retireAgent", () => {
  let home: string;
  /** Everything the delete path did, in order. */
  let log: string[];
  let published: { topic: string; payload: string }[];
  let events: NewEvent[];
  let creds: MemoryCredentials;
  const deps = () => ({
    credentials: {
      mint: creds.mint,
      revoke: async (id: string) => {
        log.push(`deleteClient ${id}`);
        return creds.revoke(id);
      },
    },
    publishRetained: async (topic: string, payload: string) => {
      log.push(`publish ${topic}`);
      published.push({ topic, payload });
    },
    clearRetained: async (t: string) => {
      log.push(`clear ${t}`);
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
  const cleared = () => log.filter((l) => l.startsWith("clear ")).map((l) => l.slice(6));

  beforeEach(() => {
    home = tempDir("volleyd-retire-");
    log = [];
    published = [];
    events = [];
    creds = memoryCredentials();
  });

  it("publishes `reaped { credentials_deleted }`, clears every record, THEN deletes the login (and clears again)", async () => {
    expect(await reapAndRevoke(ID, "ns", deps(), "T1")).toBe(true);
    const clears = [
      `clear volley/_system/registry/${ID}`,
      `clear volley/ns/${ID}/status`,
      `clear volley/ns/${ID}/progress`,
      `clear volley/ns/${ID}/result`,
      `clear volley/ns/${ID}/capability`,
      `clear volley/ns/${ID}/screen`,
      `clear volley/ns/${ID}/usage`,
    ];
    expect(log).toEqual([
      `publish volley/ns/${ID}/status`,
      ...clears,
      `deleteClient ${ID}`,
      ...clears,
    ]);
    const status = JSON.parse(published[0]?.payload as string);
    expect(status).toMatchObject({
      agent_id: ID,
      channel: "status",
      type: "reaped",
      payload: { reason: CREDENTIALS_DELETED, by: "volleyd" },
    });
    expect(events).toEqual([
      {
        type: "agent_reaped_by_supervisor",
        task: "T1",
        data: { agent_id: ID, reason: "credentials_deleted" },
      },
      { type: "credentials_revoked", task: "T1", data: { agent_id: ID, ok: true } },
    ]);
  });

  it("a record the still-connected agent re-publishes before its login is deleted is cleared too", async () => {
    const retained = new Map<string, string>();
    const d = deps();
    const r = await reapAndRevoke(
      ID,
      "ns",
      {
        ...d,
        publishRetained: async (t, p) => {
          retained.set(t, p);
        },
        clearRetained: async (t) => {
          retained.delete(t);
        },
        credentials: {
          mint: creds.mint,
          revoke: async (id) => {
            // Inside the batch window: the agent is still connected and publishes its status.
            retained.set(`volley/ns/${ID}/status`, '{"type":"working"}');
            return creds.revoke(id);
          },
        },
      },
      "T1",
    );
    expect(r).toBe(true);
    expect([...retained.keys()]).toEqual([]);
  });

  it("withJointRevokes: deletes held until every job waits on one, then sent together", async () => {
    const sent: string[][] = [];
    let tick: string[] = [];
    const store = {
      mint: creds.mint,
      revoke: async (id: string) => {
        tick.push(id);
        if (tick.length === 1) {
          queueMicrotask(() => {
            sent.push(tick);
            tick = [];
          });
        }
        return true;
      },
    };
    const later = async (turns: number) => {
      for (let i = 0; i < turns; i++) await Promise.resolve();
    };
    await withJointRevokes(store, [
      async (c) => c?.revoke("a"),
      async (c) => {
        await later(5);
        await c?.revoke("b");
      },
      async () => later(2), // a job with no login to delete
    ]);
    expect(sent).toEqual([["a", "b"]]);
  });

  it("after a terminal status: the delete path, the lock released, agent_retired journaled", async () => {
    const path = lockPath(home, "/wt/w1/T1-implementer");
    await acquireLock(
      path,
      { wave: "w1", task: "T1", role: "implementer", attempt: 1, agent_id: ID, pid: 1, at: "x" },
      { status: async () => null, registered: async () => false, lastHeartbeat: () => null },
      { staleAfterMs: 1 },
    );
    await retireAgent(req({ lockPath: path }), deps());
    expect(creds.revoked).toEqual([ID]);
    expect(cleared()).toEqual([...retainedTopics("ns", ID), ...retainedTopics("ns", ID)]);
    expect(existsSync(path)).toBe(false);
    expect(events.map((e) => e.type)).toEqual([
      "agent_reaped_by_supervisor",
      "credentials_revoked",
      "agent_retired",
    ]);
    expect(events.at(-1)).toEqual({
      type: "agent_retired",
      task: "T1",
      data: {
        agent_id: ID,
        role: "implementer",
        status: "done",
        credentials_revoked: true,
        lock_released: true,
      },
    });
  });

  it("an agent with no login: records cleared, no `reaped`, nothing deleted", async () => {
    await retireAgent(req({ minted: false }), deps());
    expect(published).toEqual([]);
    expect(creds.revoked).toEqual([]);
    expect(cleared()).toEqual(retainedTopics("ns", ID));
    expect(events.at(-1)?.data.credentials_revoked).toBeNull();
  });

  it.each(["failed", "reaped", "moved", "stopped", "relaunched"])(
    "retires a %s agent too",
    async (status) => {
      await retireAgent(req({ status }), deps());
      // Cleared before and once more after the delete (reapAndRevoke).
      expect(cleared()).toHaveLength(14);
    },
  );

  it.each([["working"], ["blocked"], [null]])(
    "a %s agent → refused, nothing touched",
    async (status) => {
      const err = await retireAgent(req({ status }), deps()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SpawnError);
      expect((err as SpawnError).code).toBe("RETIRE_REFUSED");
      expect(log).toEqual([]);
      expect(events).toEqual([]);
    },
  );

  it("another wave's agent → refused, nothing touched", async () => {
    const err = await retireAgent(
      req({ agentId: "w2-t1-implementer-1", waveAgents: new Set([ID]) }),
      deps(),
    ).catch((e: unknown) => e);
    expect((err as SpawnError).code).toBe("RETIRE_REFUSED");
    expect(log).toEqual([]);
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

  it("ends only its own session, journaled agent_session_closed before agent_retired; a kept session (endSession null) is journaled closed: false", async () => {
    const ended: (string | null)[][] = [];
    await retireAgent(req({ workspace: "workspace:1", worktree: "/wt/a" }), {
      ...deps(),
      endSession: async (ws, wt) => {
        ended.push([ws, wt]);
        return { closed: true, pids: [42], how: "close-workspace" };
      },
    });
    expect(ended).toEqual([["workspace:1", "/wt/a"]]);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["agent_session_closed", "agent_retired"]);
    expect(events.at(-2)?.data).toEqual({
      agent_id: ID,
      workspace: "workspace:1",
      how: "close-workspace",
      pids: [42],
    });
    expect(events.at(-1)?.data).toMatchObject({ workspace: "workspace:1", workspace_closed: true });
    events = [];
    await retireAgent(req({ workspace: "workspace:2" }), { ...deps(), endSession: null });
    expect(ended).toHaveLength(1);
    expect(events.map((e) => e.type)).not.toContain("agent_session_closed");
    expect(events.at(-1)?.data).toMatchObject({
      workspace: "workspace:2",
      workspace_closed: false,
    });
  });

  it("a failing endSession is journaled as nothing done; the retire still completes", async () => {
    await retireAgent(req({ workspace: "workspace:1" }), {
      ...deps(),
      endSession: async () => {
        throw new Error("cmux hung");
      },
    });
    expect(events.at(-2)?.data).toMatchObject({ how: "none", pids: [] });
    expect(events.at(-1)?.data).toMatchObject({ workspace_closed: false });
  });

  it("writes the retired marker before the login is deleted", async () => {
    const markers: unknown[] = [];
    await retireAgent(req({ status: "failed", worktree: "/wt/a" }), {
      ...deps(),
      writeMarker: async (wt, m) => {
        log.push(`marker ${wt}`);
        markers.push(m);
      },
    });
    expect(markers).toEqual([{ agent_id: ID, status: "failed" }]);
    expect(log.indexOf("marker /wt/a")).toBeLessThan(log.indexOf(`deleteClient ${ID}`));
  });

  it.each([["working"], ["blocked"], [null]])(
    "a %s agent writes no marker and ends no session",
    async (status) => {
      const touched: string[] = [];
      await retireAgent(req({ status, worktree: "/wt/a", workspace: "workspace:1" }), {
        ...deps(),
        writeMarker: async () => {
          touched.push("marker");
        },
        endSession: async () => {
          touched.push("end");
          return { closed: true, pids: [], how: "close-workspace" };
        },
      }).catch(() => {});
      expect(touched).toEqual([]);
    },
  );
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
