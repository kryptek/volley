import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type PlaybookStage,
  parsePlaybook,
  releaseGoInput,
  trainState,
} from "../src/autopilot/playbook";
import {
  RELEASE_TASK,
  type ReleaseAction,
  type ReleaseEvent,
  ReleaseTrain,
  STAGE_STEER_REASON,
  globPrefix,
  globRegex,
  nextRelease,
  parseStageResult,
  releaseView,
  verifyStage,
} from "../src/autopilot/release-train";
import type { DecisionRecord } from "../src/decisions";
import type { ExecFn } from "../src/exec";
import type { JournalEvent } from "../src/types";
import { schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

// The release train's stages (SPEC §4.6.19), pure: the interpreter over a scripted playbook with
// an owner-gated stage, and verification on a fake exec.

const WAVE = "w1";
const PLAYBOOK = parsePlaybook(`version: 1
stages:
  - name: bump
    brief: Bump the version.
    run: [[bun, run, changelog, --version, 0.5.0]]
    verify: { commits_on_release: true }
  - { name: deploy-staging, brief: Deploy to staging., gate: owner }
  - { name: smoke, brief: Run the smoke. }
`);

/** A scripted train: the journal, the decisions, and the interpreter applied to both. */
function train() {
  const events: JournalEvent[] = [];
  const decisions: Record<string, DecisionRecord> = {};
  const at = "2026-10-20T00:00:00.000Z";
  const push = (type: string, data: Record<string, unknown>, task?: string) =>
    events.push({
      seq: events.length + 1,
      at,
      type,
      data,
      ...(task !== undefined ? { task } : {}),
    } as JournalEvent);
  push("release_started", { done: ["A"], cancelled: [], playbook: { stages: PLAYBOOK.stages } });
  let status = "releasing";
  const view = () => {
    const v = releaseView({
      wave: WAVE,
      release_branch: "release/w1",
      status,
      train: trainState(events) ?? undefined,
      events,
      decisions,
    });
    if (v === null) throw new Error("no train");
    return v;
  };
  /** Apply what the daemon would: journal events and decisions land; the rest is returned. */
  const apply = (acts: ReleaseAction[]) => {
    for (const a of acts) {
      if (a.kind === "journal") {
        push(a.event.type, a.event.data);
        if (a.event.type === "release_cancelled") status = "complete";
      }
      if (a.kind === "decide") {
        const id = a.decision.id as string;
        decisions[id] = {
          decision_id: id,
          wave: WAVE,
          task: null,
          kind: a.decision.kind,
          question: a.decision.question,
          ...(a.decision.options !== undefined ? { options: a.decision.options } : {}),
          pointers: {},
          opened_at: at,
          ...a.data,
        } as DecisionRecord;
        push("decision_opened", { decision_id: id, kind: a.decision.kind, ...a.data });
      }
      if (a.kind === "steer")
        push("steering_sent", { agent_id: a.agent_id, reason: STAGE_STEER_REASON }, RELEASE_TASK);
    }
    return acts;
  };
  const step = (ev: ReleaseEvent) => apply(nextRelease(view(), ev));
  const spawned = (stage: string, attempt: number) =>
    push(
      "agent_spawned",
      {
        agent_id: `w1-release-${stage}-${attempt}`,
        role: "release",
        stage,
        attempt,
        worktree: `/wt/${stage}-${attempt}`,
        base_sha: "a".repeat(40),
      },
      RELEASE_TASK,
    );
  const resolve = (kind: string, stage: string, answer: string) => {
    const d = Object.values(decisions).find(
      (x) =>
        x.kind === kind && x.resolved === undefined && (x as { stage?: string }).stage === stage,
    ) as DecisionRecord;
    d.resolved = { answer, by: "owner", at };
    return step({ kind: "decision_resolved", decision: d });
  };
  const setStatus = (s: string) => {
    status = s;
  };
  return { events, decisions, view, step, spawned, resolve, setStatus };
}

const kinds = (acts: ReleaseAction[]) =>
  acts.map((a) =>
    a.kind === "journal"
      ? `${a.event.type} ${a.event.data.stage}`
      : a.kind === "decide"
        ? `decide ${a.decision.kind} ${a.data.stage}`
        : a.kind === "spawn"
          ? `spawn ${a.stage} ${a.attempt}`
          : a.kind === "retire"
            ? `retire ${a.agent_id}${a.status !== undefined ? ` ${a.status}` : ""}`
            : `${a.kind} ${"stage" in a ? a.stage : ""}`,
  );

const RESULT = (stage: string) => ({
  stage,
  commands: [{ argv: ["bun", "run", "changelog", "--version", "0.5.0"], code: 0, seconds: 3 }],
  notes: "bumped",
  artifacts: { files: ["CHANGELOG.md"] },
});
const OK = { ok: true, head: "b".repeat(40), tip: "b".repeat(40), facts: [], missing: [] };

describe("nextRelease (SPEC §4.6.19)", () => {
  it("runs the stages serially, asks stage_go before an owner-gated one, then stops for release_go", () => {
    const t = train();
    expect(kinds(t.step({ kind: "advance" }))).toEqual([
      "release_stage_entered bump",
      "spawn bump 1",
    ]);
    // The spawn has not happened yet: the next advance retries it; once spawned, nothing.
    expect(kinds(t.step({ kind: "advance" }))).toEqual(["spawn bump 1"]);
    t.spawned("bump", 1);
    expect(t.step({ kind: "advance" })).toEqual([]);
    const done = t.step({
      kind: "agent_done",
      agent_id: "w1-release-bump-1",
      status: "done",
      result: RESULT("bump"),
    });
    expect(kinds(done)).toEqual(["verify bump"]);
    expect(
      kinds(
        t.step({
          kind: "stage_checked",
          stage: "bump",
          agent_id: "w1-release-bump-1",
          report: OK,
          evidence: "/h/bump.md",
        }),
      ),
    ).toEqual(["release_stage_verified bump", "retire w1-release-bump-1"]);
    expect(t.events.find((e) => e.type === "release_stage_verified")?.data).toMatchObject({
      evidence: "/h/bump.md",
      head: "b".repeat(40),
    });
    expect(kinds(t.step({ kind: "advance" }))).toEqual(["decide stage_go deploy-staging"]);
    expect(t.view().train.stage).toBe("deploy-staging");
    expect(t.step({ kind: "advance" })).toEqual([]);
    expect(kinds(t.resolve("stage_go", "deploy-staging", "go"))).toEqual([
      "release_stage_entered deploy-staging",
      "spawn deploy-staging 1",
    ]);
    t.spawned("deploy-staging", 1);
    t.step({
      kind: "agent_done",
      agent_id: "w1-release-deploy-staging-1",
      status: "done",
      result: { stage: "deploy-staging", commands: [] },
    });
    t.step({
      kind: "stage_checked",
      stage: "deploy-staging",
      agent_id: "w1-release-deploy-staging-1",
      report: OK,
    });
    expect(kinds(t.step({ kind: "advance" }))).toEqual([
      "release_stage_entered smoke",
      "spawn smoke 1",
    ]);
    t.spawned("smoke", 1);
    t.step({ kind: "stage_checked", stage: "smoke", agent_id: "w1-release-smoke-1", report: OK });
    // The last stage verified: nothing more from the train (the daemon asks release_go).
    expect(t.step({ kind: "advance" })).toEqual([]);
    expect(t.view().train.stages.map((s) => s.state)).toEqual(["verified", "verified", "verified"]);
  });

  it("stage_go skip marks the stage skipped and enters the next; hold asks again", () => {
    const t = train();
    t.step({ kind: "advance" });
    t.spawned("bump", 1);
    t.step({ kind: "stage_checked", stage: "bump", agent_id: "w1-release-bump-1", report: OK });
    t.step({ kind: "advance" });
    const held = t.resolve("stage_go", "deploy-staging", "hold");
    expect(kinds(held)).toEqual(["decide stage_go deploy-staging"]);
    expect(held[0]?.kind === "decide" && held[0].data.class).toBe("held");
    expect(kinds(t.resolve("stage_go", "deploy-staging", "skip"))).toEqual([
      "release_stage_skipped deploy-staging",
    ]);
    expect(kinds(t.step({ kind: "advance" }))).toEqual([
      "release_stage_entered smoke",
      "spawn smoke 1",
    ]);
    expect(t.view().train.stages.find((s) => s.name === "deploy-staging")?.state).toBe("skipped");
  });

  it("an answer given while the wave is paused still acts; the spawn waits for the resume", () => {
    const t = train();
    t.step({ kind: "advance" });
    t.spawned("bump", 1);
    t.step({ kind: "stage_checked", stage: "bump", agent_id: "w1-release-bump-1", report: OK });
    t.step({ kind: "advance" });
    t.setStatus("paused");
    expect(kinds(t.resolve("stage_go", "deploy-staging", "go"))).toEqual([
      "release_stage_entered deploy-staging",
      "spawn deploy-staging 1",
    ]);
    // Paused: no retry of the spawn; resumed, the advance retries it.
    expect(t.step({ kind: "advance" })).toEqual([]);
    t.setStatus("releasing");
    expect(kinds(t.step({ kind: "advance" }))).toEqual(["spawn deploy-staging 1"]);
    // A failed stage's answer while paused acts too.
    t.spawned("deploy-staging", 1);
    t.step({
      kind: "agent_done",
      agent_id: "w1-release-deploy-staging-1",
      status: "failed",
      why: "boom",
    });
    t.setStatus("paused");
    expect(kinds(t.resolve("agent_blocked", "deploy-staging", "respawn"))).toEqual([
      "retire w1-release-deploy-staging-1 stopped",
      "release_stage_entered deploy-staging",
      "spawn deploy-staging 2",
    ]);
  });

  it("an answer for a wave that is neither releasing nor paused does nothing", () => {
    const t = train();
    t.step({ kind: "advance" });
    t.spawned("bump", 1);
    t.step({ kind: "stage_checked", stage: "bump", agent_id: "w1-release-bump-1", report: OK });
    t.step({ kind: "advance" });
    t.setStatus("stopped");
    expect(t.resolve("stage_go", "deploy-staging", "go")).toEqual([]);
  });

  it("a done without a stage result is steered once, then the stage fails with an agent_blocked decision; respawn is attempt 2", () => {
    const t = train();
    t.step({ kind: "advance" });
    t.spawned("bump", 1);
    const done = {
      kind: "agent_done" as const,
      agent_id: "w1-release-bump-1",
      status: "done" as const,
    };
    expect(kinds(t.step(done))).toEqual(["steer bump"]);
    expect(kinds(t.step(done))).toEqual([
      "retire w1-release-bump-1",
      "release_stage_failed bump",
      "decide agent_blocked bump",
    ]);
    const d = Object.values(t.decisions).find(
      (x) => x.kind === "agent_blocked",
    ) as DecisionRecord & {
      pipeline: Record<string, unknown>;
    };
    expect(d.task).toBeNull();
    expect(d.options).toEqual(["respawn", "skip", "cancel"]);
    expect(d.pipeline).toMatchObject({ on: "stage", stage: "bump", attempt: 1 });
    expect(t.step({ kind: "advance" })).toEqual([]);
    d.resolved = { answer: "respawn", by: "owner", at: "x" };
    expect(kinds(t.step({ kind: "decision_resolved", decision: d }))).toEqual([
      "retire w1-release-bump-1 stopped",
      "release_stage_entered bump",
      "spawn bump 2",
    ]);
    expect(t.view().train.stages[0]?.state).toBe("running");
  });

  it("a failed or blocked status, or a missing fact after the steer, fails the stage", () => {
    const t = train();
    t.step({ kind: "advance" });
    t.spawned("bump", 1);
    const report = { ok: false, facts: [], missing: ["commits_on_release"] };
    const checked = {
      kind: "stage_checked" as const,
      stage: "bump",
      agent_id: "w1-release-bump-1",
      report,
    };
    const steer = t.step(checked);
    expect(kinds(steer)).toEqual(["steer bump"]);
    expect(steer[0]?.kind === "steer" && steer[0].text).toContain("commits_on_release");
    expect(kinds(t.step(checked))).toContain("release_stage_failed bump");

    const u = train();
    u.step({ kind: "advance" });
    u.spawned("bump", 1);
    expect(
      kinds(u.step({ kind: "agent_done", agent_id: "w1-release-bump-1", status: "failed" })),
    ).toEqual(["release_stage_failed bump", "decide agent_blocked bump"]);
    // cancel ends the train.
    expect(kinds(u.resolve("agent_blocked", "bump", "cancel"))).toEqual([
      "retire w1-release-bump-1 stopped",
      "release_cancelled bump",
    ]);
    expect(u.step({ kind: "advance" })).toEqual([]);
  });

  it("ignores a status from an agent that is not the stage's current run", () => {
    const t = train();
    t.step({ kind: "advance" });
    t.spawned("bump", 1);
    expect(t.step({ kind: "agent_done", agent_id: "w1-release-bump-9", status: "failed" })).toEqual(
      [],
    );
    expect(
      t.step({ kind: "stage_checked", stage: "bump", agent_id: "w1-release-bump-9", report: OK }),
    ).toEqual([]);
  });

  it("a recovery answer about the stage agent: stop fails the stage; respawn runs it again at attempt 2", () => {
    const t = train();
    t.step({ kind: "advance" });
    t.spawned("bump", 1);
    const stop = {
      kind: "agent_recovery" as const,
      agent_id: "w1-release-bump-1",
      answer: "stop" as const,
      why: "owner stopped the task (decision d1)",
    };
    expect(kinds(t.step({ ...stop, agent_id: "w1-release-bump-9" }))).toEqual([]);
    expect(kinds(t.step(stop))).toEqual([
      "retire w1-release-bump-1 stopped",
      "release_stage_failed bump",
      "decide agent_blocked bump",
    ]);
    expect(t.events.at(-2)?.data).toMatchObject({ reason: stop.why });

    const u = train();
    u.step({ kind: "advance" });
    u.spawned("bump", 1);
    expect(kinds(u.step({ ...stop, answer: "respawn" }))).toEqual([
      "retire w1-release-bump-1 relaunched",
      "release_stage_failed bump",
      "release_stage_entered bump",
      "spawn bump 2",
    ]);
    expect(u.view().train.stages[0]?.state).toBe("running");
    expect(u.view().attempt.bump).toBe(2);
  });
});

describe("releaseGoInput", () => {
  it("names the skipped stages apart from the verified ones", () => {
    const { input } = releaseGoInput(
      WAVE,
      {
        stage: null,
        stages: [
          { name: "bump", state: "verified" },
          { name: "deploy-staging", state: "skipped" },
          { name: "smoke", state: "verified" },
        ],
      },
      new Map(),
    );
    expect(input.question).toContain("verified: bump, smoke (skipped: deploy-staging).");
  });
});

describe("ReleaseTrain", () => {
  /** A driver over a scripted train whose verification passes; steers are recorded. */
  function driver(home: string, exec?: ExecFn) {
    const t = train();
    t.step({ kind: "advance" });
    t.spawned("bump", 1);
    const steers: string[] = [];
    const ok: ExecFn = async (argv) => {
      const a = argv.join(" ");
      const out = a.includes("rev-parse") ? `${"c".repeat(40)}\n` : "";
      return { code: 0, stdout: out, stderr: "", timedOut: false };
    };
    const d = new ReleaseTrain(WAVE, {
      exec: exec ?? ok,
      home,
      view: t.view,
      journal: async () => {},
      spawn: () => {},
      steer: async (_id, text) => {
        steers.push(text);
      },
      decide: async () => {},
      retire: async () => {},
      enqueue: (fn) => fn(),
      now: () => 0,
    });
    const done = {
      kind: "agent_done" as const,
      agent_id: "w1-release-bump-1",
      status: "done" as const,
      result: RESULT("bump"),
    };
    return { d, steers, done };
  }

  it("evidence that cannot be written is a missing fact, not a silent hang", async () => {
    const home = join(tempDir("volleyd-release-"), "home");
    // A file where the evidence directory goes: mkdir fails.
    writeFileSync(home, "");
    const { d, steers, done } = driver(home);
    await d.handle(done);
    await d.settled();
    expect(steers).toHaveLength(1);
    expect(steers[0]).toMatch(/these facts do not hold: evidence \(/);
  });

  it("a verification that throws is a missing fact", async () => {
    const { d, steers, done } = driver(tempDir("volleyd-release-"), async () => {
      throw new Error("exec exploded");
    });
    await d.handle(done);
    await d.settled();
    expect(steers[0]).toContain("verification (exec exploded)");
  });
});

describe("the stage result (review-result.schema.json)", () => {
  const example = JSON.parse(
    readFileSync(
      join(__dirname, "..", "..", "..", "spec", "examples", "valid", "result-stage.json"),
      "utf-8",
    ),
  );
  it("the spec example validates and parses", () => {
    expect(schemaErrors("review-result.schema.json", example)).toEqual([]);
    expect(parseStageResult(example.payload, "bump")?.commands).toHaveLength(2);
  });
  it("a stage result without commands is not one", () => {
    const bad = { ...example, payload: { stage: "bump" } };
    expect(schemaErrors("review-result.schema.json", bad)).not.toEqual([]);
  });
  it("a release agent's identity names the _release pseudo task", () => {
    const id = {
      agent_id: "w1-release-bump-1",
      namespace: "ns",
      parent_id: null,
      wave: "w1",
      task: RELEASE_TASK,
      role: "release",
      broker_url: "mqtt://127.0.0.1:1883",
    };
    expect(schemaErrors("agent-identity.schema.json", id)).toEqual([]);
    expect(schemaErrors("agent-identity.schema.json", { ...id, task: "_other" })).not.toEqual([]);
  });
});

describe("parseStageResult", () => {
  it("accepts the contract and rejects another stage's or a malformed one", () => {
    expect(parseStageResult(RESULT("bump"), "bump")).toMatchObject({
      stage: "bump",
      notes: "bumped",
    });
    expect(parseStageResult(RESULT("bump"), "smoke")).toBeNull();
    expect(parseStageResult({ stage: "bump" }, "bump")).toBeNull();
    expect(
      parseStageResult({ stage: "bump", commands: [{ argv: "x", code: 0, seconds: 1 }] }, "bump"),
    ).toBeNull();
    expect(parseStageResult(undefined, "bump")).toBeNull();
  });

  it("keeps the payload's other fields, for verify.result", () => {
    expect(parseStageResult({ ...RESULT("smoke"), smoke: "passed" }, "smoke")?.fields).toEqual({
      smoke: "passed",
    });
  });
});

describe("verifyStage", () => {
  const START = "a".repeat(40);
  const TIP = "c".repeat(40);
  const stage = (verify: PlaybookStage["verify"]): PlaybookStage => ({
    name: "tag",
    brief: "Tag it.",
    run: [["git", "tag", "v0.5.0"]],
    gate: "auto",
    ...(verify !== undefined ? { verify } : {}),
  });
  /** A fake exec over a scripted repo: the tip, HEAD, ancestry, files and tags. */
  const fake = (o: {
    tip?: string;
    head?: string;
    ancestor?: boolean;
    files?: string[];
    tags?: unknown[];
    startAncestor?: boolean;
    tagObjects?: Record<string, string>;
  }) => {
    const calls: string[][] = [];
    const exec: ExecFn = async (argv) => {
      calls.push([...argv]);
      const r = (stdout: string, code = 0) => ({ code, stdout, stderr: "", timedOut: false });
      const a = argv.join(" ");
      if (a.includes(" fetch ")) return r("");
      if (a.includes("rev-parse --verify --quiet refs/remotes/origin/release/w1"))
        return r(`${o.tip ?? TIP}\n`);
      if (a.endsWith("rev-parse HEAD")) return r(`${o.head ?? TIP}\n`);
      if (a.includes(`merge-base --is-ancestor ${START} `))
        return r("", o.startAncestor === false ? 1 : 0);
      if (a.includes("merge-base --is-ancestor")) return r("", o.ancestor === false ? 1 : 0);
      if (argv[3] === "show") {
        const path = String(argv.at(-1)).split(":")[1];
        return r("", (o.files ?? []).includes(path as string) ? 0 : 128);
      }
      const obj = argv[0] === "gh" ? /git\/tags\/([0-9a-f]+)$/.exec(String(argv[2])) : null;
      if (obj !== null)
        return r(JSON.stringify({ object: { sha: o.tagObjects?.[obj[1] as string] } }));
      if (argv[0] === "gh" && a.includes("matching-refs/tags/v0."))
        return r(JSON.stringify(o.tags ?? []));
      return r("", 1);
    };
    return { exec, calls };
  };
  const result = {
    stage: "tag",
    commands: [{ argv: ["git", "tag", "v0.5.0"], code: 0, seconds: 1 }],
    artifacts: { tag: "v0.5.0" },
  };
  const base = { cwd: "/wt", start: START, release_branch: "release/w1", result };

  it("reports each fact true with its evidence line", async () => {
    const f = fake({
      files: ["CHANGELOG.md"],
      tags: [{ ref: "refs/tags/v0.5.0", object: { sha: TIP, type: "commit" } }],
    });
    const r = await verifyStage(f.exec, {
      ...base,
      stage: stage({ commits_on_release: true, tag: "v0.*", files: ["CHANGELOG.md"] }),
    });
    expect(r.missing).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.head).toBe(TIP);
    expect(r.facts.map((x) => x.fact)).toEqual([
      "commands",
      "commits_on_release",
      "tag v0.*",
      "file CHANGELOG.md",
    ]);
    expect(r.facts.find((x) => x.fact === "tag v0.*")?.evidence).toContain("v0.5.0");
    // The tag is read with a GET through gh api, never git fetch --tags.
    expect(
      f.calls.some(
        (c) => c[0] === "gh" && c[1] === "api" && c[2]?.endsWith("matching-refs/tags/v0."),
      ),
    ).toBe(true);
    expect(f.calls.some((c) => c.includes("--tags"))).toBe(false);
  });

  it("a missing tag, an unmoved tip, a missing file and a failed command are missing facts", async () => {
    const f = fake({
      tip: START,
      tags: [{ ref: "refs/tags/v0.4.0", object: { sha: START, type: "commit" } }],
    });
    const r = await verifyStage(f.exec, {
      ...base,
      result: { ...result, commands: [{ argv: ["git", "tag", "v0.5.0"], code: 1, seconds: 1 }] },
      stage: stage({
        commits_on_release: true,
        tag: "v0.5.0",
        files: ["NOTES.md"],
        result: { smoke: "passed" },
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      "commands",
      "commits_on_release",
      "tag v0.5.0",
      "file NOTES.md",
      "result smoke",
    ]);
  });

  it("a verify.result field the agent published holds", async () => {
    const payload = { ...result, smoke: "passed", runs: 3 };
    const parsed = parseStageResult(payload, "tag");
    if (parsed === null) throw new Error("not a stage result");
    const r = await verifyStage(fake({}).exec, {
      ...base,
      result: parsed,
      stage: stage({ result: { smoke: "passed", runs: 3 } }),
    });
    expect(r.missing).toEqual([]);
    expect(r.facts.find((x) => x.fact === "result smoke")?.evidence).toBe('smoke: "passed"');
  });

  it("commits_on_release needs the stage's start, and the tip past it", async () => {
    const commits = stage({ commits_on_release: true });
    const unknown = await verifyStage(fake({}).exec, { ...base, start: undefined, stage: commits });
    expect(unknown.missing).toEqual(["commits_on_release"]);
    expect(unknown.facts[1]?.evidence).toContain("start unknown");
    // A tip that moved, but not from the stage's start (start is no ancestor of it).
    const f = fake({ startAncestor: false });
    const elsewhere = await verifyStage(f.exec, { ...base, stage: commits });
    expect(elsewhere.missing).toEqual(["commits_on_release"]);
    expect(f.calls.some((c) => c.join(" ").includes(`--is-ancestor ${START} ${TIP}`))).toBe(true);
  });

  it("the run lines must be reported in order, each once", async () => {
    const two: PlaybookStage = {
      ...stage(undefined),
      run: [
        ["git", "tag", "v0.5.0"],
        ["git", "push", "origin", "v0.5.0"],
      ],
    };
    const c = (argv: string[]) => ({ argv, code: 0, seconds: 1 });
    const swapped = await verifyStage(fake({}).exec, {
      ...base,
      stage: two,
      result: {
        ...result,
        commands: [c(["git", "push", "origin", "v0.5.0"]), c(["git", "tag", "v0.5.0"])],
      },
    });
    expect(swapped.missing).toEqual(["commands"]);
    const twice = await verifyStage(fake({}).exec, {
      ...base,
      stage: {
        ...two,
        run: [
          ["git", "tag", "v0.5.0"],
          ["git", "tag", "v0.5.0"],
        ],
      },
    });
    expect(twice.missing).toEqual(["commands"]);
  });

  it("an annotated tag is read through its tag object", async () => {
    const OBJ = "d".repeat(40);
    const f = fake({
      tags: [{ ref: "refs/tags/v0.5.0", object: { sha: OBJ, type: "tag" } }],
      tagObjects: { [OBJ]: TIP },
    });
    const r = await verifyStage(f.exec, { ...base, stage: stage({ tag: "v0.5.0" }) });
    expect(r).toMatchObject({ ok: true, missing: [] });
    expect(f.calls.some((c) => c[2]?.endsWith(`git/tags/${OBJ}`))).toBe(true);
  });

  it("a missing tag alone: { ok: false, missing: ['tag v0.5.0'] }", async () => {
    const r = await verifyStage(fake({ tags: [] }).exec, {
      ...base,
      stage: stage({ tag: "v0.5.0" }),
    });
    expect(r).toMatchObject({ ok: false, missing: ["tag v0.5.0"] });
  });
});

describe("tag globs", () => {
  it("asks matching-refs for the literal prefix and matches the whole name", () => {
    expect(globPrefix("v0.*")).toBe("v0.");
    expect(globPrefix("v1.2.3")).toBe("v1.2.3");
    expect(globRegex("v0.*").test("v0.5.0")).toBe(true);
    expect(globRegex("v0.?.0").test("v0.5.0")).toBe(true);
    expect(globRegex("v0.5.0").test("v0.5.01")).toBe(false);
    expect(globRegex("v[0-1].*").test("v1.0")).toBe(true);
  });
});
