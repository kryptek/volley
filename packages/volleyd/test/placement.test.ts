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
import { type ReadinessInput, machineView, readiness } from "../src/readiness";
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
        line: "ineligible: overloaded: load 32.0 on 16 cores · no new agents",
      },
    ]);
  });

  it("overload reads the higher of the 1- and 5-minute load: a dip in load1 is not enough", () => {
    const r = only(machine("box-a", { record: record("box-a", { load: [4, 30, 28] }) }));
    expect(r.candidates[0]?.line).toBe(
      "ineligible: overloaded: load 30.0 on 16 cores · no new agents",
    );
    // load5 back under the maximum too: eligible.
    expect(
      place(
        task(),
        AUTO,
        snap(machine("box-a", { record: record("box-a", { load: [4, 20, 28] }) })),
        OPTS,
      ).host,
    ).toBe("box-a");
  });

  it("memory under the minimum and disk under the minimum likewise", () => {
    const mem = only(
      machine("box-a", {
        record: record("box-a", { memory: { total_mb: 8192, available_pct: 9 } }),
      }),
    );
    expect(mem.candidates[0]?.line).toBe(
      "ineligible: overloaded: memory available 9% (min 10%) · no new agents",
    );
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
    const held = only(
      machine("box-a", { held: ["recovering: memory available clear for 1/3 samples"] }),
    );
    expect(held.candidates[0]?.line).toBe(
      "ineligible: recovering: memory available clear for 1/3 samples",
    );
    // The machine's name once, not twice.
    expect(held).toMatchObject({
      why: "no eligible machine: box-a: recovering: memory available clear for 1/3 samples",
    });
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

  it("a drained host receives no placement, however much headroom it has", () => {
    const drained = machine("box-a", { drain: true, record: record("box-a", { load: [0, 0, 0] }) });
    const busy = machine("box-b", { record: record("box-b", { load: [12, 12, 12] }) });
    const r = place(task(), AUTO, snap(drained, busy), OPTS);
    expect(r.host).toBe("box-b");
    expect(r.candidates.find((c) => c.host === "box-a")).toEqual({
      host: "box-a",
      score: null,
      line: "ineligible: draining",
    });
  });

  it("exclude: a re-placement never lands on the machine it moves the task off", () => {
    const best = machine("box-a", { record: record("box-a", { load: [0, 0, 0] }) });
    const other = machine("box-b");
    expect(place(task(), AUTO, snap(best, other), OPTS).host).toBe("box-a");
    const r = place(task(), AUTO, snap(best, other), { ...OPTS, exclude: ["box-a"] });
    expect(r.host).toBe("box-b");
    expect(r.candidates.find((c) => c.host === "box-a")).toEqual({
      host: "box-a",
      score: null,
      line: "ineligible: excluded: the task is being moved off it",
    });
    // Nothing else left: unplaced, with that reason.
    expect(place(task(), AUTO, snap(best), { ...OPTS, exclude: ["box-a"] })).toMatchObject({
      host: null,
      why: "no eligible machine: box-a: excluded: the task is being moved off it",
    });
  });

  it("no candidate at all says so", () => {
    expect(place(task(), AUTO, snap(), OPTS)).toMatchObject({
      host: null,
      why: "no eligible machine: no machine reports a record",
    });
  });
});

