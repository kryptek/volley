import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WaveFileError, parseWaveFile } from "../src/wave-file";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");

const HEADER = `wave: w1
repo: example-org/example-repo
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
      `${HEADER.replace("example-org/example-repo", '"-uq"')}tasks:\n  T1: { issue: 1 }\n`,
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
