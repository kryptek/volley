import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import type { MachineRecord } from "../src/machines";
import {
  type MachineView,
  type PlaceOptions,
  type Snapshot,
  type VerdictView,
  needsPlacement,
  place,
  preview,
  reserve,
  snapshotFrom,
} from "../src/placement";
import { parseWaveFile } from "../src/wave-file";

/**
 * Placement (SPEC §4.6.15) as a pure function: eligibility with its one-line reasons, the
 * weighted-headroom score, the ranking, and in-tick reservations.
 */

const LOCAL = "control";

const record = (name: string, over: Partial<MachineRecord> = {}): MachineRecord => ({
  name,
  os: "linux",
  cores: 16,
  tunnel: "up",
  load: [3.2, 3, 2],
  agents: 0,
  memory: { total_mb: 65536, available_pct: 71 },
  disk: { path: "/srv", free_gb: 200, free_pct: 50 },
  last_seen: "2026-10-19T09:00:00.000Z",
  ...over,
});

/** A ready, idle machine; `over` changes any field. */
const machine = (name: string, over: Partial<MachineView> = {}): MachineView => ({
  name,
  local: name === LOCAL,
  record: record(name, name === LOCAL ? { tunnel: "local" } : {}),
  ready: true,
  reasons: [],
  drain: false,
  max_agents: name === LOCAL ? 12 : 4,
  agents: 0,
  heavy: {},
  usage_pct: 34,
  held: [],
  ...over,
});

const snap = (...machines: MachineView[]): Snapshot => ({ machines, reservations: {} });

const OPTS: PlaceOptions = {
  placement: CONFIG_DEFAULTS.placement,
  warn_at_pct: CONFIG_DEFAULTS.claude.warn_at_pct,
  localName: LOCAL,
};

const wave = (extra = "", tasks = "  T1: { issue: 1 }\n  T2: { issue: 2 }\n") =>
  parseWaveFile(
    `wave: w1\nrepo: /srv/repo\nrelease_branch: release/w1\nmodel: m\npipeline: [implement]\n${extra}tasks:\n${tasks}`,
  );
const AUTO = wave("placement: auto\n");

const task = (w = AUTO, id = "T1") => {
  const t = w.tasks[id];
  if (t === undefined) throw new Error(`no task ${id}`);
  return t;
};

describe("placement defaults", () => {
  it("are SPEC §4.6.15's", () => {
    expect(CONFIG_DEFAULTS.placement).toMatchObject({
      load_per_core_max: 1.5,
      mem_available_min_pct: 10,
      disk_free_min_gb: 5,
      weights: { cpu: 40, slots: 30, mem: 15, usage: 15 },
    });
  });
});

describe("needsPlacement", () => {
  it("is true for host: auto and for unpinned tasks of a placement: auto wave only", () => {
    expect(needsPlacement(task(AUTO))).toBe(true);
    expect(needsPlacement(task(wave()))).toBe(false);
    expect(needsPlacement(task(wave("", "  T1: { issue: 1, host: auto }\n")))).toBe(true);
    expect(
      needsPlacement(task(wave("placement: auto\n", "  T1: { issue: 1, host: box-a }\n"))),
    ).toBe(false);
  });
});

