import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { slugOf } from "../src/autopilot/remediation";
import { agentIdFor, mintCredentials, releaseAgentId } from "../src/identity";
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

  it("forms every role's id for a flake fixer's longest task id (44 characters), each unique", () => {
    const fixer = slugOf("test/clock.test.ts > sleep > resolves on abort");
    expect(fixer).toHaveLength(44);
    const roles = ["implementer", "spec_reviewer", "quality_reviewer", "rebase"];
    for (const wave of ["soak", "2026-10-21-autopilot-fixes"]) {
      const ids = roles.map((role) => agentIdFor(wave, fixer, role, 1));
      for (const [i, id] of ids.entries()) {
        expect(id).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
        expect(id.endsWith(`-${roles[i]}-1`)).toBe(true);
      }
      expect(new Set(ids).size).toBe(roles.length);
      expect(agentIdFor(wave, fixer, "quality_reviewer", 2)).not.toBe(ids[2]);
    }
    // Two long task ids sharing a long prefix keep distinct ids.
    const other = `${fixer.slice(0, -1)}x`;
    expect(agentIdFor("soak", other, "quality_reviewer", 1)).not.toBe(
      agentIdFor("soak", fixer, "quality_reviewer", 1),
    );
    // An id that fits is unchanged.
    expect(agentIdFor("soak", fixer, "implementer", 1)).toBe(`soak-${fixer}-implementer-1`);
  });

  it("an id that cannot be formed is a permanent refusal (never retried)", () => {
    const err = (() => {
      try {
        return agentIdFor("w1", "T1", "implementer!", 1);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).permanent).toBe(true);
  });

  it("a role tail that leaves no room for any of the task keeps only its hash", () => {
    const id = agentIdFor("w1", "fix-test-clock-test-ts-sleep", "r".repeat(50), 1);
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/^w1-[0-9a-f]{6}-r{50}-1$/);
  });
});

describe("releaseAgentId", () => {
  it("is <wave>-release-<stage>-<attempt> (SPEC §4.6.19), shortened like any id", () => {
    expect(releaseAgentId("w1", "bump", 1)).toBe("w1-release-bump-1");
    const long = releaseAgentId("a".repeat(60), "deploy-staging", 2);
    expect(long).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
    expect(long.endsWith("-release-deploy-staging-2")).toBe(true);
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

  it("a flake fixer with a 44-character task id spawns its spec and quality reviewers", async () => {
    env = await makeSpawnEnv();
    const fixer = slugOf("test/clock.test.ts > sleep > resolves on abort");
    const base = env.request().wave;
    const t1 = base.tasks.T1 as (typeof base.tasks)[string];
    const wave = {
      ...base,
      tasks: { ...base.tasks, [fixer]: { ...t1, id: fixer } },
      task_order: [...base.task_order, fixer],
    };
    for (const role of ["spec_reviewer", "quality_reviewer"] as const) {
      const out = await spawnAgent(env.request({ wave, task: fixer, role }), env.deps);
      expect(out).toMatchObject({
        kind: "launched",
        agentId: agentIdFor(wave.wave, fixer, role, 1),
      });
    }
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
