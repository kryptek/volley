import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { foldHost, hostSamples } from "../src/admission";
import { DEFAULT_SHARING, readSharing } from "../src/claude/sharing";
import type { MachineRecord } from "../src/machines";
import {
  READINESS_CHANNEL,
  type ReadinessInput,
  machineView,
  parsePathProbe,
  readiness,
  readinessKey,
  readinessTopic,
} from "../src/readiness";
import { envelope, schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

const CHECKED = new Date("2026-10-19T09:00:00.000Z");

const FILTER = {
  placement: {
    load_per_core_max: 1.5,
    mem_available_min_pct: 10,
    disk_free_min_gb: 5,
    weights: { cpu: 40, slots: 30, mem: 15, usage: 15 },
  },
  warn_at_pct: 85,
};

const VERSIONS = { peer: "0.4.0", volley: "0.4.0", bun: "1.3.1", git: "2.43.0" };

/** A peer whose doctor found everything an agent needs. */
const record = (over: Partial<MachineRecord> = {}): MachineRecord => ({
  name: "box-a",
  kind: "peer",
  os: "linux",
  cores: 8,
  tunnel: "up",
  load: [0.5, 0.4, 0.3],
  agents: 0,
  last_seen: "2026-10-19T08:59:30.000Z",
  versions: VERSIONS,
  auth: { gh: "ok", claude: "signed_in", trust: "ok" },
  repo: { path: "/srv/repo", exists: true, origin: "github.com/example-org/example-repo" },
  checks: [{ id: "repo.clone", ok: true, severity: "block", detail: "clone at /srv/repo" }],
  doctor_at: "2026-10-19T08:59:00.000Z",
  ...over,
});

const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  name: "box-a",
  record: record(),
  local: false,
  host: { max_agents: 4, drain: false },
  hostVersion: "0.4.0",
  hostOrigin: "github.com/example-org/example-repo",
  probe: { claude: true, bun: true },
  placed: 0,
  heavy: {},
  usage: { account: null, five_hour_pct: null },
  filter: FILTER,
  held: [],
  checkedAt: CHECKED,
  ...over,
});

const PATH_REASON = /^claude not on the non-interactive ssh PATH/;

