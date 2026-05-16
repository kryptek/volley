import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";

async function publisherFor(tb: TestBroker, agentId: string): Promise<VolleyBroker> {
  const b = new VolleyBroker();
  await b.connect({
    url: tb.url,
    agentId,
    willTopic: `volley/_meta/cli/${agentId}/will`,
    willPayload: "",
  });
  return b;
}

async function publishRegistry(
  broker: VolleyBroker,
  ns: string,
  agentId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const env = {
    ...buildEnvelope({
      agentId,
      parentId: (fields.parent_id as string | undefined) ?? null,
      channel: "_system/registry",
      type: "registered",
      payload: fields,
    }),
    namespace: ns,
  };
  await broker.publish(`volley/_system/registry/${agentId}`, JSON.stringify(env), {
    qos: 1,
    retain: true,
  });
}

async function publishStatus(
  broker: VolleyBroker,
  ns: string,
  agentId: string,
  type: string,
): Promise<void> {
  const env = buildEnvelope({ agentId, parentId: null, channel: "status", type, payload: {} });
  await broker.publish(`volley/${ns}/${agentId}/status`, JSON.stringify(env), {
    qos: 1,
    retain: true,
  });
}

describe("volley list", () => {
  let tb: TestBroker;
  let pub: VolleyBroker;
  beforeEach(async () => {
    tb = await startTestBroker();
    pub = await publisherFor(tb, "list-test-pub");
  });
  afterEach(async () => {
    await pub.disconnect();
    await tb.close();
  });

  it("with --json, returns an array of agents in the namespace, default-filtered to non-reaped", async () => {
    await publishRegistry(pub, "test", "a-1111", { cwd: "/tmp/a", model: "m" });
    await publishStatus(pub, "test", "a-1111", "working");
    await publishRegistry(pub, "test", "a-2222", { cwd: "/tmp/b", model: "m" });
    await publishStatus(pub, "test", "a-2222", "reaped");
    // Out-of-namespace; should not appear with default --namespace=test
    await publishRegistry(pub, "other", "a-3333", { cwd: "/tmp/c", model: "m" });
    await publishStatus(pub, "other", "a-3333", "working");

    const r = await runCli({
      argv: ["list", "--broker-url", tb.url, "--namespace", "test", "--json", "--timeout", "2"],
    });
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Array.isArray(out)).toBe(true);
    const ids = (out as Array<{ agent_id: string }>).map((a) => a.agent_id).sort();
    expect(ids).toEqual(["a-1111"]);
    expect(out[0]).toMatchObject({ namespace: "test", status: "working" });
  });

  it("with --include-reaped, also returns reaped agents", async () => {
    await publishRegistry(pub, "test", "a-1111", { cwd: "/tmp/a", model: "m" });
    await publishStatus(pub, "test", "a-1111", "working");
    await publishRegistry(pub, "test", "a-2222", { cwd: "/tmp/b", model: "m" });
    await publishStatus(pub, "test", "a-2222", "reaped");

    const r = await runCli({
      argv: [
        "list",
        "--broker-url",
        tb.url,
        "--namespace",
        "test",
        "--include-reaped",
        "--json",
        "--timeout",
        "2",
      ],
    });
    expect(r.exitCode).toBe(0);
    const ids = (JSON.parse(r.stdout) as Array<{ agent_id: string }>).map((a) => a.agent_id).sort();
    expect(ids).toEqual(["a-1111", "a-2222"]);
  });

  it("with --all-namespaces, returns agents across namespaces", async () => {
    await publishRegistry(pub, "test", "a-1111", { cwd: "/tmp/a", model: "m" });
    await publishStatus(pub, "test", "a-1111", "working");
    await publishRegistry(pub, "other", "a-3333", { cwd: "/tmp/c", model: "m" });
    await publishStatus(pub, "other", "a-3333", "working");

    const r = await runCli({
      argv: ["list", "--broker-url", tb.url, "--all-namespaces", "--json", "--timeout", "2"],
    });
    expect(r.exitCode).toBe(0);
    const nss = (JSON.parse(r.stdout) as Array<{ namespace: string }>)
      .map((a) => a.namespace)
      .sort();
    expect(nss).toEqual(["other", "test"]);
  });

  it("without --json, emits a human table with one header row + one row per agent", async () => {
    await publishRegistry(pub, "test", "a-1111", { cwd: "/tmp/a", model: "m" });
    await publishStatus(pub, "test", "a-1111", "working");

    const r = await runCli({
      argv: ["list", "--broker-url", tb.url, "--namespace", "test", "--timeout", "2"],
    });
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toContain("AGENT_ID");
    expect(lines[0]).toContain("STATUS");
    expect(lines.find((l) => l.includes("a-1111"))).toBeDefined();
  });

  it("emits an empty array and exit 0 when no agents are registered", async () => {
    const r = await runCli({
      argv: ["list", "--broker-url", tb.url, "--json", "--timeout", "1"],
    });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });

  it('falls back to status:"unknown" + last_seen=registry.wall_time when retained status is absent', async () => {
    // Publish the registry entry but NEVER publish a status — this is the unusual case
    // where joinStatus's queryRetained returns null.
    await publishRegistry(pub, "test", "ghost-aaaa", { cwd: "/tmp/ghost", model: "m" });

    const r = await runCli({
      argv: ["list", "--broker-url", tb.url, "--namespace", "test", "--json", "--timeout", "2"],
    });
    expect(r.exitCode).toBe(0);
    const rows = JSON.parse(r.stdout) as Array<{
      agent_id: string;
      status: string;
      last_seen: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent_id).toBe("ghost-aaaa");
    expect(rows[0]?.status).toBe("unknown");
    // last_seen should ISO-parse (proves it's not undefined or null).
    expect(rows[0]?.last_seen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
