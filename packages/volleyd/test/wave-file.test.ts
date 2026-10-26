import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { explain } from "../src/overlap-plan";
import type { PathError } from "../src/schemas";
import {
  type PlacementDefaults,
  WaveFileError,
  defaultPlacement,
  filePlan,
  formatPlacement,
  isSlugRepo,
  parseWaveFile,
  planNotes,
  resolveWaveRepo,
} from "../src/wave-file";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");

const HEADER = `wave: w1
repo: /path/to/example-repo
release_branch: release/w1
model: claude-opus-5-5
pipeline: [implement, merge_ready]
`;

/** Parse and return the error messages (fails the test if parsing succeeds). */
function errorsOf(text: string): string[] {
  try {
    parseWaveFile(text);
  } catch (e) {
    expect(e).toBeInstanceOf(WaveFileError);
    return (e as WaveFileError).errors.map((x) => `${x.path}: ${x.reason}`);
  }
  throw new Error("expected parseWaveFile to throw");
}

describe("parseWaveFile", () => {
  it("parses the epic example wave to the expected structure", () => {
    const w = parseWaveFile(fixture("example.yaml"));
    expect(w.wave).toBe("2026-10-20-example");
    expect(w.version).toBe(1);
    expect(w.repo).toBe("~/repos/example");
    expect(w.release_branch).toBe("release/2026-10-20-example");
    expect(w.model).toBe("claude-opus-5-5");
    expect(w.task_order).toEqual(["T0", "T1", "T2", "T3"]);
    expect(w.tasks.T0).toEqual({
      id: "T0",
      issue: 101,
      after: [],
      pipeline: ["implement", ["spec_review", "quality_review"], "fixup", "merge_ready"],
      stages: [["implement"], ["spec_review", "quality_review"], ["fixup"], ["merge_ready"]],
      model: "claude-opus-5-5",
      host: "local",
      files: [],
    });
    expect(w.tasks.T3?.after).toEqual(["T1", "T2"]);
    expect(w.tasks.T3?.stages).toEqual([["implement"], ["merge_ready"]]);
    expect(w.config).toEqual({});
    expect(w.heavy_pools).toEqual([]);
  });

  it("turns nested pipeline arrays into parallel stage groups", () => {
    const w = parseWaveFile(fixture("example.yaml"));
    expect(w.stages).toEqual([
      ["implement"],
      ["spec_review", "quality_review"],
      ["fixup"],
      ["merge_ready"],
    ]);
  });

  it("carries per-task model, files, spawn_budget and config overrides", () => {
    const w = parseWaveFile(fixture("overrides.yaml"));
    expect(w.tasks.A?.model).toBe("claude-opus-5-5");
    expect(w.tasks.B?.model).toBe("claude-sonnet-5-5");
    expect(w.tasks.B?.files).toEqual(["src/a.ts"]);
    expect(w.spawn_budget).toBe(5);
    expect(w.config).toEqual({ hard_ceiling: 3, admission: { ci_queue_max: 4 } });
  });

  it("carries a per-task host (default local) and rejects a malformed one", () => {
    const w = parseWaveFile(
      `${HEADER}tasks:\n  A: { issue: 1 }\n  B: { issue: 2, host: build-box.lan }\n`,
    );
    expect(w.tasks.A?.host).toBe("local");
    expect(w.tasks.B?.host).toBe("build-box.lan");
    expect(errorsOf(`${HEADER}tasks:\n  A: { issue: 1, host: "-oProxyCommand=x" }\n`)).toEqual([
      expect.stringMatching(/^tasks\.A\.host: must match pattern/),
    ]);
  });

  it("normalises an inline ssh host to its name plus the spec, and checks it", () => {
    const w = parseWaveFile(
      `${HEADER}tasks:
  A: { issue: 1, host: { type: ssh, name: box, tunnel: { remote_port: 21883 } } }
  B: { issue: 2, host: { type: ssh, target: dev@box.lan, repo: /src/r, volley_dir: /src/volley } }
`,
    );
    expect(w.tasks.A?.host).toBe("box");
    expect(w.tasks.A?.host_spec).toEqual({
      type: "ssh",
      name: "box",
      tunnel: { remote_port: 21883 },
    });
    expect(w.tasks.B?.host).toBe("dev@box.lan");
    expect(w.tasks.B?.host_spec?.repo).toBe("/src/r");

    // Without a name there is no config entry to inherit from.
    expect(
      errorsOf(`${HEADER}tasks:\n  A: { issue: 1, host: { type: ssh, target: box } }\n`),
    ).toEqual([
      "tasks.A.host.repo: required for an inline host without a name",
      "tasks.A.host.volley_dir: required for an inline host without a name",
    ]);
    // A target can never be read as an ssh option; paths are absolute; no unknown keys.
    expect(
      errorsOf(
        `${HEADER}tasks:\n  A: { issue: 1, host: { type: ssh, name: b, target: "-oProxyCommand=x" } }\n`,
      ),
    ).toEqual([expect.stringMatching(/^tasks\.A\.host\.target: must match pattern/)]);
    expect(
      errorsOf(`${HEADER}tasks:\n  A: { issue: 1, host: { type: ssh, name: b, repo: src/r } }\n`),
    ).toEqual([expect.stringMatching(/^tasks\.A\.host\.repo: must match pattern/)]);
    expect(
      errorsOf(`${HEADER}tasks:\n  A: { issue: 1, host: { type: ssh, name: b, shell: zsh } }\n`),
    ).toEqual([expect.stringMatching(/^tasks\.A\.host/)]);
    expect(
      errorsOf(`${HEADER}tasks:\n  A: { issue: 1, host: { type: ssh, name: local } }\n`),
    ).toEqual([expect.stringMatching(/^tasks\.A\.host\.name/)]);
    // A nameless inline host is named by its target, and `local` is never an ssh host.
    expect(
      errorsOf(
        `${HEADER}tasks:\n  A: { issue: 1, host: { type: ssh, target: local, repo: /src/r, volley_dir: /src/v } }\n`,
      ),
    ).toEqual([
      expect.stringMatching(/^tasks\.A\.host\.target: `local` is the supervisor's own host/),
    ]);
  });

  it("release_version: 0.14.0 is carried; release_version: 14 is an error at release_version", () => {
    const w = parseWaveFile(`${HEADER}release_version: 0.14.0\ntasks:\n  T1: { issue: 1 }\n`);
    expect(w.release_version).toBe("0.14.0");
    expect(parseWaveFile(`${HEADER}tasks:\n  T1: { issue: 1 }\n`).release_version).toBeUndefined();
    const errs = errorsOf(`${HEADER}release_version: 14\ntasks:\n  T1: { issue: 1 }\n`);
    expect(errs.map((e) => e.split(":")[0])).toEqual(["release_version"]);
    expect(errorsOf(`${HEADER}release_version: v1.0.0\ntasks:\n  T1: { issue: 1 }\n`)[0]).toMatch(
      /^release_version: /,
    );
  });

  it("rejects an unknown after target with a path-qualified error", () => {
    const errs = errorsOf(
      `${HEADER}tasks:\n  T1: { issue: 1 }\n  T2: { issue: 2 }\n  T3: { issue: 3, after: [T1, T9] }\n`,
    );
    expect(errs).toEqual(["tasks.T3.after[1]: unknown task 'T9'"]);
  });

  it("rejects an after target that is only an Object prototype name", () => {
    for (const name of ["toString", "constructor", "hasOwnProperty"]) {
      const errs = errorsOf(`${HEADER}tasks:\n  A: { issue: 1, after: [${name}] }\n`);
      expect(errs).toEqual([`tasks.A.after[0]: unknown task '${name}'`]);
    }
  });

  it("rejects a repo or release_branch that would read as a command-line option", () => {
    const branch = errorsOf(
      `${HEADER.replace("release/w1", '"--upload-pack=sh"')}tasks:\n  T1: { issue: 1 }\n`,
    );
    expect(branch).toHaveLength(1);
    expect(branch[0]).toMatch(/^release_branch: /);
    const repo = errorsOf(
      `${HEADER.replace("/path/to/example-repo", '"-uq"')}tasks:\n  T1: { issue: 1 }\n`,
    );
    expect(repo).toHaveLength(1);
    expect(repo[0]).toMatch(/^repo: /);
  });

  it("rejects a model the fence would refuse to launch or switch to (one grammar: MODEL_ID)", () => {
    const wave = errorsOf(
      `${HEADER.replace("claude-opus-5-5", '"opus; git push"')}tasks:\n  T1: { issue: 1 }\n`,
    );
    expect(wave).toHaveLength(1);
    expect(wave[0]).toMatch(/^model: /);
    const task = errorsOf(`${HEADER}tasks:\n  T1: { issue: 1, model: "x\\n!sh" }\n`);
    expect(task).toHaveLength(1);
    expect(task[0]).toMatch(/model/);
    expect(() =>
      parseWaveFile(
        `${HEADER}tasks:\n  T1: { issue: 1, model: "us.anthropic.claude-opus-4-1-20250805-v1:0" }\n`,
      ),
    ).not.toThrow();
  });

  it("rejects a duplicate task id", () => {
    const errs = errorsOf(`${HEADER}tasks:\n  T1: { issue: 1 }\n  T1: { issue: 2 }\n`);
    expect(errs).toEqual(["tasks.T1: duplicate task id 'T1'"]);
  });

  it("rejects task ids that differ only in case (they would share an agent id)", () => {
    const errs = errorsOf(`${HEADER}tasks:\n  T1: { issue: 1 }\n  t1: { issue: 2 }\n`);
    expect(errs).toEqual(["tasks.t1: task id 't1' differs from 'T1' only in case"]);
  });

  it("rejects a dependency cycle, naming the loop", () => {
    const errs = errorsOf(
      `${HEADER}tasks:\n  T1: { issue: 1, after: [T3] }\n  T2: { issue: 2, after: [T1] }\n  T3: { issue: 3, after: [T2] }\n`,
    );
    expect(errs).toEqual(["tasks.T1.after: dependency cycle T1 -> T3 -> T2 -> T1"]);
  });

  it("rejects a self-dependency as a cycle", () => {
    const errs = errorsOf(`${HEADER}tasks:\n  T1: { issue: 1, after: [T1] }\n`);
    expect(errs).toEqual(["tasks.T1.after: dependency cycle T1 -> T1"]);
  });

  it("rejects a bad wave id", () => {
    const errs = errorsOf(
      `${HEADER.replace("wave: w1", "wave: Wave_1")}tasks:\n  T1: { issue: 1 }\n`,
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/^wave: /);
    expect(errs[0]).toContain("[a-z0-9]");
  });

  it("reports schema violations with their paths", () => {
    const errs = errorsOf(
      `${HEADER}tasks:\n  T1: { issue: 0, color: red }\nconfig: { hard_ceiling: 500 }\n`,
    );
    expect(errs).toContain("tasks.T1.color: unknown key");
    expect(errs).toContain("tasks.T1.issue: must be >= 1");
    expect(errs).toContain("config.hard_ceiling: must be <= 100");
  });

  it("rejects per-wave lease_pools overrides: pools are machine-global", () => {
    const errs = errorsOf(
      `${HEADER}tasks:\n  T1: { issue: 1 }\nconfig:\n  lease_pools:\n    build: { capacity: 5, ttl_s: 600 }\n`,
    );
    expect(errs).toEqual([
      "config.lease_pools: lease pools are machine-global; set them in volleyd's global config, not per wave",
    ]);
  });

  it("rejects malformed YAML and non-mapping documents", () => {
    expect(errorsOf("wave: [unclosed\n")[0]).toMatch(/^\(root\): invalid YAML/);
    expect(errorsOf("- just\n- a list\n")).toEqual(["(root): must be a mapping"]);
  });
});

describe("account: (Claude account profiles)", () => {
  const TASKS = `tasks:
  T1:
    issue: 1
  T2:
    issue: 2
    account: personal
`;

  it("keeps the wave's and a task's account as written", () => {
    const w = parseWaveFile(`${HEADER}account: work\n${TASKS}`);
    expect(w.account).toBe("work");
    expect(w.tasks.T1?.account).toBeUndefined();
    expect(w.tasks.T2?.account).toBe("personal");
  });

  it("is optional, and must be an account id", () => {
    expect(parseWaveFile(`${HEADER}${TASKS}`).account).toBeUndefined();
    expect(errorsOf(`${HEADER}account: Not An Id\n${TASKS}`)).toEqual([
      expect.stringMatching(/^account: /),
    ]);
  });

  it("claude.default_account is a per-wave config override", () => {
    const w = parseWaveFile(`${HEADER}config:\n  claude:\n    default_account: work\n${TASKS}`);
    expect(w.config.claude).toEqual({ default_account: "work" });
    expect(errorsOf(`${HEADER}config:\n  claude:\n    pick: x\n${TASKS}`)[0]).toMatch(
      /^config\.claude/,
    );
  });

  it("branch_update and agent_mcp are per-wave config overrides with closed values", () => {
    const w = parseWaveFile(
      `${HEADER}config:\n  branch_update: merge\n  agent_mcp: inherit\n${TASKS}`,
    );
    expect(w.config).toEqual({ branch_update: "merge", agent_mcp: "inherit" });
    expect(errorsOf(`${HEADER}config:\n  branch_update: squash\n${TASKS}`)[0]).toMatch(
      /^config\.branch_update/,
    );
    expect(errorsOf(`${HEADER}config:\n  agent_mcp: all\n${TASKS}`)[0]).toMatch(
      /^config\.agent_mcp/,
    );
  });

  it("agent_mcp_allow is a per-wave config override: a list of server names", () => {
    const w = parseWaveFile(
      `${HEADER}config:\n  agent_mcp: inherit\n  agent_mcp_allow: [migrations, playwright]\n${TASKS}`,
    );
    expect(w.config).toEqual({
      agent_mcp: "inherit",
      agent_mcp_allow: ["migrations", "playwright"],
    });
    expect(errorsOf(`${HEADER}config:\n  agent_mcp_allow: [1]\n${TASKS}`)[0]).toMatch(
      /^config\.agent_mcp_allow/,
    );
  });

  it("agent_auto_compact_pct is a per-wave config override, 0..100", () => {
    const w = parseWaveFile(`${HEADER}config:\n  agent_auto_compact_pct: 70\n${TASKS}`);
    expect(w.config.agent_auto_compact_pct).toBe(70);
    expect(errorsOf(`${HEADER}config:\n  agent_auto_compact_pct: 101\n${TASKS}`)[0]).toMatch(
      /^config\.agent_auto_compact_pct/,
    );
  });
});

describe("placement (SPEC §4.6.15)", () => {
  const TASKS = `tasks:
  T1:
    issue: 1
  T2:
    issue: 2
    host: box-a
  T3:
    issue: 3
    host: local
    heavy: true
`;

  it("ci: auto | none | required parse onto the wave; absent is undefined; anything else is refused at ci", () => {
    const TASK = "tasks:\n  T1: { issue: 1 }\n";
    for (const ci of ["auto", "none", "required"] as const)
      expect(parseWaveFile(`${HEADER}ci: ${ci}\n${TASK}`).ci).toBe(ci);
    expect(parseWaveFile(`${HEADER}${TASK}`).ci).toBeUndefined();
    const errors = errorsOf(`${HEADER}ci: sometimes\n${TASK}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^ci: /);
  });

  it("placement: auto makes every task without a host auto; a named host stays", () => {
    const w = parseWaveFile(
      `${HEADER}placement: auto\nplacement_prefer: [box-a]\nplacement_avoid: [box-b]\nheavy_pools: [backend-it]\n${TASKS}`,
    );
    expect(w).toMatchObject({
      placement: "auto",
      placement_prefer: ["box-a"],
      placement_avoid: ["box-b"],
      heavy_pools: ["backend-it"],
    });
    expect(w.tasks.T1?.host).toBe("auto");
    expect(w.tasks.T2?.host).toBe("box-a");
    expect(w.tasks.T3).toMatchObject({ host: "local", heavy: true });
    expect(w.tasks.T1?.heavy).toBeUndefined();
  });

  it("without placement: auto, unpinned tasks stay local and host: auto opts one task in", () => {
    const w = parseWaveFile(`${HEADER}${TASKS}  T4:\n    issue: 4\n    host: auto\n`);
    expect(w.placement).toBeUndefined();
    expect(w.placement_prefer).toBeUndefined();
    expect(w.tasks.T1?.host).toBe("local");
    expect(w.tasks.T4?.host).toBe("auto");
    // placement: local is the default, written out.
    expect(parseWaveFile(`${HEADER}placement: local\n${TASKS}`).tasks.T1?.host).toBe("local");
  });

  it("no placement: takes placement.default: auto once a machine is paired (#324)", () => {
    const paired = { default: "auto" as const, paired: 1 };
    const w = parseWaveFile(`${HEADER}${TASKS}`, undefined, paired);
    expect(w.placement).toBe("auto");
    expect(w.tasks.T1?.host).toBe("auto");
    expect(w.tasks.T2?.host).toBe("box-a");
    expect(w.tasks.T3?.host).toBe("local");
    // No paired machine: local, whatever the default.
    const alone = parseWaveFile(`${HEADER}${TASKS}`, undefined, { default: "auto", paired: 0 });
    expect(alone.placement).toBeUndefined();
    expect(alone.tasks.T1?.host).toBe("local");
  });

  it("placement.default: local keeps it local; an explicit placement: wins over the default (#324)", () => {
    const local = parseWaveFile(`${HEADER}${TASKS}`, undefined, { default: "local", paired: 2 });
    expect(local.placement).toBeUndefined();
    expect(local.tasks.T1?.host).toBe("local");
    const pinned = parseWaveFile(`${HEADER}placement: local\n${TASKS}`, undefined, {
      default: "auto",
      paired: 2,
    });
    expect(pinned.placement).toBeUndefined();
    expect(pinned.tasks.T1?.host).toBe("local");
    // The wave's own config: placement.default wins over the supervisor's.
    const own = parseWaveFile(
      `${HEADER}config:\n  placement:\n    default: local\n${TASKS}`,
      undefined,
      { default: "auto", paired: 1 },
    );
    expect(own.tasks.T1?.host).toBe("local");
    // A known wave's kept placement: its config: default no longer decides, its placement: does.
    const kept = { default: "local" as const, paired: 1, kept: true };
    const auto = `${HEADER}config:\n  placement:\n    default: auto\n${TASKS}`;
    expect(parseWaveFile(auto, undefined, kept).tasks.T1?.host).toBe("local");
    expect(parseWaveFile(`${HEADER}placement: auto\n${TASKS}`, undefined, kept).placement).toBe(
      "auto",
    );
  });

  it("the placement line names what decided it (#324)", () => {
    const line = (
      raw: { placement?: "auto" | "local" },
      d: { default: "auto" | "local"; paired: number },
    ) => formatPlacement(defaultPlacement(raw, d), d);
    expect(line({}, { default: "auto", paired: 1 })).toBe(
      "placement: auto (placement.default; 1 paired machine)",
    );
    expect(line({}, { default: "auto", paired: 2 })).toBe(
      "placement: auto (placement.default; 2 paired machines)",
    );
    expect(line({}, { default: "auto", paired: 0 })).toBe("placement: local (no paired machine)");
    expect(line({}, { default: "local", paired: 1 })).toBe("placement: local (placement.default)");
    expect(line({ placement: "local" }, { default: "auto", paired: 1 })).toBe(
      "placement: local (wave file)",
    );
  });

  it("names this machine and the paired ones on the placement line (#608)", () => {
    const named = { pairedNames: ["box-a"], local: "macbook-pro" };
    const line = (
      raw: { placement?: "auto" | "local" },
      d: { default: "auto" | "local"; paired: number; pairedNames: string[]; local: string },
    ) => formatPlacement(defaultPlacement(raw, d), d);
    expect(line({}, { default: "auto", paired: 1, ...named })).toBe(
      "placement: auto (placement.default; this machine macbook-pro, 1 paired: box-a)",
    );
    expect(line({}, { default: "auto", paired: 0, pairedNames: [], local: "macbook-pro" })).toBe(
      "placement: local (no paired machine; this machine macbook-pro)",
    );
    expect(line({ placement: "auto" }, { default: "auto", paired: 1, ...named })).toBe(
      "placement: auto (wave file; this machine macbook-pro, 1 paired: box-a)",
    );
    expect(
      line({}, { default: "auto", paired: 2, pairedNames: ["box-a", "box-b"], local: "mac" }),
    ).toBe("placement: auto (placement.default; this machine mac, 2 paired: box-a, box-b)");
  });

  describe("a host named by machine (#608)", () => {
    const D = {
      default: "auto" as const,
      paired: 1,
      pairedNames: ["box-a"],
      local: "macbook-pro",
    };
    const host = (h: string) => `${HEADER}tasks:\n  T1:\n    issue: 1\n    host: ${h}\n`;
    const refused = (text: string, d: PlacementDefaults = D): PathError[] => {
      try {
        parseWaveFile(text, undefined, d);
      } catch (e) {
        expect(e).toBeInstanceOf(WaveFileError);
        return (e as WaveFileError).errors;
      }
      throw new Error("expected a WaveFileError");
    };

    it("the own machine's name is the local token; a paired name stays", () => {
      expect(parseWaveFile(host("macbook-pro"), undefined, D).tasks.T1?.host).toBe("local");
      expect(parseWaveFile(host("box-a"), undefined, D).tasks.T1?.host).toBe("box-a");
      expect(parseWaveFile(host("local"), undefined, D).tasks.T1?.host).toBe("local");
      expect(parseWaveFile(host("auto"), undefined, D).tasks.T1?.host).toBe("auto");
    });

    it("an unknown name is refused with this machine's and the paired machines' names", () => {
      expect(refused(host("mac"))).toEqual([
        {
          path: "tasks.T1.host",
          reason: 'unknown host "mac": this machine is macbook-pro; paired: box-a',
        },
      ]);
      expect(refused(host("mac"), { ...D, paired: 0, pairedNames: [] })[0]?.reason).toBe(
        'unknown host "mac": this machine is macbook-pro; no paired machine',
      );
      expect(refused(`${HEADER}placement_prefer: [mac]\n${TASKS}`)).toEqual([
        {
          path: "placement_prefer[0]",
          reason: 'unknown host "mac": this machine is macbook-pro; paired: box-a',
        },
      ]);
      expect(refused(`${HEADER}placement_avoid: [box-a, nope]\n${TASKS}`)[0]?.path).toBe(
        "placement_avoid[1]",
      );
    });

    it("prefer/avoid take this machine's name; an inline host is still accepted", () => {
      const w = parseWaveFile(`${HEADER}placement_prefer: [macbook-pro]\n${TASKS}`, undefined, D);
      expect(w.placement_prefer).toEqual(["macbook-pro"]);
      const inline = `${HEADER}tasks:\n  T1:\n    issue: 1\n    host: { type: ssh, target: dev@x, repo: /r, volley_dir: /opt/v }\n`;
      expect(parseWaveFile(inline, undefined, D).tasks.T1?.host).toBe("dev@x");
    });

    it("without the names (an old caller) no name is checked", () => {
      expect(
        parseWaveFile(host("build-box.lan"), undefined, { default: "auto", paired: 1 }).tasks.T1
          ?.host,
      ).toBe("build-box.lan");
    });
  });

  it("placement: elsewhere is refused with a path-qualified error", () => {
    expect(errorsOf(`${HEADER}placement: elsewhere\n${TASKS}`)).toEqual([
      expect.stringMatching(/^placement: must be equal to one of the allowed values/),
    ]);
    expect(errorsOf(`${HEADER}placement_avoid: [Box A]\n${TASKS}`)[0]).toMatch(
      /^placement_avoid\[0\]: /,
    );
    expect(errorsOf(`${HEADER}tasks:\n  T1:\n    issue: 1\n    heavy: yes please\n`)[0]).toMatch(
      /^tasks\.T1\.heavy: /,
    );
  });

  it("an inline host may not be named auto (the placement token)", () => {
    expect(
      errorsOf(
        `${HEADER}tasks:\n  T1:\n    issue: 1\n    host: { type: ssh, name: auto, target: dev@box, repo: /srv/r, volley_dir: /opt/v }\n`,
      ),
    ).toEqual([expect.stringMatching(/^tasks\.T1\.host\.name: /)]);
  });
});

describe("fixtures/waves/placement-auto.yaml", () => {
  it("parses: unpinned tasks auto, a pinned one local, the heavy one marked", () => {
    const w = parseWaveFile(fixture("waves/placement-auto.yaml"));
    expect(w).toMatchObject({
      placement: "auto",
      placement_prefer: ["box-a"],
      placement_avoid: ["box-c"],
      heavy_pools: ["backend-it"],
    });
    expect(w.task_order.map((id) => [id, w.tasks[id]?.host, w.tasks[id]?.heavy ?? false])).toEqual([
      ["T1", "auto", false],
      ["T2", "auto", true],
      ["T3", "local", false],
      ["T4", "auto", false],
    ]);
  });
});

describe("resolveWaveRepo: a wave file's repo: may be an owner/name slug (D9)", () => {
  const cfg = {
    repos: { "Example-Org/Widgets": { machines: ["control" as string] } },
    fleet: { repo_root: "~/.volley/repos" },
    hosts: {},
  };
  const wave = (repo: string) =>
    parseWaveFile(`${HEADER.replace("/path/to/example-repo", repo)}tasks:\n  T1: { issue: 1 }\n`);

  it("a slug resolves to the supervisor's managed clone", () => {
    expect(resolveWaveRepo(wave("example-org/widgets"), cfg, "control", "/path/to/home").repo).toBe(
      "/path/to/home/.volley/repos/Example-Org/Widgets",
    );
  });

  it("an adopted clone of the slug on the supervisor's machine (fleet.repos) wins (#616)", () => {
    const adopted = {
      ...cfg,
      fleet: { ...cfg.fleet, repos: { "example-org/widgets": "/src/w" } },
    };
    expect(
      resolveWaveRepo(wave("example-org/widgets"), adopted, "control", "/path/to/home").repo,
    ).toBe("/src/w");
  });

  it("a path is still a path", () => {
    for (const p of ["/srv/repo", "~/repos/example", "./example-org/widgets", "r"]) {
      expect(resolveWaveRepo(wave(p), cfg, "control", "/path/to/home").repo).toBe(p);
    }
  });

  it("an unknown slug is refused at repo, naming every machine (#448)", () => {
    const paired = { ...cfg, hosts: { box: {}, mini: {} } };
    expect(() => resolveWaveRepo(wave("someone/else"), paired, "control", "/path/to/home")).toThrow(
      "repo: no clone of someone/else on any machine: add it to one (Settings → Repositories, or volley repo add someone/else --machine box)",
    );
    expect(() => resolveWaveRepo(wave("someone/else"), cfg, "control", "/path/to/home")).toThrow(
      "repo: no clone of someone/else on any machine: add it to one (Settings → Repositories, or volley repo add someone/else --machine control)",
    );
    expect(() =>
      resolveWaveRepo(wave("example-org/widgets"), cfg, "other", "/path/to/home"),
    ).toThrow(
      "tasks.T1.host: no clone of example-org/widgets on other: set placement: auto (and drop any host: local) so it runs on control",
    );
  });

  describe("a slug only paired machines hold (#448)", () => {
    const boxOnly = {
      repos: { "b/b": { machines: ["box"] as string[] } },
      fleet: { repo_root: "~/.volley/repos" },
      hosts: { box: {}, mini: { repos: { "B/B": "/srv/b" } } },
    };
    const withTasks = (tasks: string) =>
      parseWaveFile(`${HEADER.replace("/path/to/example-repo", "b/b")}tasks:\n${tasks}`);

    it("keeps the slug: its tasks run on the machines that hold it", () => {
      const w = withTasks("  T1: { issue: 1, host: auto }\n");
      expect(resolveWaveRepo(w, boxOnly, "control", "/path/to/home")).toBe(w);
      expect(isSlugRepo(w)).toBe(true);
    });

    it("a task pinned to the supervisor's machine is refused at tasks.<id>.host", () => {
      const run = () =>
        resolveWaveRepo(
          withTasks("  T0: { issue: 2, host: box }\n  T1: { issue: 1, host: local }\n"),
          boxOnly,
          "control",
          "/path/to/home",
        );
      expect(run).toThrow(
        "tasks.T1.host: no clone of b/b on control: set placement: auto (and drop any host: local) so it runs on box, mini, or add the clone (volley repo add b/b --machine control)",
      );
      // No host: under placement local is the supervisor's machine too.
      expect(() =>
        resolveWaveRepo(withTasks("  T1: { issue: 1 }\n"), boxOnly, "control", "/path/to/home"),
      ).toThrow("tasks.T1.host: no clone of b/b on control");
    });

    it("under placement: auto, names the task's own host: local; every pinned task is reported", () => {
      const w = parseWaveFile(
        `${HEADER.replace("/path/to/example-repo", "b/b")}placement: auto\ntasks:\n  T1: { issue: 1, host: local }\n  T2: { issue: 2 }\n  T3: { issue: 3, host: local }\n`,
      );
      let err: unknown;
      try {
        resolveWaveRepo(w, boxOnly, "control", "/path/to/home");
      } catch (e) {
        err = e;
      }
      expect((err as WaveFileError).errors).toEqual(
        ["T1", "T3"].map((id) => ({
          path: `tasks.${id}.host`,
          reason:
            "no clone of b/b on control: drop its host: local (or set host: auto) so it runs on box, mini, or add the clone (volley repo add b/b --machine control)",
        })),
      );
    });

    it("a release playbook is refused at playbook; playbook: none is fine", () => {
      const head = `${HEADER.replace("/path/to/example-repo", "b/b")}placement: auto\n`;
      const tasks = "tasks:\n  T1: { issue: 1 }\n";
      expect(() =>
        resolveWaveRepo(
          parseWaveFile(`${head}playbook: .volley/release.yaml\n${tasks}`),
          boxOnly,
          "control",
          "/path/to/home",
        ),
      ).toThrow(
        "playbook: no clone of b/b on control to run a release playbook in: set playbook: none, or add the clone (volley repo add b/b --machine control)",
      );
      const none = parseWaveFile(`${head}playbook: none\n${tasks}`);
      expect(resolveWaveRepo(none, boxOnly, "control", "/path/to/home")).toBe(none);
    });

    it("on a machine that holds it, it is that machine's clone", () => {
      const w = withTasks("  T1: { issue: 1, host: local }\n");
      expect(resolveWaveRepo(w, boxOnly, "box", "/h").repo).toBe("/h/.volley/repos/b/b");
    });
  });
});

describe("bundles, footprints and the overlap plan (SPEC §4.6.22)", () => {
  const task = (body: string) => `${HEADER}tasks:\n  i1: ${body}\n  i9: { issue: 9 }\n`;

  it("issues without the task's issue is refused at tasks.<id>.issues", () => {
    expect(errorsOf(task("{ issue: 1, issues: [2, 3] }"))).toEqual([
      "tasks.i1.issues: must include issue 1",
    ]);
  });

  it("a duplicate issue in issues, or one another task closes, is refused with its path", () => {
    expect(errorsOf(task("{ issue: 1, issues: [1, 2, 2] }"))).toEqual([
      "tasks.i1.issues[2]: duplicate issue #2",
    ]);
    expect(errorsOf(task("{ issue: 1, issues: [1, 9] }"))).toEqual([
      "tasks.i1.issues[1]: issue #9 is also tasks.i9's",
    ]);
  });

  it("footprint and plan are parsed onto the task; a task without them has neither", () => {
    const w = parseWaveFile(fixture("bundle.yaml"));
    expect(w.tasks.i1?.issues).toEqual([1, 2]);
    expect(w.tasks.i1?.footprint).toEqual({ confidence: "listed" });
    expect(w.tasks.i3?.footprint).toEqual({ confidence: "resolved", unresolved: ["helpers.ts"] });
    expect(w.tasks.i3?.plan?.by).toBe("chain");
    expect(w.tasks.i4?.plan).toEqual({ by: "independent", why: "shares no source file" });
    const plain = parseWaveFile(task("{ issue: 1 }"));
    expect(plain.tasks.i1).not.toHaveProperty("issues");
    expect(plain.tasks.i1).not.toHaveProperty("footprint");
    expect(plain.tasks.i1).not.toHaveProperty("plan");
    expect(plain).not.toHaveProperty("overlap_plan");
  });

  it("fixtures/bundle.yaml: the wave's overlap plan is rebuilt from plan.cluster and after", () => {
    const w = parseWaveFile(fixture("bundle.yaml"));
    expect(w.overlap_plan?.clusters).toEqual([
      {
        id: "A",
        tasks: ["i1", "i3"],
        hot: [{ file: "packages/app/src/pipeline.ts", bytes: 0, shared_by: ["i1", "i3"] }],
        strategy: { collapse: [["i1"]], chain: [["i1", "i3"]] },
        state: "planned",
        why: "3 tasks share packages/app/src/pipeline.ts (2 tasks) → 1 bundle (i1), 1 chain (i1 → i3)",
      },
    ]);
    expect(explain(filePlan(w))).toEqual([
      "cluster A: 3 tasks share packages/app/src/pipeline.ts (2 tasks) → 1 bundle (i1), 1 chain (i1 → i3)",
      "independent: i4",
      "expected branch updates: ≤ 2 (was ≤ 3 one at a time)",
    ]);
  });

  it("an after entry is a chain only when the task's why names it, whatever its by", () => {
    const w = parseWaveFile(
      fixture("bundle.yaml").replace(
        '"after i1: they share packages/app/src/pipeline.ts (coupling 0.70) and cannot bundle: over 2 issues"',
        "edited by hand",
      ),
    );
    expect(w.overlap_plan?.clusters[0]?.strategy).toEqual({ collapse: [["i1"]] });
  });

  it("with the tree, the hot files carry their sizes", () => {
    const w = parseWaveFile(fixture("bundle.yaml"));
    const tree = { "packages/app/src/pipeline.ts": 40_000, "packages/app/src/retry.ts": 800 };
    expect(filePlan(w, tree).clusters[0]?.hot).toEqual([
      { file: "packages/app/src/pipeline.ts", bytes: 40_000, shared_by: ["i1", "i3"] },
    ]);
    expect(filePlan(w, tree).clusters[0]?.why).toContain("pipeline.ts (1k lines, 2 tasks)");
  });

  it("planNotes: where the file's own plan differs from the planner's (advisory)", () => {
    const text = `${HEADER}tasks:
  i1: { issue: 1, files: [src/big.ts, src/a.ts], footprint: { confidence: listed } }
  i2: { issue: 2, files: [src/big.ts, src/b.ts], footprint: { confidence: listed } }
`;
    const tree = { "src/big.ts": 40_000, "src/a.ts": 100, "src/b.ts": 100 };
    expect(planNotes(parseWaveFile(text), tree)).toEqual([
      "i1 and i2 run as separate tasks; the planner would bundle them as i1 — kept as written",
    ]);
    // The generated bundle is what the planner would do: no note.
    expect(planNotes(parseWaveFile(fixture("bundle.yaml")), {})).not.toContainEqual(
      expect.stringContaining("i1 bundles"),
    );
  });
});
