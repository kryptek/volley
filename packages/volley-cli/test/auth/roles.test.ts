import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { DynsecSession, brokerTransport, ensureClients, ensureRoles } from "../../src/auth/dynsec";
import {
  ACCOUNT_ROLE_MAP,
  FIXED_CLIENTS,
  ROLE_ACLS,
  VOLLEY_ROLES,
  isAgentClient,
  roleName,
  rolesDocument,
  tokenIdOf,
} from "../../src/auth/roles";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";

describe("role definitions", () => {
  it("eight roles, every one prefixed volley- (never mosquitto's own `admin`)", () => {
    expect(VOLLEY_ROLES).toHaveLength(8);
    expect(VOLLEY_ROLES.map(roleName)).not.toContain("admin");
    expect(VOLLEY_ROLES.map(roleName).every((r) => r.startsWith("volley-"))).toBe(true);
  });

  it("per-identity grants use %u; no role publishes another agent's own channels by name", () => {
    expect(ROLE_ACLS.agent.some((a) => a.topic === "volley/+/%u/status")).toBe(true);
    expect(ROLE_ACLS.agent.some((a) => a.topic === "volley/_system/registry/%u")).toBe(true);
    expect(ROLE_ACLS.agent.some((a) => a.topic === "volley/+/+/mailbox")).toBe(false);
    expect(ROLE_ACLS.token.map((a) => a.topic)).toEqual([
      "volley-auth/redeem/%u",
      "volley-auth/redeem/%u/reply",
    ]);
  });

  it("the desk role itself grants the Desk's resume probe on its own client id (%c)", () => {
    expect(ROLE_ACLS.desk).toContainEqual({
      acltype: "subscribePattern",
      topic: "volley/_system/desk-probe/%c",
      allow: true,
    });
  });

  it("the coordinator sends on its own account-op topic: the repository ops (#613)", () => {
    expect(ROLE_ACLS.coordinator).toContainEqual({
      acltype: "publishClientSend",
      topic: "volley/_system/auth/ops/%u",
      allow: true,
    });
  });

  it("examples/mosquitto-auth/roles.json is these definitions", async () => {
    const { readFileSync } = await import("node:fs");
    const file = new URL("../../../../examples/mosquitto-auth/roles.json", import.meta.url);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual(rolesDocument());
  });

  it("isAgentClient: exactly volley-agent and nothing else", () => {
    expect(isAgentClient({ roles: ["volley-agent"] })).toBe(true);
    expect(isAgentClient({ roles: ["volley-agent", "volley-desk"] })).toBe(false);
    expect(isAgentClient({ roles: ["admin"] })).toBe(false);
    expect(isAgentClient({ roles: [] })).toBe(false);
  });
});

