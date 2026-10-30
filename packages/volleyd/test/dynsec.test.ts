import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DynsecSession, brokerTransport, ensureClients, ensureRoles } from "volley-cli/auth/dynsec";
import { VolleyBroker } from "volley-mcp/broker";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { DynsecControl, DynsecCredentials, brokerControl } from "../src/dynsec";
import { mintCredentials, releaseAgentId } from "../src/identity";
import { SpawnError } from "../src/spawn-error";
import { eventually } from "./helpers/broker-wait";
import { type FakeClock, fakeClock, flushMicrotasks } from "./helpers/fake-clock";
import { type FakeDynsec, startFakeDynsec } from "./helpers/fake-dynsec";

let fake: FakeDynsec;
let control: DynsecControl;
let creds: DynsecCredentials;
let clock: FakeClock;
let logs: string[];

/** Await `p` while moving the fake clock past each batch window it opens. */
async function batched<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const out = p.finally(() => {
    done = true;
  });
  out.catch(() => {});
  while (!done) {
    await clock.advance(30);
    await flushMicrotasks();
  }
  return out;
}

/** Move the fake clock a watchdog period at a time until volleyd's side saw the drop. */
async function dropNoticed(): Promise<void> {
  await eventually(async () => {
    await clock.advance(DAEMON_DEFAULTS.watchdog_ms);
    return logs.some((l) => l.includes("control connection lost"));
  });
}

beforeEach(async () => {
  fake = await startFakeDynsec();
  const b = new VolleyBroker();
  await b.connect({ url: fake.url, agentId: "bootstrap", ...fake.admin });
  const s = await DynsecSession.open(brokerTransport(b));
  await ensureRoles(s);
  await ensureClients(s, [{ username: "desk", password: "desk-pw", roles: ["account", "desk"] }]);
  await s.close();
  await b.disconnect();
  clock = fakeClock();
  logs = [];
  control = new DynsecControl({
    connect: brokerControl(fake.url, fake.admin),
    batchMs: () => 30,
    clock,
    log: (l) => logs.push(l),
  });
  let n = 0;
  creds = new DynsecCredentials(control, clock, () => `pw-${++n}`);
});
afterEach(async () => {
  await control.close();
  await fake.close();
});

/** Log in as `username`; true when the broker accepts the password. */
async function canLogin(username: string, password: string): Promise<boolean> {
  const b = new VolleyBroker();
  try {
    await b.connect({ url: fake.url, agentId: `t-${username}`, username, password });
    await b.disconnect();
    return true;
  } catch {
    return false;
  }
}

