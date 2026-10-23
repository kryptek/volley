import { describe, expect, it } from "vitest";
import {
  type IssueView,
  MERGED_LABEL,
  issueLedger,
  issueRows,
  mergedActions,
  mergedMarker,
  parseIssueView,
  releaseActions,
  releasedPr,
  runIssueActions,
  settledMarker,
} from "../src/autopilot/issues";
import type { JournalEvent, NewEvent } from "../src/types";
import { fakeExec } from "./helpers/fake-exec";

/** volleyd owns a wave's issue lifecycle (#416). */

const WAVE = "w1";
const BRANCH = "release/w1";
const AT = "2026-10-22T09:00:00.000Z";

const events = (list: NewEvent[]): JournalEvent[] =>
  list.map((e, i): JournalEvent => ({ ...e, seq: i + 1, at: AT }));

const open = (over: Partial<IssueView> = {}): IssueView => ({
  state: "OPEN",
  labels: [],
  comments: [],
  ...over,
});

describe("mergedActions: a task merged into the release branch", () => {
  it("ensures the label, adds it and comments once with the marker", () => {
    const actions = mergedActions({
      wave: WAVE,
      release_branch: BRANCH,
      issue: 412,
      pr: 418,
      ledger: issueLedger([]),
      view: open(),
    });
    expect(actions).toEqual([
      { kind: "ensure_label" },
      { kind: "add_label", issue: 412 },
      {
        kind: "comment",
        issue: 412,
        marker: mergedMarker(WAVE, 418),
        body: `Merged into \`release/w1\` in PR #418; closes when the release reaches main.\n\n${mergedMarker(WAVE, 418)}`,
      },
    ]);
  });

  it("after a restart: the journal shows both done, nothing is planned", () => {
    const ledger = issueLedger(
      events([
        { type: "issue_labeled", task: "T3", data: { issue: 412, label: MERGED_LABEL, pr: 418 } },
        {
          type: "issue_commented",
          task: "T3",
          data: { issue: 412, marker: mergedMarker(WAVE, 418) },
        },
      ]),
    );
    expect(
      mergedActions({ wave: WAVE, release_branch: BRANCH, issue: 412, pr: 418, ledger }),
    ).toEqual([]);
  });

  it("a journal that lost them: GitHub's label and marker comment are enough", () => {
    const view = open({
      labels: [MERGED_LABEL],
      comments: [`Merged …\n\n${mergedMarker(WAVE, 418)}`],
    });
    expect(
      mergedActions({
        wave: WAVE,
        release_branch: BRANCH,
        issue: 412,
        pr: 418,
        ledger: issueLedger([]),
        view,
      }),
    ).toEqual([]);
  });

  it("a closed issue (closed by hand) is neither labeled nor commented", () => {
    expect(
      mergedActions({
        wave: WAVE,
        release_branch: BRANCH,
        issue: 412,
        pr: 418,
        ledger: issueLedger([]),
        view: open({ state: "CLOSED" }),
      }),
    ).toEqual([]);
  });
});

describe("releaseActions: the release reached main", () => {
  const tasks = [
    { task: "T3", issue: 412, stage: "done" as const, pr: 418 },
    { task: "T4", issue: 413, stage: "cancelled" as const, why: "superseded by T3" },
    { task: "T5", issue: 414, stage: "done" as const, pr: 420 },
    { task: "T6", issue: 415, stage: "queued" as const },
  ];

  it("closes a straggler, removes the label, leaves a cancelled or deferred task's issue open with one comment", () => {
    const views = new Map<number, IssueView>([
      [412, open({ labels: [MERGED_LABEL] })],
      [413, open()],
      [414, open({ state: "CLOSED", labels: [MERGED_LABEL] })],
      [415, open()],
    ]);
    const actions = releaseActions({
      wave: WAVE,
      release_pr: 9,
      tasks,
      ledger: issueLedger([]),
      views,
    });
    expect(actions).toEqual([
      {
        kind: "close",
        issue: 412,
        marker: settledMarker(WAVE, "closed"),
        comment: `closed by the release PR #9 (wave w1)\n\n${settledMarker(WAVE, "closed")}`,
      },
      { kind: "remove_label", issue: 412 },
      {
        kind: "comment",
        issue: 413,
        marker: settledMarker(WAVE, "cancelled"),
        body: `cancelled in wave w1: superseded by T3\n\n${settledMarker(WAVE, "cancelled")}`,
      },
      // Already closed (GitHub applied the release PR's Closes line): the label only.
      { kind: "remove_label", issue: 414 },
      {
        kind: "comment",
        issue: 415,
        marker: settledMarker(WAVE, "deferred"),
        body: `deferred in wave w1: not done when the release reached main (stage queued)\n\n${settledMarker(WAVE, "deferred")}`,
      },
    ]);
    expect(actions.some((a) => a.kind === "close" && a.issue === 413)).toBe(false);
  });

  it("replayed: what the journal or GitHub shows done is not done again", () => {
    const ledger = issueLedger(
      events([
        { type: "issue_closed", task: "T3", data: { issue: 412, release_pr: 9 } },
        { type: "issue_unlabeled", task: "T3", data: { issue: 412, label: MERGED_LABEL } },
      ]),
    );
    const views = new Map<number, IssueView>([
      [412, open({ state: "CLOSED" })],
      [413, open({ comments: [`cancelled …\n\n${settledMarker(WAVE, "cancelled")}`] })],
      [414, open({ state: "CLOSED" })],
      [415, open({ comments: [settledMarker(WAVE, "deferred")] })],
    ]);
    expect(releaseActions({ wave: WAVE, release_pr: 9, tasks, ledger, views })).toEqual([]);
  });

  it("an issue gh could not read is left alone", () => {
    expect(
      releaseActions({
        wave: WAVE,
        release_pr: 9,
        tasks: [tasks[0] as never],
        ledger: issueLedger([]),
        views: new Map(),
      }),
    ).toEqual([]);
  });
});

