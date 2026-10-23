import { describe, expect, it } from "vitest";
import { type Digest, digestOf, renderDigestMd, summaryLine } from "../src/autopilot/digest";
import { reduce } from "../src/reducer";
import type { JournalEvent, NewEvent } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { envelope, schemaErrors } from "./helpers/schema";

const T0 = "2026-10-20T22:00:00.000Z";
const NOW = "2026-10-21T07:00:00.000Z";

const wave = parseWaveFile(`wave: w1
repo: /path/to/example-repo
release_branch: release/w1
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  A: { issue: 11, title: "Add the digest" }
  B: { issue: 12 }
  C: { issue: 13 }
  D: { issue: 14 }
  E: { issue: 15 }
`);

/** Hand-written events, numbered and stamped `T0 + i minutes`. */
function journal(...evs: NewEvent[]): JournalEvent[] {
  return evs.map((e, i) => ({
    seq: i + 1,
    at: new Date(Date.parse(T0) + i * 60_000).toISOString(),
    ...e,
  }));
}

const pr = (n: number) => ({
  number: n,
  url: `https://github.com/example-org/example-repo/pull/${n}`,
});
const merged = (task: string, n: number, extra: Record<string, unknown>): NewEvent[] => [
  { type: "artifact_verified", task, data: { role: "merged", pr: pr(n), ...extra } },
  { type: "stage_entered", task, data: { stage: "done", merged: true } },
];

const events = journal(
  { type: "wave_submitted", data: { wave, owner: "coord-a" } },
  ...["A", "B", "C", "D", "E"].map(
    (t): NewEvent => ({ type: "task_queued", task: t, data: { issue: wave.tasks[t]?.issue } }),
  ),
  // A: merged by volleyd (autopilot merging), after a rebase that verified.
  { type: "artifact_verified", task: "A", data: { role: "rebase", head_sha: "a2" } },
  {
    type: "merged_by_supervisor",
    task: "A",
    data: { task: "A", pr: 21, head: "a2", merge_sha: "m-a", by: "volleyd" },
  },
  ...merged("A", 21, { via: "supervisor", merge_sha: "m-a" }),
  // B: the owner's `volleyd merged`.
  { type: "merged_by_operator", task: "B", data: { by: "coord-a", sha: "m-b", head: "b1" } },
  ...merged("B", 22, { via: "operator", sha: "m-b", by: "coord-a" }),
  // C: GitHub's merge button; two relaunches and a recovered spawn on the way.
  { type: "relaunched", task: "C", data: { role: "implementer" } },
  { type: "relaunched", task: "C", data: { role: "implementer" } },
  { type: "spawn_recovered", task: "C", data: { role: "implementer" } },
  ...merged("C", 23, { merge_sha: "m-c", merged_at: T0 }),
  // A flake's fixer landed, releasing D; D cancelled anyway.
  {
    type: "task_queued",
    task: "fix-flaky-test",
    data: {
      issue: 0,
      synthetic: true,
      title: "Fix flaky test flaky test",
      remediation: {
        kind: "fix_flake",
        test: "flaky test",
        test_file: null,
        run_urls: [],
        for: ["D"],
      },
    },
  },
  ...merged("fix-flaky-test", 24, { via: "supervisor", merge_sha: "m-f" }),
  {
    type: "remediation_closed",
    task: "fix-flaky-test",
    data: {
      kind: "fix_flake",
      test: "flaky test",
      task: "fix-flaky-test",
      outcome: "landed",
      released: ["D"],
    },
  },
  { type: "task_cancelled", task: "D", data: { by: "coord-a", why: "superseded by #99" } },
  // Two decisions autopilot answered, one escalated (still open), one resolved by the owner.
  {
    type: "decision_opened",
    task: "E",
    data: {
      decision_id: "d-1",
      kind: "reviewers_disagree",
      question: "Blocker?",
      options: ["blocker", "fine"],
    },
  },
  {
    type: "decision_auto_resolved",
    task: "E",
    data: { decision_id: "d-1", kind: "reviewers_disagree" },
  },
  {
    type: "decision_resolved",
    task: "E",
    data: { decision_id: "d-1", answer: "blocker", by: "volleyd" },
  },
  {
    type: "decision_opened",
    task: "E",
    data: { decision_id: "d-2", kind: "agent_question", question: "Which?", options: [] },
  },
  {
    type: "decision_auto_resolved",
    task: "E",
    data: { decision_id: "d-2", kind: "agent_question" },
  },
  {
    type: "decision_resolved",
    task: "E",
    data: { decision_id: "d-2", answer: "x", by: "volleyd" },
  },
  {
    type: "decision_opened",
    data: { decision_id: "d-3", kind: "plan_change", question: "Add a task?", options: ["apply"] },
  },
  {
    type: "decision_escalated",
    data: { decision_id: "d-3", kind: "plan_change", why: "owner_only" },
  },
  {
    type: "decision_opened",
    task: "E",
    data: { decision_id: "d-4", kind: "agent_blocked", question: "Stuck?", options: ["retry"] },
  },
  {
    type: "decision_escalated",
    task: "E",
    data: { decision_id: "d-4", kind: "agent_blocked", why: "no_policy" },
  },
);

