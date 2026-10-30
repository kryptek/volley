import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { foldHost, hostSamples } from "../src/admission";
import { DEFAULT_SHARING, readSharing } from "../src/claude/sharing";
import type { MachineRecord, MachineRepo } from "../src/machines";
import {
  READINESS_CHANNEL,
  type ReadinessInput,
  machineView,
  parsePathProbe,
  peerMaxAgents,
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

const SLUG = "example-org/example-repo";

/** The record's repositories as the daemon passes them (`over.repos` wins). */
const reposOf = (
  r: MachineRecord | undefined,
  wanted: string[] = [SLUG],
): ReadinessInput["repos"] => ({
  wanted,
  records: r?.repos,
  ...(r?.repo !== undefined ? { legacy: r.repo } : {}),
});

const input = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  name: "box-a",
  record: record(),
  local: false,
  host: { max_agents: 4, drain: false },
  hostVersion: "0.4.0",
  repos: reposOf("record" in over ? over.record : record()),
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

  it("the supervisor's own doctor run without a wave repo: its repo.* checks do not block the machine", () => {
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
    const r = readiness(
      input({ name: "control", local: true, record: noRepo, repos: reposOf(noRepo, []) }),
    );
    expect(r.reasons).toEqual([]);
    expect(r.repos).toEqual({});
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

  it("GitHub push and Claude sign-in are blockers in plain words; a clone of another repository is not", () => {
    const r = readiness(
      input({
        record: record({
          auth: { gh: "no_write", claude: "not_signed_in", trust: "ok" },
          repo: { path: "/srv/repo", exists: true, origin: "github.com/someone/fork" },
        }),
      }),
    );
    // D6: no machine-level origin line; the wave's repository is judged per slug.
    expect(r.reasons).toEqual(["gh: no write permission on someone/fork", "claude: not signed in"]);
    expect(r.repos[SLUG]).toMatchObject({ state: "absent" });
    expect(r.repos["someone/fork"]).toMatchObject({ state: "ready", path: "/srv/repo" });
  });

  it("#610: no git commit identity is not ready, naming the fix (a warn check, yet readiness needs it)", () => {
    const checks = [
      { id: "repo.clone", ok: true, severity: "block" as const, detail: "clone at /srv/repo" },
      {
        id: "git.identity",
        ok: false,
        severity: "warn" as const,
        detail: "git has no commit identity (user.name/user.email)",
      },
    ];
    const r = readiness(input({ record: record({ checks }) }));
    expect(r.ready).toBe(false);
    expect(r.reasons).toEqual([
      "git: no commit identity on box-a (volley setup --peer --step signin)",
    ]);
    const ok = readiness(
      input({
        record: record({
          checks: [{ id: "git.identity", ok: true, severity: "warn", detail: "git commits as x" }],
        }),
      }),
    );
    expect(ok.ready).toBe(true);
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

describe("readiness per (machine, repository) (#436)", () => {
  const toolchain = { ok: true, missing: [], outdated: [] };
  const repo = (slug: string, over: Partial<MachineRepo> = {}): MachineRepo => ({
    slug,
    path: `/path/to/home/volley/repos/${slug}`,
    exists: true,
    origin: `github.com/${slug}`,
    managed: true,
    fetched_at: "2026-10-19T08:58:00.000Z",
    toolchain,
    ...over,
  });
  const many = (repos: MachineRepo[], checks: MachineRecord["checks"] = []) => {
    const { repo: _legacy, ...r } = record({ repos, checks });
    return r;
  };

  it("a ready clone and an absent one: each its state, the absent one with its reason", () => {
    const rec = many([repo("a/a"), repo("b/b", { exists: false })]);
    const r = readiness(input({ record: rec, repos: reposOf(rec, ["a/a", "b/b"]) }));
    expect(r.repos["a/a"]).toEqual({
      state: "ready",
      path: "/path/to/home/volley/repos/a/a",
      reasons: [],
      fetched_at: "2026-10-19T08:58:00.000Z",
    });
    expect(r.repos["b/b"]).toMatchObject({
      state: "absent",
      reasons: ["no clone of b/b at /path/to/home/volley/repos/b/b"],
    });
    // Eligibility is per wave, not per machine: an absent repository does not make it unready.
    expect(r).toMatchObject({ ready: true, eligible: true, reasons: [] });
  });

  describe("#631: git's commit identity is judged per clone", () => {
    const noGlobal = {
      id: "git.identity",
      ok: false,
      severity: "warn" as const,
      detail: "git has no commit identity (user.name/user.email)",
    };
    const ident = (slug: string, ok: boolean) => ({
      id: "repo.identity",
      ok,
      severity: "block" as const,
      detail: ok
        ? "commits as Repo Level <1+repo@users.noreply.github.com>"
        : `no commit identity in /path/to/home/volley/repos/${slug} (user.name/user.email)`,
      repo: slug,
    });
    const NONE = "git: no commit identity on box-a (volley setup --peer --step signin)";

    it("repo-level only: the machine is ready and the clone ready", () => {
      const rec = many([repo("a/a")], [noGlobal, ident("a/a", true)]);
      const r = readiness(input({ record: rec, repos: reposOf(rec, ["a/a"]) }));
      expect(r).toMatchObject({ ready: true, reasons: [] });
      expect(r.repos["a/a"]?.state).toBe("ready");
    });

    it("none anywhere: not ready, naming the fix", () => {
      const rec = many([repo("a/a")], [noGlobal]);
      const r = readiness(input({ record: rec, repos: reposOf(rec, ["a/a"]) }));
      expect(r.ready).toBe(false);
      expect(r.reasons).toEqual([NONE]);
    });

    it("global only: ready", () => {
      const rec = many([repo("a/a")], [{ ...noGlobal, ok: true, detail: "git commits as x" }]);
      expect(readiness(input({ record: rec, repos: reposOf(rec, ["a/a"]) })).ready).toBe(true);
    });

    it("global missing, clone A set and clone B not: ready, A ready, B blocked by repo.identity", () => {
      const rec = many(
        [repo("a/a"), repo("b/b")],
        [noGlobal, ident("a/a", true), ident("b/b", false)],
      );
      const r = readiness(input({ record: rec, repos: reposOf(rec, ["a/a", "b/b"]) }));
      expect(r).toMatchObject({ ready: true, reasons: [] });
      expect(r.repos["a/a"]?.state).toBe("ready");
      expect(r.repos["b/b"]?.state).toBe("blocked");
      expect(r.repos["b/b"]?.reasons[0]).toMatch(/^repo\.identity: no commit identity in/);
    });
  });

  describe("#638: a repository's expected git email", () => {
    const commitsAs = (slug: string, who: string) => ({
      id: "repo.identity",
      ok: true,
      severity: "block" as const,
      detail: `commits as ${who}`,
      repo: slug,
    });

    it("blocks a clone whose repo.identity commits under another; any case passes; none: unchanged", () => {
      const rec = many(
        [repo("a/a"), repo("b/b")],
        [commitsAs("a/a", "Dev <other@example.com>"), commitsAs("b/b", "Dev <DEV@example.com>")],
      );
      const expected = { "a/a": "dev@example.com", "B/B": "dev@example.com" };
      const r = readiness(
        input({
          record: rec,
          repos: { ...reposOf(rec, ["a/a", "b/b"]), expected_emails: expected },
        }),
      );
      expect(r.repos["a/a"]).toMatchObject({
        state: "blocked",
        reasons: ["repo.identity: commits as Dev <other@example.com>, expected dev@example.com"],
      });
      expect(r.repos["b/b"]?.state).toBe("ready");
      expect(r.requirements.repos).toEqual({
        "a/a": { git_email: "dev@example.com" },
        "B/B": { git_email: "dev@example.com" },
      });
      // The machine itself stays ready: the block is that repository's.
      expect(r.ready).toBe(true);
      const plain = readiness(input({ record: rec, repos: reposOf(rec, ["a/a", "b/b"]) }));
      expect(plain.repos["a/a"]?.state).toBe("ready");
      expect(plain.requirements).not.toHaveProperty("repos");
    });

    it("a repo.identity already failing adds nothing", () => {
      const failing = {
        ...commitsAs("a/a", "x"),
        ok: false,
        detail: "commits as Dev <o@example.com>, expected dev@example.com",
      };
      const rec = many([repo("a/a")], [failing]);
      const r = readiness(
        input({
          record: rec,
          repos: { ...reposOf(rec, ["a/a"]), expected_emails: { "a/a": "dev@example.com" } },
        }),
      );
      expect(r.repos["a/a"]?.reasons).toEqual([`repo.identity: ${failing.detail}`]);
    });
  });

  it("a wanted slug the machine has no entry for is absent, and the machine stays ready", () => {
    const rec = many([repo("a/a")]);
    const r = readiness(input({ record: rec, repos: reposOf(rec, ["a/a", "c/c"]) }));
    expect(r.repos["c/c"]).toEqual({ state: "absent", reasons: ["no clone of c/c on box-a"] });
    expect(r.ready).toBe(true);
  });

  it("a clone of a repository config assigns only to other machines is blocked there (#439)", () => {
    // The supervisor's own checkout of b/b, which a running wave uses: config gives b/b to box-b.
    const rec = many([repo("a/a"), repo("b/b")]);
    const r = readiness(
      input({
        name: "control",
        local: true,
        record: rec,
        repos: { ...reposOf(rec, ["a/a", "b/b"]), unassigned: ["B/b"] },
      }),
    );
    expect(r.repos["a/a"]).toMatchObject({ state: "ready" });
    expect(r.repos["b/b"]).toEqual({
      state: "blocked",
      path: "/path/to/home/volley/repos/b/b",
      reasons: [
        "b/b is not assigned to control: add it (Settings → Repositories, or volley repo add b/b --machine control)",
      ],
    });
    expect(r.ready).toBe(true);
  });

  it("D5: a missing tool blocks that repository only, with the exact reason", () => {
    const rec = many(
      [repo("a/a", { toolchain: { ok: false, missing: ["java"], outdated: [] } }), repo("b/b")],
      [
        {
          id: "tool.java",
          ok: false,
          severity: "block",
          repo: "a/a",
          detail: "java is not installed (a/a needs it)",
        },
      ],
    );
    const r = readiness(input({ record: rec, repos: reposOf(rec, ["a/a", "b/b"]) }));
    expect(r.repos["a/a"]).toMatchObject({
      state: "blocked",
      reasons: ["java not installed (needed by a/a)"],
    });
    expect(r.repos["b/b"]).toMatchObject({ state: "ready" });
    // A per-repository check never blocks the machine.
    expect(r).toMatchObject({ ready: true, reasons: [] });
  });

  it("an outdated tool and a failing per-repository check block that repository", () => {
    const rec = many(
      [repo("a/a", { toolchain: { ok: false, missing: [], outdated: ["node"] } })],
      [
        {
          id: "repo.fetch",
          ok: false,
          severity: "block",
          repo: "a/a",
          detail: "git fetch failed",
        },
        { id: "repo.canonical", ok: false, severity: "warn", repo: "a/a", detail: "renamed" },
      ],
    );
    const r = readiness(input({ record: rec, repos: reposOf(rec, ["a/a"]) }));
    expect(r.repos["a/a"]).toMatchObject({
      state: "blocked",
      reasons: ["repo.fetch: git fetch failed", "node older than required (needed by a/a)"],
    });
  });

  it("#610: a failing repo.push or repo.worktrees blocks that repository only; the machine stays ready", () => {
    const rec = many(
      [repo("a/a"), repo("b/b")],
      [
        {
          id: "repo.push",
          ok: false,
          severity: "block",
          repo: "a/a",
          detail: "octocat cannot push to a/a (permission READ)",
        },
        {
          id: "repo.worktrees",
          ok: false,
          severity: "block",
          repo: "b/b",
          detail: "cannot write /path/to/wt (nor create it)",
        },
      ],
    );
    const r = readiness(input({ record: rec, repos: reposOf(rec, ["a/a", "b/b"]) }));
    expect(r.repos["a/a"]).toMatchObject({
      state: "blocked",
      reasons: ["repo.push: octocat cannot push to a/a (permission READ)"],
    });
    expect(r.repos["b/b"]).toMatchObject({
      state: "blocked",
      reasons: ["repo.worktrees: cannot write /path/to/wt (nor create it)"],
    });
    expect(r.ready).toBe(true);
  });

  it("an older peer's legacy repo maps to its slug through its origin", () => {
    const r = readiness(input());
    expect(r.repos).toEqual({
      [SLUG]: { state: "ready", path: "/srv/repo", reasons: [] },
    });
    const missing = record({
      repo: { path: "/srv/repo", exists: false, origin: `github.com/${SLUG}` },
      checks: [{ id: "repo.clone", ok: false, severity: "block", detail: "no clone at /srv/repo" }],
    });
    const m = readiness(input({ record: missing }));
    expect(m.repos[SLUG]).toMatchObject({
      state: "absent",
      reasons: [`no clone of ${SLUG} at /srv/repo`],
    });
    expect(m.ready).toBe(true);
    // A legacy clone without an origin yet serves any wanted slug, as placement resolves it.
    const bare = record({ repo: { path: "/srv/repo", exists: true } });
    expect(readiness(input({ record: bare })).repos[SLUG]).toMatchObject({ state: "ready" });
  });

  it("gh without push access names the slug from repos[]", () => {
    const rec = many([repo("a/a")]);
    const r = readiness(
      input({
        record: { ...rec, auth: { gh: "no_write", claude: "signed_in", trust: "ok" } },
        repos: reposOf(rec, ["a/a"]),
      }),
    );
    expect(r.reasons).toEqual(["gh: no write permission on a/a"]);
  });

  describe("the path the supervisor would spawn in (#608)", () => {
    const BOX = "/path/to/home/.volley/repos/a/a";
    const SPAWN = "/sup/.volley/volleyd/repos/a/a";
    const rec = many([repo("a/a", { path: BOX })]);
    const at = (repos: Partial<ReadinessInput["repos"]>, over: Partial<ReadinessInput> = {}) =>
      readiness(input({ record: rec, repos: { ...reposOf(rec, ["a/a"]), ...repos }, ...over }))
        .repos["a/a"];

    it("a spawn path other than the reported clone blocks the repository, keeping the clone's path", () => {
      const v = at({ spawn: { "a/a": SPAWN } });
      expect(v?.state).toBe("blocked");
      expect(v?.path).toBe(BOX);
      expect(v?.reasons[0]).toBe(
        `the supervisor would spawn in ${SPAWN} but box-a reports its clone at ${BOX}`,
      );
    });

    it("the same path (trailing slash aside), no spawn path, or the own machine: ready", () => {
      expect(at({ spawn: { "a/a": `${BOX}/` } })?.state).toBe("ready");
      expect(at({})?.state).toBe("ready");
      expect(at({ spawn: { "a/a": SPAWN } }, { local: true })?.state).toBe("ready");
    });

    it("a probe that finds no clone, or another repository's, at the spawn path blocks it", () => {
      const probed = (p: object) => at({ spawn: { "a/a": BOX }, probed: { "a/a": p as never } });
      expect(probed({ state: "missing" })).toMatchObject({
        state: "blocked",
        reasons: [`no clone at ${BOX} on box-a`],
      });
      expect(probed({ state: "not_git" })?.reasons[0]).toBe(`no clone at ${BOX} on box-a`);
      expect(probed({ state: "missing", at: CHECKED.getTime() - 40_000 })?.reasons[0]).toBe(
        `no clone at ${BOX} on box-a (probed 40 s ago)`,
      );
      expect(probed({ state: "found", slug: "b/b" })).toMatchObject({
        state: "blocked",
        reasons: [`${BOX} on box-a is a clone of b/b`],
      });
      expect(probed({ state: "found", slug: "a/a" })?.state).toBe("ready");
      expect(probed({ state: "no_origin" })?.state).toBe("ready");
    });

    it("a spawn that failed there (a runs entry) blocks it with its why", () => {
      const why = "no clone at /x on box-a";
      expect(at({ runs: { "a/a": { state: "blocked", reasons: [why] } } })).toMatchObject({
        state: "blocked",
        reasons: [why],
      });
    });

    it("the probe's age never makes a re-publish on its own", () => {
      const v = (ago: number) =>
        readiness(
          input({
            record: rec,
            repos: {
              ...reposOf(rec, ["a/a"]),
              spawn: { "a/a": BOX },
              probed: { "a/a": { state: "missing", at: CHECKED.getTime() - ago } },
            },
          }),
        );
      expect(readinessKey(v(5_000))).toBe(readinessKey(v(65_000)));
    });
  });

  it("every per-repository verdict validates against readiness.schema.json", () => {
    const rec = many([
      repo("a/a", { toolchain: { ok: false, missing: ["java"], outdated: [] } }),
      repo("b/b", { exists: false }),
      repo("c/c"),
    ]);
    const v = readiness(input({ record: rec, repos: reposOf(rec, ["a/a", "b/b", "c/c", "d/d"]) }));
    expect(Object.keys(v.repos).sort()).toEqual(["a/a", "b/b", "c/c", "d/d"]);
    expect(
      schemaErrors("readiness.schema.json", envelope(READINESS_CHANNEL, "readiness", v)),
    ).toEqual([]);
  });
});

describe("peerMaxAgents: a peer's cap (#324)", () => {
  it("hosts.<name>.max_agents wins; else derived from the record's size; else 4", () => {
    const big = { cores: 32, memory: { total_mb: 61_440, available_pct: 80 } };
    expect(peerMaxAgents(6, big)).toBe(6);
    expect(peerMaxAgents(undefined, big)).toBe(10);
    expect(
      peerMaxAgents(undefined, { cores: 10, memory: { total_mb: 32_768, available_pct: 50 } }),
    ).toBe(3);
    // The bounds: never under 2, never over 16.
    expect(
      peerMaxAgents(undefined, { cores: 2, memory: { total_mb: 4096, available_pct: 50 } }),
    ).toBe(2);
    expect(
      peerMaxAgents(undefined, { cores: 128, memory: { total_mb: 524_288, available_pct: 50 } }),
    ).toBe(16);
    // No memory figure (a record from before the Fleet), or no record: 4.
    expect(peerMaxAgents(undefined, { cores: 32 })).toBe(4);
    expect(peerMaxAgents(undefined, undefined)).toBe(4);
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
    return machineView(i, v, v.usage);
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
    expect(parsePathProbe("/path/to/home/.bun/bin/bun\n")).toEqual({ claude: false, bun: true });
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
