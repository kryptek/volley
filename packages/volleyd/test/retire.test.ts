import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, lockPath } from "../src/locks";
import {
  CREDENTIALS_DELETED,
  type RetireRequest,
  reapAndRevoke,
  retainedTopics,
  retireAgent,
  withJointRevokes,
} from "../src/retire";
import { SpawnError } from "../src/spawn-error";
import type { NewEvent } from "../src/types";
import { type MemoryCredentials, memoryCredentials } from "./helpers/fake-dynsec";

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
    home = mkdtempSync(join(tmpdir(), "volleyd-retire-"));
    log = [];
    published = [];
    events = [];
    creds = memoryCredentials();
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("publishes `reaped { credentials_deleted }`, clears every record, THEN deletes the login (and clears again)", async () => {
    expect(await reapAndRevoke(ID, "ns", deps(), "T1")).toBe(true);
    const clears = [
      `clear volley/_system/registry/${ID}`,
      `clear volley/ns/${ID}/status`,
      `clear volley/ns/${ID}/progress`,
      `clear volley/ns/${ID}/result`,
      `clear volley/ns/${ID}/capability`,
      `clear volley/ns/${ID}/screen`,
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

  it.each(["failed", "reaped", "moved", "stopped"])("retires a %s agent too", async (status) => {
    await retireAgent(req({ status }), deps());
    expect(cleared()).toHaveLength(12);
  });

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
});
