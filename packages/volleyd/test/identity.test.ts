import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentIdFor, grantAckTo, mintCredentials } from "../src/identity";
import { retireAgent } from "../src/retire";
import { spawnAgent } from "../src/spawn";
import { SpawnError } from "../src/spawn-error";
import { fakeExec } from "./helpers/fake-exec";
import { type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";
import { schemaErrors } from "./helpers/schema";

describe("agentIdFor", () => {
  it("is <wave>-<task>-<role>-<attempt>, lowercased", () => {
    expect(agentIdFor("w1", "T1", "implementer", 1)).toBe("w1-t1-implementer-1");
    expect(agentIdFor("2026-10-18-x", "T4", "spec_reviewer", 2)).toBe(
      "2026-10-18-x-t4-spec_reviewer-2",
    );
  });

  it("stays a valid, unique id when the parts are long", () => {
    const wave = "a".repeat(60);
    const a = agentIdFor(wave, "T1", "quality_reviewer", 1);
    const b = agentIdFor(`${"a".repeat(59)}b`, "T1", "quality_reviewer", 1);
    expect(a).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
    expect(a.endsWith("-t1-quality_reviewer-1")).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("mintCredentials", () => {
  it("runs the fenced volley auth add-agent <id> --ack-to … --json and parses the broker block", async () => {
    const fake = fakeExec().on(["volley", "auth", "add-agent"], {
      stdout: '{"username":"w1-t1-implementer-1","password":"s3cret"}\n',
    });
    const c = await mintCredentials(fake.exec, "w1-t1-implementer-1", ["volleyd", "volleyd"]);
    expect(c).toEqual({ username: "w1-t1-implementer-1", password: "s3cret" });
    expect(fake.calls[0]?.argv).toEqual([
      "volley",
      "auth",
      "add-agent",
      "w1-t1-implementer-1",
      "--ack-to",
      "volleyd",
      "--json",
    ]);
  });
});

describe("grantAckTo", () => {
  it("runs the fenced volley auth grant <id> --ack-to … (the password is kept)", async () => {
    const fake = fakeExec();
    await grantAckTo(fake.exec, "w1-t1-implementer-1", ["coordinator-cd34"]);
    expect(fake.calls[0]?.argv).toEqual([
      "volley",
      "auth",
      "grant",
      "w1-t1-implementer-1",
      "--ack-to",
      "coordinator-cd34",
    ]);
  });

  it("a failing grant throws with its stderr", async () => {
    const fake = fakeExec().on(["volley", "auth", "grant"], { code: 1, stderr: "not in passwd" });
    await expect(grantAckTo(fake.exec, "w1", ["desk"])).rejects.toThrow("not in passwd");
  });
});

describe("spawn identity", () => {
  let env: SpawnEnv | undefined;
  afterEach(async () => {
    // Not every case builds an env ("retire calls …" does not): shuffled order runs it first.
    await env?.cleanup();
    env = undefined;
  });

  it("agent.json has id/namespace/parent/role/broker_url and the minted broker block, mode 0600", async () => {
    env = await makeSpawnEnv();
    await spawnAgent(env.request(), env.deps);
    const path = join(env.worktree, ".volley", "agent.json");
    const id = JSON.parse(readFileSync(path, "utf-8"));
    expect(id).toEqual({
      agent_id: "w1-t1-implementer-1",
      namespace: "volleyd-test",
      parent_id: "volleyd",
      wave: "w1",
      task: "T1",
      role: "implementer",
      broker_url: "mqtt://127.0.0.1:1",
      claude_account: "primary",
      broker: { username: "w1-t1-implementer-1", password: "pw-w1-t1-implementer-1" },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(schemaErrors("agent-identity.schema.json", id)).toEqual([]);
    expect(env.host.fake.argvs(["volley", "auth", "add-agent"])).toEqual([
      [
        "volley",
        "auth",
        "add-agent",
        "w1-t1-implementer-1",
        "--ack-to",
        "volleyd",
        "--ack-to",
        "desk",
        "--json",
      ],
    ]);
  });

  it("the wave owner is the parent and may receive acks", async () => {
    env = await makeSpawnEnv();
    env.deps.owner = "coordinator-ab12";
    await spawnAgent(env.request(), env.deps);
    const id = JSON.parse(readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"));
    expect(id.parent_id).toBe("coordinator-ab12");
    expect(env.host.fake.argvs(["volley", "auth", "add-agent"])[0]).toEqual([
      "volley",
      "auth",
      "add-agent",
      "w1-t1-implementer-1",
      "--ack-to",
      "coordinator-ab12",
      "--ack-to",
      "volleyd",
      // The Desk steers too: its acks (hooks' "Delivered by hook") go to the desk's mailbox.
      "--ack-to",
      "desk",
      "--json",
    ]);
  });

  it("add-agent failing → spawn refused before any launch", async () => {
    env = await makeSpawnEnv();
    env.host.fake.on(["volley", "auth", "add-agent"], { code: 1, stderr: "mosquitto_passwd: no" });
    const err = await spawnAgent(env.request(), env.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("CREDENTIALS_FAILED");
    expect(env.host.launches).toEqual([]);
    expect(env.events.find((e) => e.type === "alarm_raised")?.data).toMatchObject({
      code: "CREDENTIALS_FAILED",
    });
    expect(env.events.some((e) => e.type === "agent_spawned")).toBe(false);
  });

  it("an open broker (minting off) writes no broker block and runs no volley auth", async () => {
    env = await makeSpawnEnv({ mint: false });
    await spawnAgent(env.request(), env.deps);
    const id = JSON.parse(readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"));
    expect(id.broker).toBeUndefined();
    expect(env.host.fake.argvs(["volley"])).toEqual([]);
  });

  it("retire calls volley auth rm-agent", async () => {
    const fake = fakeExec();
    await retireAgent(
      {
        wave: "w1",
        task: "T1",
        role: "implementer",
        agentId: "w1-t1-implementer-1",
        namespace: "ns",
        status: "done",
        waveAgents: new Set(["w1-t1-implementer-1"]),
        minted: true,
      },
      { exec: fake.exec, clearRetained: async () => {}, journal: () => {}, releaseLock: () => {} },
    );
    expect(fake.argvs(["volley"])).toEqual([["volley", "auth", "rm-agent", "w1-t1-implementer-1"]]);
  });
});
