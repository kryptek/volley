import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import {
  DynsecSession,
  applyRoleDrift,
  brokerTransport,
  classify,
  cmd,
  deleteClients,
  ensureClients,
  ensureRoles,
  listAllClients,
  sysVersion,
} from "../../src/auth/dynsec";
import { ROLE_ACLS, VOLLEY_ROLES, roleName } from "../../src/auth/roles";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";

let fake: FakeDynsec;
let admin: VolleyBroker;
let s: DynsecSession;

beforeEach(async () => {
  fake = await startFakeDynsec();
  admin = new VolleyBroker();
  await admin.connect({ url: fake.url, agentId: "admin", ...fake.admin });
  s = await DynsecSession.open(brokerTransport(admin), 2_000);
});
afterEach(async () => {
  await s.close();
  await admin.disconnect();
  await fake.close();
});

describe("DynsecSession", () => {
  it("sends a commands array as ONE control message and matches every answer", async () => {
    await s.run([cmd.createRole("agent")]);
    const r = await s.run([
      cmd.createClient("a1", "pw1", ["agent"]),
      cmd.getClient("nobody"),
      cmd.createClient("a1", "pw2", ["agent"]),
    ]);
    expect(fake.controlMessages).toHaveLength(2);
    expect(fake.controlMessages[1]).toHaveLength(3);
    expect(r.map((x) => x.command)).toEqual(["createClient", "getClient", "createClient"]);
    expect(r.map(classify)).toEqual(["ok", "missing", "exists"]);
  });

  it("reads the retained $SYS/broker/version", async () => {
    expect(await sysVersion(admin)).toBe("mosquitto version 2.1.2");
  });

  it("ignores answers to another admin connection's commands", async () => {
    const other = new VolleyBroker();
    await other.connect({ url: fake.url, agentId: "admin2", ...fake.admin });
    const s2 = await DynsecSession.open(brokerTransport(other), 2_000);
    const [a, b] = await Promise.all([s.run([cmd.getClient("x")]), s2.run([cmd.getClient("y")])]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    await s2.close();
    await other.disconnect();
  });

  it("a message that cannot be sent fails only its own commands, not another run's", async () => {
    const base = brokerTransport(admin);
    let refuse = false;
    const flaky = await DynsecSession.open(
      {
        publish: (t, p) => (refuse ? Promise.reject(new Error("offline")) : base.publish(t, p)),
        subscribe: base.subscribe,
      },
      2_000,
    );
    const release = fake.stall();
    const first = flaky.run([cmd.getClient("x")]);
    await new Promise((r) => setTimeout(r, 50));
    refuse = true;
    await expect(flaky.run([cmd.getClient("y")])).rejects.toThrow(/not sent: offline/);
    release();
    expect(await first).toHaveLength(1);
    await flaky.close();
  });

  it("an answer that never comes times out", async () => {
    const release = fake.stall();
    const quick = await DynsecSession.open(brokerTransport(admin), 100);
    await expect(quick.run([cmd.getClient("x")])).rejects.toThrow(/no answer to getClient/);
    release();
    await quick.close();
  });
});

describe("ensureRoles", () => {
  it("creates the eight volley-* roles inline in one message; a rerun edits nothing", async () => {
    const first = await ensureRoles(s);
    expect(first.created).toEqual([...VOLLEY_ROLES]);
    expect(fake.controlMessages).toHaveLength(1);
    expect([...fake.roles().keys()].sort()).toEqual(
      ["admin", ...VOLLEY_ROLES.map(roleName)].sort(),
    );
    const edits = fake.roleEdits();
    const again = await ensureRoles(s);
    expect(again.created).toEqual([]);
    expect(again.existing).toEqual([...VOLLEY_ROLES]);
    expect(again.drifted).toEqual([]);
    expect(fake.roleEdits()).toBe(edits);
  });

  it("never touches mosquitto's own `admin` role", async () => {
    const before = fake.roles().get("admin");
    await ensureRoles(s);
    expect(fake.roles().get("admin")).toEqual(before);
  });

  it("reports an edited role as drift instead of editing it", async () => {
    await ensureRoles(s);
    await s.run([
      cmd.addRoleACL(roleName("agent"), {
        acltype: "publishClientSend",
        topic: "volley/+/+/mailbox",
        allow: true,
      }),
    ]);
    const edits = fake.roleEdits();
    const r = await ensureRoles(s);
    expect(fake.roleEdits()).toBe(edits);
    expect(r.drifted).toEqual([
      {
        role: "agent",
        missing: [],
        extra: [
          { acltype: "publishClientSend", topic: "volley/+/+/mailbox", allow: true, priority: 0 },
        ],
      },
    ]);
    await applyRoleDrift(s, r.drifted);
    expect((await ensureRoles(s)).drifted).toEqual([]);
    expect(fake.roles().get(roleName("agent"))).toHaveLength(ROLE_ACLS.agent.length);
  });
});

describe("ensureClients", () => {
  beforeEach(async () => {
    await ensureRoles(s);
  });

  it("creates, then keeps an existing client's password on a rerun", async () => {
    const w = [{ username: "desk", password: "first", roles: ["account", "desk"] as const }];
    expect(await ensureClients(s, w)).toEqual(["created"]);
    expect(await ensureClients(s, [{ ...w[0], password: "second" } as never])).toEqual([
      "existing",
    ]);
    expect(fake.clients().get("desk")?.password).toBe("first");
  });

  it("adds a missing role to an existing client", async () => {
    await ensureClients(s, [{ username: "coordinator", password: "p", roles: ["account"] }]);
    await ensureClients(s, [
      { username: "coordinator", password: "p", roles: ["account", "coordinator"] },
    ]);
    expect(fake.clients().get("coordinator")?.roles).toEqual([
      roleName("account"),
      roleName("coordinator"),
    ]);
  });

  it("addClientRole's `Internal error` is success once getClient shows the role held", async () => {
    await ensureClients(s, [{ username: "volleyd", password: "p", roles: [] }]);
    fake.failNext("addClientRole", "Internal error", "volleyd", true);
    await expect(
      ensureClients(s, [{ username: "volleyd", password: "p", roles: ["volleyd"] }]),
    ).resolves.toEqual(["existing"]);
    expect(fake.clients().get("volleyd")?.roles).toEqual([roleName("volleyd")]);
  });

  it("a role that could not be added fails", async () => {
    await ensureClients(s, [{ username: "volleyd", password: "p", roles: [] }]);
    fake.failNext("addClientRole", "Internal error");
    await expect(
      ensureClients(s, [{ username: "volleyd", password: "p", roles: ["volleyd"] }]),
    ).rejects.toThrow(/could not add role volley-volleyd/);
  });
});

describe("listAllClients / deleteClients", () => {
  it("pages through every client and deletes idempotently", async () => {
    await ensureRoles(s);
    await s.run(Array.from({ length: 7 }, (_, i) => cmd.createClient(`a${i}`, "p", ["agent"])));
    const all = await listAllClients(s, 3);
    expect(all.filter((c) => c.roles.includes(roleName("agent")))).toHaveLength(7);
    await deleteClients(s, ["a0", "a1", "nobody"]);
    expect(fake.clients().has("a0")).toBe(false);
  });
});
