import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type EvidenceJson, evidenceJson, renderEvidenceMd } from "../src/evidence";
import { apply, emptyRecord } from "../src/reducer";
import { ready } from "../src/scheduler";
import type { JournalEvent, NewEvent } from "../src/types";
import { parseWaveFile } from "../src/wave-file";
import { FIXTURES } from "./helpers/fake-host";
import { type Harness, pipelineHarness, sha } from "./helpers/pipeline-harness";
import { schemaErrors } from "./helpers/schema";

const result = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, "review-results", `${name}.json`), "utf-8"));
const H1 = sha(0x1001);
const H2 = sha(0x1002);

let h: Harness;
afterEach(() => h?.cleanup());

/** One task through the default pipeline to the gate. */
async function gated() {
  h = pipelineHarness();
  await h.start();
  h.openPr(H1);
  await h.finish("implementer", { head: H1, ci: "green" });
  await h.finish("spec_reviewer", { result: result("spec-p1") });
  await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });
  await h.finish("fixup", { head: H2, ci: "green", result: result("fixup-resolved") });
}

describe("merge-ready evidence package", () => {
  it("md + json carry the PR url, head sha, CI links, findings with resolutions, diffstat, current-with-release line", async () => {
    await gated();
    const task = h.task();
    expect(task?.stage).toBe("merge_ready");
    const md = task?.evidence_path as string;
    expect(md).toBe(join(h.home, "waves", "w1", "evidence", "T1.md"));
    const text = readFileSync(md, "utf-8");
    const json = JSON.parse(readFileSync(md.replace(/\.md$/, ".json"), "utf-8")) as EvidenceJson;

    expect(text).toContain("https://github.com/example/repo/pull/7");
    expect(text).toContain(H2);
    expect(text).toContain("https://github.com/example/repo/actions/runs/1002");
    expect(text).toContain("CI on this exact head: **green**");
    expect(text).toContain("Branch current with release branch: yes");
    expect(text).toMatch(/S1 · P1.*Empty batches.*resolved: Return early on an empty batch/);
    expect(text).toMatch(/Q1 · P1.*Retries forever.*resolved: Stop retrying on 4xx/);
    expect(text).toContain("1 file changed");
    expect(text).toContain("volleyd never merges");

    expect(json).toMatchObject({
      pr_url: "https://github.com/example/repo/pull/7",
      head_sha: H2,
      ci: { status: "green", runs: [{ url: "https://github.com/example/repo/actions/runs/1002" }] },
      unresolved_p1: [],
      current_with_release_branch: true,
      behind_by: 0,
      fixups: [{ round: 1, from: H1, to: H2, diffstat: expect.stringContaining("1 file changed") }],
    });
    expect(json.reviews.spec_reviewer?.findings[0]).toMatchObject({
      id: "S1",
      severity: "P1",
      resolution: "Return early on an empty batch; test added.",
    });
    // The fixup's diffstat is read for exactly its own range.
    expect(h.calls).toContainEqual(["git", "-C", "/wt/w1/T1-fixup-1", "diff", "--stat", H1, H2]);
  });

  it("a run superseded on the gated head is listed under ci.superseded, not ci.runs", async () => {
    h = pipelineHarness();
    await h.start();
    h.openPr(H1);
    h.world.ciRuns[H1] = [
      { status: "completed", conclusion: "cancelled", id: 1201, workflow: "CI" },
      { status: "completed", conclusion: "success", id: 1202, workflow: "CI" },
    ];
    await h.finish("implementer", { head: H1 });
    expect(h.openDecisions()).toEqual([]);
    await h.finish("spec_reviewer", { result: result("spec-p1") });
    await h.finish("quality_reviewer", { result: result("quality-p1-elsewhere") });
    h.world.ciRuns[H2] = h.world.ciRuns[H1];
    await h.finish("fixup", { head: H2, result: result("fixup-resolved") });
    const md = h.task()?.evidence_path as string;
    const json = JSON.parse(readFileSync(md.replace(/\.md$/, ".json"), "utf-8")) as EvidenceJson;
    expect(json.ci).toEqual({
      status: "green",
      runs: [expect.objectContaining({ id: 1202 })],
      superseded: [
        {
          id: 1201,
          url: "https://github.com/example/repo/actions/runs/1201",
          conclusion: "cancelled",
        },
      ],
    });
    expect(readFileSync(md, "utf-8")).toContain(
      "superseded (not this head's CI): cancelled — https://github.com/example/repo/actions/runs/1201",
    );
  });

  it("wave state gets gates: ['T1'] and the evidence_path, and stays schema-valid", async () => {
    await gated();
    const state = h.record().state;
    expect(state?.gates).toEqual(["T1"]);
    expect(state?.tasks[0]?.evidence_path).toMatch(/evidence\/T1\.md$/);
    expect(
      schemaErrors("wave-state.schema.json", {
        schema_version: "0.1",
        agent_id: "volleyd",
        parent_id: null,
        wall_time: "2026-10-18T12:00:00.000Z",
        channel: "_waves/state",
        type: "wave_state",
        payload: state,
        correlation_id: null,
      }),
    ).toEqual([]);
  });

  it("an unresolved P1 and a branch behind the release branch are stated plainly", () => {
    const j = evidenceJson({
      wave: "w1",
      task: "T1",
      issue: 42,
      pr: { number: 7, url: "https://github.com/example/repo/pull/7" },
      head: H2,
      branch: "w1/T1-implementer-1",
      release_branch: "release/w1",
      ci: "green",
      ci_runs: [],
      reviews: {
        spec_reviewer: { round: 1, head: H1, result: result("spec-p1") as never },
      },
      fixups: [],
      rebases: [],
      release: { release_sha: sha(9), merge_base: sha(8), behind: 3 },
      merge: "manual",
      generated_at: "2026-10-18T12:00:00.000Z",
    });
    expect(j.unresolved_p1).toEqual(["S1"]);
    const md = renderEvidenceMd(j);
    expect(md).toContain("Branch current with release branch: no (behind by 3)");
    expect(md).toMatch(/S1 · P1.*UNRESOLVED/);
    expect(md).toContain("No fixup ran");
  });

  it("with the task's base_sha, the release-branch line says where it was cut from and how far behind", () => {
    const base = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    const j = evidenceJson({
      wave: "w1",
      task: "T1",
      issue: 42,
      pr: { number: 7, url: "https://github.com/example/repo/pull/7" },
      head: H2,
      branch: "w1/T1-implementer-1",
      release_branch: "release/w1",
      ci: "green",
      ci_runs: [],
      reviews: {},
      fixups: [],
      rebases: [],
      base_sha: base,
      release: { release_sha: sha(9), merge_base: sha(8), behind: 2 },
      merge: "manual",
      generated_at: "2026-10-18T12:00:00.000Z",
    });
    expect(j).toMatchObject({ base_sha: base, behind_by: 2, current_with_release_branch: false });
    expect(renderEvidenceMd(j)).toContain(
      "Branch current with release branch: no — cut from 4b825dc, 2 behind",
    );
  });

  it("a move the owner accepted as a merge of the release branch only says so", () => {
    const j = evidenceJson({
      wave: "w1",
      task: "T1",
      issue: 42,
      pr: { number: 7, url: "https://github.com/example/repo/pull/7" },
      head: H2,
      branch: "w1/T1-implementer-1",
      release_branch: "release/w1",
      ci: "green",
      ci_runs: [],
      reviews: {},
      fixups: [],
      rebases: [],
      moves: [
        {
          from: H1,
          to: H2,
          touched: ["CHANGELOG.md"],
          accepted_by: "owner",
          how: "release_merge",
          parent: sha(9),
        },
      ],
      release: { release_sha: sha(9), merge_base: sha(9), behind: 0 },
      merge: "manual",
      generated_at: "2026-10-18T12:00:00.000Z",
    });
    expect(j.moves[0]).toMatchObject({ how: "release_merge", accepted_by: "owner" });
    expect(renderEvidenceMd(j)).toContain(
      "Accepted by owner: a merge of the release branch only (touched: CHANGELOG.md; they may carry content resolved by hand, which no reviewer saw).",
    );
  });

  it("a gated task's package carries the base its implementer's worktree was cut from", async () => {
    await gated();
    const base = h.task()?.base_sha as string;
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    const md = readFileSync(h.task()?.evidence_path as string, "utf-8");
    expect(md).toContain(
      `Branch current with release branch: yes — cut from ${base.slice(0, 7)}, 0 behind`,
    );
    const json = JSON.parse(
      readFileSync((h.task()?.evidence_path as string).replace(/\.md$/, ".json"), "utf-8"),
    ) as EvidenceJson;
    expect(json.base_sha).toBe(base);
  });
});

describe("done releases dependents", () => {
  it("a task entering done (merged) makes the task after it ready", () => {
    const wave = parseWaveFile(
      "wave: w2\nrepo: /r\nrelease_branch: rel\nmodel: m\npipeline: [implement, merge_ready]\ntasks:\n  A: { issue: 1 }\n  B: { issue: 2, after: [A] }\n",
    );
    let rec = emptyRecord();
    let seq = 0;
    const add = (ev: NewEvent) => {
      rec = apply(rec, { ...ev, seq: ++seq, at: "2026-10-18T12:00:00.000Z" } as JournalEvent);
    };
    add({ type: "wave_submitted", data: { wave, owner: null } });
    add({ type: "task_queued", task: "A", data: {} });
    add({ type: "task_queued", task: "B", data: {} });
    add({ type: "task_admitted", task: "A", data: {} });
    add({ type: "stage_entered", task: "A", data: { stage: "merge_ready" } });
    expect(ready(rec)).toEqual([]);
    expect(rec.state?.tasks.find((t) => t.id === "B")?.waiting_on).toEqual(["A"]);
    add({ type: "stage_entered", task: "A", data: { stage: "done", merged: true } });
    expect(ready(rec)).toEqual(["B"]);
  });
});
