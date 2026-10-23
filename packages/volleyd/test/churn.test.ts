import { describe, expect, it } from "vitest";
import {
  churnFuse,
  churnOf,
  fuseQuietUntil,
  strategyFor,
  strategySwitch,
} from "../src/autopilot/churn";
import { DAEMON_DEFAULTS } from "../src/config-defaults";
import { replay } from "../src/reducer";
import type { JournalEvent, NewEvent, PlanCluster } from "../src/types";
import { parseWaveFile } from "../src/wave-file";

const capped = (id: string, issue: number) =>
  `  ${id}: { issue: ${issue}, files: [src/hot.ts], plan: { cluster: A, by: cap, why: "capped" } }\n`;
const wave = parseWaveFile(
  `wave: wc\nrepo: r\nrelease_branch: release/wc\nmodel: m\npipeline: [implement, spec_review, merge_ready]\ntasks:\n${["a1", "a2", "a3", "a4", "a5"].map((id, i) => capped(id, i + 1)).join("")}  u1: { issue: 9, files: [src/other.ts] }\n`,
);

const T0 = Date.parse("2026-10-23T09:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** The wave's journal from un-sequenced events, each at its `at` (default: T0). */
function journal(extra: NewEvent[]): JournalEvent[] {
  const evs: NewEvent[] = [
    { type: "wave_submitted", data: { wave, owner: null } },
    ...wave.task_order.map((id): NewEvent => ({ type: "task_queued", task: id, data: {} })),
    { type: "wave_planned", data: { clusters: wave.overlap_plan?.clusters ?? [] } },
    ...extra,
  ];
  return evs.map((e, i): JournalEvent => ({ ...e, seq: i + 1, at: e.at ?? iso(T0) }));
}

const start = (task: string): NewEvent[] => [
  { type: "task_admitted", task, data: {} },
  { type: "agent_spawned", task, data: { role: "implementer", agent_id: `${task}-1` } },
  { type: "stage_entered", task, data: { stage: "implement" } },
];
const update = (task: string, at = T0): NewEvent => ({
  type: "stage_entered",
  task,
  at: iso(at),
  data: { stage: "fixup", step: 1, roles: ["rebase"], rebase: true },
});
const review = (task: string, at = T0): NewEvent => ({
  type: "stage_entered",
  task,
  at: iso(at),
  data: { stage: "spec_review" },
});
const gate = (task: string): NewEvent => ({
  type: "stage_entered",
  task,
  data: { stage: "merge_ready" },
});
const merged = (task: string, at = T0): NewEvent[] => [
  { type: "merged_by_supervisor", task, at: iso(at), data: {} },
  { type: "stage_entered", task, at: iso(at), data: { stage: "done", merged: true } },
];

const churn = (extra: NewEvent[], now = T0 + HOUR) => {
  const evs = journal(extra);
  const rec = replay(evs);
  const cluster = rec.state?.overlap_plan?.clusters[0] as PlanCluster;
  return { rec, evs, cluster, c: churnOf(rec, evs, now), now };
};

describe("churnOf (#384)", () => {
  it("counts each task's branch updates and the reviews after one", () => {
    const { c } = churn([
      ...start("a1"),
      review("a1"),
      update("a1"),
      review("a1"),
      update("a1"),
      ...start("a2"),
    ]);
    expect(c.tasks.a1).toEqual({ updates: 2, updates_in_window: 2, rereviews: 1 });
    expect(c.tasks.a2).toEqual({ updates: 0, updates_in_window: 0, rereviews: 0 });
  });

  it("per cluster: gated, in flight, merges and updates in the last 2 h", () => {
    const { c } = churn(
      [
        ...start("a1"),
        ...start("a2"),
        ...start("a3"),
        gate("a3"),
        update("a1", T0 - 3 * HOUR),
        update("a2", T0),
        ...start("a4"),
        ...merged("a4", T0 + HOUR / 2),
        ...start("a5"),
        ...merged("a5", T0 - 2 * HOUR),
      ],
      T0 + HOUR,
    );
    expect(c.clusters.A).toEqual({
      gated: 1,
      in_flight: 2,
      merges_in_window: 1,
      updates_in_window: 1,
    });
  });
});

describe("strategyFor (#384)", () => {
  it("0 or 1 updates and nothing gated: planned", () => {
    expect(strategyFor(churn([]).cluster, churn([]).c).strategy).toBe("planned");
    const one = churn([...start("a1"), update("a1")]);
    expect(strategyFor(one.cluster, one.c).strategy).toBe("planned");
  });

  it("a member with 2 updates: hold, naming it", () => {
    const two = churn([...start("a1"), update("a1"), update("a1")]);
    expect(strategyFor(two.cluster, two.c)).toEqual({
      strategy: "hold",
      why: "a1 updated its branch 2 times in the last 2 h",
    });
  });

  it("a live member's 2 updates outside the window: no hold, back to planned (Q1)", () => {
    const old = churn([...start("a1"), update("a1", T0 - 3 * HOUR), update("a1", T0 - 2 * HOUR)]);
    expect(old.c.tasks.a1).toEqual({ updates: 2, updates_in_window: 0, rereviews: 0 });
    const held = { ...old.cluster, state: "hold" as const };
    expect(strategyFor(held, old.c)).toEqual({
      strategy: "planned",
      why: "nothing gated, no branch update in the last 2 h",
    });
  });

  it("3 gated and fewer than 2 merges in 2 h: hold; with 2 merges: train", () => {
    const three = ["a1", "a2", "a3"].flatMap((id) => [...start(id), gate(id)]);
    const slow = churn([...three, ...start("a4"), ...merged("a4", T0)]);
    expect(strategyFor(slow.cluster, slow.c)).toEqual({
      strategy: "hold",
      why: "3 gated, 1 merge in the last 2 h",
    });
    const fast = churn([
      ...three,
      ...start("a4"),
      ...merged("a4"),
      ...start("a5"),
      ...merged("a5"),
    ]);
    expect(strategyFor(fast.cluster, fast.c)).toEqual({ strategy: "train", why: "3 gated" });
  });

  it("2 gated: train", () => {
    const two = churn(["a1", "a2"].flatMap((id) => [...start(id), gate(id)]));
    expect(strategyFor(two.cluster, two.c)).toEqual({ strategy: "train", why: "2 gated" });
  });

  it("a held cluster with 1 gated or a recent update stays held; back to planned when calm", () => {
    const held: NewEvent = {
      type: "cluster_strategy_changed",
      data: { cluster: "A", from: "cap", to: "hold", why: "x" },
    };
    // a1 updated twice and merged: no live member churns, but one is gated.
    const stay = churn([
      ...start("a1"),
      update("a1"),
      update("a1"),
      ...merged("a1"),
      ...start("a2"),
      gate("a2"),
      held,
    ]);
    expect(stay.cluster.state).toBe("hold");
    expect(strategyFor(stay.cluster, stay.c).strategy).toBe("hold");
    const calm = churn(
      [...start("a1"), update("a1", T0), update("a1", T0), ...merged("a1"), held],
      T0 + 3 * HOUR,
    );
    expect(strategyFor(calm.cluster, calm.c)).toEqual({
      strategy: "planned",
      why: "nothing gated, no branch update in the last 2 h",
    });
  });
});

describe("strategySwitch (#384): the journaled change, with hysteresis", () => {
  const MIN = DAEMON_DEFAULTS.cluster_strategy_min_interval_ms;
  const trip = [...start("a1"), update("a1"), update("a1")];

  it("a change names the plan's strategy as `from` (planned) and the new one as `to`", () => {
    const { cluster, c, evs, now } = churn(trip);
    expect(strategySwitch(cluster, c, evs, now, MIN)).toEqual({
      from: "cap",
      to: "hold",
      why: "a1 updated its branch 2 times in the last 2 h",
    });
  });

  it("no change: null", () => {
    const { cluster, c, evs, now } = churn([...start("a1")]);
    expect(strategySwitch(cluster, c, evs, now, MIN)).toBeNull();
  });

  it("changes at most once per min interval", () => {
    const changed: NewEvent = {
      type: "cluster_strategy_changed",
      at: iso(T0),
      data: { cluster: "A", from: "cap", to: "train", why: "2 gated" },
    };
    const soon = churn([...trip, changed], T0 + MIN - 1);
    expect(soon.cluster.state).toBe("train");
    expect(strategySwitch(soon.cluster, soon.c, soon.evs, soon.now, MIN)).toBeNull();
    const later = churn([...trip, changed], T0 + MIN);
    expect(strategySwitch(later.cluster, later.c, later.evs, later.now, MIN)).toEqual({
      from: "train",
      to: "hold",
      why: "a1 updated its branch 2 times in the last 2 h",
    });
  });
});

describe("churnFuse (#387): hold the cluster, then ask once", () => {
  const fuse = (o: Partial<Parameters<typeof churnFuse>[0]> = {}) =>
    churnFuse({ churn: 0, roles: 2, held: false, quietUntil: 0, open: false, ...o });
  const max = DAEMON_DEFAULTS.churn_roles_multiple_max;

  it("quiet up to churn_roles_multiple_max × the task's pipeline roles", () => {
    expect(fuse({ churn: max * 2 })).toBeNull();
  });

  it("over it: hold the cluster; already on hold: decide; never a second open decision", () => {
    expect(fuse({ churn: max * 2 + 1 })).toBe("hold");
    expect(fuse({ churn: max * 2 + 1, held: true })).toBe("decide");
    expect(fuse({ churn: max * 2 + 5, held: true, open: true })).toBeNull();
  });

  it("acts once per new churn spawn: quiet until its churn passes quietUntil", () => {
    expect(fuse({ churn: 7, held: true, quietUntil: 7 })).toBeNull();
    expect(fuse({ churn: 8, held: true, quietUntil: 7 })).toBe("decide");
  });

  it("fuseQuietUntil: the limit, then the churn at the last trip; a continue adds the limit", () => {
    const at = "2026-10-23T09:00:00.000Z";
    const evs = (extra: NewEvent[]): JournalEvent[] =>
      extra.map((e, i) => ({ ...e, seq: i + 1, at }));
    expect(fuseQuietUntil([], "a1", 6)).toBe(6);
    const held: NewEvent = {
      type: "cluster_strategy_changed",
      task: "a1",
      data: { cluster: "A", from: "cap", to: "hold", why: "x", churn: 7 },
    };
    expect(fuseQuietUntil(evs([held]), "a1", 6)).toBe(7);
    expect(fuseQuietUntil(evs([held]), "a2", 6)).toBe(6);
    const asked: NewEvent = {
      type: "decision_opened",
      task: "a1",
      data: {
        decision_id: "d1",
        kind: "churn_exhausted",
        cluster: "A",
        churn: 8,
        roles: ["rebase"],
      },
    };
    expect(fuseQuietUntil(evs([held, asked]), "a1", 6)).toBe(8);
    const cont: NewEvent = {
      type: "decision_resolved",
      task: "a1",
      data: { decision_id: "d1", answer: "continue", by: "o" },
    };
    expect(fuseQuietUntil(evs([held, asked, cont]), "a1", 6)).toBe(14);
  });
});
