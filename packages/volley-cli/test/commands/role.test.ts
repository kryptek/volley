import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VolleyBroker } from "volley-mcp/broker";
import { buildEnvelope } from "volley-mcp/envelope";
import { type TestBroker, startTestBroker } from "../helpers/aedes-broker";
import { runCli } from "../helpers/run-cli";

const RECORD = {
  broker: {
    machine: "box-a",
    address: { ssh: "owner@box-a.lan", mqtt_port: 1883, ws_port: 9001 },
    lan: true,
  },
  supervisor: { machine: "mac" },
  desk: { machine: "mac", url: "http://192.168.1.20:5199" },
  version: 2,
  updated_at: "2026-10-24T09:00:00.000Z",
  updated_by: "admin-1",
};

describe("volley role status", () => {
  let tb: TestBroker;
  let pub: VolleyBroker;
  const publishRoles = (agentId = "volleyd") =>
    pub.publish(
      "volley/_system/roles",
      JSON.stringify(
        buildEnvelope({
          agentId,
          parentId: null,
          channel: "_system/roles",
          type: "roles",
          payload: RECORD,
        }),
      ),
      { qos: 1, retain: true },
    );
  const run = (...extra: string[]) =>
    runCli({ argv: ["role", "status", "--broker-url", tb.url, "--timeout", "1", ...extra] });

  beforeEach(async () => {
    tb = await startTestBroker();
    pub = new VolleyBroker();
    await pub.connect({ url: tb.url, agentId: "volleyd" });
  });
  afterEach(async () => {
    await pub.disconnect();
    await tb.close();
  });

  it("prints one line per role from the retained record", async () => {
    await publishRoles();
    const r = await run();
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      [
        "broker      on box-a",
        "supervisor  on mac",
        "desk        on mac (http://192.168.1.20:5199)",
        "",
      ].join("\n"),
    );
  });

  it("--json prints the record's payload", async () => {
    await publishRoles();
    const r = await run("--json");
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(RECORD);
  });

  it("no record: exit 1, is volleyd running?", async () => {
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("volley role: no roles record: is volleyd running?\n");
  });

  it("a record not published by volleyd is no record", async () => {
    await publishRoles("someone-else");
    const r = await run();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toBe("volley role: no roles record: is volleyd running?\n");
  });

  it("an unknown verb is a usage error", async () => {
    const r = await runCli({ argv: ["role", "shuffle"] });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("volley role: unknown verb: shuffle");
  });
});
