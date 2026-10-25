import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEnvelope } from "volley-mcp/envelope";
import { buildTopic, registryTopic } from "volley-mcp/topics";
import { RELEASE_TASK } from "../src/autopilot/release-train";
import { ControlClient } from "../src/control";
import type { DaemonOptions } from "../src/daemon";
import { SpawnError } from "../src/spawn-error";
import type { JournalEvent } from "../src/types";
import { AUTOPILOT_ON, NS } from "./helpers/daemon-env";
import { asApiRuns } from "./helpers/fake-exec";
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
const START = "a".repeat(40);

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
  /** While true, a release-branch cut fails (WORKTREE_FAILED). */
  failCut: { on: boolean };
  /** Publish on `channel` as agent `id`. */
  as: (
    id: string,
    channel: string,
    type: string,
    payload: unknown,
    retain?: boolean,
  ) => Promise<unknown>;
}

async function start(
  config?: string,
  playbook = PLAYBOOK,
  daemon: Partial<DaemonOptions> = {},
): Promise<Stages> {
  s = await makeSupervisedEnv({
    daemon: { ...AUTOPILOT_ON, ...daemon },
    ...(config !== undefined ? { config } : {}),
  });
  mkdirSync(join(s.repo, ".volley"), { recursive: true });
  writeFileSync(join(s.repo, ".volley", "release.yaml"), playbook);
  const pubAs = (id: string, channel: string, type: string, payload: unknown, retain = true) =>
    s.agent.publish(
      channel === "_system/registry" ? registryTopic(id) : buildTopic(NS, id, channel),
      JSON.stringify({
        ...buildEnvelope({ agentId: id, parentId: "volleyd", channel, type, payload }),
        ...(channel === "_system/registry" ? { namespace: NS } : {}),
      }),
      { qos: 1, retain },
    );
  // A release-branch cut records its base, as the real host's does (the stage's start).
  const failCut = { on: false };
  const prepare = s.host.prepareWorktree.bind(s.host);
  s.host.prepareWorktree = async (spec) => {
    if (failCut.on && spec.releaseBase === true)
      throw new SpawnError("WORKTREE_FAILED", "git worktree add failed: fatal: disk full", {
        path: spec.path,
        branch: spec.branch,
      });
    return {
      ...(await prepare(spec)),
      ...(spec.releaseBase === true
        ? { base: { ref: "origin/release/w1", sha: START, fresh: true } }
        : {}),
    };
  };
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
  return { launched, finish, failCut, as: pubAs };
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
        base_sha: START,
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
      expect(go?.data).toMatchObject({
        stage: "deploy-staging",
        options: ["go", "skip", "hold"],
        stages: [{ name: "bump", evidence }],
      });

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
  it(
    "a stage agent's question is answered by steering it; stop task fails the stage",
    { timeout: 30_000 },
    async () => {
      const st = await start();
      await settleTasks();
      const id = "w1-release-bump-1";
      await s.event(registered(id));
      await s.settled();
      const ask = (seq: number) =>
        st.as(
          id,
          "progress",
          "awaiting_input",
          {
            notification_type: "permission_prompt",
            text: "May I push the bump?",
            source: "harness-hook",
            seq,
            hook_event: "Notification",
          },
          false,
        );
      const questions = () =>
        ofType("decision_opened").filter((e) => e.data.kind === "agent_question");
      // The first question: autopilot answers it (question_max 1), and the answer reaches the agent.
      await ask(10);
      await s.event((e) => e.type === "decision_opened" && e.data.kind === "agent_question");
      expect(questions()[0]?.data).toMatchObject({ agent_id: id, class: "agent_question" });
      const answered = await s.event(
        (e) => e.type === "steering_sent" && e.data.reason === "answer",
      );
      expect(answered).toMatchObject({ task: RELEASE_TASK, data: { agent_id: id } });
      await s.settled();

      // The second is the owner's: stop task stops the agent and fails the stage.
      await ask(11);
      await s.event((e) => e.type === "decision_opened" && e.data.kind === "agent_question", 2);
      await s.settled();
      const q = questions()[1];
      expect(
        s.daemon.record("w1")?.decisions[String(q?.data.decision_id)]?.resolved,
      ).toBeUndefined();
      ctl = await ControlClient.connect(s.env.broker.url, NS);
      const r = await ctl.request("resolve", {
        decision_id: q?.data.decision_id,
        answer: "stop task",
        by: "owner",
      });
      expect(r.error).toBeUndefined();
      await s.event((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked");
      expect(ofType("release_stage_failed")[0]?.data).toMatchObject({
        stage: "bump",
        agent_id: id,
      });
      expect(String(ofType("release_stage_failed")[0]?.data.reason)).toContain("owner stopped");
      await s.event((e) => e.type === "agent_retired" && e.data.agent_id === id);
      expect(ofType("agent_retired").find((e) => e.data.agent_id === id)?.data.status).toBe(
        "stopped",
      );
      expect(ofType("task_cancelled")).toEqual([]);
    },
  );

  it(
    "a stage spawn that fails asks one wave-level spawn_failed: retry now spawns at once, stop task fails the stage",
    { timeout: 30_000 },
    async () => {
      // Every failure stops the retries: the decision is the owner's, not autopilot's.
      const st = await start("spawn_retry_max: 1");
      st.failCut.on = true;
      await settleTasks();
      await s.event((e) => e.type === "decision_opened" && e.data.kind === "spawn_failed");
      await s.settled();
      const failed = () => ofType("decision_opened").filter((e) => e.data.kind === "spawn_failed");
      expect(failed()).toHaveLength(1);
      expect(failed()[0]?.task).toBeUndefined();
      // retry now: the spawn is tried at once; it fails again and asks again.
      ctl = await ControlClient.connect(s.env.broker.url, NS);
      const retry = await ctl.request("resolve", {
        decision_id: failed()[0]?.data.decision_id,
        answer: "retry now",
        by: "owner",
      });
      expect(retry.error).toBeUndefined();
      await s.event((e) => e.type === "spawn_failed" && e.task === RELEASE_TASK, 2);
      await s.settled();
      expect(failed()).toHaveLength(2);
      expect(s.daemon.record("w1")?.state?.open_decisions).toHaveLength(1);

      // stop task: the stage fails and the owner is asked what next; no task is cancelled.
      const r = await ctl.request("resolve", {
        decision_id: failed()[1]?.data.decision_id,
        answer: "stop task",
        by: "owner",
      });
      expect(r.error).toBeUndefined();
      await s.event((e) => e.type === "decision_opened" && e.data.kind === "agent_blocked");
      expect(ofType("release_stage_failed")[0]?.data).toMatchObject({ stage: "bump" });
      expect(ofType("task_cancelled")).toEqual([]);
      const d = ofType("decision_opened").find((e) => e.data.kind === "agent_blocked");
      expect(d?.data).toMatchObject({ pipeline: { on: "stage", stage: "bump" } });

      // respawn, the cut fixed: the stage runs again at once, whatever the backoff said.
      st.failCut.on = false;
      const again = await ctl.request("resolve", {
        decision_id: d?.data.decision_id,
        answer: "respawn",
        by: "owner",
      });
      expect(again.error).toBeUndefined();
      await s.event(
        (e) =>
          e.type === "agent_registered" && String(e.data.agent_id).startsWith("w1-release-bump-"),
      );
      expect(ofType("release_stage_entered").map((e) => e.data)).toEqual([
        { stage: "bump", attempt: 1 },
        { stage: "bump", attempt: 2 },
      ]);
    },
  );

  it(
    "the Volley playbook end to end: version, release PR, its CI, one go, the merge, the tag at the merge commit, deploy across a restart",
    { timeout: 60_000 },
    async () => {
      const HEAD = "d".repeat(40);
      const MERGED = "e".repeat(40);
      let skew = 0;
      const own = readFileSync(new URL("../../../.volley/release.yaml", import.meta.url), "utf-8");
      // The daemon's clock runs `skew` ahead of the wall: a CI read again after ci_poll_ms.
      const st = await start(undefined, own, { now: () => skew + Date.now() });
      const ci = { status: "in_progress", conclusion: "" };
      const merge = {
        code: 1,
        stderr: "GraphQL: Base branch was modified. Review and try the merge again.",
      };
      const pr = {
        number: 12,
        headRefOid: HEAD,
        title: "release: v0.13.3 — one go",
        labels: [{ name: "no-changelog" }],
      };
      s.host.fake
        .on(["gh", "repo", "view"], {
          stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }),
        })
        .on(["git", "-C", s.repo, "ls-tree"], {
          stdout: "changes/600.fixed.md\nchanges/README.md\n",
        })
        .on(["gh", "pr", "list"], (argv) => ({
          stdout: JSON.stringify(argv.includes("open") ? [pr] : []),
        }))
        .on(["git", "-C", s.repo, "show"], {
          stdout: "# Changelog\n\n## 0.13.3 — 2026-10-25\n\n- **One go.** (#609)\n- Two.\n",
        })
        .on(["gh", "issue", "view"], {
          stdout: JSON.stringify({ state: "OPEN", labels: [], comments: [] }),
        })
        .on(["gh", "pr", "merge"], () => merge)
        .on(["gh", "pr", "view"], (argv) => {
          const fields = String(argv.at(-1));
          if (fields === "baseRefName,headRefOid,isDraft,state")
            return {
              stdout: JSON.stringify({
                baseRefName: "main",
                headRefOid: HEAD,
                isDraft: false,
                state: "OPEN",
              }),
            };
          if (fields === "mergeCommit,state")
            return { stdout: JSON.stringify({ state: "MERGED", mergeCommit: { oid: MERGED } }) };
          return { stdout: JSON.stringify({ state: "OPEN", headRefOid: HEAD, mergeCommit: null }) };
        })
        .on(["gh", "api"], (argv) => {
          const endpoint = String(argv[2]);
          if (endpoint === "repos/{owner}/{repo}/git/matching-refs/tags/v")
            return {
              stdout: JSON.stringify([
                [{ ref: "refs/tags/v0.13.2", object: { sha: "1".repeat(40), type: "commit" } }],
              ]),
            };
          if (endpoint.endsWith("matching-refs/tags/v0.13.3"))
            return {
              stdout: JSON.stringify([
                [{ ref: "refs/tags/v0.13.3", object: { sha: MERGED, type: "commit" } }],
              ]),
            };
          if (endpoint.includes(`actions/runs?head_sha=${HEAD}`))
            return {
              stdout: asApiRuns(
                JSON.stringify([
                  {
                    databaseId: 9,
                    name: "CI",
                    workflowName: "CI",
                    status: ci.status,
                    conclusion: ci.conclusion,
                    url: "https://x/9",
                    headSha: HEAD,
                  },
                ]),
              ),
            };
          return { stdout: "[]" };
        });
      await settleTasks();
      const started = await s.event("release_started");
      // Read before the match: bun's toMatchObject writes an asymmetric matcher back into the
      // object it matched, and the bump agent reports this date as its `--date`.
      const date = String(started.data.date);
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(started.data).toMatchObject({ version: "0.13.3", default_branch: "main" });

      // bump: its run lines substituted, verified as before.
      await s.event(registered("w1-release-bump-1"));
      await s.settled();
      const bumpMd = readFileSync(
        join(st.launched.get("w1-release-bump-1") as string, ".volley", "stage.md"),
        "utf-8",
      );
      expect(bumpMd).toContain("bun scripts/release-version.ts --set 0.13.3");
      await st.finish("w1-release-bump-1", {
        stage: "bump",
        commands: [
          { argv: ["bun", "scripts/release-version.ts", "--set", "0.13.3"], code: 0, seconds: 1 },
          {
            argv: ["bun", "run", "changelog", "--version", "0.13.3", "--date", date],
            code: 0,
            seconds: 1,
          },
        ],
        artifacts: { files: ["CHANGELOG.md"] },
      });
      await s.event((e) => e.type === "release_stage_verified" && e.data.stage === "bump");

      // release-pr: its done verifies the PR, journaled as release_pr_detected.
      await s.event(registered("w1-release-release-pr-1"));
      await s.settled();
      await st.finish("w1-release-release-pr-1", { stage: "release-pr", commands: [] });
      const detected = await s.event("release_pr_detected");
      expect(detected.data).toMatchObject({
        pr: 12,
        head: HEAD,
        title: "release: v0.13.3 — one go",
      });
      await s.event((e) => e.type === "release_stage_verified" && e.data.stage === "release-pr");

      // Its CI is running: no release_go.
      const ciReads = () =>
        s.host.fake.argvs(["gh", "api"]).filter((a) => String(a[2]).includes(HEAD)).length;
      await s.until(() => ciReads() > 0);
      await s.daemon.tick();
      await s.settled();
      expect(ofType("decision_opened").filter((e) => e.data.kind === "release_go")).toEqual([]);
      // Green (read again after ci_poll_ms): release_go names the version, the PR, the bullets.
      ci.status = "completed";
      ci.conclusion = "success";
      skew += 61_000;
      await s.daemon.tick();
      const opened = await s.event(
        (e) => e.type === "decision_opened" && e.data.kind === "release_go",
      );
      expect(String(opened.data.question)).toContain("release v0.13.3 is ready: PR #12");
      expect(String(opened.data.question)).toContain("- **One go.** (#609)");
      await s.settled();
      expect((await runCli(["status", "w1"], s.env.env)).stdout).toContain(
        "release: v0.13.3 · awaiting release_go (2/4 verified)",
      );

      // go, the merge refused: release_merge_failed, and release_go again with the reason.
      ctl = await ControlClient.connect(s.env.broker.url, NS);
      const r1 = await ctl.request("resolve", {
        decision_id: opened.data.decision_id,
        answer: "go",
        by: "owner",
      });
      expect(r1.error).toBeUndefined();
      const failed = await s.event("release_merge_failed");
      expect(failed.data).toMatchObject({ pr: 12, head: HEAD });
      expect(String(failed.data.reason)).toContain("Base branch was modified");
      const again = await s.event(
        (e) => e.type === "decision_opened" && e.data.kind === "release_go",
        2,
      );
      expect(String(again.data.question)).toContain("The last go did not merge:");

      // go again, the merge goes through: exactly the release squash, deleting the branch.
      merge.code = 0;
      merge.stderr = "";
      const r2 = await ctl.request("resolve", {
        decision_id: again.data.decision_id,
        answer: "go",
        by: "owner",
      });
      expect(r2.error).toBeUndefined();
      const merged = await s.event("release_merged");
      expect(merged.data).toMatchObject({ pr: 12, sha: MERGED });
      expect(s.host.fake.argvs(["gh", "pr", "merge"]).at(-1)).toEqual([
        "gh",
        "pr",
        "merge",
        "12",
        "--squash",
        "--match-head-commit",
        HEAD,
        "--delete-branch",
      ]);
      expect(s.host.fake.argvs(["gh", "pr", "merge"]).every((a) => !a.includes("--admin"))).toBe(
        true,
      );
      // The issues are closed now, not on the release poll.
      const verified = await s.event("issues_verified");
      expect(verified.data).toMatchObject({ release_pr: 12 });

      // tag: a ship stage, detached at the merge commit, the tag checked there.
      await s.event(registered("w1-release-tag-1"));
      await s.settled();
      const cut = s.host.worktrees.find((w) => w.base === MERGED);
      expect(cut).toMatchObject({ detach: true });
      const tagMd = readFileSync(
        join(st.launched.get("w1-release-tag-1") as string, ".volley", "stage.md"),
        "utf-8",
      );
      expect(tagMd).toContain("git push origin v0.13.3");
      expect(tagMd).toContain("Push nothing but the tag");
      await st.finish("w1-release-tag-1", {
        stage: "tag",
        commands: [
          { argv: ["git", "tag", "-a", "v0.13.3", "-m", "v0.13.3"], code: 0, seconds: 1 },
          { argv: ["git", "push", "origin", "v0.13.3"], code: 0, seconds: 1 },
        ],
        artifacts: { tag: "v0.13.3" },
      });
      await s.event((e) => e.type === "release_stage_verified" && e.data.stage === "tag");
      await s.event(registered("w1-release-deploy-1"));
      await s.settled();
      expect((await runCli(["status", "w1"], s.env.env)).stdout).toContain(
        "release: v0.13.3 · deploy running (3/4 verified)",
      );

      // deploy restarts volleyd under its own agent: the agent's done lands while it is down.
      await s.daemon.stop();
      await st.finish("w1-release-deploy-1", {
        stage: "deploy",
        commands: [{ argv: ["volley", "deploy", "v0.13.3"], code: 0, seconds: 30 }],
        artifacts: {},
        deployed: "v0.13.3",
      });
      s.daemon = await s.restart();
      const done = await s.event("release_done");
      expect(done.data).toMatchObject({ by: "owner", version: "0.13.3", merged_sha: MERGED });
      await s.settled();
      expect(s.daemon.record("w1")?.state?.status).toBe("complete");
      const order = s
        .journal()
        .map((e) => e.type)
        .filter((t) =>
          ["release_started", "release_pr_detected", "release_merged", "release_done"].includes(t),
        );
      expect(order).toEqual([
        "release_started",
        "release_pr_detected",
        "release_merged",
        "release_done",
      ]);
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
    },
  );
});
