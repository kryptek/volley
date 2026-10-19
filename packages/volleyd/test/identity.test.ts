import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentIdFor, mintCredentials } from "../src/identity";
import { retireAgent } from "../src/retire";
import { spawnAgent } from "../src/spawn";
import { SpawnError } from "../src/spawn-error";
import { memoryCredentials } from "./helpers/fake-dynsec";
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
  it("mints through the credential store; its failure is CREDENTIALS_FAILED", async () => {
    const creds = memoryCredentials();
    expect(await mintCredentials(creds, "w1-t1-implementer-1")).toEqual({
      username: "w1-t1-implementer-1",
      password: "pw-w1-t1-implementer-1",
    });
    creds.failNextMint();
    const err = await mintCredentials(creds, "w1-t2-implementer-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("CREDENTIALS_FAILED");
  });

  it("without a credential store (no admin login) refuses, naming where the login comes from", async () => {
    const err = await mintCredentials(undefined, "w1-t1-implementer-1").catch((e: unknown) => e);
    expect((err as SpawnError).code).toBe("CREDENTIALS_FAILED");
    expect((err as SpawnError).message).toContain("dynsec-admin.json");
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
    expect(env.creds.minted).toEqual(["w1-t1-implementer-1"]);
    // No per-agent grant: acks to volleyd and the Desk are in the shared agent role.
    expect(env.host.fake.argvs(["volley"])).toEqual([]);
  });

  it("the wave owner is the parent", async () => {
    env = await makeSpawnEnv();
    env.deps.owner = "coordinator-ab12";
    await spawnAgent(env.request(), env.deps);
    const id = JSON.parse(readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"));
    expect(id.parent_id).toBe("coordinator-ab12");
  });

  it("a failed mint → spawn refused before any launch", async () => {
    env = await makeSpawnEnv();
    env.creds.failNextMint();
    const err = await spawnAgent(env.request(), env.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("CREDENTIALS_FAILED");
    expect(env.host.launches).toEqual([]);
    expect(env.events.find((e) => e.type === "alarm_raised")?.data).toMatchObject({
      code: "CREDENTIALS_FAILED",
    });
    expect(env.events.some((e) => e.type === "agent_spawned")).toBe(false);
  });

  it("an open broker (minting off) writes no broker block and mints nothing", async () => {
    env = await makeSpawnEnv({ mint: false });
    await spawnAgent(env.request(), env.deps);
    const id = JSON.parse(readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"));
    expect(id.broker).toBeUndefined();
    expect(env.creds.minted).toEqual([]);
  });

  it("retire deletes the agent's login", async () => {
    const creds = memoryCredentials();
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
      {
        credentials: creds,
        publishRetained: async () => {},
        clearRetained: async () => {},
        journal: () => {},
        releaseLock: () => {},
      },
    );
    expect(creds.revoked).toEqual(["w1-t1-implementer-1"]);
  });
});
