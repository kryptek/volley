import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { RELEASE_TASK } from "../src/autopilot/release-train";
import { ControlClient } from "../src/control";
import type { JournalEvent } from "../src/types";
import { AUTOPILOT_ON, NS } from "./helpers/daemon-env";
import { runCli } from "./helpers/run-cli";
import { schemaErrors } from "./helpers/schema";
import { type SupervisedEnv, makeSupervisedEnv } from "./helpers/supervised-env";

// The release train's stages end to end (SPEC §4.6.19): a settled wave with a playbook spawns one
// `release` agent per stage, serially; the simulated agent publishes its stage result and done;
// volleyd verifies on the fake exec, writes the evidence, waits on stage_go before an owner-gated
// stage, and asks release_go with every stage's evidence.

const PLAYBOOK = `version: 1
stages:
  - name: bump
    brief: Bump the version.
    run: [[git, commit, --allow-empty, -m, "release: bump"]]
    verify: { commits_on_release: true, files: [CHANGELOG.md] }
  - { name: deploy-staging, brief: Deploy to staging., gate: owner }
  - { name: smoke, brief: Run the smoke. }
`;
const TIP = "c".repeat(40);

let s: SupervisedEnv;
let ctl: ControlClient | undefined;
afterEach(async () => {
  await ctl?.close();
  ctl = undefined;
  await s?.cleanup();
});

/** The release agents the fake host launched, by id, and their worktrees. */
interface Stages {
  launched: Map<string, string>;
  /** Publish the stage result (retained) and `done` as agent `id`. */
  finish: (id: string, result: Record<string, unknown> | null) => Promise<void>;
}

