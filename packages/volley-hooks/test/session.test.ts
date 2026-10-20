import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerConnectOptions, VolleyBroker } from "volley-mcp/broker";
import { registryTopic } from "volley-mcp/topics";
import type { HookIdentity } from "../src/lib/identity";
import {
  HookSession,
  connectDrain,
  hooksClientId,
  resolveSessionExpiry,
  workspaceTitleFrom,
} from "../src/lib/session";
import { type TestBroker, startTestBroker } from "./helpers/aedes-broker";
import { connectClient, publishEnvelope, publishRegistry, retainedEnvelope } from "./helpers/hooks";

let broker: TestBroker;
let client: VolleyBroker;
let identity: HookIdentity;

beforeEach(async () => {
  broker = await startTestBroker();
  client = await connectClient(broker.url);
  const dir = mkdtempSync(join(tmpdir(), "volley-hooks-session-"));
  mkdirSync(join(dir, ".volley"));
  identity = {
    mode: "agent",
    agentId: "w1-t1-implementer-1",
    namespace: "ns",
    parentId: null,
    brokerUrl: broker.url,
    projectDir: dir,
    stateDir: join(dir, ".volley"),
  };
});

afterEach(async () => {
  await client.disconnect();
  await broker.close();
});

const setConfig = (sessionExpiry: number) =>
  publishEnvelope(
    client,
    "volley/_waves/_config",
    {
      agentId: "volleyd",
      parentId: null,
      channel: "_waves/_config",
      type: "config",
      payload: { version: 1, mailbox: { session_expiry_s: sessionExpiry } },
    },
    { qos: 1, retain: true },
  );

describe("session expiry", () => {
  it("reads mailbox.session_expiry_s from the retained _config topic and caches it for 60 s", async () => {
    await setConfig(120);
    expect(await resolveSessionExpiry(identity, {})).toBe(120);
    await setConfig(999);
    expect(await resolveSessionExpiry(identity, {})).toBe(120);
    expect(await resolveSessionExpiry(identity, {}, { now: () => Date.now() + 61_000 })).toBe(999);
  });

  it("falls back to VOLLEY_SESSION_EXPIRY_S, then 7 days", async () => {
    expect(await resolveSessionExpiry(identity, { VOLLEY_SESSION_EXPIRY_S: "300" })).toBe(300);
    expect(await resolveSessionExpiry(identity, { VOLLEY_SESSION_EXPIRY_S: "nope" })).toBe(604800);
    expect(await resolveSessionExpiry(identity, {})).toBe(604800);
  });

  it("the drain session connects persistent, with the hooks clientId and that expiry", async () => {
    await setConfig(120);
    const calls: BrokerConnectOptions[] = [];
    const fake = {
      connect: async (opts: BrokerConnectOptions) => {
        calls.push(opts);
      },
    } as unknown as VolleyBroker;
    await connectDrain(identity, { VOLLEY_HOOKS_MQTT_VERSION: "5" }, { createBroker: () => fake });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: broker.url,
      agentId: "w1-t1-implementer-1",
      clientId: hooksClientId("w1-t1-implementer-1"),
      cleanSession: false,
      sessionExpirySeconds: 120,
      protocolVersion: 5,
    });
    expect(hooksClientId("w1-t1-implementer-1")).toBe("volley-w1-t1-implementer-1-hooks");
  });

  it("defaults to MQTT 5 and honours VOLLEY_HOOKS_MQTT_VERSION=4", async () => {
    const calls: BrokerConnectOptions[] = [];
    const fake = {
      connect: async (opts: BrokerConnectOptions) => {
        calls.push(opts);
      },
    } as unknown as VolleyBroker;
    await connectDrain(identity, {}, { createBroker: () => fake });
    await connectDrain(identity, { VOLLEY_HOOKS_MQTT_VERSION: "4" }, { createBroker: () => fake });
    expect(calls.map((c) => c.protocolVersion)).toEqual([5, 4]);
  });
});

describe("republishRegistry", () => {
  it("keeps the entry's title and links alongside the harness model", async () => {
    const links = { repo: "owner/name", issue: 169 };
    await publishRegistry(client, identity.agentId, identity.namespace, {
      capabilities: ["implements-issue"],
      cwd: identity.projectDir,
      started_at: "2026-10-18T10:00:00.000Z",
      title: "#169 C14 desk purpose — implement",
      links,
    });
    const hooks = await connectClient(broker.url, "volley-hooks-test");
    try {
      await new HookSession(identity, hooks, "SessionStart").republishRegistry("claude-opus-5-5");
    } finally {
      await hooks.disconnect();
    }
    const reg = await retainedEnvelope(client, registryTopic(identity.agentId));
    expect(reg.payload).toMatchObject({
      title: "#169 C14 desk purpose — implement",
      links,
      model: "claude-opus-5-5",
      model_source: "harness-hook",
      capabilities: ["implements-issue"],
    });
  });
});

describe("workspaceTitleFrom (cmux list-workspaces --json)", () => {
  it("reads the real cmux shape: matches `ref`, takes `title`, nothing else", () => {
    const json = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "cmux-list-workspaces.json"), "utf-8"),
    );
    expect(workspaceTitleFrom(json, { ref: "workspace:1515" })).toBe("Release triage");
    expect(workspaceTitleFrom(json, { ref: "workspace:1514" })).toBe("Another workspace");
  });

  const ws = [
    { ref: "workspace:1", id: "aaaa-1", index: 0, title: "other", selected: false },
    { ref: "workspace:2", id: "bbbb-2", index: 1, title: "  #169 desk purpose  ", selected: true },
  ];

  it("picks the workspace by ref, or by id, from an array or a { workspaces } object", () => {
    expect(workspaceTitleFrom(ws, { ref: "workspace:2" })).toBe("#169 desk purpose");
    expect(workspaceTitleFrom({ workspaces: ws }, { id: "aaaa-1" })).toBe("other");
    expect(workspaceTitleFrom(ws, { ref: "workspace:9", id: "bbbb-2" })).toBe("#169 desk purpose");
  });

  it("cuts a long title to 120 characters", () => {
    const long = [{ ref: "workspace:1", id: "x", title: "t".repeat(200) }];
    expect(workspaceTitleFrom(long, { ref: "workspace:1" })).toBe("t".repeat(120));
  });

  it("anything unusable is no title", () => {
    expect(workspaceTitleFrom(ws, { ref: "workspace:9" })).toBeUndefined();
    expect(workspaceTitleFrom(ws, {})).toBeUndefined();
    expect(workspaceTitleFrom(null, { ref: "workspace:1" })).toBeUndefined();
    expect(workspaceTitleFrom({ workspaces: "no" }, { ref: "workspace:1" })).toBeUndefined();
    expect(
      workspaceTitleFrom([{ ref: "workspace:1", title: "   " }], { ref: "workspace:1" }),
    ).toBeUndefined();
    expect(
      workspaceTitleFrom([{ ref: "workspace:1", title: 7 }], { ref: "workspace:1" }),
    ).toBeUndefined();
    expect(workspaceTitleFrom([null, "x"], { ref: "workspace:1" })).toBeUndefined();
  });
});
