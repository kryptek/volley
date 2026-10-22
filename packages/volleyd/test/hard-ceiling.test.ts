import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { AGENT, type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

// #322: the hard ceiling counts the agents volleyd runs or is starting, never a task's stage.

const yaml = (wave: string, tasks: string[], config = "") => `wave: ${wave}
repo: example-org/example-repo
release_branch: release/${wave}
model: claude-opus-5-5
pipeline: [implement, merge_ready]
${config !== "" ? `config: { ${config} }\n` : ""}tasks:
${tasks.map((t, i) => `  ${t}: { issue: ${i + 1} }`).join("\n")}
`;

describe("hard ceiling without a spawner (admitted, not started)", () => {
  let t: DaemonEnv;
  let daemon: Daemon;
  let client: ControlClient;
  beforeEach(async () => {
    t = await makeDaemonEnv();
    daemon = await t.start();
    client = await ControlClient.connect(t.broker.url, NS);
  });
  afterEach(async () => {
    await client.close();
    await t.cleanup();
  });

  const admitted = (wave: string) =>
    readJournalFile(join(t.home, "waves", wave, "journal.jsonl"))
      .filter((e) => e.type === "task_admitted")
      .map((e) => e.task);
  const run = async (y: string) =>
    expect((await client.request("run", { wave_yaml: y, owner: "coord-a" })).error).toBeUndefined();
  const configSet = async (patch: Record<string, unknown>) =>
    expect(
      (await client.request("config_set", { patch, by: "tester" }, { text: "t" })).applied,
    ).toBe(true);

  it("a stopped wave's unsettled tasks count nothing: the running wave admits up to the ceiling", async () => {
    await run(yaml("w-stopped", ["S1", "S2", "S3"]));
    expect(admitted("w-stopped")).toEqual(["S1", "S2", "S3"]);
    expect((await client.request("stop", { wave: "w-stopped", by: "coord-a" })).ok).toBe(true);
    await configSet({ hard_ceiling: 2 });

    await run(yaml("w-run", ["R1", "R2", "R3"]));
    await daemon.tick();
    expect(admitted("w-run")).toEqual(["R1", "R2"]);
    expect(daemon.snapshot("w-run")?.tasks.find((x) => x.id === "R3")?.why_waiting).toBe(
      "hard ceiling reached: 2/2 live agents",
    );

    const res = await client.request("admission", {});
    expect(res.ok).toBe(true);
    expect((res.result as { ceiling: unknown }).ceiling).toEqual({
      live: 2,
      max: 2,
      launching: 2,
      by_wave: { "w-run": 2 },
    });
    const cli = await runCli(["admission"], t.env);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("ceiling: 2/2 live agents · 2 launching · by wave: w-run 2");

    const status = await runCli(["status"], t.env);
    expect(status.stdout).toContain("hard ceiling: 2/2");
  });

  it("a task awaiting a decision whose agent is retired counts nothing", async () => {
    await run(yaml("w-a", ["A", "B"], "hard_ceiling: 1"));
    expect(admitted("w-a")).toEqual(["A"]);
    await daemon.recordEvent("w-a", {
      type: "agent_spawned",
      task: "A",
      data: { role: "implementer", agent_id: "w-a-a-implementer-1" },
    });
    await daemon.recordEvent("w-a", {
      type: "stage_entered",
      task: "A",
      data: { stage: "awaiting_decision" },
    });
    expect(daemon.snapshot("w-a")?.tasks.find((x) => x.id === "A")?.stage).toBe(
      "awaiting_decision",
    );
    await daemon.tick();
    expect(admitted("w-a")).toEqual(["A", "B"]);
  });

  const reviewed = (wave: string, tasks: string[], config: string) =>
    yaml(wave, tasks, config).replace(
      "pipeline: [implement, merge_ready]",
      "pipeline: [implement, [spec_review, quality_review], fixup, merge_ready]",
    );

  it("a running wave's task between roles holds its slot: its reviewers come before a new task", async () => {
    await run(reviewed("w-r", ["A", "B"], "hard_ceiling: 1"));
    expect(admitted("w-r")).toEqual(["A"]);
    await daemon.recordEvent("w-r", {
      type: "agent_spawned",
      task: "A",
      data: { role: "implementer", agent_id: "w-r-a-implementer-1" },
    });
    // Implemented and retired; its reviewers are not spawned yet.
    await daemon.recordEvent("w-r", {
      type: "stage_entered",
      task: "A",
      data: { stage: "spec_review" },
    });
    await daemon.tick();
    expect(admitted("w-r")).toEqual(["A"]);
    expect(daemon.snapshot("w-r")?.tasks.find((x) => x.id === "B")?.why_waiting).toBe(
      "hard ceiling reached: 1/1 live agents",
    );
    // Held, not supervised: it reads as launching, never as a running agent.
    const held = await client.request("admission", {});
    expect((held.result as { ceiling: unknown }).ceiling).toMatchObject({
      live: 1,
      launching: 1,
    });
    // Paused, the same task holds nothing.
    expect((await client.request("pause", { wave: "w-r", by: "coord-a" })).ok).toBe(true);
    const res = await client.request("admission", {});
    expect((res.result as { ceiling: { live: number } }).ceiling.live).toBe(0);
  });

  it("a running wave's task in implement whose implementer retired unverified counts nothing", async () => {
    await run(reviewed("w-d", ["A", "B"], "hard_ceiling: 1"));
    expect(admitted("w-d")).toEqual(["A"]);
    await daemon.recordEvent("w-d", {
      type: "agent_spawned",
      task: "A",
      data: { role: "implementer", agent_id: "w-d-a-implementer-1" },
    });
    await daemon.recordEvent("w-d", {
      type: "stage_entered",
      task: "A",
      data: { stage: "implement" },
    });
    await daemon.recordEvent("w-d", {
      type: "agent_retired",
      task: "A",
      data: { role: "implementer", agent_id: "w-d-a-implementer-1", status: "dead" },
    });
    expect(daemon.snapshot("w-d")?.tasks.find((x) => x.id === "A")?.stage).toBe("implement");
    await daemon.tick();
    expect(admitted("w-d")).toEqual(["A", "B"]);
  });

  it("a task whose implementer retired unverified keeps its slot while its respawn is held", async () => {
    await run(reviewed("w-h", ["A", "B"], "hard_ceiling: 1"));
    expect(admitted("w-h")).toEqual(["A"]);
    await daemon.recordEvent("w-h", {
      type: "agent_spawned",
      task: "A",
      data: { role: "implementer", agent_id: "w-h-a-implementer-1" },
    });
    await daemon.recordEvent("w-h", {
      type: "stage_entered",
      task: "A",
      data: { stage: "implement" },
    });
    await daemon.recordEvent("w-h", {
      type: "agent_retired",
      task: "A",
      data: { role: "implementer", agent_id: "w-h-a-implementer-1", status: "dead" },
    });
    // Its respawn is held (a closed machine): the slot stays held for it.
    const heldRespawn = (daemon as unknown as { heldRespawn: Map<string, unknown> }).heldRespawn;
    heldRespawn.set("w-h/A", { role: "implementer", pipeline: {} });
    await daemon.tick();
    expect(admitted("w-h")).toEqual(["A"]);
    heldRespawn.delete("w-h/A");
    await daemon.tick();
    expect(admitted("w-h")).toEqual(["A", "B"]);
  });

  it("a task between roles whose next role is refused for good frees its slot", async () => {
    await run(reviewed("w-q", ["A", "B"], "hard_ceiling: 1"));
    expect(admitted("w-q")).toEqual(["A"]);
    await daemon.recordEvent("w-q", {
      type: "agent_spawned",
      task: "A",
      data: { role: "implementer", agent_id: "w-q-a-implementer-1" },
    });
    await daemon.recordEvent("w-q", {
      type: "stage_entered",
      task: "A",
      data: { stage: "implement" },
    });
    await daemon.tick();
    expect(admitted("w-q")).toEqual(["A"]);
    const refused = (daemon as unknown as { refused: Map<string, { n: number; until: number }> })
      .refused;
    refused.set("w-q/A/implementer", { n: 1, until: Number.POSITIVE_INFINITY });
    await daemon.tick();
    expect(admitted("w-q")).toEqual(["A", "B"]);
  });

  it("an admitted task whose implementer spawn is backed off keeps its slot", async () => {
    await run(yaml("w-b", ["A", "B"], "hard_ceiling: 1"));
    expect(admitted("w-b")).toEqual(["A"]);
    const refused = (daemon as unknown as { refused: Map<string, { n: number; until: number }> })
      .refused;
    refused.set("w-b/A/implementer", { n: 1, until: Date.now() + 60_000 });
    await daemon.tick();
    expect(admitted("w-b")).toEqual(["A"]);
    // Refused for good (it never retries by itself), it frees its slot.
    refused.set("w-b/A/implementer", { n: 1, until: Number.POSITIVE_INFINITY });
    await daemon.tick();
    expect(admitted("w-b")).toEqual(["A", "B"]);
  });
});

describe("hard ceiling with a supervised agent", () => {
  let s: SupervisedEnv;
  beforeEach(async () => {
    s = await makeSupervisedEnv();
  });
  afterEach(async () => {
    await s.cleanup();
  });

  it("counts the supervised agent, and admission names the breakdown", async () => {
    await s.daemon.tick();
    const cli = await runCli(["admission"], s.env.env);
    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain("ceiling: 1/12 live agents · 0 launching · by wave: w1 1");
    const status = await runCli(["status"], s.env.env);
    expect(status.stdout).toContain("hard ceiling: 1/12");
  });

  it("a relaunch spawning while the role's old agent is still supervised counts both", async () => {
    await s.daemon.tick();
    const spawning = (s.daemon as unknown as { spawning: Set<string> }).spawning;
    spawning.add("w1/T1/implementer");
    try {
      const cli = await runCli(["admission"], s.env.env);
      expect(cli.stdout).toContain("ceiling: 2/12 live agents · 1 launching · by wave: w1 2");
    } finally {
      spawning.delete("w1/T1/implementer");
    }
  });

  it("a task awaiting a decision counts its agent while it is live, nothing once it retires", async () => {
    await s.status("blocked", { reason: "stuck" });
    await s.event("decision_opened");
    await s.settled();
    expect(s.daemon.snapshot("w1")?.tasks[0]?.stage).toBe("awaiting_decision");
    const ceiling = async () => {
      const client = await ControlClient.connect(s.env.broker.url, NS);
      try {
        return ((await client.request("admission", {})).result as { ceiling: { live: number } })
          .ceiling.live;
      } finally {
        await client.close();
      }
    };
    expect(await ceiling()).toBe(1);
    await (s.daemon as unknown as { retire: (id: string, status: string) => Promise<void> }).retire(
      AGENT,
      "stopped",
    );
    await s.event((e) => e.type === "agent_retired" && e.data.agent_id === AGENT);
    expect(s.daemon.snapshot("w1")?.tasks[0]?.stage).toBe("awaiting_decision");
    expect(await ceiling()).toBe(0);
  });
});

describe("hard ceiling with a supervised agent and a tight ceiling", () => {
  let s: SupervisedEnv;
  beforeEach(async () => {
    s = await makeSupervisedEnv();
  });
  afterEach(async () => {
    await s.cleanup();
  });

  it("the supervised agent and one new admission fill it; the next task waits", async () => {
    const client = await ControlClient.connect(s.env.broker.url, NS);
    try {
      const set = await client.request(
        "config_set",
        { patch: { hard_ceiling: 2 }, by: "tester" },
        { text: "t" },
      );
      expect(set.applied).toBe(true);
    } finally {
      await client.close();
    }
    const wave = join(s.env.home, "w2.yaml");
    writeFileSync(
      wave,
      `wave: w2\nrepo: ${s.repo}\nrelease_branch: release/w1\nmodel: claude-opus-5-5\npipeline: [implement]\ntasks:\n  R1: { issue: 42 }\n  R2: { issue: 42 }\nconfig: { worktree_root: ${join(s.env.home, "wt2")} }\n`,
    );
    const r = await runCli(["run", wave], s.env.env);
    expect(r.exitCode).toBe(0);
    await s.daemon.tick();
    await s.settled();
    expect(
      s
        .journal("w2")
        .filter((e) => e.type === "task_admitted")
        .map((e) => e.task),
    ).toEqual(["R1"]);
    expect(s.daemon.snapshot("w2")?.tasks.find((x) => x.id === "R2")?.why_waiting).toBe(
      "hard ceiling reached: 2/2 live agents",
    );
    const cli = await runCli(["admission"], s.env.env);
    expect(cli.stdout).toContain("ceiling: 2/2 live agents · 1 launching · by wave: w1 1, w2 1");
  });
});

describe("hard ceiling and pipeline role spawns", () => {
  let t: DaemonEnv;
  let daemon: Daemon;
  let client: ControlClient;
  let started: string[];
  type Spawns = {
    opts: { spawner?: object };
    spawning: Set<string>;
    startSpawn: (wave: string, task: string, role: string) => Promise<unknown>;
    pipelineSpawn: (wave: string, task: string, role: string, req: { files: object }) => void;
  };
  const d = () => daemon as unknown as Spawns;
  beforeEach(async () => {
    t = await makeDaemonEnv();
    daemon = await t.start();
    started = [];
    // Each start is recorded, never launched.
    d().startSpawn = async (wave, task, role) => {
      started.push(`${wave}/${task}/${role}`);
      return new Promise(() => {});
    };
    client = await ControlClient.connect(t.broker.url, NS);
  });
  afterEach(async () => {
    await client.close();
    await t.cleanup();
  });

  const reviewed = (wave: string, tasks: string[], config: string) =>
    yaml(wave, tasks, config).replace(
      "pipeline: [implement, merge_ready]",
      "pipeline: [implement, [spec_review, quality_review], fixup, merge_ready]",
    );
  const run = async (y: string) =>
    expect((await client.request("run", { wave_yaml: y, owner: "coord-a" })).error).toBeUndefined();
  const configSet = async (patch: Record<string, unknown>) =>
    expect(
      (await client.request("config_set", { patch, by: "tester" }, { text: "t" })).applied,
    ).toBe(true);
  /** Implemented and retired, its reviewers not spawned yet. */
  const betweenRoles = async (wave: string, task: string) => {
    await daemon.recordEvent(wave, {
      type: "agent_spawned",
      task,
      data: { role: "implementer", agent_id: `${wave}-${task.toLowerCase()}-implementer-1` },
    });
    await daemon.recordEvent(wave, { type: "stage_entered", task, data: { stage: "spec_review" } });
  };
  // startSpawn is stubbed, so these tests add to `spawning` by hand. That stands for the real
  // launchSpawn, which reaches `spawning.add(key)` with no await on its success paths: the next
  // pipelineSpawn in the same pass already counts it. Keep it that way, or parallel reviewers
  // can overshoot the ceiling.
  const spawnRole = (wave: string, task: string, role: string) => {
    // A spawner only from here on: `run` checks no repo, and nothing spawns on its own before.
    d().opts.spawner = {};
    started = [];
    d().pipelineSpawn(wave, task, role, { files: {} });
    return started;
  };

  it("parallel reviewers at a tight ceiling: the second waits for the first's slot", async () => {
    await run(reviewed("w-p", ["A"], "hard_ceiling: 1"));
    await betweenRoles("w-p", "A");
    expect(spawnRole("w-p", "A", "spec_reviewer")).toEqual(["w-p/A/spec_reviewer"]);
    d().spawning.add("w-p/A/spec_reviewer");
    expect(spawnRole("w-p", "A", "quality_reviewer")).toEqual([]);
    d().spawning.delete("w-p/A/spec_reviewer");
    expect(spawnRole("w-p", "A", "quality_reviewer")).toEqual(["w-p/A/quality_reviewer"]);
  });

  it("more tasks between roles than the ceiling (a lowered ceiling): role spawns still start", async () => {
    await configSet({ hard_ceiling: 4 });
    await run(reviewed("w-l", ["A", "B", "C", "D"], ""));
    for (const id of ["A", "B", "C", "D"]) await betweenRoles("w-l", id);
    await configSet({ hard_ceiling: 2 });
    // No agent runs: the four held slots never hold each other's spawns.
    expect(spawnRole("w-l", "A", "spec_reviewer")).toEqual(["w-l/A/spec_reviewer"]);
    d().spawning.add("w-l/A/spec_reviewer");
    expect(spawnRole("w-l", "B", "spec_reviewer")).toEqual(["w-l/B/spec_reviewer"]);
    d().spawning.add("w-l/B/spec_reviewer");
    // Two agents starting fill the ceiling: the third waits.
    expect(spawnRole("w-l", "C", "spec_reviewer")).toEqual([]);
  });

  it("a resumed wave's tasks between roles over the ceiling: role spawns still start", async () => {
    await configSet({ hard_ceiling: 2 });
    await run(reviewed("w-x", ["A", "B"], ""));
    for (const id of ["A", "B"]) await betweenRoles("w-x", id);
    expect((await client.request("pause", { wave: "w-x", by: "coord-a" })).ok).toBe(true);
    await run(reviewed("w-y", ["C", "D"], ""));
    for (const id of ["C", "D"]) await betweenRoles("w-y", id);
    expect((await client.request("resume", { wave: "w-x", by: "coord-a" })).ok).toBe(true);
    expect(spawnRole("w-x", "A", "spec_reviewer")).toEqual(["w-x/A/spec_reviewer"]);
    expect(spawnRole("w-y", "C", "spec_reviewer")).toEqual(["w-y/C/spec_reviewer"]);
  });

  it("a release stage's spawn is not held by another wave's tasks between roles", async () => {
    await configSet({ hard_ceiling: 2 });
    await run(reviewed("w-h", ["A", "B"], ""));
    for (const id of ["A", "B"]) await betweenRoles("w-h", id);
    await run(yaml("w-rel", ["R"], ""));
    const rec = (
      daemon as unknown as { waves: Map<string, { record: { state: { status: string } } }> }
    ).waves.get("w-rel")?.record;
    if (rec === undefined) throw new Error("w-rel not loaded");
    rec.state.status = "releasing";
    d().opts.spawner = {};
    started = [];
    const stage = { name: "tag", brief: "Tag it.", run: [], gate: "auto" as const };
    (daemon as unknown as { releaseSpawn: (w: string, s: object) => void }).releaseSpawn(
      "w-rel",
      stage,
    );
    expect(started).toEqual(["w-rel/_release/release"]);
  });
});
