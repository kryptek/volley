import { describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS } from "../src/config-defaults";
import type { MachineRecord } from "../src/machines";
import {
  type MachineView,
  type PlaceOptions,
  type Snapshot,
  type VerdictView,
  machineIneligible,
  needsPlacement,
  peerIdleUnderLoad,
  place,
  preview,
  reserve,
  snapshotFrom,
} from "../src/placement";
import { type ReadinessInput, type RepoVerdict, machineView, readiness } from "../src/readiness";
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
    repos: { wanted: ["example-org/example-repo"], records: undefined, legacy: ok.repo },
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
    const view = machineView(i, v, v.usage);
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

  it("usage is the machine's best login: eligible with one fresh login, and the line names it", () => {
    // the daemon hands readiness its best candidate (rankAccounts: work at 12%, beside a hot 95%)
    const { v, line, placed } = candidate(input({ usage: { account: "work", five_hour_pct: 12 } }));
    expect(v.usage).toEqual({ account: "work", five_hour_pct: 12 });
    expect(v.eligible).toBe(true);
    expect(placed).toBe(true);
    expect(line).toContain("usage 12% (work)");
  });

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

describe("placement per (machine, repository) (#436)", () => {
  const repos = (
    states: Record<string, "ready" | "absent" | "blocked">,
  ): Record<string, RepoVerdict> =>
    Object.fromEntries(
      Object.entries(states).map(([slug, state]) => [
        slug,
        state === "ready"
          ? { state, path: `/path/to/${slug}`, reasons: [] }
          : state === "absent"
            ? { state, reasons: [`no clone of ${slug} on the machine`] }
            : {
                state,
                path: `/path/to/${slug}`,
                reasons: [`java not installed (needed by ${slug})`],
              },
      ]),
    );
  // box-b is the better machine by headroom: only the repository keeps it out.
  const two = () =>
    snap(
      machine("box-a", { repos: repos({ "a/a": "ready", "b/b": "absent" }), agents: 2 }),
      machine("box-b", { repos: repos({ "a/a": "absent", "b/b": "ready" }) }),
    );

  it("a machine without a ready clone of the wave's slug is ineligible with the exact reason", () => {
    const r = place(task(), AUTO, two(), { ...OPTS, waveSlug: "a/a" });
    expect(r.host).toBe("box-a");
    expect(r.candidates.find((c) => c.host === "box-b")?.line).toBe(
      "ineligible: no ready clone of a/a (absent: no clone of a/a on the machine)",
    );
  });

  it("a second wave for the other slug places on the other machine", () => {
    expect(place(task(), AUTO, two(), { ...OPTS, waveSlug: "b/b" }).host).toBe("box-b");
    // The slug matches case-insensitively (GitHub's names do).
    expect(place(task(), AUTO, two(), { ...OPTS, waveSlug: "B/B" }).host).toBe("box-b");
  });

  it("a blocked clone names its state and first reason; no slug or no repos view: no filter", () => {
    const s = snap(machine("box-a", { repos: repos({ "a/a": "blocked" }) }));
    const r = place(task(), AUTO, s, { ...OPTS, waveSlug: "a/a" });
    expect(r).toMatchObject({
      host: null,
      why: "no eligible machine: box-a: no ready clone of a/a (blocked: java not installed (needed by a/a))",
    });
    expect(place(task(), AUTO, s, OPTS).host).toBe("box-a");
    expect(place(task(), AUTO, snap(machine("box-a")), { ...OPTS, waveSlug: "a/a" }).host).toBe(
      "box-a",
    );
  });

  it("a machine whose repos view lacks the slug is not filtered: unknown, as in a preview", () => {
    // The daemon's verdicts judge every running wave's slug; a preview's wave may not be running.
    const s = snap(machine("box-a", { repos: repos({ "b/b": "ready" }) }));
    expect(place(task(), AUTO, s, { ...OPTS, waveSlug: "a/a" }).host).toBe("box-a");
  });

  it("the machine filter itself stays task-agnostic: the verdict's eligible ignores repositories", () => {
    const s = two();
    const b = s.machines[1] as MachineView;
    expect(machineIneligible(b, s, OPTS)).toEqual([]);
  });

  it("preview reads repos from the verdicts and prints the reason", () => {
    const verdict = (name: string, r: VerdictView["repos"]): VerdictView => ({
      name,
      ready: true,
      reasons: [],
      drain: false,
      max_agents: 4,
      placed: 0,
      heavy: {},
      usage: { five_hour_pct: 34 },
      ...(r !== undefined ? { repos: r } : {}),
    });
    const snapshot = snapshotFrom(
      [record("box-a"), record("box-b")],
      [verdict("box-a", repos({ "a/a": "absent" })), verdict("box-b", repos({ "a/a": "absent" }))],
      LOCAL,
    );
    expect(preview(AUTO, snapshot, { ...OPTS, waveSlug: "a/a" })).toBe(
      "if admitted now: T1 → waiting (no eligible machine: box-a: no ready clone of a/a (absent: no clone of a/a on the machine)), T2 → waiting (no eligible machine: box-a: no ready clone of a/a (absent: no clone of a/a on the machine))",
    );
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

describe("fleet.local_agents: the supervisor's own machine as a fallback (SPEC §4.6.15)", () => {
  const NOW = Date.parse("2026-10-20T12:00:00.000Z");
  const GRACE = 300_000;
  const FB: PlaceOptions = {
    ...OPTS,
    local_agents: "fallback",
    fallback: { max_agents: 3, per_machine: {} },
    now: NOW,
    down_grace_ms: GRACE,
  };
  /** The supervisor's laptop: 12 cores, idle, the best headroom on paper. */
  const laptop = (over: Partial<MachineView> = {}) =>
    machine(LOCAL, {
      record: record(LOCAL, { tunnel: "local", cores: 12, load: [0.2, 0.2, 0.2] }),
      local_agents: 0,
      ...over,
    });
  const peerUp = (over: Partial<MachineView> = {}) =>
    machine("box-a", { record: record("box-a", { load: [3, 3, 3] }), ...over });
  const peerDown = (downFor: number) =>
    machine("box-a", {
      record: record("box-a", { tunnel: "down" }),
      ready: false,
      reasons: ["tunnel down"],
      down_since: NOW - downFor,
    });
  /** Admit `n` auto tasks in one tick, reserving as admission does. */
  const admitN = (n: number, s: Snapshot, o: PlaceOptions, w = AUTO, id = "T1") => {
    let cur = s;
    const out: ReturnType<typeof place>[] = [];
    for (let k = 0; k < n; k++) {
      const p = place(task(w, id), w, cur, o);
      out.push(p);
      if (p.host !== null) cur = reserve(cur, p.host, task(w, id), w);
    }
    return out;
  };

  it("with a healthy peer, every admission in one tick lands on the peer and none locally", () => {
    const peer = peerUp({ max_agents: 8 });
    const placed = admitN(5, snap(laptop(), peer), FB);
    expect(placed.map((p) => p.host)).toEqual(["box-a", "box-a", "box-a", "box-a", "box-a"]);
    const first = placed[0];
    if (first === undefined || first.host === null) throw new Error("unplaced");
    expect(first.candidates.find((c) => c.host === LOCAL)).toEqual({
      host: LOCAL,
      score: null,
      line: "ineligible: fallback: box-a is eligible",
    });
    // Under always the idle laptop scores higher and wins, as before.
    expect(place(task(), AUTO, snap(laptop(), peer), { ...FB, local_agents: "always" }).host).toBe(
      LOCAL,
    );
  });

  it("a peer without a ready clone of the wave's slug does not keep the laptop closed (#436)", () => {
    const peer = peerUp({
      repos: { "a/a": { state: "absent", reasons: ["no clone of a/a on box-a"] } },
    });
    const laptopWith = laptop({
      repos: { "a/a": { state: "ready", path: "/path/to/a", reasons: [] } },
    });
    const r = place(task(), AUTO, snap(laptopWith, peer), { ...FB, waveSlug: "a/a" });
    expect(r.host).toBe(LOCAL);
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates[0]?.line).toMatch(
      /^local \(fallback: no peer eligible: box-a: no ready clone of a\/a \(absent: no clone of a\/a on box-a\)\)/,
    );
    // Another repository's wave still goes to the peer.
    expect(place(task(), AUTO, snap(laptopWith, peer), FB).host).toBe("box-a");
  });

  it("the peer full in the tick: the next admission falls back to the laptop", () => {
    const placed = admitN(5, snap(laptop(), peerUp()), FB);
    // box-a's max_agents is 4; the fifth finds no peer eligible.
    expect(placed.map((p) => p.host)).toEqual(["box-a", "box-a", "box-a", "box-a", LOCAL]);
  });

  it("never: the laptop is no candidate, even with no peer; a pinned task still runs there", () => {
    const never = { ...FB, local_agents: "never" as const };
    const r = place(task(), AUTO, snap(laptop()), never);
    expect(r.host).toBeNull();
    expect(r.candidates).toEqual([
      { host: LOCAL, score: null, line: "ineligible: local_agents: never" },
    ]);
    const pinned = wave("placement: auto\n", "  T1: { issue: 1, host: local }\n");
    expect(place(task(pinned), pinned, snap(laptop()), never)).toMatchObject({
      host: LOCAL,
      by: "wave_file",
      candidates: [{ host: LOCAL, line: "named in the wave file" }],
    });
  });

  it("peer down past the grace: the task lands locally under the fallback cap", () => {
    const s = snap(laptop(), peerDown(400_000));
    const placed = admitN(4, s, FB);
    expect(placed.map((p) => p.host)).toEqual([LOCAL, LOCAL, LOCAL, null]);
    const first = placed[0];
    if (first === undefined || first.host === null) throw new Error("unplaced");
    expect(first).toMatchObject({ host: LOCAL, local: true, by: "auto" });
    expect(first.candidates[0]?.line).toMatch(
      /^local \(fallback: no peer eligible: box-a: tunnel down \(readiness\)\) · load 0\.2 on 12 cores · 0\/3 agents/,
    );
    const fourth = placed[3];
    if (fourth === undefined || fourth.host !== null) throw new Error("placed");
    expect(fourth.candidates.find((c) => c.host === LOCAL)?.line).toBe(
      "ineligible: 3/3 agents (fallback max_agents)",
    );
  });

  it("the fallback counts the laptop's own agents, not every supervised agent", () => {
    // 6 agents supervised (most on peers), 1 on the laptop: 1/3 under the fallback profile.
    const r = place(
      task(),
      AUTO,
      snap(laptop({ agents: 6, local_agents: 1 }), peerDown(400_000)),
      FB,
    );
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates[0]?.line).toContain("· 1/3 agents ·");
  });

  it("peer down within the grace: nothing is placed, and why says it may be back", () => {
    const r = place(task(), AUTO, snap(laptop(), peerDown(40_000)), FB);
    expect(r.host).toBeNull();
    if (r.host !== null) throw new Error("placed");
    expect(r.why).toContain("fallback: box-a may be back (down 40 s, grace 300 s)");
    expect(r.candidates.find((c) => c.host === LOCAL)?.line).toBe(
      "ineligible: fallback: box-a may be back (down 40 s, grace 300 s)",
    );
  });

  it("heavy tasks under the fallback get one slot per pool by default; 0 keeps them off", () => {
    const heavy = wave(
      "placement: auto\nheavy_pools: [js-suite]\n",
      "  T1: { issue: 1, heavy: true }\n  T2: { issue: 2 }\n",
    );
    const s = snap(
      laptop({ heavy: { "js-suite": { held: 0, per_machine: 3 } } }),
      peerDown(400_000),
    );
    const two = admitN(2, s, FB, heavy);
    expect(two.map((p) => p.host)).toEqual([LOCAL, null]);
    const second = two[1];
    if (second === undefined || second.host !== null) throw new Error("placed");
    expect(second.candidates.find((c) => c.host === LOCAL)?.line).toBe(
      "ineligible: heavy slots 0/1 free (js-suite)",
    );
    const zero = { ...FB, fallback: { max_agents: 3, per_machine: { "js-suite": 0 } } };
    expect(place(task(heavy), heavy, s, zero).host).toBeNull();
    expect(place(task(heavy, "T2"), heavy, s, zero).host).toBe(LOCAL);
  });

  it("peer back: the next task goes to the peer; the laptop's agents are not mentioned moving", () => {
    const r = place(task(), AUTO, snap(laptop({ agents: 2, local_agents: 2 }), peerUp()), FB);
    expect(r.host).toBe("box-a");
    if (r.host === null) throw new Error("unplaced");
    expect(r.candidates.find((c) => c.host === LOCAL)?.line).toBe(
      "ineligible: fallback: box-a is eligible",
    );
    expect(JSON.stringify(r)).not.toMatch(/mov/);
  });

  it("a re-placement off the peer counts it as ineligible, so the laptop is the fallback", () => {
    const r = place(task(), AUTO, snap(laptop(), peerUp()), { ...FB, exclude: ["box-a"] });
    expect(r.host).toBe(LOCAL);
  });

  it("a peer eligible but with its heavy slots full keeps the laptop closed: the heavy task waits", () => {
    // "No peer eligible" is the task-agnostic verdict (machineIneligible), so readiness and
    // placement agree; full heavy slots on a peer do not open the laptop's fallback slot.
    const heavy = wave(
      "placement: auto\nheavy_pools: [js-suite]\n",
      "  T1: { issue: 1, heavy: true }\n  T2: { issue: 2 }\n",
    );
    const s = snap(
      laptop({ heavy: { "js-suite": { held: 0, per_machine: 3 } } }),
      peerUp({ heavy: { "js-suite": { held: 3, per_machine: 3 } } }),
    );
    const r = place(task(heavy), heavy, s, FB);
    expect(r.host).toBeNull();
    expect(r.candidates.find((c) => c.host === LOCAL)?.line).toBe(
      "ineligible: fallback: box-a is eligible",
    );
    expect(r.candidates.find((c) => c.host === "box-a")?.line).toBe(
      "ineligible: heavy slots 0/3 free (js-suite)",
    );
    expect(place(task(heavy, "T2"), heavy, s, FB).host).toBe("box-a");
  });
});

describe("per-machine lease overrides in placement (SPEC §4.6.5)", () => {
  it("a heavy task skips a machine whose override is 0 and lands on the other", () => {
    const heavy = wave(
      "placement: auto\nheavy_pools: [js-suite]\n",
      "  T1: { issue: 1, heavy: true }\n  T2: { issue: 2 }\n",
    );
    // The daemon's heavy map carries the cap in force per machine (capFor).
    const none = machine("box-a", { heavy: { "js-suite": { held: 0, per_machine: 0 } } });
    const three = machine("box-b", {
      record: record("box-b", { load: [12, 12, 12] }),
      heavy: { "js-suite": { held: 2, per_machine: 3 } },
    });
    const r = place(task(heavy), heavy, snap(none, three), OPTS);
    expect(r.host).toBe("box-b");
    expect(r.candidates.find((c) => c.host === "box-a")?.line).toBe(
      "ineligible: heavy slots 0/0 free (js-suite)",
    );
    expect(place(task(heavy, "T2"), heavy, snap(none, three), OPTS).host).toBe("box-a");
  });
});

describe("peerIdleUnderLoad: the supervisor overloaded while a peer idles (#324)", () => {
  // 10 cores at load 130: 13 per core, over the 1.5 default.
  const hot = machine(LOCAL, {
    record: record(LOCAL, { tunnel: "local", cores: 10, load: [130, 120, 90] }),
  });
  const opts = { placement: CONFIG_DEFAULTS.placement };

  it("names the peer with the most free slots, and the key that uses it", () => {
    const idle = peerIdleUnderLoad(
      snap(
        hot,
        machine("box-a", { max_agents: 10 }),
        machine("box-b", { max_agents: 4, agents: 1 }),
      ),
      opts,
    );
    expect(idle).toMatchObject({ peer: "box-a", free: 10, load: 130, cores: 10 });
    expect(idle?.message).toBe(
      "this machine is overloaded (load 130.0 on 10 cores, max 1.5 per core) while box-a is ready with 10 free agent slots; this wave is placement: local (set placement: auto to use it)",
    );
  });

  it("nothing when the own machine is under the threshold", () => {
    expect(peerIdleUnderLoad(snap(machine(LOCAL), machine("box-a")), opts)).toBeNull();
  });

  it("nothing when the only peer is drained, not ready, down or full", () => {
    for (const peer of [
      machine("box-a", { drain: true }),
      machine("box-a", { ready: false, reasons: ["not probed yet"] }),
      machine("box-a", { down_since: 1 }),
      machine("box-a", { max_agents: 4, agents: 4 }),
    ]) {
      expect(peerIdleUnderLoad(snap(hot, peer), opts)).toBeNull();
    }
  });

  it("nothing before the own machine's record is known", () => {
    const { record: _r, ...bare } = hot;
    expect(peerIdleUnderLoad(snap(bare, machine("box-a")), opts)).toBeNull();
  });
});
