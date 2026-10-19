import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DynsecSession, brokerTransport, ensureClients, ensureRoles } from "volley-cli/auth/dynsec";
import { ACCOUNT_ROLE_MAP, FIXED_CLIENTS } from "volley-cli/auth/roles";
import { VolleyBroker } from "volley-mcp/broker";
import { CredentialSweeper, planSweep } from "../src/credential-sweep";
import { DynsecControl, DynsecCredentials, brokerControl } from "../src/dynsec";
import { reapAndRevoke } from "../src/retire";
import type { NewEvent } from "../src/types";
import { makeDaemonEnv } from "./helpers/daemon-env";
import { type FakeDynsec, memoryCredentials, startFakeDynsec } from "./helpers/fake-dynsec";
import { makeSupervisedEnv } from "./helpers/supervised-env";

describe("planSweep", () => {
  const base = { mintedAt: new Map<string, number>(), now: 1_000_000, graceMs: 120_000 };

  it("sweeps logins with no live agent; spares live ones", () => {
    const r = planSweep({
      ...base,
      logins: ["a", "b", "c"],
      live: new Set(["b"]),
      mintedAt: new Map([
        ["a", 0],
        ["c", 0],
      ]),
      firstSeen: new Map(),
    });
    expect(r).toEqual({ sweep: ["a", "c"], kept: ["b"] });
  });

  it("spares a login minted within the grace (a spawn not journaled yet)", () => {
    const r = planSweep({
      ...base,
      logins: ["young", "old"],
      live: new Set(),
      mintedAt: new Map([
        ["young", base.now - 5_000],
        ["old", base.now - 500_000],
      ]),
      firstSeen: new Map(),
    });
    expect(r).toEqual({ sweep: ["old"], kept: ["young"] });
  });

  it("a login this daemon never minted is judged from when it was first listed", () => {
    const firstSeen = new Map<string, number>();
    const first = planSweep({ ...base, logins: ["x"], live: new Set(), firstSeen });
    expect(first.sweep).toEqual([]);
    const later = planSweep({
      ...base,
      now: base.now + 200_000,
      logins: ["x"],
      live: new Set(),
      firstSeen,
    });
    expect(later.sweep).toEqual(["x"]);
    planSweep({ ...base, logins: [], live: new Set(), firstSeen });
    expect(firstSeen.size).toBe(0);
  });
});