describe("place: scoring", () => {
  it("two eligible machines: the less loaded wins, with the documented score to two decimals", () => {
    const a = machine("box-a", { agents: 1 });
    const b = machine("box-b", { record: record("box-b", { load: [16, 15, 14] }), agents: 1 });
    const r = place(task(), AUTO, snap(b, a), OPTS);
    // cpu 1 - (3.2/16)/1.5 = 0.8667, slots 3/4, mem 0.71, usage 0.66, weights 40/30/15/15:
    // (34.67 + 22.5 + 10.65 + 9.9) / 100 = 0.78.
    expect(r).toMatchObject({ host: "box-a", local: false, by: "auto", score: 0.78 });
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates.map((c) => [c.host, c.score])).toEqual([
      ["box-a", 0.78],
      // cpu 1 - (16/16)/1.5 = 0.3333: (13.33 + 22.5 + 10.65 + 9.9) / 100 = 0.56.
      ["box-b", 0.56],
    ]);
    expect(r.candidates[0]?.line).toBe("load 3.2 on 16 cores · 1/4 agents · 71% mem · usage 34%");
  });

  it("a weight of 0 drops its headroom; unknown usage is left out and the weights renormalised", () => {
    const r = place(task(), AUTO, snap(machine("box-a", { usage_pct: null })), OPTS);
    // (34.67 + 30 + 10.65) / 85 = 0.886
    expect(r).toMatchObject({ host: "box-a", score: 0.89 });
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates[0]?.line).toBe(
      "load 3.2 on 16 cores · 0/4 agents · 71% mem · usage unknown",
    );

    const cpuOnly: PlaceOptions = {
      ...OPTS,
      placement: { ...OPTS.placement, weights: { cpu: 1, slots: 0, mem: 0, usage: 0 } },
    };
    expect(place(task(), AUTO, snap(machine("box-a")), cpuOnly)).toMatchObject({ score: 0.87 });
  });

  it("no weighted headroom known: scores 0 and says so", () => {
    const usageOnly: PlaceOptions = {
      ...OPTS,
      placement: { ...OPTS.placement, weights: { cpu: 0, slots: 0, mem: 0, usage: 1 } },
    };
    const r = place(task(), AUTO, snap(machine("box-a", { usage_pct: null })), usageOnly);
    expect(r).toMatchObject({ host: "box-a", score: 0 });
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates[0]?.line).toMatch(/no weighted headroom known$/);
  });

  it("the supervisor's own machine is placed under its name, flagged local", () => {
    const r = place(task(), AUTO, snap(machine(LOCAL)), OPTS);
    expect(r).toMatchObject({ host: LOCAL, local: true, by: "auto" });
  });
});