const state = reduce(events);
const digest = digestOf(events, state, NOW, "escalation");

describe("digestOf", () => {
  it("lists shipped tasks with their PR, merge sha and who merged them", () => {
    expect(digest.shipped).toEqual([
      {
        task: "A",
        issue: 11,
        title: "Add the digest",
        pr: pr(21),
        merge_sha: "m-a",
        merged_by: "supervisor",
      },
      { task: "B", issue: 12, pr: pr(22), merge_sha: "m-b", merged_by: "operator" },
      { task: "C", issue: 13, pr: pr(23), merge_sha: "m-c", merged_by: "github" },
      {
        task: "fix-flaky-test",
        issue: 0,
        title: "Fix flaky test flaky test",
        pr: pr(24),
        merge_sha: "m-f",
        merged_by: "supervisor",
      },
    ]);
  });

  it("closes (#416): the done tasks' issues in merge order; not a cancelled one's, not a fixer's issue 0", () => {
    expect(digest.closes).toEqual([11, 12, 13]);
    const md = renderDigestMd(digest);
    expect(md).toContain("## Closes");
    expect(md.match(/^ {4}Closes #\d+$/gm)).toEqual([
      "    Closes #11",
      "    Closes #12",
      "    Closes #13",
    ]);
    expect(md).not.toContain("Closes #14");
  });

  it("counts what autopilot handled", () => {
    expect(digest.auto).toEqual({
      decisions_resolved: 2,
      flakes_fixed: [{ test: "flaky test", fixer: "fix-flaky-test", prs_released: 1 }],
      conflicts_resolved: 1,
      retries: 3,
      merges: 2,
      churn: { branch_updates: 0, rereviews: 0, retries: 0, trains: 0 },
    });
  });

  it("counts the churn spawns by cause (#387)", () => {
    const spawn = (task: string, role: string, cause?: string): NewEvent => ({
      type: "agent_spawned",
      task,
      data: {
        role,
        agent_id: `w1-${task.toLowerCase()}-${role}`,
        ...(cause !== undefined ? { churn: true, cause } : {}),
      },
    });
    const d = digestOf(
      journal(
        ...events.map(({ seq: _s, at: _a, ...e }) => e),
        spawn("A", "implementer"),
        spawn("A", "rebase", "branch_update"),
        spawn("A", "rebase", "branch_update"),
        spawn("A", "spec_reviewer", "rereview"),
        spawn("B", "implementer", "retry"),
        spawn("train-1", "integrator", "train"),
      ),
      reduce(events),
      NOW,
      "wave_complete",
    );
    expect(d.auto.churn).toEqual({ branch_updates: 2, rereviews: 1, retries: 1, trains: 1 });
    expect(schemaErrors("digest.schema.json", envelope("_waves/digest", "digest", d))).toEqual([]);
    expect(summaryLine(d)).toContain(", 5 churn spawns (no budget)");
    expect(renderDigestMd(d)).toContain(
      "- 5 churn spawns (2 branch updates, 1 re-review, 1 retry, 1 train)",
    );
  });

  it("lists open decisions as waiting, owner_only for an owner_only escalation", () => {
    expect(digest.waiting).toEqual([
      {
        id: "d-3",
        kind: "plan_change",
        question: "Add a task?",
        since: events.find((e) => e.data.decision_id === "d-3")?.at,
        owner_only: true,
      },
      {
        id: "d-4",
        kind: "agent_blocked",
        task: "E",
        question: "Stuck?",
        since: events.find((e) => e.data.decision_id === "d-4")?.at,
        owner_only: false,
      },
    ]);
  });

  it("lists cancelled tasks as failures with why", () => {
    expect(digest.failures).toEqual([{ task: "D", why: "superseded by #99" }]);
  });

  it("carries the wave, its release branch, when and why", () => {
    expect(digest).toMatchObject({
      wave: "w1",
      release_branch: "release/w1",
      generated_at: NOW,
      trigger: "escalation",
    });
    expect(digest.release).toBeUndefined();
  });

  it("validates against digest.schema.json", () => {
    expect(schemaErrors("digest.schema.json", envelope("_waves/digest", "digest", digest))).toEqual(
      [],
    );
  });
});

