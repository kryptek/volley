import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { parseEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { contextOf, fixture, makeWorkdir, publishEnvelope, runHook, tick } from "../helpers/hooks";

/**
 * The hooks as an agent login against real mosquitto 2.1 with Volley's shared Dynamic Security
 * roles. Opt-in: needs VOLLEY_INTEGRATION=1 and VOLLEY_AUTH_BROKER_URL pointing at a PRIVATE
 * broker bootstrapped by volley-cli's test/integration/dynsec-fixture.ts (each password is
 * "<username>-test-pw"; the agent holds the static `agent` role).
 */
const URL = process.env.VOLLEY_AUTH_BROKER_URL;
const RUN = process.env.VOLLEY_INTEGRATION === "1" && URL !== undefined;
// Only read inside the suite, which RUN gates on URL being set: there is no default broker.
const BROKER_URL = URL as string;

const AGENT = "w1-t1-implementer-1";
const OTHER = "w1-t2-implementer-1";
/** A steering sender the shared agent role lets AGENT ack: a fixed identity's mailbox. */
const PARENT = "desk";
/** A coordinator session's random-suffixed id: no static role rule can name its mailbox. */
const COORDINATOR = "coordinator-ab12";
const NS = `hooksacl-${randomBytes(3).toString("hex")}`;
const pw = (user: string) => `${user}-test-pw`;

async function connectAs(username: string): Promise<VolleyBroker> {
  const b = new VolleyBroker();
  await b.connect({
    url: BROKER_URL,
    agentId: `hooksacl-${username}`,
    username,
    password: pw(username),
  });
  return b;
}

describe.skipIf(!RUN)("volley-hooks against mosquitto 2.1 Dynamic Security roles", () => {
  let observer: VolleyBroker;
  let coordinator: VolleyBroker;
  let stop: () => Promise<void>;
  const seen: { topic: string; payload: string }[] = [];

  const agentDir = (password: string | null) =>
    makeWorkdir({
      agent_id: AGENT,
      namespace: NS,
      parent_id: PARENT,
      broker_url: BROKER_URL,
      ...(password !== null ? { broker: { username: AGENT, password } } : {}),
    });
  const sessionStart = (dir: string) =>
    runHook("session-start", fixture("session-start-startup.json", dir), { cwd: dir });
  const postToolUse = (dir: string) =>
    runHook("post-tool-use", fixture("post-tool-use.json", dir), { cwd: dir });

  const envelopes = (topic: string) =>
    seen.filter((m) => m.topic === topic).flatMap((m) => parseEnvelope(m.payload) ?? []);

  async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > deadline) return false;
      await tick(25);
    }
    return true;
  }

  async function steer(from: string): Promise<string> {
    const id = randomUUID();
    // The coordinator identity may write any mailbox; the envelope names the sender.
    await publishEnvelope(coordinator, buildTopic(NS, AGENT, "mailbox"), {
      agentId: from,
      parentId: null,
      channel: "mailbox",
      type: "steering",
      payload: { text: `steer from ${from} ${id}` },
      correlationId: id,
    });
    return id;
  }

  beforeAll(async () => {
    observer = await connectAs("volleyd");
    coordinator = await connectAs("coordinator");
    stop = await observer.subscribeStream("volley/#", (m) => seen.push(m));
  });

  afterAll(async () => {
    if (!observer) return;
    await stop();
    for (const topic of [registryTopic(AGENT), buildTopic(NS, AGENT, "status")]) {
      await observer.publish(topic, "", { qos: 1, retain: true });
    }
    await coordinator.disconnect();
    await observer.disconnect();
  });

  it("wrong credentials: exit 1, AUTH_FAILED + username on stderr, hooks-error.json", async () => {
    const dir = agentDir("wrong");
    const run = await sessionStart(dir);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`AUTH_FAILED for ${AGENT}`);
    const err = JSON.parse(readFileSync(join(dir, ".volley", "hooks-error.json"), "utf-8"));
    expect(err).toMatchObject({ code: "AUTH_FAILED", username: AGENT });

    // Fixed credentials: the next run connects and clears the error file.
    const agentJson = JSON.parse(readFileSync(join(dir, ".volley", "agent.json"), "utf-8"));
    agentJson.broker.password = pw(AGENT);
    writeFileSync(join(dir, ".volley", "agent.json"), JSON.stringify(agentJson));
    expect((await sessionStart(dir)).exitCode).toBe(0);
    expect(existsSync(join(dir, ".volley", "hooks-error.json"))).toBe(false);
  });

  it("anonymous: exit 1, reported as anonymous", async () => {
    const run = await sessionStart(agentDir(null));
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("AUTH_FAILED for anonymous");
  });

  it("right credentials: registers (harness-hook), heartbeats, drains a steer and acks its sender", async () => {
    const dir = agentDir(pw(AGENT));
    const start = await sessionStart(dir);
    expect(start.exitCode).toBe(0);
    expect(start.stderr).toBe("");
    expect(
      await until(() =>
        envelopes(registryTopic(AGENT)).some(
          (e) => (e.payload as { model_source?: string }).model_source === "harness-hook",
        ),
      ),
    ).toBe(true);
    expect(
      await until(() =>
        envelopes(buildTopic(NS, AGENT, "progress")).some(
          (e) =>
            e.type === "heartbeat" &&
            (e.payload as { hook_event?: string }).hook_event === "SessionStart",
        ),
      ),
    ).toBe(true);

    const id = await steer(PARENT);
    await tick(200);
    const post = await postToolUse(dir);
    expect(post.exitCode).toBe(0);
    expect(contextOf(post.stdout)).toContain(`steer from ${PARENT}`);
    expect(
      await until(() =>
        envelopes(buildTopic(NS, PARENT, "mailbox")).some(
          (e) => e.type === "ack" && e.correlation_id === id,
        ),
      ),
    ).toBe(true);
  });

  it.each([OTHER, COORDINATOR])(
    "an ack to %s is dropped: the agent role writes only the fixed identities' mailboxes",
    async (sender) => {
      // The static role lets an agent write volleyd's and the Desk's mailboxes and no other, so
      // the hooks' ack to another agent or to a random-suffixed coordinator is dropped by the
      // broker (the steer is still delivered and injected).
      const dir = agentDir(pw(AGENT));
      expect((await postToolUse(dir)).exitCode).toBe(0);
      const id = await steer(sender);
      await tick(200);
      const post = await postToolUse(dir);
      expect(post.exitCode).toBe(0);
      expect(contextOf(post.stdout)).toContain(`steer from ${sender}`);
      expect(
        await until(
          () =>
            envelopes(buildTopic(NS, sender, "mailbox")).some(
              (e) => e.type === "ack" && e.correlation_id === id,
            ),
          1000,
        ),
      ).toBe(false);
    },
  );
});
