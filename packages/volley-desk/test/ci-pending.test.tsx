import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ciPending, ciStuck, waveAttention } from "../src/attention";
import { initialState, reduceAll } from "../src/store/reducer";
import { WaveWindow } from "../src/windows/wave/WaveWindow";
import { NOW, S, registry, status, waveMsg, waveState, waveView } from "./helpers/desk-msgs";

const WHY = "CI pending on abc1234 (2/5 checks)";

const state = () =>
  waveState({
    owner: "coord-1",
    tasks: [
      {
        id: "T1",
        issue: 1,
        stage: "implement",
        agents: { implementer: "impl-1" },
        why_waiting: WHY,
        pr: {
          number: 12,
          url: "https://example.invalid/pr/12",
          head_sha: "abc1234",
          ci: "running",
        },
      },
      { id: "T2", issue: 2, stage: "queued", agents: {} },
    ],
    spec: { version: 1, tasks: { T1: { issue: 1, after: [] }, T2: { issue: 2, after: ["T1"] } } },
  });

const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

describe("CI pending", () => {
  it("is read from the task's why_waiting", () => {
    const [t1, t2] = state().tasks;
    expect(t1 && ciPending(t1)).toBe(true);
    expect(t2 && ciPending(t2)).toBe(false);
  });

  it("covers all four of volleyd's hold wordings, and nothing else", () => {
    const t = (why_waiting: string) => ({
      id: "T1",
      issue: 1,
      stage: "implement" as const,
      agents: {},
      why_waiting,
    });
    for (const why of [
      "CI pending on abc1234 (2/5 runs)",
      "CI 21/22 · running: x",
      "CI unreadable (no answer), retrying",
      "CI infra incident: x; re-checking",
    ]) {
      expect(ciPending(t(why))).toBe(true);
    }
    expect(ciPending(t("CI flake in t: fixer pending"))).toBe(false);
    expect(ciPending(t("after: T1"))).toBe(false);
  });

  it("the wave window shows the 'waiting for CI' chip and the task row with why_waiting and its pipeline", () => {
    render(<WaveWindow wave={waveView(state())} me={null} now={NOW} frame={frame} />);
    const win = screen.getByRole("region", { name: "w1" });
    expect(win.querySelector(".win-title .chip--ci")).toHaveTextContent("waiting for CI");
    const row = within(win).getByRole("listitem", { name: "T1 CI pending" });
    expect(row).toHaveTextContent(WHY);
    expect(row).toHaveTextContent("implement ✓ · CI ⟳ · review");
    // The graph node no longer reads as a plain `implementing`.
    const node = win.querySelector('.dag-node[data-id="T1"]');
    expect(node?.querySelector(".dag-stage")).toHaveTextContent(/^CI pending$/);
    expect(node?.getAttribute("title")).toContain("waiting for CI");
  });

  it("no live agent and no stall tier: the retired implementer is not a no-signal item", () => {
    const s = reduceAll(initialState(), [
      waveMsg(state()),
      registry("coord-1", NOW - 600 * S),
      status("coord-1", "working", NOW - 5 * S),
      registry("impl-1", NOW - 900 * S),
      status("impl-1", "done", NOW - 300 * S),
    ]);
    const w = s.waves.w1;
    if (!w) throw new Error("no wave");
    const tier = waveAttention(w, {
      now: NOW,
      agents: s.agents,
      coordinators: s.coordinators,
    }).tier;
    expect(["info", "none"]).toContain(tier);
  });

  it("no chip when nothing waits for CI", () => {
    render(<WaveWindow wave={waveView(waveState())} me={null} now={NOW} frame={frame} />);
    expect(screen.queryAllByText("waiting for CI")).toHaveLength(0);
  });

  describe("jobs (#415)", () => {
    const JOBS = "CI 3/13 · running: Backend IT shard 2–6/6 · ~8 min left";
    const jobsState = (o: { last_done_at: string; slowest_s?: number }) =>
      waveState({
        owner: "coord-1",
        tasks: [
          {
            id: "T1",
            issue: 1,
            stage: "implement",
            agents: {},
            why_waiting: JOBS,
            pr: {
              number: 12,
              url: "https://example.invalid/pr/12",
              head_sha: "abc1234",
              ci: "running",
              jobs: {
                done: 3,
                total: 13,
                running: ["Backend IT shard 2/6"],
                failed: [],
                ...o,
              },
              eta_s: 480,
            },
          },
        ],
        spec: { version: 1, tasks: { T1: { issue: 1, after: [] } } },
      });
    const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

    it("a job-counted hold is CI pending; the graph label and the row show the job text", () => {
      const s = jobsState({ last_done_at: ago(2), slowest_s: 900 });
      const [t1] = s.tasks;
      expect(t1 && ciPending(t1)).toBe(true);
      render(<WaveWindow wave={waveView(s)} me={null} now={NOW} frame={frame} />);
      const win = screen.getByRole("region", { name: "w1" });
      const node = win.querySelector('.dag-node[data-id="T1"]');
      expect(node?.querySelector(".dag-stage")).toHaveTextContent(/^CI · 3\/13$/);
      expect(node?.getAttribute("title")).toContain("waiting for CI · 3/13 jobs");
      const row = within(win).getByRole("listitem", { name: "T1 CI pending" });
      expect(row).toHaveTextContent(JOBS);
      expect(row).not.toHaveTextContent("possibly stuck");
    });

    it("no job finished for longer than the slowest job's last duration: possibly stuck, in plain words", () => {
      const s = jobsState({ last_done_at: ago(25), slowest_s: 900 });
      const [t1] = s.tasks;
      expect(t1 && ciStuck(t1, NOW)).toBe(
        "possibly stuck: no job finished for 25 min (the slowest usually takes 15 min)",
      );
      render(<WaveWindow wave={waveView(s)} me={null} now={NOW} frame={frame} />);
      const row = within(screen.getByRole("region", { name: "w1" })).getByRole("listitem", {
        name: "T1 CI pending",
      });
      expect(row).toHaveTextContent(
        "possibly stuck: no job finished for 25 min (the slowest usually takes 15 min)",
      );
    });

    it("without a known duration nothing is called stuck", () => {
      const [t1] = jobsState({ last_done_at: ago(120) }).tasks;
      expect(t1 && ciStuck(t1, NOW)).toBeUndefined();
    });
  });

  describe("retired implementer (#451)", () => {
    const HOLD = "CI 21/22 · running: Backend IT shard 6/6 · ~3 min left";
    const held = (why?: string, jobs = true) =>
      waveState({
        owner: "coord-1",
        tasks: [
          {
            id: "T1",
            issue: 1,
            stage: "implement",
            agents: { implementer: "impl-1" },
            ...(why ? { why_waiting: why } : {}),
            pr: {
              number: 12,
              url: "https://example.invalid/pr/12",
              head_sha: "abc1234",
              ci: "running",
              ...(jobs
                ? { jobs: { done: 21, total: 22, running: ["Backend IT shard 6/6"], failed: [] } }
                : {}),
            },
          },
        ],
        spec: { version: 1, tasks: { T1: { issue: 1, after: [] } } },
      });
    const renderWith = (st: ReturnType<typeof held>, impl: "done" | "working") => {
      const s = reduceAll(initialState(), [
        waveMsg(st),
        registry("impl-1", NOW - 900 * S),
        status("impl-1", impl, NOW - 300 * S),
      ]);
      const w = s.waves.w1;
      if (!w) throw new Error("no wave");
      render(<WaveWindow wave={w} me={null} now={NOW} frame={frame} agents={s.agents} />);
      return screen.getByRole("region", { name: "w1" });
    };

    it("the node and the task line say waiting for CI with the job count, never implementing", () => {
      const win = renderWith(held(HOLD), "done");
      expect(win.querySelector('.dag-node[data-id="T1"] .dag-stage')).toHaveTextContent(
        /^CI · 21\/22$/,
      );
      const row = within(win).getByRole("listitem", { name: "T1 CI pending" });
      expect(row).toHaveTextContent("waiting for CI · 21/22 jobs");
      expect(
        win.querySelector('.rail-seg[title="T1 · waiting for CI · 21/22 jobs"]'),
      ).not.toBeNull();
    });

    it("an unreadable CI poll still reads waiting for CI", () => {
      const win = renderWith(held("CI unreadable (no answer), retrying", false), "done");
      expect(win.querySelector('.dag-node[data-id="T1"] .dag-stage')).toHaveTextContent(
        /^CI pending$/,
      );
    });

    it("a running implementer reads implementing, with no CI row", () => {
      const win = renderWith(held(undefined), "working");
      expect(win.querySelector('.dag-node[data-id="T1"] .dag-stage')).toHaveTextContent(
        /^implementing$/,
      );
      expect(within(win).queryByRole("listitem", { name: "T1 CI pending" })).toBeNull();
    });
  });
});