describe("a wave-level alarm (#324)", () => {
  const message =
    "this machine is overloaded (load 130.0 on 10 cores, max 1.5 per core) while box-a is ready with 10 free agent slots; this wave is placement: local (set placement: auto to use it)";
  const raised = journal(...events.map(({ seq: _s, at: _a, ...e }) => e), {
    type: "alarm_raised",
    data: { alarm: "peer_idle_under_load", peer: "box-a", free: 10, message },
  });
  const s = reduce(raised);
  const d = digestOf(raised, s, NOW, "escalation");

  it("peer_idle_under_load holds on the wave state, and the digest carries it", () => {
    expect(s.alarms).toEqual([{ alarm: "peer_idle_under_load", message }]);
    expect(d.alarms).toEqual([{ alarm: "peer_idle_under_load", message }]);
    expect(digest.alarms).toBeUndefined();
    expect(schemaErrors("digest.schema.json", envelope("_waves/digest", "digest", d))).toEqual([]);
    expect(
      schemaErrors("wave-state.schema.json", envelope("_waves/state", "wave_state", s)),
    ).toEqual([]);
    expect(renderDigestMd(d)).toContain(`## Alarms\n\n- peer_idle_under_load: ${message}\n`);
  });

  it("alarm_cleared drops it: the state and the digest no longer carry it", () => {
    const cleared = journal(...raised.map(({ seq: _s, at: _a, ...e }) => e), {
      type: "alarm_cleared",
      data: { alarm: "peer_idle_under_load" },
    });
    const after = reduce(cleared);
    expect(after.alarms).toBeUndefined();
    expect(digestOf(cleared, after, NOW, "escalation").alarms).toBeUndefined();
  });
});

describe("summaryLine", () => {
  const base: Digest = {
    wave: "w1",
    release_branch: "release/w1",
    generated_at: NOW,
    trigger: "wave_complete",
    shipped: Array.from({ length: 27 }, (_, i) => ({
      task: `T${i}`,
      issue: i + 1,
      pr: pr(i + 1),
      merge_sha: null,
      merged_by: "supervisor" as const,
    })),
    closes: Array.from({ length: 27 }, (_, i) => i + 1),
    auto: {
      decisions_resolved: 0,
      flakes_fixed: [1, 2, 3].map((i) => ({ test: `t${i}`, fixer: `fix-t${i}`, prs_released: 1 })),
      conflicts_resolved: 2,
      retries: 0,
      merges: 27,
      churn: { branch_updates: 0, rereviews: 0, retries: 0, trains: 0 },
    },
    waiting: [{ id: "d-go", kind: "release_go", question: "Go?", since: NOW, owner_only: true }],
    held: [],
    failures: [],
  };

  it("matches the issue's example", () => {
    expect(summaryLine(base)).toBe(
      "w1 complete: 27 shipped, 3 flakes fixed, 2 conflicts resolved, 1 waiting for you (release_go)",
    );
  });

  it("says why it was sent, and leaves out what is zero", () => {
    expect(summaryLine(digest)).toBe(
      "w1 needs you: 4 shipped, 1 flake fixed, 1 conflict resolved, 3 retries, 2 decisions answered, 1 failed, 2 waiting for you (plan_change, agent_blocked)",
    );
    expect(
      summaryLine({
        ...base,
        trigger: "stopped",
        auto: { ...base.auto, flakes_fixed: [], conflicts_resolved: 0 },
        waiting: [],
      }),
    ).toBe("w1 stopped: 27 shipped");
    // Churn only when there was any.
    expect(summaryLine(base)).not.toContain("churn");
    expect(
      summaryLine({
        ...base,
        waiting: [],
        auto: { ...base.auto, churn: { branch_updates: 1, rereviews: 0, retries: 0, trains: 0 } },
      }),
    ).toBe(
      "w1 complete: 27 shipped, 3 flakes fixed, 2 conflicts resolved, 1 churn spawn (no budget)",
    );
  });
});