describe("place: ranking, prefer, avoid, reservations", () => {
  it("a heavy placement reserves its slot: two heavy tasks in one tick land on two machines", () => {
    const w = wave(
      "placement: auto\nheavy_pools: [backend-it]\n",
      "  T1: { issue: 1, heavy: true }\n  T2: { issue: 2, heavy: true }\n  T3: { issue: 3 }\n",
    );
    const slot = { heavy: { "backend-it": { held: 0, per_machine: 1 } } };
    let s = snap(
      machine("box-a", slot),
      machine("box-b", { ...slot, record: record("box-b", { load: [12, 12, 12] }) }),
    );
    const first = place(task(w, "T1"), w, s, OPTS);
    expect(first.host).toBe("box-a");
    s = reserve(s, "box-a", task(w, "T1"), w);
    const second = place(task(w, "T2"), w, s, OPTS);
    expect(second.host).toBe("box-b");
    if (second.host === null) throw new Error("unplaced");
    expect(second.candidates.find((c) => c.host === "box-a")?.line).toBe(
      "ineligible: heavy slots 0/1 free (backend-it)",
    );
    // A task that is not heavy still fits on box-a; a placement of one reserves no slot.
    expect(place(task(w, "T3"), w, s, OPTS).host).toBe("box-a");
    expect(reserve(s, "box-b", task(w, "T3"), w).heavyReserved).toEqual({
      "box-a": { "backend-it": 1 },
    });
  });

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

describe("one machine filter: the readiness verdict agrees with placement", () => {
  const FILTER = { placement: OPTS.placement, warn_at_pct: OPTS.warn_at_pct };
  const ok = record("box-a", {
    kind: "peer",
    versions: { peer: "0.4.0", volley: "0.4.0", bun: "1.3.1", git: "2.43.0" },
    auth: { gh: "ok", claude: "signed_in", trust: "ok" },
    repo: { path: "/srv/repo", exists: true, origin: "github.com/example-org/example-repo" },
    checks: [],
    doctor_at: "2026-10-19T08:59:00.000Z",
  });
  const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
    name: "box-a",
    record: ok,
    local: false,
    host: { max_agents: 4, drain: false },
    hostVersion: "0.4.0",
    hostOrigin: "github.com/example-org/example-repo",
    probe: { claude: true, bun: true },
    placed: 0,
    heavy: {},
    usage: { account: "dev@box-a", five_hour_pct: 34 },
    filter: FILTER,
    held: [],
    checkedAt: new Date("2026-10-19T09:00:00.000Z"),
    ...over,
  });
  /** Placement's view of the verdict's machine, and the candidate line for task `t` of `w`. */
  const candidate = (i: ReadinessInput, w = AUTO, t = task(w)) => {
    const v = readiness(i);
    const view = machineView(i, v, v.usage.five_hour_pct);
    const p = place(t, w, snap(view), OPTS);
    return { v, line: p.candidates[0]?.line ?? "", placed: p.host !== null };
  };
  const cases: [string, Partial<ReadinessInput>, string | null][] = [
    ["eligible", {}, null],
    [
      "load",
      { record: { ...ok, load: [32, 30, 28] } },
      "overloaded: load 32.0 on 16 cores · no new agents",
    ],
    [
      "memory",
      { record: { ...ok, memory: { total_mb: 8192, available_pct: 9 } } },
      "overloaded: memory available 9% (min 10%) · no new agents",
    ],
    [
      "disk",
      { record: { ...ok, disk: { path: "/srv", free_gb: 3, free_pct: 2 } } },
      "disk free 3 GB (min 5 GB)",
    ],
    ["usage", { usage: { account: "dev@box-a", five_hour_pct: 90 } }, "usage 90% (warn at 90%)"],
    ["cap", { placed: 4 }, "4/4 agents (max_agents)"],
    ["drain", { host: { max_agents: 4, drain: true } }, "draining"],
    [
      "own admission",
      { held: ["recovering: load per core clear for 2/3 samples"] },
      "recovering: load per core clear for 2/3 samples",
    ],
    [
      "readiness",
      { probe: { claude: false, bun: true } },
      "claude not on the non-interactive ssh PATH (the supervisor's ssh probe decides; the doctor's claude_on_path only estimates it) (readiness)",
    ],
  ];
  for (const [filter, over, reason] of cases) {
    it(`${filter}: eligible and ineligible_reason are placement's own verdict and line`, () => {
      const { v, line, placed } = candidate(input(over));
      expect(v.eligible).toBe(reason === null);
      expect(placed).toBe(reason === null);
      if (reason === null) {
        expect(v.ineligible_reason).toBeUndefined();
        expect(line).not.toMatch(/^ineligible/);
      } else {
        expect(v.ineligible_reason).toBe(reason);
        expect(line).toBe(`ineligible: ${reason}`.slice(0, 200));
      }
    });
  }

  it("heavy slots: the verdict says the machine takes work, a heavy task's line says the slots", () => {
    const w = wave(
      "placement: auto\nheavy_pools: [backend-it]\n",
      "  T1: { issue: 1, heavy: true }\n  T2: { issue: 2 }\n",
    );
    const i = input({ heavy: { "backend-it": { held: 1, per_machine: 1 } } });
    const heavy = candidate(i, w, task(w, "T1"));
    // A task-independent verdict: eligible for work that needs no slot, and its `heavy` shows the
    // slot taken, which is exactly why a heavy task is not placed there.
    expect(heavy.v).toMatchObject({ eligible: true, heavy: { "backend-it": { held: 1 } } });
    expect(heavy).toMatchObject({
      placed: false,
      line: "ineligible: heavy slots 0/1 free (backend-it)",
    });
    expect(candidate(i, w, task(w, "T2")).placed).toBe(true);
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
