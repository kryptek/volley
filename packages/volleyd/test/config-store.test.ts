import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DEFAULTS, DEFAULTS_AUTHOR, defaultsFor } from "../src/config-defaults";
import { ConfigError, ConfigStore, volleydHome } from "../src/config-store";
import { Journal, readJournalFile } from "../src/journal";
import { SYSTEM_WAVE } from "../src/types";
import { envelope, schemaErrors } from "./helpers/schema";

let home: string;
const now = () => new Date("2026-10-18T12:00:00.000Z");
const open = () =>
  ConfigStore.load({ home, system: Journal.open(join(home, "waves", SYSTEM_WAVE)), now });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "volleyd-config-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
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
    expect(c.effective()).toEqual(CONFIG_DEFAULTS);
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

  it("rejects an unknown path in get()", () => {
    expect(() => open().get("nope")).toThrow(/unknown config path 'nope'/);
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