describe("readiness (the supervisor's verdict on one machine)", () => {
  it("a machine whose doctor found everything, probed and under its cap, is ready and eligible", () => {
    const r = readiness(input());
    expect(r).toMatchObject({
      name: "box-a",
      ready: true,
      reasons: [],
      eligible: true,
      drain: false,
      max_agents: 4,
      placed: 0,
      path_ok: { claude: true, bun: true },
      requirements: { volley: "0.4.0" },
      checked_at: CHECKED.toISOString(),
    });
    expect(r.ineligible_reason).toBeUndefined();
  });

  it("a volley version other than the host's is not ready, with the exact reason", () => {
    const r = readiness(input({ record: record({ versions: { ...VERSIONS, volley: "0.3.0" } }) }));
    expect(r.ready).toBe(false);
    expect(r.reasons).toEqual(["volley 0.3.0 on box-a, host runs 0.4.0"]);
    expect(r).toMatchObject({ eligible: false, ineligible_reason: `${r.reasons[0]} (readiness)` });
  });

  it("a probe without claude: path_ok.claude false and the PATH reason, saying the probe decides", () => {
    const r = readiness(input({ probe: { claude: false, bun: true } }));
    expect(r.path_ok).toEqual({ claude: false, bun: true });
    expect(r.ready).toBe(false);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(PATH_REASON);
    // The doctor's own claude_on_path only estimates that PATH: the reason says which one counts.
    expect(r.reasons[0]).toContain("claude_on_path");
  });

  it("no probe yet: path_ok nulls and not ready", () => {
    const r = readiness(input({ probe: null }));
    expect(r.path_ok).toEqual({ claude: null, bun: null });
    expect(r.ready).toBe(false);
    expect(r.reasons).toEqual([expect.stringMatching(/not probed yet/)]);
  });

  it("the supervisor's own machine names its own agent environment, not ssh", () => {
    const r = readiness(
      input({
        local: true,
        record: record({ kind: "supervisor", tunnel: "local" }),
        probe: { claude: true, bun: false },
      }),
    );
    expect(r.reasons).toEqual([expect.stringMatching(/^bun not on the PATH .*own agents/)]);
  });

  it("an ssh failure of the PATH probe: path_ok nulls and the transport reason", () => {
    const r = readiness(
      input({ probe: null, probeError: "ssh to dev@box-a failed: Connection refused" }),
    );
    expect(r).toMatchObject({
      ready: false,
      path_ok: { claude: null, bun: null },
      reasons: ["PATH probe over ssh failed: ssh to dev@box-a failed: Connection refused"],
    });
  });

  it("the supervisor's own doctor run without a wave repo: its repo.* checks do not count", () => {
    const own = record({
      name: "control",
      kind: "supervisor",
      tunnel: "local",
      checks: [
        { id: "tool.bun", ok: true, severity: "block", detail: "bun" },
        { id: "repo.clone", ok: false, severity: "block", detail: "no wave repo: pass --repo" },
      ],
    });
    const { repo: _none, ...noRepo } = own;
    const base = { name: "control", local: true, hostOrigin: null };
    expect(readiness(input({ ...base, record: noRepo, noRepo: true })).reasons).toEqual([]);
    // Given a repo, a failing clone check blocks as on any machine.
    expect(readiness(input({ ...base, record: noRepo })).reasons).toEqual([
      "repo.clone: no wave repo: pass --repo",
    ]);
  });

  it("drain: true is ineligible with ineligible_reason draining (and still ready)", () => {
    const r = readiness(input({ host: { max_agents: 4, drain: true } }));
    expect(r).toMatchObject({ ready: true, drain: true, eligible: false });
    expect(r.ineligible_reason).toBe("draining");
  });

  it("an overloaded machine (load 24.1 on 16 cores) is ineligible with the exact overload line, still ready", () => {
    const r = readiness(input({ record: record({ cores: 16, load: [24.1, 20, 18] }) }));
    expect(r).toMatchObject({
      ready: true,
      eligible: false,
      ineligible_reason: "overloaded: load 24.1 on 16 cores · no new agents",
    });
    const mem = readiness(
      input({ record: record({ memory: { total_mb: 8192, available_pct: 4 } }) }),
    );
    expect(mem.ineligible_reason).toBe("overloaded: memory available 4% (min 10%) · no new agents");
  });

  it("after an overload, three clean heartbeats restore eligibility; two do not", () => {
    const T = { mem_available_min_pct: 10, load_per_core_max: 1.5, hysteresis_samples: 3 };
    const hot = record({ cores: 16, load: [24.1, 20, 18] });
    const clean = record({ cores: 16, load: [2, 3, 3] });
    /** The verdict after these heartbeats (the daemon folds the box's last ones the same way). */
    const verdictAfter = (beats: MachineRecord[]) =>
      readiness(
        input({
          record: beats.at(-1),
          held: foldHost("box-a", beats.map(hostSamples), T).recovering,
        }),
      );
    expect(verdictAfter([hot]).eligible).toBe(false);
    expect(verdictAfter([hot, clean, clean])).toMatchObject({
      eligible: false,
      ineligible_reason: "recovering: load per core clear for 2/3 samples",
    });
    expect(verdictAfter([hot, clean, clean, clean]).eligible).toBe(true);
    // A heartbeat whose 1-minute load dipped while the 5-minute one is still over is not clean.
    const dip = record({ cores: 16, load: [2, 30, 20] });
    expect(verdictAfter([hot, dip, clean, clean]).eligible).toBe(false);
  });

  it("placed at max_agents is ineligible: 4/4 agents (max_agents)", () => {
    const r = readiness(input({ placed: 4 }));
    expect(r).toMatchObject({
      ready: true,
      eligible: false,
      ineligible_reason: "4/4 agents (max_agents)",
    });
    expect(readiness(input({ placed: 3 })).eligible).toBe(true);
  });

  it("no record, a down tunnel, or no doctor report: not ready, each said plainly", () => {
    expect(readiness(input({ record: undefined })).reasons).toEqual([
      expect.stringMatching(/^no machine record/),
    ]);
    expect(
      readiness(input({ record: record({ tunnel: "down", reason: "heartbeat_timeout" }) })).reasons,
    ).toEqual([expect.stringMatching(/^tunnel down to box-a/)]);
    const { checks: _c, doctor_at: _d, versions: _v, auth: _a, ...bare } = record();
    expect(readiness(input({ record: bare })).reasons).toEqual([
      "no doctor report: run volley peer doctor",
    ]);
  });

  it("a failing block check blocks, a failing warn check does not", () => {
    const checks = [
      { id: "tools.git", ok: false, severity: "block" as const, detail: "git not found" },
      { id: "claude_on_path", ok: false, severity: "warn" as const, detail: "estimate" },
    ];
    expect(readiness(input({ record: record({ checks }) })).reasons).toEqual([
      "tools.git: git not found",
    ]);
  });

  it("GitHub push, Claude sign-in and the repo origin are blockers in plain words", () => {
    const r = readiness(
      input({
        record: record({
          auth: { gh: "no_write", claude: "not_signed_in", trust: "ok" },
          repo: { path: "/srv/repo", exists: true, origin: "github.com/someone/fork" },
        }),
      }),
    );
    expect(r.reasons).toEqual([
      "gh: no write permission on someone/fork",
      "claude: not signed in",
      "repo origin differs from the host's (github.com/someone/fork, host: github.com/example-org/example-repo)",
    ]);
  });

  it("carries requirements (bun, sharing), heavy and usage through", () => {
    const r = readiness(
      input({
        bun: "1.3.0",
        sharing: DEFAULT_SHARING,
        heavy: { build: { held: 1, per_machine: 2 } },
        usage: { account: "main@box-a", five_hour_pct: 42 },
      }),
    );
    expect(r.requirements).toEqual({ volley: "0.4.0", bun: "1.3.0", sharing: DEFAULT_SHARING });
    expect(r.heavy).toEqual({ build: { held: 1, per_machine: 2 } });
    expect(r.usage).toEqual({ account: "main@box-a", five_hour_pct: 42 });
  });

  it("every verdict validates against readiness.schema.json (reasons cut to 200 characters)", () => {
    const long = "x".repeat(300);
    for (const v of [
      readiness(input()),
      readiness(input({ record: undefined, host: { max_agents: 4, drain: true } })),
      readiness(input({ placed: 9, sharing: DEFAULT_SHARING, bun: "1.3.0" })),
      readiness(
        input({
          record: record({ checks: [{ id: "x", ok: false, severity: "block", detail: long }] }),
        }),
      ),
    ]) {
      expect(
        schemaErrors("readiness.schema.json", envelope(READINESS_CHANNEL, "readiness", v)),
      ).toEqual([]);
    }
    expect(readinessTopic("box-a")).toBe("volley/_system/machines/box-a/readiness");
  });
});