describe("held decisions (#335)", () => {
  const withHold = journal(...events.map(({ seq: _s, at: _a, ...e }) => e), {
    type: "decision_held",
    task: "E",
    data: { decision_id: "d-4", kind: "agent_blocked", on: { task: "C" }, by: "coord-a" },
  });
  const d = digestOf(withHold, reduce(withHold), NOW, "escalation");

  it("lists a held decision under held, not waiting", () => {
    expect(d.waiting.map((w) => w.id)).toEqual(["d-3"]);
    expect(d.held).toEqual([
      {
        id: "d-4",
        kind: "agent_blocked",
        task: "E",
        question: "Stuck?",
        since: withHold.find((e) => e.data.decision_id === "d-4")?.at,
        on: { task: "C" },
        label: "C (#23)",
        held_since: withHold.at(-1)?.at,
      },
    ]);
    expect(schemaErrors("digest.schema.json", envelope("_waves/digest", "digest", d))).toEqual([]);
    expect(summaryLine(d)).toContain("1 waiting for you (plan_change), 1 held");
  });

  it("renders them under their own heading; a released hold is waiting again", () => {
    const md = renderDigestMd(d);
    expect(md).toContain(
      `## Held\n\n- d-4 agent_blocked on E: waiting on C (#23) since ${withHold.at(-1)?.at}`,
    );
    expect(md.indexOf("## Waiting for you")).toBeLessThan(md.indexOf("## Held"));
    const released = journal(...withHold.map(({ seq: _s, at: _a, ...e }) => e), {
      type: "decision_released",
      task: "E",
      data: { decision_id: "d-4", kind: "agent_blocked", why: "C done", by: "volleyd" },
    });
    const r = digestOf(released, reduce(released), NOW, "escalation");
    expect(r.held).toEqual([]);
    expect(r.waiting.map((w) => w.id)).toEqual(["d-3", "d-4"]);
  });
});

describe("renderDigestMd", () => {
  it("has the three sections, with PR links and decision ids", () => {
    const md = renderDigestMd(digest);
    expect(md.split("\n")[0]).toBe(`# ${summaryLine(digest)}`);
    for (const h of ["## Shipped", "## Autopilot handled", "## Waiting for you"])
      expect(md).toContain(h);
    expect(md.indexOf("## Shipped")).toBeLessThan(md.indexOf("## Autopilot handled"));
    expect(md.indexOf("## Autopilot handled")).toBeLessThan(md.indexOf("## Waiting for you"));
    expect(md).toContain(`- A (#11) Add the digest: PR #21 ${pr(21).url} (merged by supervisor)`);
    expect(md).toContain("- flaky test: fixed by fix-flaky-test, 1 task released");
    expect(md).toContain("- d-3 plan_change (owner only): Add a task?");
    expect(md).toContain("- d-4 agent_blocked on E: Stuck?");
    expect(md).toContain("## Failed");
    expect(md).toContain("- D: superseded by #99");
  });

  it("says none for an empty section", () => {
    const md = renderDigestMd({ ...digest, shipped: [], waiting: [], failures: [] });
    expect(md).toContain("## Shipped\n\nNothing shipped.");
    expect(md).toContain("## Waiting for you\n\nNothing is waiting for you.");
    expect(md).not.toContain("## Failed");
  });
});

