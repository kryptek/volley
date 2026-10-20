import { afterEach, describe, expect, it } from "vitest";
import { spawnAgent } from "../src/spawn";
import type { SpawnError } from "../src/spawn-error";
import { type SpawnEnv, fakeWatch, makeSpawnEnv } from "./helpers/fake-host";
import { ARTIFACTS_OK, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

const NAME = "w1 T1 implementer";
const ID = "w1-t1-implementer-1";

/** A spawn env whose agent never comes up: its watch holds no hook signals. */
async function silentEnv(): Promise<SpawnEnv> {
  const env = await makeSpawnEnv({
    watch: async (ns, id) => fakeWatch(ns, id, { registry: null, sessionStart: false }),
  });
  env.host.launchOutcome = "unknown";
  return env;
}

const types = (env: SpawnEnv) => env.events.map((e) => e.type);
const eventOf = (env: SpawnEnv, type: string) => env.events.find((e) => e.type === type);
const refusal = (env: SpawnEnv) =>
  spawnAgent(env.request(), env.deps).then(
    () => {
      throw new Error("spawned");
    },
    (e: unknown) => e as SpawnError,
  );

describe("a launch whose outcome is unknown is reconciled before any retry", () => {
  it("the agent registered: it is adopted, with no second launch", async () => {
    const env = await makeSpawnEnv();
    env.host.launchOutcome = "unknown";
    env.host.found = "workspace:7";
    const out = await spawnAgent(env.request(), env.deps);
    expect(out).toMatchObject({ kind: "launched", agentId: ID, workspace: "workspace:7" });
    expect(env.host.launches).toHaveLength(1);
    expect(env.host.finds[0]).toEqual({ name: NAME });
    expect(env.host.closed).toEqual([]);
    expect(env.creds.revoked).toEqual([]);
    const adopted = eventOf(env, "spawn_adopted");
    expect(adopted).toMatchObject({
      task: "T1",
      data: {
        agent_id: ID,
        role: "implementer",
        attempt: 1,
        workspace: "workspace:7",
        after: "launch_unknown",
      },
    });
    expect(typeof adopted?.data.waited_ms).toBe("number");
    expect(types(env).indexOf("spawn_adopted")).toBeLessThan(types(env).indexOf("agent_spawned"));
    expect(eventOf(env, "agent_spawned")?.data).toMatchObject({
      agent_id: ID,
      workspace: "workspace:7",
      adopted: true,
    });
    if (out.kind === "launched") expect((await out.verified).kind).toBe("registered");
  });

  it("an adopted agent whose workspace cannot be found is adopted all the same", async () => {
    const env = await makeSpawnEnv();
    env.host.launchOutcome = "unknown";
    env.host.found = new Error("cmux list-workspaces failed: timed out");
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("launched");
    expect(eventOf(env, "spawn_adopted")?.data.workspace).toBe("unknown");
    expect(eventOf(env, "agent_spawned")?.data).toMatchObject({ workspace: "", adopted: true });
    expect(types(env)).not.toContain("spawn_identity_burned");
  });

  it("a workspace with no agent in it is closed, then the launch fails as before", async () => {
    const env = await silentEnv();
    env.host.found = "workspace:1";
    const err = await refusal(env);
    expect(err.code).toBe("LAUNCH_FAILED");
    expect(env.host.closed).toEqual(["workspace:1"]);
    expect(eventOf(env, "launch_orphan_closed")).toMatchObject({
      task: "T1",
      data: { agent_id: ID, workspace: "workspace:1" },
    });
    expect(types(env)).not.toContain("spawn_identity_burned");
    expect(types(env)).not.toContain("agent_spawned");
    expect(env.creds.revoked).toEqual([ID]);
  });

  it("nothing found and the host answering: the launch fails as before, the lookup re-run at the window's end", async () => {
    const env = await silentEnv();
    const err = await refusal(env);
    expect(err.code).toBe("LAUNCH_FAILED");
    expect(env.host.finds).toHaveLength(2);
    expect(env.host.closed).toEqual([]);
    expect(types(env)).not.toContain("launch_orphan_closed");
    expect(types(env)).not.toContain("spawn_identity_burned");
  });

  it("the host cannot be asked: the identity is burned and its login revoked", async () => {
    const env = await silentEnv();
    env.host.found = new Error("cmux list-workspaces failed: timed out");
    const err = await refusal(env);
    expect(err.code).toBe("LAUNCH_FAILED");
    expect(eventOf(env, "spawn_identity_burned")).toMatchObject({
      task: "T1",
      data: { agent_id: ID, role: "implementer", attempt: 1 },
    });
    expect(String(eventOf(env, "spawn_identity_burned")?.data.why)).toContain("timed out");
    expect(env.creds.revoked).toEqual([ID]);
  });

  it("a workspace that cannot be closed burns the identity too", async () => {
    const env = await silentEnv();
    env.host.found = "workspace:1";
    env.host.close = async () => {
      throw new Error("cmux close-workspace failed");
    };
    await refusal(env);
    expect(types(env)).not.toContain("launch_orphan_closed");
    expect(eventOf(env, "spawn_identity_burned")?.data).toMatchObject({ agent_id: ID });
  });

  it("each attempt titles its workspace apart, so a reconcile never finds an earlier attempt's", async () => {
    const env = await silentEnv();
    // An earlier attempt's workspace is still open under the role's plain title.
    const open = new Map([[NAME, "workspace:9"]]);
    env.host.findWorkspace = async (name) => {
      env.host.finds.push({ name });
      return open.get(name) ?? null;
    };
    await spawnAgent(env.request({ attempt: 2 }), env.deps).catch(() => undefined);
    expect(env.host.launches.map((l) => l.name)).toEqual([`${NAME} 2`]);
    expect(env.host.finds.map((f) => f.name)).toEqual([`${NAME} 2`, `${NAME} 2`]);
    expect(env.host.closed).toEqual([]);
    expect(types(env)).not.toContain("launch_orphan_closed");
  });

  it("a refused launch is not reconciled: no lookup, no new events", async () => {
    const env = await makeSpawnEnv();
    env.host.launchOutcome = "refused";
    const err = await refusal(env);
    expect(err.code).toBe("LAUNCH_FAILED");
    expect(env.host.finds).toEqual([]);
    for (const t of ["spawn_adopted", "launch_orphan_closed", "spawn_identity_burned"]) {
      expect(types(env)).not.toContain(t);
    }
  });
});

describe("an adopted agent under the daemon", () => {
  let s: SupervisedEnv | undefined;
  afterEach(async () => {
    await s?.cleanup();
    s = undefined;
  });

  it("is supervised like any other: one launch, no spawn_failed, retired on done", async () => {
    s = await makeSupervisedEnv({ exec: ARTIFACTS_OK, launchOutcome: "unknown" });
    const env = s;
    const types = () => env.journal().map((e) => e.type);
    expect(env.host.launches).toHaveLength(1);
    expect(types()).not.toContain("spawn_failed");
    expect(types().indexOf("spawn_adopted")).toBeLessThan(types().indexOf("agent_spawned"));
    expect(env.journal().find((e) => e.type === "agent_spawned")?.data).toMatchObject({
      agent_id: ID,
      adopted: true,
    });
    await env.status("done", { summary: "ok" });
    await env.until(() => env.journal().some((e) => e.type === "agent_retired"));
  });
});
