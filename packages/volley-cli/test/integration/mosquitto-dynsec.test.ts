import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import {
  DynsecSession,
  brokerTransport,
  cmd,
  ensureClients,
  ensureRoles,
  listAllClients,
  sysVersion,
} from "../../src/auth/dynsec";
import {
  ACCOUNT_ROLE_MAP,
  DYNSEC_ADMIN_USER,
  FIXED_CLIENTS,
  type VolleyRole,
  isAgentClient,
} from "../../src/auth/roles";
import { checkBrokerVersion } from "../../src/auth/version";

/**
 * Volley's shared Dynamic Security roles against REAL mosquitto 2.1 (opt-in). Needs
 * VOLLEY_INTEGRATION=1 and a PRIVATE broker (never the one your agents use) started from
 * examples/mosquitto-auth/mosquitto-dynsec.conf with a state file from
 * `mosquitto_ctrl dynsec init <file> dynsec-admin <password>`:
 *
 *   VOLLEY_DYNSEC_BROKER_URL=mqtt://127.0.0.1:<port>   the TCP listener
 *   VOLLEY_DYNSEC_WS_URL=ws://127.0.0.1:<port>          the WebSocket listener (optional)
 *   VOLLEY_DYNSEC_ADMIN_PASSWORD=<password>
 *
 * CI's test-integration-dynsec job runs it against the eclipse-mosquitto:2.1 container. The
 * suite bootstraps the roles itself (what `volley auth init` does) and the identities below, each
 * with the password "<username>-test-pw".
 */
const URL_TCP = process.env.VOLLEY_DYNSEC_BROKER_URL;
const URL_WS = process.env.VOLLEY_DYNSEC_WS_URL;
const ADMIN_PW = process.env.VOLLEY_DYNSEC_ADMIN_PASSWORD;
const RUN =
  process.env.VOLLEY_INTEGRATION === "1" && URL_TCP !== undefined && ADMIN_PW !== undefined;
const NS = `dynsecit-${randomBytes(3).toString("hex")}`;
const X = `${NS}-t1-implementer-1`;
const Y = `${NS}-t2-implementer-1`;
const TOKEN = randomBytes(4).toString("hex");

const IDENTITIES: { username: string; roles: readonly VolleyRole[] }[] = [
  ...Object.entries(FIXED_CLIENTS).map(([username, roles]) => ({ username, roles })),
  { username: X, roles: ["agent"] },
  { username: Y, roles: ["agent"] },
  ...Object.entries(ACCOUNT_ROLE_MAP).map(([role, roles]) => ({ username: `${role}-test`, roles })),
  { username: TOKEN, roles: ["token"] },
];

async function connectAs(username: string, url = URL_TCP as string): Promise<VolleyBroker> {
  const b = new VolleyBroker();
  await b.connect({
    url,
    agentId: `it-${username}`,
    username,
    password: username === DYNSEC_ADMIN_USER ? (ADMIN_PW as string) : `${username}-test-pw`,
  });
  return b;
}

