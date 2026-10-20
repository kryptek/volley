import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, DEFAULTS_AUTHOR, defaultsFor } from "../src/config-defaults";
import { ConfigError, ConfigStore, volleydHome } from "../src/config-store";
import { Journal, readJournalFile } from "../src/journal";
import { SYSTEM_WAVE } from "../src/types";
import { envelope, schemaErrors } from "./helpers/schema";
import { tempDir } from "./helpers/tmp";

let home: string;
const now = () => new Date("2026-10-18T12:00:00.000Z");
const open = () =>
  ConfigStore.load({ home, system: Journal.open(join(home, "waves", SYSTEM_WAVE)), now });

beforeEach(() => {
  home = tempDir("volleyd-config-");
});

describe("volleydHome", () => {
  it("is $VOLLEYD_HOME, else ~/.volley/volleyd", () => {
    expect(volleydHome({ VOLLEYD_HOME: "/x/y" })).toBe("/x/y");
    expect(volleydHome({ HOME: "/home/u" })).toBe("/home/u/.volley/volleyd");
  });
});

describe("worktree_root under VOLLEYD_HOME", () => {
  it("defaults to $VOLLEYD_HOME/worktrees when VOLLEYD_HOME is set", () => {
    expect(defaultsFor({ VOLLEYD_HOME: "/smoke/home" }).worktree_root).toBe(
      "/smoke/home/worktrees",
    );
    expect(defaultsFor({}).worktree_root).toBe(CONFIG_DEFAULTS.worktree_root);
  });

  it("an explicit config.yaml worktree_root still wins", () => {
    const system = Journal.open(join(home, "waves", SYSTEM_WAVE));
    const defaults = defaultsFor({ VOLLEYD_HOME: home });
    expect(ConfigStore.load({ home, system, now, defaults }).get("worktree_root")).toBe(
      join(home, "worktrees"),
    );
    writeFileSync(join(home, "config.yaml"), "worktree_root: /elsewhere/wt\n");
    expect(ConfigStore.load({ home, system, now, defaults }).get("worktree_root")).toBe(
      "/elsewhere/wt",
    );
  });
});