describe("a bundle's digest (several issues, one PR)", () => {
  const bundleWave = parseWaveFile(`wave: w2
repo: /path/to/example-repo
release_branch: release/w2
model: claude-opus-5-5
pipeline: [implement, merge_ready]
tasks:
  R: { issue: 310, issues: [310, 312], title: "bundle: #310 + #312" }
  S: { issue: 320 }
`);
  const evs = journal(
    { type: "wave_submitted", data: { wave: bundleWave, owner: "coord-a" } },
    { type: "task_queued", task: "R", data: { issue: 310, issues: [310, 312] } },
    { type: "task_queued", task: "S", data: { issue: 320 } },
    {
      type: "agent_spawned",
      task: "R",
      data: {
        agent_id: "w2-r-implementer-1",
        role: "implementer",
        attempt: 1,
        issue: { number: 310, title: "Retries", url: "u310" },
        issues: [
          { number: 310, title: "Retries", url: "u310" },
          { number: 312, title: "Backoff", url: "u312" },
        ],
      },
    },
    { type: "merged_by_supervisor", task: "R", data: { task: "R", pr: 31, merge_sha: "m-r" } },
    ...merged("R", 31, { via: "supervisor", merge_sha: "m-r" }),
    ...merged("S", 32, { merge_sha: "m-s" }),
  );
  const d = digestOf(evs, reduce(evs), NOW, "wave_complete");

  it("ships one entry per issue of the bundle, sharing its PR", () => {
    expect(d.shipped).toEqual([
      {
        task: "R",
        issue: 310,
        title: "Retries",
        pr: pr(31),
        merge_sha: "m-r",
        merged_by: "supervisor",
      },
      {
        task: "R",
        issue: 312,
        title: "Backoff",
        pr: pr(31),
        merge_sha: "m-r",
        merged_by: "supervisor",
      },
      { task: "S", issue: 320, pr: pr(32), merge_sha: "m-s", merged_by: "github" },
    ]);
    expect(d.closes).toEqual([310, 312, 320]);
    // One PR merged, however many issues it shipped.
    expect(d.auto.merges).toBe(1);
    expect(schemaErrors("digest.schema.json", envelope("_waves/digest", "digest", d))).toEqual([]);
  });

  it("volleyd digest text says `#310 + #312 (one PR)`", () => {
    const md = renderDigestMd(d);
    expect(md).toContain(
      `- R #310 + #312 (one PR): #310 Retries, #312 Backoff; PR #31 ${pr(31).url} (merged by supervisor)`,
    );
    expect(md).toContain(`- S (#320): PR #32 ${pr(32).url} (merged by github)`);
    expect(summaryLine(d)).toMatch(/^w2 complete: 3 shipped/);
  });
});

describe("a merge train in the digest (SPEC §4.6.23)", () => {
  const evs = journal(
    { type: "wave_submitted", data: { wave, owner: "coord-a" } },
    { type: "task_queued", task: "A", data: { issue: 11 } },
    { type: "task_queued", task: "B", data: { issue: 12 } },
    {
      type: "task_queued",
      task: "train-1",
      data: {
        issue: 0,
        synthetic: true,
        title: "Train: #11, #12",
        train: {
          members: [
            { task: "A", pr: 21, head: "a".repeat(40) },
            { task: "B", pr: 22, head: "b".repeat(40) },
          ],
        },
      },
    },
    ...["A", "B"].flatMap((t, i): NewEvent[] => [
      {
        type: "merged_by_supervisor",
        task: t,
        data: { task: t, pr: 21 + i, merge_sha: "m-t", by: "volleyd", via: "train", train_pr: 30 },
      },
      ...merged(t, 21 + i, { via: "train", merge_sha: "m-t" }),
    ]),
    ...merged("train-1", 30, { via: "supervisor", merge_sha: "m-t" }),
  );
  const d = digestOf(evs, reduce(evs), NOW, "wave_complete");

  it("ships each member through its own PR, never the train task itself", () => {
    expect(d.shipped.map((s) => [s.task, s.issue, s.pr.number, s.merged_by])).toEqual([
      ["A", 11, 21, "supervisor"],
      ["B", 12, 22, "supervisor"],
    ]);
    expect(d.closes).toEqual([11, 12]);
  });
});