describe.skipIf(!RUN)("Volley roles on mosquitto 2.1 Dynamic Security", () => {
  let admin: VolleyBroker;
  let s: DynsecSession;
  let observer: VolleyBroker;
  let stopObserving: () => Promise<void>;
  const seen: string[] = [];
  const clients: VolleyBroker[] = [];

  async function attempt(who: string, topic: string, payload: string): Promise<void> {
    const c = await connectAs(who);
    clients.push(c);
    await c.publish(topic, payload, { qos: 1, retain: false }).catch(() => {});
  }
  async function delivered(payload: string): Promise<boolean> {
    for (let i = 0; i < 20; i++) {
      if (seen.includes(payload)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  }
  const probe = (label: string) => `${label}-${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    admin = await connectAs(DYNSEC_ADMIN_USER);
    s = await DynsecSession.open(brokerTransport(admin));
    await ensureRoles(s);
    await ensureClients(
      s,
      IDENTITIES.map((i) => ({ ...i, password: `${i.username}-test-pw` })),
    );
    observer = await connectAs("volleyd");
    const a = await observer.subscribeStream("volley/#", (m) => seen.push(m.payload));
    const b = await observer.subscribeStream("volley-auth/#", (m) => seen.push(m.payload));
    stopObserving = async () => {
      await a();
      await b();
    };
  });

  afterAll(async () => {
    for (const c of clients) await c.disconnect().catch(() => {});
    await stopObserving?.();
    await observer?.disconnect();
    // Fixed identities and accounts stay (a rerun keeps them); the per-run agents and token go.
    await s?.run([X, Y, TOKEN].map((u) => cmd.deleteClient(u))).catch(() => {});
    await s?.close();
    await admin?.disconnect();
  });

  it("the broker is 2.1 or newer ($SYS/broker/version)", async () => {
    const v = await sysVersion(admin);
    expect(v).not.toBeNull();
    expect(checkBrokerVersion(v as string).ok).toBe(true);
  });

  it("a bootstrap rerun changes nothing and kicks no connected identity", async () => {
    const desk = await connectAs("desk");
    clients.push(desk);
    const again = await ensureRoles(s);
    expect(again.created).toEqual([]);
    expect(again.drifted).toEqual([]);
    expect(
      await ensureClients(
        s,
        IDENTITIES.map((i) => ({ ...i, password: "would-rotate" })),
      ),
    ).toEqual(IDENTITIES.map(() => "existing"));
    await new Promise((r) => setTimeout(r, 100));
    expect(desk.connected).toBe(true);
    expect(observer.connected).toBe(true);
    // The rerun kept the original passwords.
    (await connectAs("coordinator")).disconnect();
  });

  it("%u: agent X publishes its own status and registry entry, never Y's", async () => {
    const own = probe("own-status");
    const reg = probe("own-registry");
    const steer = probe("x-steers-y");
    const forge = probe("x-forges-y-status");
    const forgeReg = probe("x-forges-y-registry");
    const screen = probe("x-own-screen");
    await attempt(X, `volley/${NS}/${X}/status`, own);
    await attempt(X, `volley/_system/registry/${X}`, reg);
    await attempt(X, `volley/${NS}/${Y}/mailbox`, steer);
    await attempt(X, `volley/${NS}/${Y}/status`, forge);
    await attempt(X, `volley/_system/registry/${Y}`, forgeReg);
    await attempt(X, `volley/${NS}/${X}/screen`, screen);
    expect(await delivered(own)).toBe(true);
    expect(await delivered(reg)).toBe(true);
    expect(await delivered(steer)).toBe(false);
    expect(await delivered(forge)).toBe(false);
    expect(await delivered(forgeReg)).toBe(false);
    expect(await delivered(screen)).toBe(false);
  });

  it("an agent acks volleyd's and the desk's mailboxes (SPEC §4.4)", async () => {
    const toVolleyd = probe("ack-volleyd");
    const toDesk = probe("ack-desk");
    await attempt(X, `volley/${NS}/volleyd/mailbox`, toVolleyd);
    await attempt(X, `volley/${NS}/desk/mailbox`, toDesk);
    expect(await delivered(toVolleyd)).toBe(true);
    expect(await delivered(toDesk)).toBe(true);
  });

  it("the desk publishes a mailbox; watch cannot; steer can", async () => {
    const d = probe("desk-steers");
    const w = probe("watch-steers");
    const st = probe("steer-steers");
    await attempt("desk", `volley/${NS}/${X}/mailbox`, d);
    await attempt("watch-test", `volley/${NS}/${X}/mailbox`, w);
    await attempt("steer-test", `volley/${NS}/${X}/mailbox`, st);
    expect(await delivered(d)).toBe(true);
    expect(await delivered(w)).toBe(false);
    expect(await delivered(st)).toBe(true);
  });

  it("supervisor writes the tree but not the account-op or reply topics", async () => {
    const tree = probe("sup-tree");
    const ops = probe("sup-ops");
    const reply = probe("sup-reply");
    await attempt("supervisor-test", `volley/_waves/${NS}/state`, tree);
    await attempt("supervisor-test", "volley/_system/auth/ops/admin-test", ops);
    await attempt("supervisor-test", "volley/_system/auth/replies/abcd1234abcd", reply);
    expect(await delivered(tree)).toBe(true);
    expect(await delivered(ops)).toBe(false);
    expect(await delivered(reply)).toBe(false);
  });

  it("only an admin writes account ops, and only on its own topic", async () => {
    const own = probe("admin-own-ops");
    const other = probe("admin-other-ops");
    await attempt("admin-test", "volley/_system/auth/ops/admin-test", own);
    await attempt("admin-test", "volley/_system/auth/ops/steer-test", other);
    expect(await delivered(own)).toBe(true);
    expect(await delivered(other)).toBe(false);
  });

  it("a token login: its own %u redeem topic and reply, nothing else", async () => {
    const own = probe("token-own");
    const other = probe("token-other");
    const tree = probe("token-tree");
    await attempt(TOKEN, `volley-auth/redeem/${TOKEN}`, own);
    await attempt(TOKEN, "volley-auth/redeem/ffffffff", other);
    await attempt(TOKEN, `volley/${NS}/${TOKEN}/status`, tree);
    expect(await delivered(own)).toBe(true);
    expect(await delivered(other)).toBe(false);
    expect(await delivered(tree)).toBe(false);

    const tok = await connectAs(TOKEN);
    clients.push(tok);
    const got: string[] = [];
    await tok.subscribeStream(`volley-auth/redeem/${TOKEN}/reply`, (m) => got.push(m.payload));
    await tok.subscribeStream("volley/#", (m) => got.push(m.payload)).catch(() => {});
    const answer = probe("answer");
    const leak = probe("leak");
    await observer.publish(`volley-auth/redeem/${TOKEN}/reply`, answer, { qos: 1, retain: false });
    await observer.publish(`volley/${NS}/${X}/progress`, leak, { qos: 1, retain: false });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toContain(answer);
    expect(got).not.toContain(leak);
  });

  it("anonymous is refused on TCP and on WebSocket", async () => {
    await expect(
      new VolleyBroker().connect({ url: URL_TCP as string, agentId: "anon" }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
    if (URL_WS !== undefined) {
      await expect(
        new VolleyBroker().connect({ url: URL_WS, agentId: "anon-ws" }),
      ).rejects.toMatchObject({ code: "AUTH_FAILED" });
      const ws = await connectAs("desk", URL_WS);
      expect(ws.connected).toBe(true);
      await ws.disconnect();
    }
  });

  it("deleteClient drops a connected agent with no LWT", async () => {
    const id = `${NS}-t9-implementer-1`;
    await s.run([cmd.createClient(id, `${id}-test-pw`, ["agent"])]);
    const agent = new VolleyBroker();
    const statusTopic = `volley/${NS}/${id}/status`;
    await agent.connect({
      url: URL_TCP as string,
      agentId: id,
      username: id,
      password: `${id}-test-pw`,
      willTopic: statusTopic,
      willPayload: probe("lwt"),
      willRetain: false,
    });
    const lwt: string[] = [];
    const stop = await observer.subscribeStream(statusTopic, (m) => lwt.push(m.payload));
    await s.run([cmd.deleteClient(id)]);
    await new Promise((r) => setTimeout(r, 300));
    expect(agent.connected).toBe(false);
    expect(lwt).toEqual([]);
    await stop();
  });

  it("50 mints in one control message: 50 agent clients, no role edit, no leak", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `${NS}-p${i}-implementer-1`);
    const answers = await s.run(ids.map((id) => cmd.createClient(id, "pw", ["agent"])));
    expect(answers.every((r) => r.error === undefined)).toBe(true);
    const agents = (await listAllClients(s)).filter((c) => isAgentClient(c));
    expect(ids.filter((id) => !agents.some((a) => a.username === id))).toEqual([]);
    expect((await ensureRoles(s)).drifted).toEqual([]);
    await s.run(ids.map((id) => cmd.deleteClient(id)));
    const after = (await listAllClients(s)).filter((c) => ids.includes(c.username));
    expect(after).toEqual([]);
  });
});