describe("place: eligibility lines", () => {
  const only = (m: MachineView, w = AUTO, t = task(w)) => {
    const r = place(t, w, snap(m), OPTS);
    expect(r.host).toBeNull();
    return r;
  };

  it("an overloaded machine (load 32 on 16 cores) is ineligible with its exact line", () => {
    const r = only(machine("box-a", { record: record("box-a", { load: [32, 30, 28] }) }));
    expect(r.candidates).toEqual([
      {
        host: "box-a",
        score: null,
        line: "ineligible: load 32.0 on 16 cores (2.00 per core > max 1.5)",
      },
    ]);
  });

  it("memory under the minimum and disk under the minimum likewise", () => {
    const mem = only(
      machine("box-a", {
        record: record("box-a", { memory: { total_mb: 8192, available_pct: 9 } }),
      }),
    );
    expect(mem.candidates[0]?.line).toBe("ineligible: memory available 9% (min 10%)");
    const disk = only(
      machine("box-a", {
        record: record("box-a", { disk: { path: "/srv", free_gb: 3, free_pct: 2 } }),
      }),
    );
    expect(disk.candidates[0]?.line).toBe("ineligible: disk free 3 GB (min 5 GB)");
  });

  it("not ready, draining, full and held by its own admission each say why", () => {
    expect(
      only(
        machine("box-a", { ready: false, reasons: ["claude not on the non-interactive ssh PATH"] }),
      ).candidates[0]?.line,
    ).toBe("ineligible: claude not on the non-interactive ssh PATH (readiness)");
    expect(only(machine("box-a", { drain: true })).candidates[0]?.line).toBe(
      "ineligible: draining",
    );
    expect(only(machine("box-a", { agents: 4 })).candidates[0]?.line).toBe(
      "ineligible: 4/4 agents (max_agents)",
    );
    expect(
      only(machine("box-a", { held: ["box-a: memory available 9% (min 10%)"] })).candidates[0]
        ?.line,
    ).toBe("ineligible: box-a: memory available 9% (min 10%)");
  });

  it("usage at or over warn_at_pct is ineligible; unknown usage passes", () => {
    expect(only(machine("box-a", { usage_pct: 90 })).candidates[0]?.line).toBe(
      "ineligible: usage 90% (warn at 90%)",
    );
    expect(place(task(), AUTO, snap(machine("box-a", { usage_pct: null })), OPTS).host).toBe(
      "box-a",
    );
  });

  it("a heavy task skips a machine whose per-machine lease slot is held", () => {
    const heavy = wave(
      "placement: auto\nheavy_pools: [backend-it]\n",
      "  T1: { issue: 1, heavy: true }\n  T2: { issue: 2 }\n",
    );
    const full = machine("box-a", { heavy: { "backend-it": { held: 1, per_machine: 1 } } });
    const free = machine("box-b", {
      record: record("box-b", { load: [12, 12, 12] }),
      heavy: { "backend-it": { held: 0, per_machine: 1 } },
    });
    const r = place(task(heavy), heavy, snap(full, free), OPTS);
    expect(r.host).toBe("box-b");
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates.find((c) => c.host === "box-a")).toEqual({
      host: "box-a",
      score: null,
      line: "ineligible: heavy slots 0/1 free (backend-it)",
    });
    expect(r.candidates.find((c) => c.host === "box-b")?.line).toMatch(
      / · heavy slots 1\/1 free \(backend-it\)$/,
    );
    // A task that is not heavy ignores the slots.
    expect(place(task(heavy, "T2"), heavy, snap(full, free), OPTS).host).toBe("box-a");
  });

  it("no eligible machine: the closest machine's reason, for why_waiting", () => {
    const far = machine("box-a", {
      ready: false,
      reasons: ["no doctor report: run volley peer doctor"],
      drain: true,
    });
    const near = machine("box-b", { drain: true });
    const r = place(task(), AUTO, snap(far, near), OPTS);
    expect(r).toMatchObject({ host: null, why: "no eligible machine: box-b: draining" });
    if (r.host !== null) throw new Error("placed");
    expect(r.candidates.map((c) => c.host)).toEqual(["box-b", "box-a"]);
  });

  it("no candidate at all says so", () => {
    expect(place(task(), AUTO, snap(), OPTS)).toMatchObject({
      host: null,
      why: "no eligible machine: no machine reports a record",
    });
  });
});

describe("place: ranking, prefer, avoid, reservations", () => {
  it("reservations make the second admission in one tick land elsewhere", () => {
    let s = snap(machine("box-a", { max_agents: 1 }), machine("box-b", { max_agents: 1 }));
    const first = place(task(AUTO, "T1"), AUTO, s, OPTS);
    expect(first.host).toBe("box-a");
    s = reserve(s, "box-a");
    const second = place(task(AUTO, "T2"), AUTO, s, OPTS);
    expect(second.host).toBe("box-b");
    if (second.host === null) throw new Error("unplaced");
    expect(second.candidates.find((c) => c.host === "box-a")?.line).toBe(
      "ineligible: 1/1 agents (max_agents)",
    );
  });

  it("the supervisor's own machine counts every reservation (hard_ceiling caps them all)", () => {
    let s = snap(machine(LOCAL, { max_agents: 1 }), machine("box-a"));
    s = reserve(s, "box-a");
    const r = place(task(), AUTO, s, OPTS);
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates.find((c) => c.host === LOCAL)?.line).toBe(
      "ineligible: 1/1 agents (max_agents)",
    );
  });

  it("placement_avoid is used only when no other machine is eligible", () => {
    const w = wave("placement: auto\nplacement_avoid: [box-a]\n");
    const r = place(task(w), w, snap(machine("box-a"), machine("box-b", { agents: 2 })), OPTS);
    expect(r.host).toBe("box-b");
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates.map((c) => c.host)).toEqual(["box-b", "box-a"]);
    expect(r.candidates[1]?.line).toMatch(/ · avoided$/);
    expect(place(task(w), w, snap(machine("box-a")), OPTS).host).toBe("box-a");
  });

  it("placement_prefer ranks first and breaks a tie; equal otherwise, fewer placed then the name", () => {
    const tie = snap(machine("box-a"), machine("box-b"));
    expect(place(task(), AUTO, tie, OPTS).host).toBe("box-a");
    const w = wave("placement: auto\nplacement_prefer: [box-b]\n");
    const r = place(task(w), w, tie, OPTS);
    expect(r.host).toBe("box-b");
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates[0]?.line).toMatch(/ · preferred$/);
    // Same score (rounded), fewer placed agents first.
    const fewer = snap(
      machine("box-a", { agents: 1, max_agents: 100 }),
      machine("box-b", { max_agents: 100 }),
    );
    expect(place(task(), AUTO, fewer, OPTS).host).toBe("box-b");
  });
});