describe("DynsecControl", () => {
  it("one control connection is reused across mints", async () => {
    for (const id of ["w1-t1-implementer-1", "w1-t2-implementer-1", "w1-t3-implementer-1"]) {
      await batched(creds.mint(id));
    }
    expect(control.opened).toBe(1);
    expect(control.version).toBe("2.1.2");
  });

  it("the batch window collapses N simultaneous mints into one commands array", async () => {
    const before = fake.controlMessages.length;
    const ids = Array.from({ length: 12 }, (_, i) => `w1-t${i}-implementer-1`);
    const got = await batched(Promise.all(ids.map((id) => creds.mint(id))));
    const msgs = fake.controlMessages.slice(before);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.map((c) => [c.command, c.username])).toEqual(
      ids.map((id) => ["createClient", id]),
    );
    expect(
      msgs[0]?.every((c) => (c.roles as { rolename: string }[])[0]?.rolename === "volley-agent"),
    ).toBe(true);
    // Each caller got its own command's answer: its password logs it in.
    for (const c of got) expect(await canLogin(c.username, c.password)).toBe(true);
  });

  it("a mint that finds its agent login already there (a retry) sets a new password", async () => {
    const first = await batched(creds.mint("w1-t1-implementer-1"));
    const again = await batched(creds.mint("w1-t1-implementer-1"));
    expect(again.password).not.toBe(first.password);
    expect(await canLogin("w1-t1-implementer-1", again.password)).toBe(true);
    expect(fake.clients().get("w1-t1-implementer-1")?.roles).toEqual(["volley-agent"]);
  });

  it("never takes over a login that is not an agent login", async () => {
    const err = await batched(mintCredentials(creds, "desk").catch((e: unknown) => e));
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("CREDENTIALS_FAILED");
    expect(fake.clients().get("desk")?.password).toBe("desk-pw");
  });

  it("a failed element fails only its own mint", async () => {
    fake.failNext("createClient", "Internal error", "w1-t2-implementer-1");
    const r = await batched(
      Promise.allSettled(
        ["w1-t1-implementer-1", "w1-t2-implementer-1", "w1-t3-implementer-1"].map((id) =>
          mintCredentials(creds, id),
        ),
      ),
    );
    expect(r.map((x) => x.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(((r[1] as PromiseRejectedResult).reason as SpawnError).code).toBe("CREDENTIALS_FAILED");
  });

  it("revokes are batched too, and an already-deleted login counts", async () => {
    await batched(creds.mint("w1-t1-implementer-1"));
    await batched(creds.mint("w1-t2-implementer-1"));
    const before = fake.controlMessages.length;
    const ok = await batched(
      Promise.all(
        ["w1-t1-implementer-1", "w1-t2-implementer-1", "w1-t9-implementer-1"].map((id) =>
          creds.revoke(id),
        ),
      ),
    );
    expect(ok).toEqual([true, true, true]);
    expect(fake.controlMessages.slice(before)).toHaveLength(1);
    expect(await creds.agentLogins()).toEqual([]);
  });

  it("connection drop: the pending batch fails once with CREDENTIALS_FAILED, then a retry reconnects", async () => {
    await batched(creds.mint("w1-t1-implementer-1"));
    const release = fake.stall();
    const before = fake.controlMessages.length;
    const pending = mintCredentials(creds, "w1-t2-implementer-1").catch((e: unknown) => e);
    await clock.advance(30); // the batch window closes: the batch is sent and waiting
    await eventually(() => fake.controlMessages.length > before);
    fake.kick(fake.admin.username);
    await dropNoticed();
    const err = await pending;
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("CREDENTIALS_FAILED");
    release();
    // The retry (the spawn's own) goes through on a new connection.
    const c = await batched(mintCredentials(creds, "w1-t2-implementer-1"));
    expect(await canLogin(c.username, c.password)).toBe(true);
    expect(control.opened).toBe(2);
  });

  it("a reconnect checks the version again: a broker downgraded to 2.0 is refused", async () => {
    await batched(creds.mint("w1-t1-implementer-1"));
    await fake.setVersion("mosquitto version 2.0.22");
    fake.kick(fake.admin.username);
    await dropNoticed();
    const err = await batched(creds.mint("w1-t2-implementer-1").catch((e: unknown) => e));
    expect((err as { code?: string }).code).toBe("BROKER_TOO_OLD");
    expect(control.opened).toBe(1);
  });

  it("agentLogins lists only agent logins (never the desk or the admin)", async () => {
    await batched(creds.mint("w1-t1-implementer-1"));
    expect(await creds.agentLogins()).toEqual(["w1-t1-implementer-1"]);
  });
});

describe("revoking an agent login (#635)", () => {
  /** A connection that logs in as `username` and stays up. */
  async function online(username: string, password: string): Promise<VolleyBroker> {
    const b = new VolleyBroker();
    await b.connect({ url: fake.url, agentId: `t-${username}`, username, password });
    return b;
  }

  it.each([
    ["a task agent", "w1-t1-implementer-1"],
    ["a release-stage agent", releaseAgentId("w1", "bump", 1)],
  ])(
    "revoking %s kicks only that agent: the supervisor and the admin stay connected",
    async (_, id) => {
      fake.setPassword("volleyd", "vd-pw", ["agent"]);
      const daemon = await online("volleyd", "vd-pw");
      const c = await batched(creds.mint(id));
      const agent = await online(c.username, c.password);
      await batched(creds.agentLogins()); // the admin's control link is open
      const edits = fake.roleEdits();
      const before = fake.controlMessages.length;
      expect(fake.connected()).toEqual([fake.admin.username, id, "volleyd"].sort());

      expect(await batched(creds.revoke(id))).toBe(true);
      await eventually(() => !agent.connected);
      expect(fake.controlMessages.slice(before)).toMatchObject([
        [{ command: "deleteClient", username: id }],
      ]);
      expect(fake.roleEdits()).toBe(edits);
      expect(fake.connected()).toEqual([fake.admin.username, "volleyd"].sort());
      expect(daemon.connected).toBe(true);
      await daemon.disconnect();
      agent.simulateCrash();
    },
  );

  it("revoking a login that is already gone kicks nobody", async () => {
    fake.setPassword("volleyd", "vd-pw", ["agent"]);
    const daemon = await online("volleyd", "vd-pw");
    const id = releaseAgentId("w1", "tag", 1);
    await batched(creds.agentLogins());
    const before = fake.controlMessages.length;
    expect(await batched(creds.revoke(id))).toBe(true);
    expect(fake.controlMessages.slice(before)).toMatchObject([
      [{ command: "deleteClient", username: id }],
    ]);
    expect(fake.connected()).toEqual([fake.admin.username, "volleyd"].sort());
    expect(daemon.connected).toBe(true);
    await daemon.disconnect();
  });
});

describe("DynsecControl liveness", () => {
  it("a control link the broker stopped answering (connected, but silent) is closed and reopened on next use", async () => {
    let idle = 0;
    const killed: string[] = [];
    let opened = 0;
    const silent = new DynsecControl({
      connect: async () => {
        opened++;
        const session = { failAll: () => {}, close: async () => {} } as unknown as DynsecSession;
        let up = true;
        return {
          session,
          sysVersion: async () => "mosquitto version 2.1.2",
          connected: () => up,
          idleMs: () => idle,
          kill: (why: string) => {
            killed.push(why);
            up = false;
          },
          close: async () => {
            up = false;
          },
        };
      },
      batchMs: () => 30,
      clock,
      log: (l) => logs.push(l),
    });
    try {
      await silent.open();
      await clock.advance(DAEMON_DEFAULTS.watchdog_ms);
      expect(killed).toEqual([]);
      idle = DAEMON_DEFAULTS.broker_keepalive_s * 1000 * DAEMON_DEFAULTS.broker_stale_factor + 1;
      await clock.advance(DAEMON_DEFAULTS.watchdog_ms);
      expect(killed).toHaveLength(1);
      expect(logs.some((l) => /control connection silent/.test(l))).toBe(true);
      await silent.open();
      expect(opened).toBe(2);
    } finally {
      await silent.close();
    }
  });
});