describe("ConfigStore layering", () => {
  it("uses built-in defaults when there is no config.yaml", () => {
    const c = open();
    // `fleet.local_agents: null` is resolved: no hosts, so `always`.
    expect(c.effective()).toEqual({
      ...CONFIG_DEFAULTS,
      fleet: { ...CONFIG_DEFAULTS.fleet, local_agents: "always" },
    });
    expect(c.get("hard_ceiling")).toBe(12);
  });

  it("layers defaults ← config.yaml ← per-wave overrides", () => {
    writeFileSync(
      join(home, "config.yaml"),
      "hard_ceiling: 8\nadmission:\n  ci_queue_max: 4\nlease_pools:\n  build: { capacity: 2, match: [vite build] }\n",
    );
    const c = open();
    c.setWaveOverrides("w1", { hard_ceiling: 3, lease_pools: { build: { capacity: 1 } } });

    expect(c.get("hard_ceiling")).toBe(8);
    expect(c.get("hard_ceiling", "w1")).toBe(3);
    expect(c.get("hard_ceiling", "w2")).toBe(8);
    // Nested objects merge key by key; untouched keys keep the lower layer's value.
    expect(c.get("admission.ci_queue_max", "w1")).toBe(4);
    expect(c.get("admission.hysteresis_samples", "w1")).toBe(3);
    expect(c.get("lease_pools.build", "w1")).toEqual({ capacity: 1, match: ["vite build"] });
    expect(c.effective("w1").spawn_budget_multiplier).toBe(3);

    c.clearWave("w1");
    expect(c.get("hard_ceiling", "w1")).toBe(8);
  });

  it("placement.nudge_on_merge: the default, config.yaml, then a wave's config: (what the pipeline reads)", () => {
    expect(open().get("placement.nudge_on_merge")).toBe("files");
    writeFileSync(join(home, "config.yaml"), "placement:\n  nudge_on_merge: all\n");
    const c = open();
    c.setWaveOverrides("w1", { placement: { nudge_on_merge: "off" } });
    expect(c.get("placement.nudge_on_merge", "w1")).toBe("off");
    expect(c.get("placement.nudge_on_merge", "w2")).toBe("all");
  });

  it("rejects an unknown path in get()", () => {
    expect(() => open().get("nope")).toThrow(/unknown config path 'nope'/);
  });

  it("branch_update defaults to rebase and agent_mcp to strict; both layer like any tunable", () => {
    writeFileSync(join(home, "config.yaml"), "branch_update: merge\n");
    const c = open();
    expect(CONFIG_DEFAULTS.branch_update).toBe("rebase");
    expect(CONFIG_DEFAULTS.agent_mcp).toBe("strict");
    expect(c.get("branch_update")).toBe("merge");
    c.setWaveOverrides("w1", { branch_update: "rebase", agent_mcp: "inherit" });
    expect(c.effective("w1")).toMatchObject({ branch_update: "rebase", agent_mcp: "inherit" });
    expect(c.effective().agent_mcp).toBe("strict");
    const r = c.applyPatch({ agent_mcp: "everything" } as never, "x");
    expect(r.applied).toBe(false);
    expect(
      schemaErrors("config.schema.json", envelope("_waves/_config", "config", c.retainedPayload())),
    ).toEqual([]);
  });

  it("background_wait_max_s and stall_backoff_max_s: bounded, per-wave, in the effective config", () => {
    expect(CONFIG_DEFAULTS).toMatchObject({
      background_wait_max_s: 7200,
      stall_backoff_max_s: 1800,
    });
    const c = open();
    for (const bad of [{ background_wait_max_s: 59 }, { stall_backoff_max_s: 86401 }]) {
      const r = c.applyPatch(bad as never, "x");
      expect(r.applied).toBe(false);
      expect(r.rejected?.[0]?.path).toBe(Object.keys(bad)[0]);
    }
    expect(c.applyPatch({ stall_backoff_max_s: 3600 }, "x").applied).toBe(true);
    c.setWaveOverrides("w1", { background_wait_max_s: 600 });
    expect(c.effective("w1")).toMatchObject({
      background_wait_max_s: 600,
      stall_backoff_max_s: 3600,
    });
    expect(c.effective("w2").background_wait_max_s).toBe(7200);
    expect(
      schemaErrors("config.schema.json", envelope("_waves/_config", "config", c.retainedPayload())),
    ).toEqual([]);
  });

  it("public_hygiene: auto | on | off, default auto, per-wave override, in the retained payload", () => {
    writeFileSync(join(home, "config.yaml"), "public_hygiene: on\n");
    const c = open();
    expect(CONFIG_DEFAULTS.public_hygiene).toBe("auto");
    expect(c.get("public_hygiene")).toBe("on");
    c.setWaveOverrides("w1", { public_hygiene: "off" });
    expect(c.effective("w1").public_hygiene).toBe("off");
    expect(c.effective().public_hygiene).toBe("on");
    expect(c.applyPatch({ public_hygiene: "yes" } as never, "x").applied).toBe(false);
    expect(c.applyPatch({ public_hygiene: "auto" }, "x").applied).toBe(true);
    expect(c.effective().public_hygiene).toBe("auto");
    expect(c.retainedPayload()).toMatchObject({ public_hygiene: "auto" });
    expect(
      schemaErrors("config.schema.json", envelope("_waves/_config", "config", c.retainedPayload())),
    ).toEqual([]);
  });

  it("rejects Object prototype names as config paths", () => {
    for (const p of ["constructor", "toString", "__proto__", "hasOwnProperty.x"]) {
      expect(() => open().get(p)).toThrow(/unknown config path/);
    }
  });

  it("fails load on an out-of-bounds file value, naming the path", () => {
    writeFileSync(join(home, "config.yaml"), "hard_ceiling: 500\n");
    let err: unknown;
    try {
      open();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("config.yaml");
    expect((err as ConfigError).errors).toEqual([
      { path: "hard_ceiling", reason: "must be <= 100" },
    ]);
  });

  it("fails load on a per_machine above its pool's capacity, naming the path", () => {
    writeFileSync(
      join(home, "config.yaml"),
      "lease_pools:\n  build: { capacity: 2, per_machine: 3 }\n",
    );
    let err: unknown;
    try {
      open();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).errors).toEqual([
      { path: "lease_pools.build.per_machine", reason: "must be at most capacity (2)" },
    ]);
  });

  it("fails load on an unknown key and on malformed YAML", () => {
    writeFileSync(join(home, "config.yaml"), "hard_ceilin: 5\n");
    expect(() => open()).toThrow(/hard_ceilin: unknown key/);
    writeFileSync(join(home, "config.yaml"), "hard_ceiling: [\n");
    expect(() => open()).toThrow(ConfigError);
  });
});

