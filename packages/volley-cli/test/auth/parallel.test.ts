import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import {
  DynsecBatcher,
  DynsecSession,
  brokerTransport,
  classify,
  cmd,
  ensureRoles,
  listAllClients,
} from "../../src/auth/dynsec";
import { isAgentClient } from "../../src/auth/roles";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";

/** A wave's simultaneous mints through one batching queue (the real 2.1 run: integration/). */
describe("parallel mints through DynsecBatcher", () => {
  let fake: FakeDynsec;
  let admin: VolleyBroker;
  let s: DynsecSession;
  beforeEach(async () => {
    fake = await startFakeDynsec();
    admin = new VolleyBroker();
    await admin.connect({ url: fake.url, agentId: "admin", ...fake.admin });
    s = await DynsecSession.open(brokerTransport(admin));
    await ensureRoles(s);
  });
  afterEach(async () => {
    await s.close();
    await admin.disconnect();
    await fake.close();
  });
  const ids = Array.from({ length: 50 }, (_, i) => `w1-t${i}-implementer-1`);

  it("50 parallel mints → one or two control messages, 50 agent logins, none lost or leaked", async () => {
    const before = fake.controlMessages.length;
    const edits = fake.roleEdits();
    const b = new DynsecBatcher(
      async () => s,
      () => 50,
    );
    const answers = await Promise.all(
      ids.map((id) => b.send(cmd.createClient(id, `pw-${id}`, ["agent"]))),
    );
    expect(answers.map(classify)).toEqual(ids.map(() => "ok"));
    expect(fake.controlMessages.length - before).toBeGreaterThanOrEqual(1);
    expect(fake.controlMessages.length - before).toBeLessThanOrEqual(2);
    const agents = (await listAllClients(s)).filter(isAgentClient).map((c) => c.username);
    expect(agents.sort()).toEqual([...ids].sort());
    expect(fake.roleEdits()).toBe(edits);
    // Each answer is its own command's.
    expect(fake.clients().get(ids[7] as string)?.password).toBe(`pw-${ids[7]}`);
  });

  it("a failed element fails only its own agent", async () => {
    fake.failNext("createClient", "Internal error", ids[3]);
    const b = new DynsecBatcher(
      async () => s,
      () => 50,
    );
    const answers = await Promise.all(
      ids.map((id) => b.send(cmd.createClient(id, "pw", ["agent"]))),
    );
    expect(answers.filter((r) => classify(r) !== "ok").map((r) => r.error)).toEqual([
      "Internal error",
    ]);
    expect(classify(answers[3] as never)).toBe("failed");
    expect(fake.clients().size).toBe(1 + 49 + 0); // the admin + 49 agents
  });

  it("a message that is never answered rejects every command in it", async () => {
    const release = fake.stall();
    const quick = await DynsecSession.open(brokerTransport(admin), 150);
    const b = new DynsecBatcher(
      async () => quick,
      () => 10,
    );
    const all = await Promise.allSettled(ids.slice(0, 3).map((id) => b.send(cmd.getClient(id))));
    expect(all.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"]);
    release();
    await quick.close();
  });
});