async function start(): Promise<Stages> {
  s = await makeSupervisedEnv({ daemon: AUTOPILOT_ON });
  mkdirSync(join(s.repo, ".volley"), { recursive: true });
  writeFileSync(join(s.repo, ".volley", "release.yaml"), PLAYBOOK);
  const pubAs = (id: string, channel: string, type: string, payload: unknown, retain = true) =>
    s.agent.publish(
      channel === "_system/registry" ? registryTopic(id) : buildTopic(NS, id, channel),
      JSON.stringify({
        ...buildEnvelope({ agentId: id, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain },
    );
  const launched = new Map<string, string>();
  const prev = s.host.onLaunch;
  s.host.onLaunch = (spec, ws) => {
    if (!spec.cwd.includes(`${RELEASE_TASK}-release-`)) return prev?.(spec, ws);
    const id = JSON.parse(readFileSync(join(spec.cwd, ".volley", "agent.json"), "utf-8"))
      .agent_id as string;
    launched.set(id, spec.cwd);
    // Its worktree's HEAD is the release tip it pushed; origin's tip moved to it.
    s.host.fake
      .on(["git", "-C", spec.cwd, "rev-parse", "HEAD"], { stdout: `${TIP}\n` })
      .on(
        [
          "git",
          "-C",
          spec.cwd,
          "rev-parse",
          "--verify",
          "--quiet",
          "refs/remotes/origin/release/w1",
        ],
        {
          stdout: `${TIP}\n`,
        },
      );
    void (async () => {
      await pubAs(id, "status", "spawning", {});
      await pubAs(id, "_system/registry", "registered", {
        capabilities: [],
        cwd: spec.cwd,
        started_at: new Date().toISOString(),
        model: "claude-opus-5-5",
        model_source: "harness-hook",
      });
      await pubAs(id, "status", "working", { source: "harness-hook" });
      await pubAs(
        id,
        "progress",
        "heartbeat",
        { source: "harness-hook", seq: 1, hook_event: "SessionStart" },
        false,
      );
    })();
  };
  const finish = async (id: string, result: Record<string, unknown> | null) => {
    if (result !== null) await pubAs(id, "result", "stage", result);
    await pubAs(id, "status", "done", { summary: "ok" });
  };
  return { launched, finish };
}

const registered = (id: string) => (e: JournalEvent) =>
  e.type === "agent_registered" && e.data.agent_id === id;
const ofType = (type: string) => s.journal().filter((e) => e.type === type);

async function settleTasks(): Promise<void> {
  await s.daemon.recordEvent("w1", { type: "stage_entered", task: "T1", data: { stage: "done" } });
  await s.daemon.tick();
}

describe("release stages (SPEC §4.6.19)", () => {
  it(
    "runs each stage's agent serially, verifies it, writes evidence, waits on stage_go, then asks release_go",
    { timeout: 30_000 },
    async () => {
      const st = await start();
      await settleTasks();
      await s.event(registered("w1-release-bump-1"));
      await s.settled();
      const spawned = ofType("agent_spawned").find((e) => e.task === RELEASE_TASK);
      expect(spawned?.data).toMatchObject({
        agent_id: "w1-release-bump-1",
        role: "release",
        stage: "bump",
        attempt: 1,
        branch: "w1/release-bump-1",
      });
      expect(ofType("release_stage_entered")[0]?.data).toMatchObject({ stage: "bump", attempt: 1 });
      // Cut from the release branch's tip (a fresh fetch), not a pipeline start ref.
      const cut = s.host.worktrees.find((w) => w.branch === "w1/release-bump-1");
      expect(cut).toMatchObject({ base: "release/w1", releaseBase: true });
      const wt = st.launched.get("w1-release-bump-1") as string;
      const stageMd = readFileSync(join(wt, ".volley", "stage.md"), "utf-8");
      expect(stageMd).toContain("git commit --allow-empty -m 'release: bump'");
      expect(stageMd).toContain("`CHANGELOG.md` exists on `release/w1`");
      const brief = readFileSync(join(wt, ".volley", "brief.md"), "utf-8");
      expect(brief).toMatch(/# Release stage `bump` of wave w1/);
      expect(brief).toContain("## Volley protocol (mandatory)");
      expect(existsSync(join(wt, "ISSUE.md"))).toBe(false);

      await st.finish("w1-release-bump-1", {
        stage: "bump",
        commands: [
          { argv: ["git", "commit", "--allow-empty", "-m", "release: bump"], code: 0, seconds: 1 },
        ],
        notes: "bumped",
        artifacts: { files: ["CHANGELOG.md"] },
      });
      await s.event((e) => e.type === "release_stage_verified" && e.data.stage === "bump");
      const verified = ofType("release_stage_verified")[0];
      const evidence = join(s.env.home, "waves", "w1", "release", "bump.md");
      expect(verified?.data).toMatchObject({ stage: "bump", head: TIP, evidence });
      expect(readFileSync(evidence, "utf-8")).toContain("exit 0");
      const json = JSON.parse(
        readFileSync(join(s.env.home, "waves", "w1", "release", "bump.json"), "utf-8"),
      );
      expect(json.facts.map((f: { fact: string }) => f.fact)).toEqual([
        "commands",
        "commits_on_release",
        "file CHANGELOG.md",
      ]);
      // Verification is read-only: the fence allowed every argv (fake-exec checks it).
      expect(s.host.fake.argvs(["git", "-C", wt, "show"])).toEqual([
        ["git", "-C", wt, "show", "--quiet", "refs/remotes/origin/release/w1:CHANGELOG.md"],
      ]);

      // The owner-gated stage waits on stage_go.
      await s.event((e) => e.type === "decision_opened" && e.data.kind === "stage_go");
      await s.settled();
      const status = await runCli(["status", "w1"], s.env.env);
      expect(status.stdout).toContain("release: deploy-staging awaiting go (1/3 verified)");
      expect(ofType("agent_spawned").filter((e) => e.task === RELEASE_TASK)).toHaveLength(1);
      const go = ofType("decision_opened").find((e) => e.data.kind === "stage_go");
      expect(go?.data).toMatchObject({ stage: "deploy-staging", options: ["go", "skip", "hold"] });

      ctl = await ControlClient.connect(s.env.broker.url, NS);
      const r = await ctl.request("resolve", {
        decision_id: go?.data.decision_id,
        answer: "go",
        by: "owner",
      });
      expect(r.error).toBeUndefined();
      await s.event(registered("w1-release-deploy-staging-1"));
      await s.settled();
      await st.finish("w1-release-deploy-staging-1", { stage: "deploy-staging", commands: [] });
      await s.event(registered("w1-release-smoke-1"));
      await s.settled();
      await st.finish("w1-release-smoke-1", { stage: "smoke", commands: [] });

      await s.event((e) => e.type === "decision_opened" && e.data.kind === "release_go");
      const releaseGo = ofType("decision_opened").find((e) => e.data.kind === "release_go");
      const home = join(s.env.home, "waves", "w1", "release");
      expect(releaseGo?.data.stages).toEqual([
        { name: "bump", evidence: join(home, "bump.md") },
        { name: "deploy-staging", evidence: join(home, "deploy-staging.md") },
        { name: "smoke", evidence: join(home, "smoke.md") },
      ]);
      // Every event the train journaled is a valid wave event (`_release` is its task).
      for (const e of s.journal())
        expect(
          schemaErrors("wave-event.schema.json", {
            schema_version: "0.1",
            agent_id: "volleyd",
            parent_id: null,
            wall_time: e.at,
            channel: "_waves/events",
            type: e.type,
            payload: { wave: "w1", ...e },
          }),
        ).toEqual([]);
      const identity = JSON.parse(readFileSync(join(wt, ".volley", "agent.json"), "utf-8"));
      expect(schemaErrors("agent-identity.schema.json", identity)).toEqual([]);
      // Every stage agent was retired once verified.
      await s.event((e) => e.type === "agent_retired" && e.data.agent_id === "w1-release-smoke-1");
      expect(
        ofType("agent_retired")
          .map((e) => e.data.agent_id)
          .filter((id) => String(id).includes("-release-")),
      ).toEqual(["w1-release-bump-1", "w1-release-deploy-staging-1", "w1-release-smoke-1"]);
    },
  );

  it(
    "a done without a stage result is steered once, then the stage fails with an agent_blocked decision",
    { timeout: 30_000 },
    async () => {
      const st = await start();
      await settleTasks();
      await s.event(registered("w1-release-bump-1"));
      await s.settled();
      await st.finish("w1-release-bump-1", null);
      await s.event((e) => e.type === "steering_sent" && e.data.reason === "stage");
      expect(ofType("steering_sent").at(-1)?.task).toBe(RELEASE_TASK);
      // A second done, still without a result: failed, and the owner is asked.
      await s.agent.publish(
        buildTopic(NS, "w1-release-bump-1", "status"),
        JSON.stringify(
          buildEnvelope({
            agentId: "w1-release-bump-1",
            parentId: "volleyd",
            channel: "status",
            type: "done",
            payload: { summary: "again" },
          }),
        ),
        { qos: 1, retain: true },
      );
      await s.event((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked");
      expect(ofType("release_stage_failed")[0]?.data).toMatchObject({
        stage: "bump",
        reason: "no stage result",
      });
      const d = ofType("decision_opened").find((e) => e.data.kind === "agent_blocked");
      expect(d?.task).toBeUndefined();
      expect(d?.data).toMatchObject({
        options: ["respawn", "skip", "cancel"],
        pipeline: { on: "stage", stage: "bump" },
      });
      await s.settled();
      expect((await runCli(["status", "w1"], s.env.env)).stdout).toContain(
        "release: bump failed (0/3 verified)",
      );

      // respawn: attempt 2 of the stage.
      ctl = await ControlClient.connect(s.env.broker.url, NS);
      const r = await ctl.request("resolve", {
        decision_id: d?.data.decision_id,
        answer: "respawn",
        by: "owner",
      });
      expect(r.error).toBeUndefined();
      await s.event(registered("w1-release-bump-2"));
      expect(ofType("release_stage_entered").map((e) => e.data)).toEqual([
        { stage: "bump", attempt: 1 },
        { stage: "bump", attempt: 2 },
      ]);
    },
  );
});