describe("retained _config payload", () => {
  it("validates against config.schema.json and carries version/updated_by", () => {
    const c = open();
    const p = c.retainedPayload();
    expect(schemaErrors("config.schema.json", envelope("_waves/_config", "config", p))).toEqual([]);
    expect(p.version).toBe(1);
    expect(p.updated_by).toBe(DEFAULTS_AUTHOR);
    expect(p.updated_at).toBe("2026-10-18T12:00:00.000Z");
    expect(p.hard_ceiling).toBe(12);
  });

  it("derives version and updated_by from the _system journal across restarts", () => {
    const c = open();
    expect(c.applyPatch({ hard_ceiling: 5 }, "coordinator-ab12").applied).toBe(true);
    expect(c.applyPatch({ claim_after_s: 900 }, "desk").applied).toBe(true);
    const again = open();
    const p = again.retainedPayload();
    expect(p.version).toBe(3);
    expect(p.updated_by).toBe("desk");
    expect(p.hard_ceiling).toBe(5);
    expect(p.claim_after_s).toBe(900);
    expect(schemaErrors("config.schema.json", envelope("_waves/_config", "config", p))).toEqual([]);
  });
});

describe("applyPatch", () => {
  it("writes config.yaml, journals config_changed with by/previous, bumps version", () => {
    const c = open();
    const changes: number[] = [];
    c.onChange((ch) => changes.push(ch.version));
    const r = c.applyPatch({ hard_ceiling: 2, admission: { ci_queue_max: 5 } }, "coordinator-ab12");
    expect(r).toEqual({ applied: true, rejected: [], version: 2 });
    expect(changes).toEqual([2]);
    expect(c.get("hard_ceiling")).toBe(2);
    expect(readFileSync(join(home, "config.yaml"), "utf-8")).toContain("hard_ceiling: 2");

    const ev = Journal.open(join(home, "waves", SYSTEM_WAVE)).readAll();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      seq: 1,
      type: "config_changed",
      data: {
        by: "coordinator-ab12",
        patch: { hard_ceiling: 2, admission: { ci_queue_max: 5 } },
        previous: { hard_ceiling: 12, admission: { ci_queue_max: 10 } },
        version: 2,
      },
    });
    expect(typeof ev[0]?.at).toBe("string");
  });

  it("rejects unknown keys and out-of-bounds values as a whole, changing nothing", () => {
    const c = open();
    let notified = false;
    c.onChange(() => {
      notified = true;
    });
    const r = c.applyPatch(
      { hard_ceiling: 2, bogus: 1, admission: { container_max: -1 } } as never,
      "x",
    );
    expect(r.applied).toBe(false);
    expect(r.rejected).toEqual(
      expect.arrayContaining([
        { path: "bogus", reason: "unknown key" },
        { path: "admission.container_max", reason: "must be >= 0" },
      ]),
    );
    expect(c.get("hard_ceiling")).toBe(12);
    expect(c.retainedPayload().version).toBe(1);
    expect(notified).toBe(false);
    expect(Journal.open(join(home, "waves", SYSTEM_WAVE)).readAll()).toEqual([]);
  });

  it("rejects an empty patch", () => {
    const r = open().applyPatch({}, "x");
    expect(r.applied).toBe(false);
    expect(r.rejected[0]?.reason).toMatch(/at least 1/);
  });

  it("sets one field of an existing lease pool without restating capacity", () => {
    const c = open();
    expect(c.applyPatch({ lease_pools: { build: { capacity: 2 } } }, "x").applied).toBe(true);
    const r = c.applyPatch({ lease_pools: { build: { ttl_s: 600 } } } as never, "x");
    expect(r).toEqual({ applied: true, rejected: [], version: 3 });
    expect(c.get("lease_pools.build")).toMatchObject({ capacity: 2, ttl_s: 600 });
    // The written file still loads.
    expect(open().get("lease_pools.build")).toMatchObject({ capacity: 2, ttl_s: 600 });
  });

  it("still requires capacity for a new lease pool", () => {
    const r = open().applyPatch({ lease_pools: { build: { ttl_s: 600 } } } as never, "x");
    expect(r.applied).toBe(false);
    expect(r.rejected).toEqual([
      { path: "lease_pools.build", reason: "must have required property 'capacity'" },
    ]);
  });

  it("refuses a per_machine above its pool's capacity, naming the path; equal is accepted", () => {
    const c = open();
    const r = c.applyPatch({ lease_pools: { build: { capacity: 2, per_machine: 3 } } }, "x");
    expect(r.applied).toBe(false);
    expect(r.rejected).toEqual([
      { path: "lease_pools.build.per_machine", reason: "must be at most capacity (2)" },
    ]);
    expect(c.applyPatch({ lease_pools: { build: { capacity: 2, per_machine: 2 } } }, "x")).toEqual({
      applied: true,
      rejected: [],
      version: 2,
    });
    // Cutting capacity below an existing per_machine is refused the same way.
    const cut = c.applyPatch({ lease_pools: { build: { capacity: 1 } } }, "x");
    expect(cut.rejected).toEqual([
      { path: "lease_pools.build.per_machine", reason: "must be at most capacity (1)" },
    ]);
  });

  it("rejects an empty sub-object as a no-op, without bumping the version", () => {
    const c = open();
    const r = c.applyPatch({ admission: {} }, "x");
    expect(r.applied).toBe(false);
    expect(r.rejected).toEqual([{ path: "admission", reason: "must set at least 1 key" }]);
    expect(c.retainedPayload().version).toBe(1);
    expect(Journal.open(join(home, "waves", SYSTEM_WAVE)).readAll()).toEqual([]);
  });

  it("reports the journal seq of each change to listeners", () => {
    const c = open();
    const seqs: number[] = [];
    c.onChange((ch) => seqs.push(ch.seq));
    c.applyPatch({ hard_ceiling: 2 }, "x");
    c.applyPatch({ hard_ceiling: 3 }, "x");
    expect(seqs).toEqual([1, 2]);
  });
});