describe("local_agents on the supervisor's own verdict (SPEC §4.6.15)", () => {
  const NOW = Date.parse("2026-10-19T09:00:00.000Z");
  const OWN = {
    ...FILTER,
    local_agents: "fallback" as const,
    fallback: { max_agents: 3, per_machine: {} },
    now: NOW,
    down_grace_ms: 300_000,
  };
  /** Placement's view of peer box-a from its own verdict. */
  const peer = (over: Partial<ReadinessInput> = {}) => {
    const i = input({ filter: OWN, ...over });
    const v = readiness(i);
    return machineView(i, v, v.usage.five_hour_pct);
  };
  const DOWN = { record: record({ tunnel: "down", reason: "heartbeat_timeout" as const }) };
  const own = (peers: ReturnType<typeof peer>[], filter: ReadinessInput["filter"] = OWN) =>
    readiness(
      input({
        name: "laptop",
        record: record({ name: "laptop", kind: "supervisor", tunnel: "local" }),
        local: true,
        host: { max_agents: 12, drain: false },
        localAgents: 0,
        peers,
        filter,
      }),
    );

  it("an eligible peer: the own machine is not eligible, and the fallback is idle", () => {
    const v = own([peer()]);
    expect(v).toMatchObject({
      eligible: false,
      ineligible_reason: "fallback: box-a is eligible",
      local_agents: { mode: "fallback", active: false, why: "box-a eligible" },
    });
    expect(
      schemaErrors("readiness.schema.json", envelope(READINESS_CHANNEL, "readiness", v)),
    ).toEqual([]);
  });

  it("no peer eligible: the own machine is eligible, the fallback active with the peer's reason", () => {
    const v = own([peer({ ...DOWN, downSince: NOW - 400_000 })]);
    expect(v).toMatchObject({
      eligible: true,
      local_agents: {
        mode: "fallback",
        active: true,
        why: "box-a: tunnel down to box-a: no heartbeat (readiness)",
      },
    });
    expect(v.ineligible_reason).toBeUndefined();
  });

  it("a peer down within the grace keeps the own machine closed: it may be back", () => {
    const v = own([peer({ ...DOWN, downSince: NOW - 40_000 })]);
    expect(v).toMatchObject({
      eligible: false,
      ineligible_reason: "fallback: box-a may be back (down 40 s, grace 300 s)",
      local_agents: { mode: "fallback", active: false },
    });
  });

  it("the down counter ticking within the grace is no news: the key stays the same", () => {
    const at40 = own([peer({ ...DOWN, downSince: NOW - 40_000 })]);
    const at55 = own([peer({ ...DOWN, downSince: NOW - 55_000 })]);
    expect(at55.ineligible_reason).toBe("fallback: box-a may be back (down 55 s, grace 300 s)");
    expect(readinessKey(at55)).toBe(readinessKey(at40));
    const past = own([peer({ ...DOWN, downSince: NOW - 400_000 })]);
    expect(readinessKey(past)).not.toBe(readinessKey(at40));
  });

  it("a peer's verdict never has local_agents; always and never say so on the own", () => {
    expect(readiness(input({ filter: OWN }))).not.toHaveProperty("local_agents");
    expect(own([peer()], { ...OWN, local_agents: "always" }).local_agents).toEqual({
      mode: "always",
      active: false,
    });
    expect(own([peer()], { ...OWN, local_agents: "always" }).eligible).toBe(true);
    expect(own([], { ...OWN, local_agents: "never" })).toMatchObject({
      eligible: false,
      ineligible_reason: "local_agents: never",
      local_agents: { mode: "never", active: false },
    });
  });
});

describe("requirements.sharing is the supervisor's sharing.yaml", () => {
  let root: string;
  beforeEach(() => {
    root = tempDir("volleyd-readiness-");
  });

  it("equals readSharing's modes", () => {
    writeFileSync(join(root, "sharing.yaml"), "skills: own\nmcp: own\n");
    const sharing = readSharing(root);
    expect(readiness(input({ sharing })).requirements.sharing).toEqual({
      ...DEFAULT_SHARING,
      skills: "own",
      mcp: "own",
    });
  });
});

describe("parsePathProbe (`command -v claude bun` on the box)", () => {
  it("maps each resolved path to its tool, a missing one to false", () => {
    expect(parsePathProbe("/home/dev/.bun/bin/bun\n")).toEqual({ claude: false, bun: true });
    expect(parsePathProbe("/usr/local/bin/claude\n/usr/bin/bun\n")).toEqual({
      claude: true,
      bun: true,
    });
    expect(parsePathProbe("")).toEqual({ claude: false, bun: false });
    // A function or an alias from the box's bashrc resolves too.
    expect(parsePathProbe("claude\nalias bun='/opt/bun/bin/bun'\n")).toEqual({
      claude: true,
      bun: true,
    });
  });
});
