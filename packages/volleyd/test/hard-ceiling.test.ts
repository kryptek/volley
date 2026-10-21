import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ControlClient } from "../src/control";
import type { Daemon } from "../src/daemon";
import { readJournalFile } from "../src/journal";
import { type DaemonEnv, NS, makeDaemonEnv } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

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
});