describe("ConfigStore.removeHost (volley peer remove)", () => {
  const HOSTS =
    "hosts:\n  box-a:\n    target: dev@box-a\n    tunnel: { remote_port: 21883, supervise: false }\n  box-b:\n    target: dev@box-b\n";

  it("drops hosts.<name> from config.yaml, journals the null patch with `previous`, bumps the version and notifies", () => {
    writeFileSync(join(home, "config.yaml"), HOSTS);
    const c = open();
    const changes: unknown[] = [];
    c.onChange((ch) => changes.push(ch));
    const before = c.effective().hosts["box-a"];
    expect(before).toBeDefined();

    const r = c.removeHost("box-a", "admin-1");
    expect(r).toEqual({ applied: true, rejected: [], version: 2 });
    expect(Object.keys(c.effective().hosts)).toEqual(["box-b"]);
    expect(readFileSync(join(home, "config.yaml"), "utf-8")).not.toContain("box-a");
    const ev = readJournalFile(join(home, "waves", SYSTEM_WAVE, "journal.jsonl")).find(
      (e) => e.type === "config_changed",
    );
    expect(ev?.data).toEqual({
      by: "admin-1",
      patch: { hosts: { "box-a": null } },
      previous: { hosts: { "box-a": before } },
      version: 2,
    });
    expect(changes).toEqual([
      expect.objectContaining({ version: 2, by: "admin-1", patch: { hosts: { "box-a": null } } }),
    ]);
    // The removal survives a restart (replayed from config.yaml and the journal).
    expect(Object.keys(open().effective().hosts)).toEqual(["box-b"]);
  });

  it("refuses a name config.yaml does not have, and changes nothing", () => {
    writeFileSync(join(home, "config.yaml"), HOSTS);
    const c = open();
    expect(c.removeHost("nobody", "admin-1")).toEqual({
      applied: false,
      rejected: [{ path: "hosts.nobody", reason: "not in config.yaml" }],
    });
    expect(readFileSync(join(home, "config.yaml"), "utf-8")).toBe(HOSTS);
    expect(c.retainedPayload().version).toBe(1);
  });
});