describe("the sweep on Dynamic Security", () => {
  let fake: FakeDynsec;
  let control: DynsecControl;
  let creds: DynsecCredentials;
  let observer: VolleyBroker;
  const statuses: { topic: string; payload: string }[] = [];
  const events: NewEvent[] = [];

  beforeEach(async () => {
    statuses.length = 0;
    events.length = 0;
    fake = await startFakeDynsec();
    const b = new VolleyBroker();
    await b.connect({ url: fake.url, agentId: "bootstrap", ...fake.admin });
    const s = await DynsecSession.open(brokerTransport(b));
    await ensureRoles(s);
    // Every kind of login there is: fixed identities, accounts of each role, a token login.
    await ensureClients(s, [
      ...Object.entries(FIXED_CLIENTS).map(([username, roles]) => ({
        username,
        password: `${username}-pw`,
        roles,
      })),
      ...Object.entries(ACCOUNT_ROLE_MAP).map(([role, roles]) => ({
        username: `${role}-acct`,
        password: "pw",
        roles,
      })),
      { username: "0000abcd", password: "vly_admin_x", roles: ["token"] },
      // Agent logins left over from before this daemon (never minted by it).
      { username: "w0-t1-implementer-1", password: "pw", roles: ["agent"] },
      { username: "w0-t2-implementer-1", password: "pw", roles: ["agent"] },
      { username: "w1-t3-implementer-1", password: "pw", roles: ["agent"] },
    ]);
    await s.close();
    await b.disconnect();
    observer = new VolleyBroker();
    await observer.connect({
      url: fake.url,
      agentId: "obs",
      username: "volleyd",
      password: "volleyd-pw",
    });
    await observer.subscribeStream("volley/+/+/status", (m) => statuses.push(m));
    control = new DynsecControl({
      connect: brokerControl(fake.url, fake.admin),
      batchMs: () => 30,
    });
    creds = new DynsecCredentials(control);
  });
  afterEach(async () => {
    await observer.disconnect();
    await control.close();
    await fake.close();
  });

  function sweeper(live: string[], now = Date.now) {
    return new CredentialSweeper({
      credentials: creds,
      live: async () => new Set(live),
      reap: (id) =>
        reapAndRevoke(id, "ns", {
          credentials: creds,
          publishRetained: (t, p) => observer.publish(t, p, { qos: 1, retain: true }),
          clearRetained: (t) => observer.publish(t, "", { qos: 1, retain: true }),
          journal: (ev) => {
            events.push(ev);
          },
        }),
      journal: (ev) => {
        events.push(ev);
      },
      graceMs: () => 120_000,
      now,
    });
  }

  it("deletes the finished agents' logins, spares the live, the just-minted and every non-agent login", async () => {
    await creds.mint("w1-t4-implementer-1"); // just minted: its spawn is not journaled yet
    const later = () => Date.now() + 200_000; // the leftovers were first seen long ago
    const sw = sweeper(["w1-t3-implementer-1"], later);
    // First listing: the leftovers become known; minted-by-us age comes from mintedAt.
    creds.mintedAt.set("w0-t1-implementer-1", 0);
    creds.mintedAt.set("w0-t2-implementer-1", 0);
    creds.mintedAt.set("w1-t4-implementer-1", later() - 1_000);
    const before = fake.controlMessages.length;
    const swept = await sw.sweep();
    expect(swept).toEqual(["w0-t1-implementer-1", "w0-t2-implementer-1"]);

    const clients = fake.clients();
    expect(clients.has("w0-t1-implementer-1")).toBe(false);
    expect(clients.has("w0-t2-implementer-1")).toBe(false);
    for (const kept of [
      "w1-t3-implementer-1",
      "w1-t4-implementer-1",
      "volleyd",
      "desk",
      "coordinator",
      "admin-acct",
      "supervisor-acct",
      "steer-acct",
      "watch-acct",
      "peer-acct",
      "0000abcd",
      fake.admin.username,
    ]) {
      expect(clients.has(kept), kept).toBe(true);
    }
    // The two deletes went as ONE control message.
    const deletes = fake.controlMessages
      .slice(before)
      .filter((m) => m.some((c) => c.command === "deleteClient"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.map((c) => c.username).sort()).toEqual([
      "w0-t1-implementer-1",
      "w0-t2-implementer-1",
    ]);
    // `reaped` (no LWT comes) published before the delete, then the records cleared.
    await new Promise((r) => setTimeout(r, 100));
    const reaped = statuses.filter((m) => m.payload !== "").map((m) => JSON.parse(m.payload));
    expect(reaped.map((e) => [e.agent_id, e.type, e.payload.reason])).toEqual([
      ["w0-t1-implementer-1", "reaped", "credentials_deleted"],
      ["w0-t2-implementer-1", "reaped", "credentials_deleted"],
    ]);
    expect(await observer.queryRetained("volley/ns/w0-t1-implementer-1/status", 200)).toBeNull();
    // Journaled: each reap + revoke, then the sweep.
    expect(events.at(-1)).toEqual({
      type: "credentials_swept",
      data: { agent_ids: ["w0-t1-implementer-1", "w0-t2-implementer-1"] },
    });
    expect(events.filter((e) => e.type === "agent_reaped_by_supervisor")).toHaveLength(2);
    expect(sw.counts).toEqual({ live: 2, swept: 2 });
  });

  it("nothing to sweep: no delete, nothing journaled", async () => {
    const sw = sweeper(["w0-t1-implementer-1", "w0-t2-implementer-1", "w1-t3-implementer-1"]);
    expect(await sw.sweep()).toEqual([]);
    expect(events).toEqual([]);
    expect(fake.controlMessages.flat().some((c) => c.command === "deleteClient")).toBe(false);
  });
});

describe("the daemon sweeps at start and on the interval", () => {
  it("a stale login is deleted without anyone asking; credentials_swept is journaled", async () => {
    const s = await makeSupervisedEnv({ daemon: { credentialSweepMs: 150 } });
    try {
      // A login from an earlier run (not live, minted long ago) appears after start.
      s.creds.logins.add("w0-t1-implementer-1");
      s.creds.mintedAt.set("w0-t1-implementer-1", 0);
      await s.until(() => s.creds.revoked.includes("w0-t1-implementer-1"), 3_000);
      // The live, supervised implementer is spared.
      expect(s.creds.revoked).not.toContain("w1-t1-implementer-1");
      expect(s.creds.logins.has("w1-t1-implementer-1")).toBe(true);
      await s.until(() => s.journal("_system").some((e) => e.type === "credentials_swept"));
      expect(s.journal("_system").find((e) => e.type === "credentials_swept")?.data).toEqual({
        agent_ids: ["w0-t1-implementer-1"],
      });
    } finally {
      await s.cleanup();
    }
  });

  it("sweeps once at start: a login left from before is gone before any interval", async () => {
    const creds = memoryCredentials();
    creds.logins.add("w0-t1-implementer-1");
    creds.mintedAt.set("w0-t1-implementer-1", 0);
    const s = await makeSupervisedEnv({ creds, daemon: { credentialSweepMs: 3_600_000 } });
    try {
      await s.until(() => creds.revoked.includes("w0-t1-implementer-1"), 3_000);
    } finally {
      await s.cleanup();
    }
  });

  it("a daemon with no credential store (no admin login, or --no-mint) sweeps nothing", async () => {
    const env = await makeDaemonEnv();
    try {
      const d = await env.start();
      expect(await d.sweepCredentials()).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });
});