describe("parseIssueView / releasedPr", () => {
  it("reads gh issue view --json state,labels,comments", () => {
    const out = JSON.stringify({
      state: "OPEN",
      labels: [{ name: MERGED_LABEL }, { name: "bug" }],
      comments: [{ body: "hi" }],
    });
    expect(parseIssueView(out)).toEqual({
      state: "OPEN",
      labels: [MERGED_LABEL, "bug"],
      comments: ["hi"],
    });
    expect(parseIssueView("")).toBeNull();
    expect(parseIssueView("{}")).toBeNull();
  });

  it("the merged release PR: one whose base is not another release branch", () => {
    expect(releasedPr(JSON.stringify([{ number: 9, baseRefName: "main" }]))).toBe(9);
    expect(releasedPr("[]")).toBeNull();
    expect(releasedPr("nope")).toBeNull();
  });
});

describe("issueRows: volleyd issues <wave>", () => {
  it("one line per task: merged-to-release, closed, open, cancelled, deferred", () => {
    const ledger = issueLedger(
      events([
        { type: "issue_labeled", task: "T3", data: { issue: 412, label: MERGED_LABEL, pr: 418 } },
        { type: "issue_labeled", task: "T5", data: { issue: 414, label: MERGED_LABEL, pr: 420 } },
        { type: "issue_closed", task: "T5", data: { issue: 414, release_pr: 9 } },
      ]),
    );
    const rows = issueRows(
      [
        { task: "T3", issue: 412, stage: "done", pr: 418 },
        { task: "T5", issue: 414, stage: "done", pr: 420 },
        { task: "T2", issue: 411, stage: "implement" },
        { task: "T4", issue: 413, stage: "cancelled", why: "dup" },
      ],
      ledger,
      { released: false },
    );
    expect(rows.map((r) => r.line)).toEqual([
      "T3 #412 merged-to-release (PR #418)",
      "T5 #414 closed (PR #420)",
      "T2 #411 open",
      "T4 #413 cancelled: dup",
    ]);
    const after = issueRows(
      [
        { task: "T2", issue: 411, stage: "implement" },
        { task: "T3", issue: 412, stage: "done", pr: 418 },
      ],
      ledger,
      { released: true },
    );
    expect(after.map((r) => r.state)).toEqual(["deferred", "closed"]);
  });
});

describe("runIssueActions: the gh runner", () => {
  it("creates the label only when gh label list lacks it, and journals what it did", async () => {
    const fake = fakeExec().on(["gh", "label", "list"], { stdout: "[]" });
    const actions = mergedActions({
      wave: WAVE,
      release_branch: BRANCH,
      issue: 412,
      pr: 418,
      ledger: issueLedger([]),
      view: open(),
    });
    const r = await runIssueActions(fake.exec, "/path/to/repo", actions, { task: "T3", pr: 418 });
    expect(fake.argvs(["gh"]).map((a) => a.slice(1, 3).join(" "))).toEqual([
      "label list",
      "label create",
      "issue edit",
      "issue comment",
    ]);
    expect(r.failed).toEqual([]);
    expect(r.events.map((e) => e.type)).toEqual(["issue_labeled", "issue_commented"]);
    expect(r.events[0]).toEqual({
      type: "issue_labeled",
      task: "T3",
      data: { issue: 412, label: MERGED_LABEL, pr: 418 },
    });
  });

  it("a label that exists is not created; a failed write is reported, not journaled", async () => {
    const fake = fakeExec()
      .on(["gh", "label", "list"], { stdout: JSON.stringify([{ name: MERGED_LABEL }]) })
      .on(["gh", "issue", "comment"], { code: 1, stderr: "HTTP 502" });
    const actions = mergedActions({
      wave: WAVE,
      release_branch: BRANCH,
      issue: 412,
      pr: 418,
      ledger: issueLedger([]),
      view: open(),
    });
    const r = await runIssueActions(fake.exec, "/path/to/repo", actions, { task: "T3", pr: 418 });
    expect(fake.argvs(["gh", "label", "create"])).toEqual([]);
    expect(r.events.map((e) => e.type)).toEqual(["issue_labeled"]);
    expect(r.failed).toEqual([expect.stringContaining("HTTP 502")]);
  });
});