describe("Fleet keys: hosts.<name>.max_agents / drain, fleet.local_name (SPEC §4.6.15)", () => {
  const BOX = "hosts:\n  box-a:\n    target: dev@box-a\n    volley_dir: /opt/volley\n";
  const openAs = (hostname: string) =>
    ConfigStore.load({
      home,
      system: Journal.open(join(home, "waves", SYSTEM_WAVE)),
      now,
      hostname,
    });

  it("refuses max_agents outside 1..100, a non-boolean drain and a reserved local_name", () => {
    writeFileSync(join(home, "config.yaml"), BOX);
    const c = openAs("host-1.example");
    for (const [patch, path] of [
      [{ hosts: { "box-a": { max_agents: 0 } } }, "hosts.box-a.max_agents"],
      [{ hosts: { "box-a": { max_agents: 101 } } }, "hosts.box-a.max_agents"],
      [{ hosts: { "box-a": { drain: "yes" } } }, "hosts.box-a.drain"],
      [{ fleet: { local_name: "local" } }, "fleet.local_name"],
      [{ fleet: { local_name: "auto" } }, "fleet.local_name"],
    ] as const) {
      const r = c.applyPatch(patch as never, "admin-1");
      expect(r.applied, JSON.stringify(patch)).toBe(false);
      expect(r.rejected.map((e) => e.path)).toContain(path);
    }
    expect(c.retainedPayload().version).toBe(1);
  });

  it("applies max_agents and drain hot, journaled as config_changed", () => {
    writeFileSync(join(home, "config.yaml"), BOX);
    const c = openAs("host-1.example");
    const r = c.applyPatch({ hosts: { "box-a": { max_agents: 2, drain: true } } }, "admin-1");
    expect(r).toEqual({ applied: true, rejected: [], version: 2 });
    expect(c.effective().hosts["box-a"]).toMatchObject({ max_agents: 2, drain: true });
    const ev = readJournalFile(join(home, "waves", SYSTEM_WAVE, "journal.jsonl")).find(
      (e) => e.type === "config_changed",
    );
    expect(ev?.data.patch).toEqual({ hosts: { "box-a": { max_agents: 2, drain: true } } });
  });

  it("never lets the supervisor's machine name be a configured host's, either way round", () => {
    writeFileSync(join(home, "config.yaml"), BOX);
    const c = openAs("host-1.example");
    const named = c.applyPatch({ fleet: { local_name: "box-a" } }, "admin-1");
    expect(named.applied).toBe(false);
    expect(named.rejected).toEqual([
      expect.objectContaining({
        path: "fleet.local_name",
        reason: expect.stringContaining("box-a"),
      }),
    ]);
    // The derived name (from the host name) counts too.
    const host = c.applyPatch(
      { hosts: { "host-1": { target: "dev@host-1", volley_dir: "/opt/volley" } } },
      "admin-1",
    );
    expect(host.applied).toBe(false);
    expect(host.rejected).toEqual([expect.objectContaining({ path: "hosts.host-1" })]);
    // Naming the supervisor's machine otherwise frees the derived name.
    expect(c.applyPatch({ fleet: { local_name: "control" } }, "admin-1").applied).toBe(true);
    expect(
      c.applyPatch(
        { hosts: { "host-1": { target: "dev@host-1", volley_dir: "/opt/volley" } } },
        "admin-1",
      ).applied,
    ).toBe(true);
  });

  it("a config.yaml whose host takes the supervisor's name is refused at load", () => {
    writeFileSync(join(home, "config.yaml"), `${BOX}fleet:\n  local_name: box-a\n`);
    expect(() => openAs("host-1.example")).toThrow(ConfigError);
  });

  it("the retained payload carries the resolved name, never null", () => {
    const c = openAs("MacBook-Pro.local");
    expect(c.effective().fleet.local_name).toBeNull();
    const payload = c.retainedPayload();
    expect(payload.fleet.local_name).toBe("macbook-pro");
    expect(
      schemaErrors("config.schema.json", envelope("_waves/_config", "config", payload)),
    ).toEqual([]);
    c.applyPatch({ fleet: { local_name: "control" } }, "admin-1");
    expect(c.retainedPayload().fleet.local_name).toBe("control");
  });
});