describe("place: tasks that name their host", () => {
  it("a pinned task ignores the score: by wave_file, one unscored candidate", () => {
    const w = wave("placement: auto\n", "  T1: { issue: 1, host: box-b }\n");
    const r = place(task(w), w, snap(machine("box-a"), machine("box-b", { drain: true })), OPTS);
    expect(r).toEqual({
      host: "box-b",
      local: false,
      by: "wave_file",
      score: null,
      candidates: [{ host: "box-b", score: null, line: "named in the wave file" }],
    });
  });

  it("a wave without placement: auto places every unpinned task on local, by wave_file", () => {
    const w = wave();
    expect(place(task(w), w, snap(machine("box-a"), machine(LOCAL)), OPTS)).toEqual({
      host: LOCAL,
      local: true,
      by: "wave_file",
      score: null,
      candidates: [{ host: LOCAL, score: null, line: "named in the wave file" }],
    });
  });
});

describe("preview", () => {
  const verdict = (name: string, over: Partial<VerdictView> = {}): VerdictView => ({
    name,
    ready: true,
    reasons: [],
    drain: false,
    max_agents: name === LOCAL ? 12 : 4,
    placed: 0,
    heavy: {},
    usage: { five_hour_pct: 34 },
    ...over,
  });

  it("places each auto task in file order, reserving as it goes; the own machine reads local", () => {
    const w = wave(
      "placement: auto\n",
      "  T1: { issue: 1 }\n  T2: { issue: 2, host: box-b }\n  T3: { issue: 3 }\n",
    );
    const snapshot = snapshotFrom(
      [
        record("box-a"),
        record(LOCAL, {
          tunnel: "local",
          load: [6, 6, 6],
          cores: 8,
          memory: { total_mb: 1, available_pct: 40 },
        }),
      ],
      [verdict("box-a", { max_agents: 1 }), verdict(LOCAL, { placed: 2 })],
      LOCAL,
    );
    // T1 takes box-a's one slot: (34.67 + 30 + 10.65 + 9.9) / 100. T3 goes to the supervisor's
    // own machine, which counts that reservation: 0.75 per core, 3/12 placed, 40% mem:
    // (20 + 22.5 + 6 + 9.9) / 100. T2 names its host.
    expect(preview(w, snapshot, OPTS)).toBe(
      "if admitted now: T1 → box-a (0.85), T3 → local (0.58)",
    );
  });

  it("an unplaceable task says why; a machine without a verdict is not ready; nothing to place is null", () => {
    const snapshot = snapshotFrom([record("box-a")], [], LOCAL);
    expect(preview(AUTO, snapshot, OPTS)).toBe(
      "if admitted now: T1 → waiting (no eligible machine: box-a: no readiness verdict yet (readiness)), T2 → waiting (no eligible machine: box-a: no readiness verdict yet (readiness))",
    );
    expect(preview(wave(), snapshot, OPTS)).toBeNull();
  });
});