describe("what each role may do (Dynamic Security semantics, %u substituted)", () => {
  let fake: FakeDynsec;
  let admin: VolleyBroker;
  beforeAll(async () => {
    fake = await startFakeDynsec();
    admin = new VolleyBroker();
    await admin.connect({ url: fake.url, agentId: "admin", ...fake.admin });
    const s = await DynsecSession.open(brokerTransport(admin));
    await ensureRoles(s);
    await ensureClients(s, [
      ...Object.entries(FIXED_CLIENTS).map(([username, roles]) => ({
        username,
        password: "p",
        roles,
      })),
      { username: "w1-t1-implementer-1", password: "p", roles: ["agent"] },
      { username: "w1-t2-implementer-1", password: "p", roles: ["agent"] },
      ...Object.entries(ACCOUNT_ROLE_MAP).map(([role, roles]) => ({
        username: `${role}-test`,
        password: "p",
        roles,
      })),
      { username: "0000abcd", password: "p", roles: ["token"] },
    ]);
    await s.close();
  });
  afterAll(async () => {
    await admin.disconnect();
    await fake.close();
  });
  const X = "w1-t1-implementer-1";
  const Y = "w1-t2-implementer-1";

  it("agent X: its own status / registry entry / leases; acks volleyd and the desk", () => {
    expect(fake.canPublish(X, `volley/ns/${X}/status`)).toBe(true);
    expect(fake.canPublish(X, `volley/ns/${X}/_user/notes`)).toBe(true);
    expect(fake.canPublish(X, `volley/_system/registry/${X}`)).toBe(true);
    expect(fake.canPublish(X, "volley/_system/leases/gpu/requests")).toBe(true);
    expect(fake.canPublish(X, "volley/ns/volleyd/mailbox")).toBe(true);
    expect(fake.canPublish(X, "volley/ns/desk/mailbox")).toBe(true);
    expect(fake.canSubscribe(X, "volley/#")).toBe(true);
  });

  it("agent X: never Y's mailbox, status or registry entry, its own screen, or _waves/_config", () => {
    expect(fake.canPublish(X, `volley/ns/${Y}/mailbox`)).toBe(false);
    expect(fake.canPublish(X, `volley/ns/${Y}/status`)).toBe(false);
    expect(fake.canPublish(X, `volley/_system/registry/${Y}`)).toBe(false);
    expect(fake.canPublish(X, `volley/ns/${X}/screen`)).toBe(false);
    expect(fake.canPublish(X, `volley/ns/${X}/mailbox`)).toBe(false);
    expect(fake.canPublish(X, "volley/_waves/_config")).toBe(false);
    expect(fake.canPublish(X, "volley/ns/coordinator-ab12/mailbox")).toBe(false);
  });

  it("desk steers any agent; coordinator writes any agent's channels; neither writes _waves", () => {
    expect(fake.canPublish("desk", `volley/ns/${X}/mailbox`)).toBe(true);
    expect(fake.canPublish("desk", `volley/ns/${X}/status`)).toBe(false);
    expect(fake.canPublish("coordinator", "volley/ns/coordinator-ab12/status")).toBe(true);
    expect(fake.canPublish("coordinator", "volley/_system/registry/coordinator-ab12")).toBe(true);
    expect(fake.canPublish("coordinator", "volley/_waves/_config")).toBe(false);
    expect(fake.canPublish("desk", "volley/_waves/_config")).toBe(false);
    expect(fake.canPublish("volleyd", "volley/_waves/_config")).toBe(true);
    expect(fake.canPublish("volleyd", "volley-auth/redeem/0000abcd/reply")).toBe(true);
  });

  it("accounts: watch writes no mailbox, steer does; admin ops only on its own topic", () => {
    expect(fake.canPublish("watch-test", `volley/ns/${X}/mailbox`)).toBe(false);
    expect(fake.canPublish("steer-test", `volley/ns/${X}/mailbox`)).toBe(true);
    expect(fake.canPublish("admin-test", "volley/_system/auth/ops/admin-test")).toBe(true);
    expect(fake.canPublish("admin-test", "volley/_system/auth/ops/steer-test")).toBe(false);
    expect(fake.canPublish("peer-test", "volley/_system/machines/peer-test")).toBe(true);
    expect(fake.canPublish("peer-test", "volley/_system/machines/other")).toBe(false);
  });

  it("a Desk login writes its own account-op topic, nobody else's (SPEC §4.6.18 answers)", () => {
    expect(fake.canPublish("steer-test", "volley/_system/auth/ops/steer-test")).toBe(true);
    expect(fake.canPublish("steer-test", "volley/_system/auth/ops/admin-test")).toBe(false);
    expect(fake.canPublish("desk", "volley/_system/auth/ops/desk")).toBe(true);
    expect(fake.canPublish("desk", "volley/_system/auth/ops/steer-test")).toBe(false);
    for (const u of ["watch-test", "peer-test", X]) {
      expect(fake.canPublish(u, `volley/_system/auth/ops/${u}`)).toBe(false);
    }
    // The coordinator writes its own (volleyd answers only the repository ops there), no other.
    expect(fake.canPublish("coordinator", "volley/_system/auth/ops/coordinator")).toBe(true);
    expect(fake.canPublish("coordinator", "volley/_system/auth/ops/admin-test")).toBe(false);
    expect(fake.canPublish("supervisor-test", "volley/_system/auth/ops/supervisor-test")).toBe(
      false,
    );
  });

  it("readiness: no account writes a verdict, its own or another's; the supervisors do (SPEC §4.6.15)", () => {
    expect(fake.canPublish("peer-test", "volley/_system/machines/peer-test")).toBe(true);
    expect(fake.canPublish("peer-test", "volley/_system/machines/peer-test/readiness")).toBe(false);
    expect(fake.canPublish("peer-test", "volley/_system/machines/other/readiness")).toBe(false);
    for (const u of ["admin-test", "steer-test", "watch-test", "desk", "coordinator"]) {
      expect(fake.canPublish(u, `volley/_system/machines/${u}/readiness`)).toBe(false);
    }
    expect(fake.canPublish("supervisor-test", "volley/_system/machines/peer-test/readiness")).toBe(
      true,
    );
    expect(
      fake.canPublish("supervisor-test", "volley/_system/machines/supervisor-test/readiness"),
    ).toBe(true);
    expect(fake.canPublish("volleyd", "volley/_system/machines/peer-test/readiness")).toBe(true);
    // No account grant reaches under a machine record, so no deny is needed (or could work: a
    // supervisor account holds `account` first, and the first matching ACL decides).
    expect(ROLE_ACLS.account.some((a) => a.topic.startsWith("volley/_system/machines/%u/"))).toBe(
      false,
    );
  });

  it("the Desk's resume probe: it subscribes to volley/_system/desk-probe/<its client id>", () => {
    expect(fake.canSubscribe("desk", "volley/_system/desk-probe/desk-ab12", "desk-ab12")).toBe(
      true,
    );
    expect(fake.canSubscribe("steer-test", "volley/_system/desk-probe/p1", "p1")).toBe(true);
    expect(fake.canSubscribe("0000abcd", "volley/_system/desk-probe/x", "x")).toBe(false);
    // Nothing publishes there.
    expect(fake.canPublish("desk", "volley/_system/desk-probe/desk-ab12", "desk-ab12")).toBe(false);
  });

  it("the needs-you inbox (SPEC §4.6.18): steer, watch and admin read it; only the supervisors write it", () => {
    for (const u of ["steer-test", "watch-test", "admin-test", "desk"]) {
      expect(fake.canSubscribe(u, "volley/_inbox/+")).toBe(true);
      expect(fake.canPublish(u, "volley/_inbox/d-w1-d-abc")).toBe(false);
    }
    expect(fake.canPublish("coordinator", "volley/_inbox/d-w1-d-abc")).toBe(false);
    expect(fake.canPublish(X, "volley/_inbox/d-w1-d-abc")).toBe(false);
    expect(fake.canPublish("supervisor-test", "volley/_inbox/d-w1-d-abc")).toBe(true);
    expect(fake.canPublish("volleyd", "volley/_inbox/d-w1-d-abc")).toBe(true);
    // A Desk login's answer (inbox_answer) goes on its own account-op topic, where the broker
    // names the sender; the mailbox still carries the owner's (and its bound session's) answers.
    expect(fake.canPublish("steer-test", "volley/_system/auth/ops/steer-test")).toBe(true);
    expect(fake.canPublish("steer-test", "volley/ns/volleyd/mailbox")).toBe(true);
    expect(fake.canPublish("watch-test", "volley/ns/volleyd/mailbox")).toBe(false);
  });

  it("supervisor writes the tree but not the account-op or answer topics", () => {
    expect(fake.canPublish("supervisor-test", "volley/_waves/w1/state")).toBe(true);
    expect(fake.canPublish("supervisor-test", "volley/_system/auth/ops/admin-test")).toBe(false);
    expect(fake.canPublish("supervisor-test", "volley/_system/auth/replies/abcd1234")).toBe(false);
  });

  it("a token login: only its own redeem topic and reply; nothing under volley/", () => {
    expect(fake.canPublish("0000abcd", "volley-auth/redeem/0000abcd")).toBe(true);
    expect(fake.canPublish("0000abcd", "volley-auth/redeem/ffff0000")).toBe(false);
    expect(fake.canPublish("0000abcd", "volley/ns/0000abcd/status")).toBe(false);
    expect(fake.canSubscribe("0000abcd", "volley-auth/redeem/0000abcd/reply")).toBe(true);
    expect(fake.canSubscribe("0000abcd", "volley-auth/redeem/+/reply")).toBe(false);
    expect(fake.canSubscribe("0000abcd", "volley/#")).toBe(false);
  });
});

describe("tokenIdOf", () => {
  it("is the <id> of vly_<kind>_<id>_<secret>, or null for anything else", () => {
    expect(tokenIdOf(`vly_admin_4f2a9c1e_${"0".repeat(32)}`)).toBe("4f2a9c1e");
    expect(tokenIdOf(`vly_signin_0badc0de_${"f".repeat(32)}`)).toBe("0badc0de");
    expect(tokenIdOf("vly_admin_nothex00_x")).toBeNull();
    expect(tokenIdOf("not a token")).toBeNull();
  });
});