describe("fleet.local_agents and lease_pools.<pool>.per_machine_overrides (SPEC §4.6.15, §4.6.5)", () => {
  const BOX = "hosts:\n  box-a:\n    target: dev@box-a\n    volley_dir: /opt/volley\n";
  const openAs = (hostname: string) =>
    ConfigStore.load({
      home,
      system: Journal.open(join(home, "waves", SYSTEM_WAVE)),
      now,
      hostname,
    });
  const journal = () => readJournalFile(join(home, "waves", SYSTEM_WAVE, "journal.jsonl"));

  it("refuses an override over the pool's capacity, naming the path and the bound", () => {
    const c = openAs("laptop");
    const r = c.applyPatch(
      { lease_pools: { js: { capacity: 3, per_machine_overrides: { "box-a": 5 } } } },
      "admin-1",
    );
    expect(r.applied).toBe(false);
    expect(r.rejected).toEqual([
      {
        path: "lease_pools.js.per_machine_overrides.box-a",
        reason: "5 is over capacity 3",
      },
    ]);
    // 0 is allowed: none on that machine.
    expect(
      c.applyPatch(
        { lease_pools: { js: { capacity: 3, per_machine_overrides: { "box-a": 0 } } } },
        "admin-1",
      ).applied,
    ).toBe(true);
  });

  it("an over-capacity override in config.yaml is refused at load", () => {
    writeFileSync(
      join(home, "config.yaml"),
      "lease_pools:\n  js:\n    capacity: 2\n    per_machine_overrides: { box-a: 3 }\n",
    );
    expect(() => openAs("laptop")).toThrow(/per_machine_overrides\.box-a: 3 is over capacity 2/);
  });

  it("resolves `local` to the supervisor's machine name in the effective config", () => {
    const c = openAs("laptop");
    expect(
      c.applyPatch(
        { lease_pools: { js: { capacity: 3, per_machine_overrides: { local: 1, "box-a": 3 } } } },
        "admin-1",
      ).applied,
    ).toBe(true);
    expect(c.effective().lease_pools.js?.per_machine_overrides).toEqual({ laptop: 1, "box-a": 3 });
    expect(c.retainedPayload().lease_pools.js?.per_machine_overrides).toEqual({
      laptop: 1,
      "box-a": 3,
    });
  });

  it("the supervisor's machine name set explicitly wins over `local` (what the Desk shows is in force)", () => {
    writeFileSync(
      join(home, "config.yaml"),
      "lease_pools:\n  js:\n    capacity: 4\n    per_machine_overrides: { local: 2 }\n",
    );
    const c = openAs("laptop");
    expect(c.effective().lease_pools.js?.per_machine_overrides).toEqual({ laptop: 2 });
    // The Desk writes the resolved name.
    expect(
      c.applyPatch(
        { lease_pools: { js: { capacity: 4, per_machine_overrides: { laptop: 3 } } } },
        "admin-1",
      ).applied,
    ).toBe(true);
    expect(c.effective().lease_pools.js?.per_machine_overrides).toEqual({ laptop: 3 });
  });

  it("local_agents null resolves to always with no hosts and fallback once a host exists", () => {
    const c = openAs("laptop");
    expect(c.effective().fleet.local_agents).toBe("always");
    expect(c.retainedPayload().fleet.local_agents).toBe("always");
    c.applyPatch(
      { hosts: { "box-a": { target: "dev@box-a", volley_dir: "/opt/volley" } } },
      "admin-1",
    );
    expect(c.effective().fleet.local_agents).toBe("fallback");
    expect(c.retainedPayload().fleet.local_agents).toBe("fallback");
    // The flip is journaled as the defaults' own change, so clients see it.
    const flip = journal()
      .filter((e) => e.type === "config_changed")
      .at(-1);
    expect(flip?.data).toMatchObject({
      by: DEFAULTS_AUTHOR,
      patch: { fleet: { local_agents: "fallback" } },
      previous: { fleet: { local_agents: "always" } },
    });
    expect(c.retainedPayload().updated_by).toBe(DEFAULTS_AUTHOR);
    expect(
      schemaErrors("config.schema.json", envelope("_waves/_config", "config", c.retainedPayload())),
    ).toEqual([]);
  });

  it("an explicit mode is kept with or without hosts", () => {
    const c = openAs("laptop");
    c.applyPatch({ fleet: { local_agents: "never" } }, "admin-1");
    expect(c.effective().fleet.local_agents).toBe("never");
    const before = journal().length;
    c.applyPatch(
      { hosts: { "box-a": { target: "dev@box-a", volley_dir: "/opt/volley" } } },
      "admin-1",
    );
    expect(c.effective().fleet.local_agents).toBe("never");
    // No derived flip to journal.
    expect(journal().length).toBe(before + 1);
    writeFileSync(join(home, "config.yaml"), `${BOX}fleet:\n  local_agents: always\n`);
    expect(openAs("laptop").effective().fleet.local_agents).toBe("always");
  });

  it("an explicit local_agents patch, or clearing it, journals exactly one change", () => {
    const changes = () => journal().filter((e) => e.type === "config_changed");
    const c = openAs("laptop");
    const v0 = c.retainedPayload().version;
    c.applyPatch({ fleet: { local_agents: "never" } }, "admin-1");
    expect(changes()).toHaveLength(1);
    expect(changes().at(-1)?.data).toMatchObject({ by: "admin-1" });
    expect(c.retainedPayload()).toMatchObject({ version: v0 + 1, updated_by: "admin-1" });
    c.applyPatch({ fleet: { local_agents: null } }, "admin-1");
    expect(c.effective().fleet.local_agents).toBe("always");
    expect(changes()).toHaveLength(2);
    expect(c.retainedPayload()).toMatchObject({ version: v0 + 2, updated_by: "admin-1" });
  });

  it("refuses an unknown mode and a fallback max_agents of 0", () => {
    const c = openAs("laptop");
    for (const [patch, path] of [
      [{ fleet: { local_agents: "sometimes" } }, "fleet.local_agents"],
      [{ fleet: { fallback: { max_agents: 0 } } }, "fleet.fallback.max_agents"],
      [{ fleet: { fallback: { per_machine: { js: 65 } } } }, "fleet.fallback.per_machine.js"],
    ] as const) {
      const r = c.applyPatch(patch as never, "admin-1");
      expect(r.applied, JSON.stringify(patch)).toBe(false);
      expect(r.rejected.map((e) => e.path)).toContain(path);
    }
  });
});

describe("placement.weights: never all four at 0 (SPEC §4.6.15)", () => {
  const ZERO = "not all four weights may be 0 (cpu, slots, mem, usage)";

  it("a config_set that zeroes them is refused with a plain reason at the field", () => {
    const c = open();
    const r = c.applyPatch(
      { placement: { weights: { cpu: 0, slots: 0, mem: 0, usage: 0 } } },
      "tester",
    );
    expect(r.applied).toBe(false);
    expect(r.rejected).toEqual([{ path: "placement.weights", reason: ZERO }]);
  });

  it("a wave's config: that zeroes them with the global config's is refused; one that does not passes", () => {
    writeFileSync(
      join(home, "config.yaml"),
      "placement:\n  weights: { cpu: 100, slots: 0, mem: 0, usage: 0 }\n",
    );
    const c = open();
    expect(c.waveOverrideErrors({ placement: { weights: { cpu: 0 } } } as never)).toEqual([
      { path: "config.placement.weights", reason: `${ZERO} with the global config` },
    ]);
    expect(c.waveOverrideErrors({ placement: { weights: { mem: 1 } } } as never)).toEqual([]);
    expect(c.waveOverrideErrors({})).toEqual([]);
  });
});
