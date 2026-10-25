import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseWaveFile } from "volleyd/wave-file";
import {
  BRIEF_PREFACE_TEMPLATE,
  DEFAULT_BRIEF_PREFACE,
  type IssueInput,
  type WaveOptions,
  ensureBriefPreface,
  parseDependsOn,
  submitLines as submitLinesFor,
  taskIdFor,
  waveFromIssues,
} from "../scripts/wave-from-issues";
import { tempDir, tempDirForAll } from "./helpers/tmp";

const VOLLEYD_CLI = fileURLToPath(new URL("../../volleyd/src/cli.ts", import.meta.url));
const HELPER_CLI = fileURLToPath(new URL("../scripts/wave-from-issues.ts", import.meta.url));

const tmp = tempDirForAll("wave-from-issues-");

const OPTS: WaveOptions = {
  wave: "2026-10-18-example",
  // Never created: the CLI writes a brief preface into a --repo that exists.
  repo: join(tmpdir(), "wave-from-issues-never-created", "example-repo"),
  releaseBranch: "release/2026-10-18-example",
  model: "claude-opus-5-5",
};

const THREE: IssueInput[] = [
  { number: 101, title: "Foundation", body: "Set things up.\n\nDepends on: none\n" },
  { number: 102, title: "Feature A", body: "## Plan\n\nDepends on: #101\n" },
  {
    number: 103,
    title: 'Feature "B": the sequel',
    body: "**Depends on:** #101 (T0), #102 (T1)\n\nMore text mentioning #999 elsewhere.",
  },
];

function volleydValidate(yaml: string): { code: number | null; out: string } {
  const file = join(tmp(), `wave-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(file, yaml);
  const r = spawnSync("bun", [VOLLEYD_CLI, "validate", file], {
    encoding: "utf-8",
    // Not the operator's config.yaml (validate reads its brief_preface_max_bytes).
    env: { ...process.env, VOLLEYD_HOME: join(tmp(), "no-volleyd-home") },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** The environment without a coordinator name. */
const noCoordinator = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k !== "VOLLEY_COORDINATOR"),
);

/** What the CLI prints about THREE's footprints and plan when --repo has no tree. */
const NO_TREE_THREE = [
  `no tree: footprints unresolved (${OPTS.repo} has no origin/${OPTS.releaseBranch} or ${OPTS.releaseBranch})`,
  "independent: i101, i102, i103",
  "expected branch updates: ≤ 0 (was ≤ 2 one at a time)",
  "footprints: 3 none (#101, #102, #103)",
  "",
].join("\n");

/** What the CLI prints after a clean run with VOLLEY_COORDINATOR unset. */
const submitLines = (file: string) =>
  [
    `submit: volleyd run ${file} --owner "$VOLLEY_COORDINATOR"`,
    "owner: VOLLEY_COORDINATOR is unset: export it in this shell (and set it in the volley MCP server's env), a stable name like coord-main, before submitting",
    "",
  ].join("\n");

describe("--help", () => {
  it("keeps every line within the help text's wrap width", () => {
    const r = spawnSync("bun", [HELPER_CLI, "--help"], { encoding: "utf-8" });
    expect(r.status).toBe(0);
    const long = r.stdout.split("\n").filter((l) => l.length > 98);
    expect(long).toEqual([]);
  });
});

describe("submitLines", () => {
  it("leaves a plain path and the <wave.yaml> placeholder bare", () => {
    expect(submitLinesFor(".volley/waves/w.yaml", "c")[0]).toBe(
      'submit: volleyd run .volley/waves/w.yaml --owner "$VOLLEY_COORDINATOR"',
    );
    expect(submitLinesFor("<wave.yaml>", "c")[0]).toBe(
      'submit: volleyd run <wave.yaml> --owner "$VOLLEY_COORDINATOR"',
    );
  });

  it("single-quotes a path the shell would split or expand", () => {
    expect(submitLinesFor("/tmp/my waves/it's.yaml", "c")[0]).toBe(
      `submit: volleyd run '/tmp/my waves/it'\\''s.yaml' --owner "$VOLLEY_COORDINATOR"`,
    );
  });
});

describe("parseDependsOn", () => {
  it("reads 'Depends on:' and 'deps:' lines, markdown emphasis included", () => {
    expect(parseDependsOn("Depends on: #5, #6")).toEqual({ declared: true, refs: [5, 6] });
    expect(parseDependsOn("**Depends on:** #5 (T3), #6 (T4)")).toEqual({
      declared: true,
      refs: [5, 6],
    });
    expect(parseDependsOn("- deps: #7")).toEqual({ declared: true, refs: [7] });
  });
  it("distinguishes 'Depends on: none' from no line at all", () => {
    expect(parseDependsOn("Depends on: none")).toEqual({ declared: true, refs: [] });
    expect(parseDependsOn("No dependency line, but #12 is mentioned.")).toEqual({
      declared: false,
      refs: [],
    });
  });
  it("ignores issue references outside the dependency line", () => {
    expect(parseDependsOn("See #40.\nDepends on: #41\nAlso #42.").refs).toEqual([41]);
  });
  it("rejects a cross-repository reference", () => {
    expect(() => parseDependsOn("Depends on: other/repo#5")).toThrow(/other\/repo#5/);
    expect(() => parseDependsOn("Depends on: other/repo#5", "owner/repo")).toThrow(
      /cross-repository dependency other\/repo#5/,
    );
  });
  it("accepts a reference qualified with this wave's own repository", () => {
    expect(parseDependsOn("Depends on: owner/repo#5, #6", "owner/repo").refs).toEqual([5, 6]);
    expect(parseDependsOn("Depends on: Owner/Repo#5", "owner/repo").refs).toEqual([5]);
  });
  it("accepts issue URLs of this repository", () => {
    expect(
      parseDependsOn("Depends on: https://github.com/owner/repo/issues/5", "owner/repo").refs,
    ).toEqual([5]);
    expect(() =>
      parseDependsOn("Depends on: https://github.com/other/repo/issues/5", "owner/repo"),
    ).toThrow(/cross-repository/);
  });
  it("reads a list of references on the lines after an empty dependency label", () => {
    expect(parseDependsOn("Depends on:\n- #5\n- #6 (T4)\n\nMore text #9")).toEqual({
      declared: true,
      refs: [5, 6],
    });
    expect(parseDependsOn("**Depends on:**\n* #7\n")).toEqual({ declared: true, refs: [7] });
  });
  it("never silently drops a dependency it cannot read", () => {
    expect(() => parseDependsOn("Depends on: T3, T4")).toThrow(
      /unparseable dependency line 'Depends on: T3, T4'/,
    );
    expect(() => parseDependsOn("Depends on: #5, T3")).toThrow(/unparseable dependency/);
    expect(() => parseDependsOn("Depends on:\n- T3\n")).toThrow(/unparseable dependency/);
    expect(() => parseDependsOn("Depends on:\n\nNothing listed.")).toThrow(/empty dependency line/);
  });
  it("accepts 'none' with punctuation or a parenthetical", () => {
    for (const body of ["Depends on: None.", "deps: none (foundation task)", "Depends on: n/a"]) {
      expect(parseDependsOn(body)).toEqual({ declared: true, refs: [] });
    }
  });
  it("keeps underscores in names it reports", () => {
    expect(() => parseDependsOn("Depends on: owner/my_repo#5")).toThrow(/owner\/my_repo#5/);
  });
});

describe("waveFromIssues", () => {
  it("derives after: lists from Depends on lines", () => {
    const { yaml, undeclared } = waveFromIssues(THREE, OPTS);
    expect(undeclared).toEqual([]);
    expect(yaml).toContain(`  ${taskIdFor(101)}:\n    issue: 101\n`);
    expect(yaml).not.toMatch(/i101:\n {4}issue: 101\n {4}title: "Foundation"\n {4}after/);
    expect(yaml).toContain('  i102:\n    issue: 102\n    title: "Feature A"\n    after: [i101]\n');
    expect(yaml).toContain("    after: [i101, i102]\n");
    // Titles are quoted so YAML-significant characters survive.
    expect(yaml).toContain('title: "Feature \\"B\\": the sequel"');
  });

  it("output validates with volleyd validate", () => {
    const { yaml } = waveFromIssues(THREE, OPTS);
    const r = volleydValidate(yaml);
    expect(r.out).toContain("ok: wave 2026-10-18-example");
    expect(r.out).toContain("3 task(s), critical path 3");
    expect(r.code).toBe(0);
  });

  it("errors on a dependency outside the issue set, naming it", () => {
    const issues: IssueInput[] = [
      { number: 101, title: "A", body: "" },
      { number: 102, title: "B", body: "Depends on: #101, #555" },
    ];
    expect(() => waveFromIssues(issues, OPTS)).toThrow(/#102 depends on #555/);
  });

  it("drops dependencies listed as already satisfied", () => {
    const issues: IssueInput[] = [{ number: 102, title: "B", body: "Depends on: #5, #6" }];
    const { yaml } = waveFromIssues(issues, { ...OPTS, satisfied: [5, 6] });
    expect(yaml).not.toContain("after:");
    expect(volleydValidate(yaml).code).toBe(0);
  });

  it("errors on a self-dependency and on duplicate issues", () => {
    expect(() =>
      waveFromIssues([{ number: 101, title: "A", body: "Depends on: #101" }], OPTS),
    ).toThrow(/#101 depends on itself/);
    expect(() =>
      waveFromIssues(
        [
          { number: 101, title: "A", body: "" },
          { number: 101, title: "A", body: "" },
        ],
        OPTS,
      ),
    ).toThrow(/duplicate issue #101/);
  });

  it("reports issues with no dependency line so the coordinator can ask", () => {
    const issues: IssueInput[] = [
      { number: 101, title: "A", body: "no line" },
      { number: 102, title: "B", body: "Depends on: none" },
    ];
    expect(waveFromIssues(issues, OPTS).undeclared).toEqual([101]);
  });

  it("carries a custom pipeline and namespace through", () => {
    const { yaml } = waveFromIssues(THREE, {
      ...OPTS,
      pipeline: ["implement", "merge_ready"],
      namespace: "example-dispatch",
    });
    expect(yaml).toContain('pipeline: ["implement","merge_ready"]\n');
    expect(yaml).toContain('namespace: "example-dispatch"\n');
    expect(volleydValidate(yaml).code).toBe(0);
  });

  it("writes merge: auto by default, and merge: manual on request", () => {
    const auto = waveFromIssues(THREE, OPTS).yaml;
    expect(auto).toContain('merge: "auto"\n');
    expect(auto).not.toContain("config:");
    expect(volleydValidate(auto).code).toBe(0);
    const manual = waveFromIssues(THREE, { ...OPTS, merge: "manual" }).yaml;
    expect(manual).toContain('merge: "manual"\n');
    expect(volleydValidate(manual).code).toBe(0);
  });

  it("writes autopilot on/off and branch_update into the wave's config", () => {
    const off = waveFromIssues(THREE, { ...OPTS, autopilot: false }).yaml;
    expect(off).toContain('config: {"autopilot":{"enabled":false}}\n');
    expect(volleydValidate(off).code).toBe(0);
    const on = waveFromIssues(THREE, { ...OPTS, autopilot: true }).yaml;
    expect(on).toContain('config: {"autopilot":{"enabled":true}}\n');
    const merge = waveFromIssues(THREE, { ...OPTS, branchUpdate: "merge" }).yaml;
    expect(merge).toContain('config: {"branch_update":"merge"}\n');
    const both = waveFromIssues(THREE, { ...OPTS, autopilot: true, branchUpdate: "merge" }).yaml;
    expect(both).toContain('config: {"autopilot":{"enabled":true},"branch_update":"merge"}\n');
    expect(volleydValidate(both).code).toBe(0);
  });

  it("writes placement: only when pinned, and the pinned wave validates (#324)", () => {
    expect(waveFromIssues(THREE, OPTS).yaml).not.toContain("placement:");
    const auto = waveFromIssues(THREE, { ...OPTS, placement: "auto" }).yaml;
    expect(auto).toContain('placement: "auto"\n');
    const v = volleydValidate(auto);
    expect(v.code, v.out).toBe(0);
    expect(v.out).toContain("placement: auto (wave file)\n");
    const local = waveFromIssues(THREE, { ...OPTS, placement: "local" }).yaml;
    expect(local).toContain('placement: "local"\n');
    expect(volleydValidate(local).code).toBe(0);
  });

  it("--placement <machine> pins every task to that machine and writes no placement: (#608)", () => {
    for (const host of ["box-a", "macbook-pro"]) {
      const yaml = waveFromIssues(THREE, { ...OPTS, placement: { host } }).yaml;
      expect(yaml).not.toContain("placement:");
      const hosts = yaml.split("\n").filter((l) => l.startsWith("    host: "));
      expect(hosts).toEqual(THREE.map(() => `    host: "${host}"`));
    }
    const pinned = waveFromIssues(THREE, { ...OPTS, placement: { host: "box-a" } }).yaml;
    const defaults = {
      default: "auto" as const,
      paired: 1,
      pairedNames: ["box-a"],
      local: "macbook-pro",
    };
    const wave = parseWaveFile(pinned, undefined, defaults);
    expect(Object.values(wave.tasks).map((t) => t.host)).toEqual(["box-a", "box-a", "box-a"]);
    const own = waveFromIssues(THREE, { ...OPTS, placement: { host: "macbook-pro" } }).yaml;
    const local = parseWaveFile(own, undefined, defaults);
    expect(Object.values(local.tasks).map((t) => t.host)).toEqual(["local", "local", "local"]);
  });

  it("rejects an invalid wave id before emitting anything", () => {
    expect(() => waveFromIssues(THREE, { ...OPTS, wave: "Bad Wave" })).toThrow(/wave id/);
  });

  it("rejects a wave id that is a reserved channel name (SPEC §4.6)", () => {
    expect(() => waveFromIssues(THREE, { ...OPTS, wave: "status" })).toThrow(
      /reserved channel name/,
    );
  });

  it("quotes the wave id so YAML never reads it as a number, boolean or null", () => {
    for (const wave of ["123", "null", "true", "1e5"]) {
      const { yaml } = waveFromIssues(THREE, { ...OPTS, wave });
      expect(yaml).toContain(`wave: "${wave}"\n`);
      const r = volleydValidate(yaml);
      expect(r.out).toContain(`ok: wave ${wave}`);
      expect(r.code).toBe(0);
    }
  });

  it("names the issue whose dependency line it cannot read", () => {
    const issues: IssueInput[] = [
      { number: 101, title: "A", body: "" },
      { number: 102, title: "B", body: "Depends on: T3" },
    ];
    expect(() => waveFromIssues(issues, OPTS)).toThrow(/#102: unparseable dependency line/);
  });

  it("resolves same-repo qualified references with repoSlug", () => {
    const issues: IssueInput[] = [
      { number: 101, title: "A", body: "Depends on: none" },
      { number: 102, title: "B", body: "Depends on: owner/repo#101" },
    ];
    const { yaml } = waveFromIssues(issues, { ...OPTS, repoSlug: "owner/repo" });
    expect(yaml).toContain("    after: [i101]\n");
  });

  it("rejects an issue that is both in the set and listed as satisfied", () => {
    const issues: IssueInput[] = [
      { number: 101, title: "A", body: "" },
      { number: 102, title: "B", body: "Depends on: #101" },
    ];
    expect(() => waveFromIssues(issues, { ...OPTS, satisfied: [101] })).toThrow(
      /#101 is in this wave and also listed as satisfied/,
    );
  });

  it("names the index of an issue entry that is not an object", () => {
    expect(() =>
      waveFromIssues([{ number: 1, title: "A", body: "" }, null] as unknown as IssueInput[], OPTS),
    ).toThrow(/issue at index 1/);
  });
});

describe("task ids from title tags", () => {
  const TAGGED: IssueInput[] = [
    { number: 68, title: "O0: onboarding groundwork", body: "Depends on: none" },
    { number: 70, title: "T3b — fence follow-up", body: "Depends on: #68" },
    { number: 71, title: "D10 - desk polish", body: "Depends on: #68, #70" },
    { number: 72, title: "Untagged chore", body: "Depends on: #71" },
  ];

  it("uses the title's task tag, keeping its case", () => {
    expect(taskIdFor(68, "O0: onboarding groundwork")).toBe("O0");
    expect(taskIdFor(70, "T3b — fence follow-up")).toBe("T3b");
    expect(taskIdFor(71, "D10 - desk polish")).toBe("D10");
    expect(taskIdFor(73, "ABC123:no space")).toBe("ABC123");
    expect(taskIdFor(79, "T5 – en dash")).toBe("T5");
  });

  it("does not read a product or format name as a task tag", () => {
    for (const title of [
      "S3: upload fails",
      "EC2 - instance type",
      "K8s: manifests",
      "MP3: metadata",
      "UTF8 - decoding",
      "I18n: strings",
      "A11y: focus rings",
    ]) {
      expect(taskIdFor(85, title)).toBe("i85");
    }
  });

  it("falls back to i<N> for a title without a tag", () => {
    expect(taskIdFor(72, "Untagged chore")).toBe("i72");
    expect(taskIdFor(74, "T4 without a separator")).toBe("i74");
    expect(taskIdFor(75, "fix: T4 lower-case prefix")).toBe("i75");
    expect(taskIdFor(76, "ABCD1: tag too long")).toBe("i76");
    expect(taskIdFor(77, "")).toBe("i77");
    expect(taskIdFor(78)).toBe("i78");
  });

  it("names tasks by tag and resolves after: through the same mapping", () => {
    const { yaml } = waveFromIssues(TAGGED, OPTS);
    expect(yaml).toContain('  O0:\n    issue: 68\n    title: "O0: onboarding groundwork"\n');
    expect(yaml).toContain("  T3b:\n    issue: 70\n");
    expect(yaml).toContain("    after: [O0]\n");
    expect(yaml).toContain("  D10:\n    issue: 71\n");
    expect(yaml).toContain("    after: [O0, T3b]\n");
    expect(yaml).toContain("  i72:\n    issue: 72\n");
    expect(yaml).toContain("    after: [D10]\n");
  });

  it("output with tagged ids passes volleyd validate", () => {
    const r = volleydValidate(waveFromIssues(TAGGED, OPTS).yaml);
    expect(r.out).toContain("4 task(s), critical path 4");
    expect(r.code).toBe(0);
  });

  it("falls back to i<N> for a tag used by two issues, warning with both named", () => {
    const dup: IssueInput[] = [
      { number: 80, title: "O1: first", body: "" },
      { number: 81, title: "O1 — second", body: "Depends on: #80" },
      { number: 82, title: "O2: third", body: "Depends on: #81" },
    ];
    const { yaml, warnings } = waveFromIssues(dup, OPTS);
    expect(yaml).toContain("  i80:\n    issue: 80\n");
    expect(yaml).toContain("  i81:\n    issue: 81\n");
    expect(yaml).toContain("    after: [i80]\n");
    expect(yaml).toContain("  O2:\n    issue: 82\n");
    expect(yaml).toContain("    after: [i81]\n");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/'O1'.*#80.*#81.*i80.*i81/);
    expect(volleydValidate(yaml).code).toBe(0);
  });

  it("falls back when a tag collides with another issue's fallback id, ignoring case", () => {
    // volleyd rejects task ids that differ only in case, so the helper must not emit them.
    const clash: IssueInput[] = [
      { number: 90, title: "Untagged", body: "" },
      { number: 91, title: "I90: tagged like a fallback", body: "" },
    ];
    const { yaml, warnings } = waveFromIssues(clash, OPTS);
    expect(yaml).toContain("  i90:\n    issue: 90\n");
    expect(yaml).toContain("  i91:\n    issue: 91\n");
    expect(warnings.join(" ")).toMatch(/#91/);
    expect(volleydValidate(yaml).code).toBe(0);
  });

  it("CLI: a repeated tag still writes the wave and warns on stderr", () => {
    const input = join(tmp(), "dup-issues.json");
    writeFileSync(
      input,
      JSON.stringify([
        { number: 1, title: "R2: upload", body: "Depends on: none" },
        { number: 2, title: "R2: download", body: "Depends on: none" },
      ]),
    );
    const r = spawnSync(
      "bun",
      [
        HELPER_CLI,
        input,
        "--wave",
        OPTS.wave,
        "--repo",
        OPTS.repo,
        "--release-branch",
        OPTS.releaseBranch,
        "--model",
        OPTS.model,
      ],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  i1:\n    issue: 1\n");
    expect(r.stdout).toContain("  i2:\n    issue: 2\n");
    expect(r.stderr).toMatch(/warning: .*'R2'.*#1.*#2/);
  });
});

describe("wave-from-issues CLI", () => {
  it("reads issues JSON and writes the wave file", () => {
    const input = join(tmp(), "issues.json");
    const out = join(tmp(), "cli-wave.yaml");
    writeFileSync(input, JSON.stringify(THREE));
    const r = spawnSync(
      "bun",
      [
        HELPER_CLI,
        input,
        "--wave",
        OPTS.wave,
        "--repo",
        OPTS.repo,
        "--release-branch",
        OPTS.releaseBranch,
        "--model",
        OPTS.model,
        "--out",
        out,
      ],
      { encoding: "utf-8", env: noCoordinator },
    );
    expect(r.stderr).toBe(`${NO_TREE_THREE}${submitLines(out)}`);
    expect(r.status).toBe(0);
    const v = spawnSync("bun", [VOLLEYD_CLI, "validate", out], { encoding: "utf-8" });
    expect(v.status).toBe(0);
  });

  it("writes --merge, --autopilot and --branch-update into the wave file", () => {
    const input = join(tmp(), "flags.json");
    const out = join(tmp(), "flags-wave.yaml");
    writeFileSync(input, JSON.stringify(THREE));
    const r = spawnSync(
      "bun",
      [
        HELPER_CLI,
        input,
        "--wave",
        OPTS.wave,
        "--repo",
        OPTS.repo,
        "--release-branch",
        OPTS.releaseBranch,
        "--model",
        OPTS.model,
        "--merge",
        "manual",
        "--autopilot",
        "off",
        "--branch-update",
        "merge",
        "--placement",
        "auto",
        "--out",
        out,
      ],
      { encoding: "utf-8", env: noCoordinator },
    );
    expect(r.stderr).toBe(`${NO_TREE_THREE}${submitLines(out)}`);
    expect(r.status).toBe(0);
    const yaml = readFileSync(out, "utf-8");
    expect(yaml).toContain('placement: "auto"\n');
    expect(yaml).toContain('merge: "manual"\n');
    expect(yaml).toContain('config: {"autopilot":{"enabled":false},"branch_update":"merge"}\n');
    expect(spawnSync("bun", [VOLLEYD_CLI, "validate", out], { encoding: "utf-8" }).status).toBe(0);
  });

  it("--placement <machine> says the name is checked by volleyd validate (#608)", () => {
    const input = join(tmp(), "pinned.json");
    writeFileSync(input, JSON.stringify(THREE));
    const r = spawnSync(
      "bun",
      [
        HELPER_CLI,
        input,
        "--wave",
        OPTS.wave,
        "--repo",
        OPTS.repo,
        "--release-branch",
        OPTS.releaseBranch,
        "--model",
        OPTS.model,
        "--placement",
        "box-a",
      ],
      { encoding: "utf-8", env: noCoordinator },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('    host: "box-a"\n');
    expect(r.stdout).not.toContain("placement:");
    expect(r.stderr).toContain(
      "placement: every task pinned to box-a; volleyd validate checks the name\n",
    );
  });

  it("prints the submit line with the coordinator's name as the owner", () => {
    const input = join(tmp(), "owner.json");
    writeFileSync(input, JSON.stringify(THREE));
    const r = spawnSync(
      "bun",
      [
        HELPER_CLI,
        input,
        "--wave",
        OPTS.wave,
        "--repo",
        OPTS.repo,
        "--release-branch",
        OPTS.releaseBranch,
        "--model",
        OPTS.model,
      ],
      { encoding: "utf-8", env: { ...noCoordinator, VOLLEY_COORDINATOR: "coord-main" } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('merge: "auto"\n');
    expect(r.stderr).toBe(
      `${NO_TREE_THREE}submit: volleyd run <wave.yaml> --owner "$VOLLEY_COORDINATOR"\nowner: coord-main (VOLLEY_COORDINATOR)\n`,
    );
  });

  it("exits 2 on a --merge, --autopilot, --branch-update or --placement value it does not know", () => {
    const input = join(tmp(), "badflag.json");
    writeFileSync(input, JSON.stringify([{ number: 7, title: "x", body: "deps: none" }]));
    for (const [flag, value] of [
      ["--merge", "yes"],
      ["--autopilot", "true"],
      ["--branch-update", "squash"],
      ["--placement", "Bad Name"],
      ["--placement", "local,auto"],
    ] as const) {
      const r = spawnSync(
        "bun",
        [
          HELPER_CLI,
          input,
          "--wave",
          "w",
          "--repo",
          "/r",
          "--release-branch",
          "b",
          "--model",
          "m",
          flag,
          value,
        ],
        { encoding: "utf-8" },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`${flag} must be`);
    }
  });

  it("exits 1 naming the outside dependency", () => {
    const input = join(tmp(), "bad.json");
    writeFileSync(input, JSON.stringify([{ number: 7, title: "x", body: "deps: #8" }]));
    const r = spawnSync(
      "bun",
      [HELPER_CLI, input, "--wave", "w", "--repo", "/r", "--release-branch", "b", "--model", "m"],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("#7 depends on #8");
  });

  it("exits 2 on a --pipeline that is not a JSON array", () => {
    const input = join(tmp(), "pipe.json");
    writeFileSync(input, JSON.stringify([{ number: 7, title: "x", body: "deps: none" }]));
    for (const pipeline of ["[implement", '{"a":1}']) {
      const r = spawnSync(
        "bun",
        [
          HELPER_CLI,
          input,
          "--wave",
          "w",
          "--repo",
          "/r",
          "--release-branch",
          "b",
          "--model",
          "m",
          "--pipeline",
          pipeline,
        ],
        { encoding: "utf-8" },
      );
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--pipeline");
    }
  });

  it("passes --repo-slug through to dependency parsing", () => {
    const input = join(tmp(), "slug.json");
    writeFileSync(
      input,
      JSON.stringify([
        { number: 7, title: "x", body: "deps: none" },
        { number: 8, title: "y", body: "deps: owner/repo#7" },
      ]),
    );
    const r = spawnSync(
      "bun",
      [
        HELPER_CLI,
        input,
        "--wave",
        "w",
        "--repo",
        "/r",
        "--release-branch",
        "b",
        "--model",
        "m",
        "--repo-slug",
        "owner/repo",
      ],
      { encoding: "utf-8", env: noCoordinator },
    );
    expect(r.stderr).toContain(submitLines("<wave.yaml>"));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("after: [i7]");
  });

  it("exits 2 on a --satisfied entry that is not an issue number", () => {
    const input = join(tmp(), "one.json");
    writeFileSync(input, JSON.stringify([{ number: 7, title: "x", body: "deps: #8" }]));
    const r = spawnSync(
      "bun",
      [
        HELPER_CLI,
        input,
        "--wave",
        "w",
        "--repo",
        "/r",
        "--release-branch",
        "b",
        "--model",
        "m",
        "--satisfied",
        "#8,abc",
      ],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--satisfied");
    expect(r.stderr).toContain("abc");
  });
});

describe("brief preface", () => {
  const template = readFileSync(BRIEF_PREFACE_TEMPLATE);

  it("the generated wave file points at the repo's preface, and validates", () => {
    const { yaml } = waveFromIssues(THREE, OPTS);
    expect(DEFAULT_BRIEF_PREFACE).toBe(".volley/brief-preface.md");
    expect(yaml).toContain('brief_preface: ".volley/brief-preface.md"\n');
    expect(volleydValidate(yaml).code).toBe(0);
    expect(waveFromIssues(THREE, { ...OPTS, briefPreface: "docs/agent-rules.md" }).yaml).toContain(
      'brief_preface: "docs/agent-rules.md"\n',
    );
  });

  it("the template carries the public-repo hygiene rules and a slot for the repo's own", () => {
    const text = template.toString("utf-8");
    for (const rule of [
      /person's name/,
      /local username/,
      /machine path/,
      /private hostname/,
      /"the owner"/,
    ])
      expect(text).toMatch(rule);
    expect(text).toContain("## Repository rules");
    expect(text).toMatch(/P1\s+for public repositories, P3 for private ones/);
    expect(text).toContain("`public_hygiene`");
  });

  it("writes the template when the preface is absent", () => {
    const repo = tempDir("wave-from-issues-repo-");
    const r = ensureBriefPreface(repo);
    expect(r).toEqual({ path: join(repo, ".volley", "brief-preface.md"), created: true });
    expect(readFileSync(r.path).equals(template)).toBe(true);
  });

  it("never overwrites an existing preface (byte for byte)", () => {
    const repo = tempDir("wave-from-issues-repo-");
    mkdirSync(join(repo, ".volley"));
    const mine = Buffer.from("# Our rules\n\nOnly ours.\n\u00e9\n");
    writeFileSync(join(repo, ".volley", "brief-preface.md"), mine);
    expect(ensureBriefPreface(repo).created).toBe(false);
    expect(readFileSync(join(repo, ".volley", "brief-preface.md")).equals(mine)).toBe(true);
    // Another path (relative to the repo, or absolute) is honoured the same way.
    const abs = join(tmp(), `rules-${Math.random().toString(36).slice(2)}.md`);
    expect(ensureBriefPreface(repo, abs)).toEqual({ path: abs, created: true });
    expect(ensureBriefPreface(repo, "docs/rules.md").path).toBe(join(repo, "docs", "rules.md"));
  });

  it("a ~/ path is under the home directory, as volleyd reads it (not under the repo)", () => {
    const repo = tempDir("wave-from-issues-repo-");
    const home = tempDir("wave-from-issues-home-");
    expect(ensureBriefPreface(repo, "~/rules.md", home)).toEqual({
      path: join(home, "rules.md"),
      created: true,
    });
    expect(existsSync(join(repo, "~"))).toBe(false);
  });

  it("the CLI writes the preface into a repo on this machine, and says so", () => {
    const repo = tempDir("wave-from-issues-repo-");
    const input = join(tmp(), "issues-preface.json");
    writeFileSync(input, JSON.stringify(THREE));
    const run = () =>
      spawnSync(
        "bun",
        [
          HELPER_CLI,
          input,
          "--wave",
          OPTS.wave,
          "--repo",
          repo,
          "--release-branch",
          OPTS.releaseBranch,
          "--model",
          OPTS.model,
        ],
        { encoding: "utf-8" },
      );
    const first = run();
    expect(first.status).toBe(0);
    const file = join(repo, ".volley", "brief-preface.md");
    expect(existsSync(file)).toBe(true);
    expect(first.stderr).toContain(`wrote ${file} from the template`);
    writeFileSync(file, "edited\n");
    const second = run();
    expect(second.status).toBe(0);
    expect(readFileSync(file, "utf-8")).toBe("edited\n");
    expect(second.stderr).toContain(`brief preface: ${file} (kept)`);
  });
});

describe("footprints and the overlap plan (#381)", () => {
  const files = (...paths: string[]) =>
    `### Files\n\n${paths.map((p) => `- \`${p}\``).join("\n")}\n`;
  const P = "packages/app/src";
  const FIVE: IssueInput[] = [
    {
      number: 101,
      title: "Retry policy",
      body: `${files(`${P}/pipeline.ts`, `${P}/retry.ts`)}\nDepends on: none\n`,
    },
    {
      number: 102,
      title: "Timeouts",
      body: `${files(`${P}/pipeline.ts`, `${P}/timeout.ts`)}\nDepends on: none\n`,
    },
    {
      number: 103,
      title: "Backoff",
      body: `${files(`${P}/pipeline.ts`, `${P}/backoff.ts`)}\nDepends on: none\n`,
    },
    {
      number: 104,
      title: "Engine core",
      body: `${files(`${P}/engine.ts`, `${P}/core.ts`, "helpers.ts")}\nDepends on: none\n`,
    },
    {
      number: 105,
      title: "Engine notes",
      body: `Only \`${P}/engine.ts\` changes.\n\nDepends on: none\n`,
    },
  ];
  const TREE: Record<string, number> = {
    [`${P}/pipeline.ts`]: 40_000,
    [`${P}/retry.ts`]: 400,
    [`${P}/timeout.ts`]: 400,
    [`${P}/backoff.ts`]: 400,
    [`${P}/engine.ts`]: 40_000,
    [`${P}/core.ts`]: 400,
  };

  /** A git checkout of TREE on the release branch. */
  function repoWithTree(): string {
    const repo = join(tmp(), `repo-${Math.random().toString(36).slice(2)}`);
    for (const [f, n] of Object.entries(TREE)) {
      mkdirSync(join(repo, f, ".."), { recursive: true });
      writeFileSync(join(repo, f), "x".repeat(n));
    }
    const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf-8" });
    git("init", "--quiet", "-b", OPTS.releaseBranch);
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "i");
    return repo;
  }

  const cli = (args: string[], issues: IssueInput[] = FIVE) => {
    const input = join(tmp(), `five-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(input, JSON.stringify(issues));
    return spawnSync(
      "bun",
      [
        HELPER_CLI,
        input,
        "--wave",
        OPTS.wave,
        "--release-branch",
        OPTS.releaseBranch,
        "--model",
        OPTS.model,
        ...args,
      ],
      { encoding: "utf-8", env: noCoordinator },
    );
  };

  it("three issues sharing a large file become one bundle with issues, files, footprint and plan", () => {
    const { yaml, explanation } = waveFromIssues(FIVE, { ...OPTS, tree: TREE });
    const w = parseWaveFile(yaml);
    expect(w.task_order).toEqual(["i101", "i104", "i105"]);
    const b = w.tasks.i101;
    expect(b?.issues).toEqual([101, 102, 103]);
    expect(b?.title).toBe("bundle: #101 + #102 + #103 — Retry policy");
    expect(b?.files).toEqual([
      `${P}/pipeline.ts`,
      `${P}/retry.ts`,
      `${P}/timeout.ts`,
      `${P}/backoff.ts`,
    ]);
    expect(b?.footprint).toEqual({ confidence: "listed" });
    expect(b?.plan).toMatchObject({ cluster: "A", by: "collapse" });
    expect(w.tasks.i104?.footprint).toEqual({ confidence: "resolved", unresolved: ["helpers.ts"] });
    expect(w.tasks.i105?.footprint).toEqual({ confidence: "guessed" });
    // The header comment holds the explanation, and the parsed file plans the same clusters.
    for (const line of explanation) expect(yaml).toContain(`# plan: ${line}\n`);
    expect(explanation[0]).toBe(
      `cluster A: 3 tasks share ${P}/pipeline.ts (1k lines, 3 tasks) → 1 bundle (i101+i102+i103)`,
    );
    expect(w.overlap_plan?.clusters.map((c) => [c.id, c.strategy])).toEqual([
      ["A", { collapse: [["i101"]] }],
      ["B", { chain: [["i104", "i105"]] }],
    ]);
    expect(volleydValidate(yaml).code).toBe(0);
  });

  it("a chained pair: the added after: carries the planner's comment", () => {
    const { yaml } = waveFromIssues(FIVE, { ...OPTS, tree: TREE });
    expect(yaml).toContain(`    after: [i104]  # chained by the planner: shares ${P}/engine.ts\n`);
    expect(parseWaveFile(yaml).tasks.i105?.after).toEqual(["i104"]);
  });

  it("a declared after keeps its line without the comment", () => {
    const issues = FIVE.map((i) =>
      i.number === 105 ? { ...i, body: i.body.replace("Depends on: none", "Depends on: #101") } : i,
    );
    const { yaml } = waveFromIssues(issues, { ...OPTS, tree: TREE });
    expect(yaml).toContain(
      `    after: [i101, i104]  # chained by the planner: i104 shares ${P}/engine.ts\n`,
    );
  });

  it("noPlan: footprints only — no bundle, no plan, no added after", () => {
    const { yaml, explanation } = waveFromIssues(FIVE, { ...OPTS, tree: TREE, noPlan: true });
    const w = parseWaveFile(yaml);
    expect(w.task_order).toEqual(["i101", "i102", "i103", "i104", "i105"]);
    expect(w.tasks.i102?.files).toEqual([`${P}/pipeline.ts`, `${P}/timeout.ts`]);
    expect(w.tasks.i102?.footprint).toEqual({ confidence: "listed" });
    expect(yaml).not.toContain("plan:");
    expect(yaml).not.toContain("issues:");
    expect(w.tasks.i105?.after).toEqual([]);
    expect(explanation).toEqual([]);
  });

  it("CLI: reads the tree from --repo, writes the file, prints the plan and the footprint line", () => {
    const repo = repoWithTree();
    const out = join(tmp(), "five.yaml");
    const r = cli(["--repo", repo, "--out", out]);
    expect(r.status).toBe(0);
    const yaml = readFileSync(out, "utf-8");
    expect(parseWaveFile(yaml).tasks.i101?.issues).toEqual([101, 102, 103]);
    expect(r.stderr).toContain(
      `cluster A: 3 tasks share ${P}/pipeline.ts (1k lines, 3 tasks) → 1 bundle (i101+i102+i103)\n`,
    );
    expect(r.stderr).toContain(
      "footprints: 3 listed, 1 resolved, 1 guessed (#105); 1 entry unresolved (run with --verbose to list)\n",
    );
    expect(r.stderr).not.toContain("no tree");
    const v = cli(["--repo", repo, "--verbose"]);
    expect(v.stderr).toContain("unresolved: #104: helpers.ts\n");
  });

  it("CLI --plan-only prints the explanation and writes nothing", () => {
    const repo = repoWithTree();
    const out = join(tmp(), "plan-only.yaml");
    const r = cli(["--repo", repo, "--out", out, "--plan-only"]);
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(repo, DEFAULT_BRIEF_PREFACE))).toBe(false);
    expect(r.stdout).toContain(
      `cluster B: 2 tasks share ${P}/engine.ts (1k lines, 2 tasks) → 1 chain (i104 → i105)\n`,
    );
    expect(r.stdout).toContain("expected branch updates: ");
    expect(r.stdout).not.toContain("tasks:");
    expect(r.stderr).not.toContain("submit:");
  });

  it("CLI --no-plan with --plan-only is a usage error", () => {
    const r = cli(["--repo", repoWithTree(), "--no-plan", "--plan-only"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("wave-from-issues: --no-plan and --plan-only exclude each other\n");
  });

  it("CLI --no-plan writes footprints only", () => {
    const repo = repoWithTree();
    const r = cli(["--repo", repo, "--no-plan"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("  i102:\n");
    expect(r.stdout).not.toContain("plan:");
    expect(r.stderr).not.toContain("cluster A");
    expect(r.stderr).toContain("footprints: 3 listed, 1 resolved, 1 guessed (#105); 1 entry");
  });

  it("CLI: a repo without .volley/release.yaml is told the wave completes without a release", () => {
    const r = cli(["--repo", repoWithTree()]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(
      `footprints: 3 listed, 1 resolved, 1 guessed (#105); 1 entry unresolved (run with --verbose to list)\nrelease playbook: none — the wave will complete without a release; add .volley/release.yaml (volleyd README, "The release train")\n`,
    );
    // --plan-only says so too, on stderr (stdout is the plan).
    const p = cli(["--repo", repoWithTree(), "--plan-only"]);
    expect(p.stderr).toContain("release playbook: none — the wave will complete");
    expect(p.stdout).not.toContain("release playbook");
  });

  it("CLI: a repo with a playbook names it, its stages and the owner-gated ones", () => {
    const repo = repoWithTree();
    mkdirSync(join(repo, ".volley"), { recursive: true });
    writeFileSync(
      join(repo, ".volley", "release.yaml"),
      `version: 1
stages:
  - { name: bump, brief: Bump. }
  - { name: release-pr, brief: Open the PR. }
  - { name: tag, brief: Tag. }
  - { name: deploy, brief: Deploy. }
`,
    );
    const r = cli(["--repo", repo]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(
      "release playbook: .volley/release.yaml (4 stages, 0 owner-gated)\n",
    );
    expect(r.stderr).not.toContain("release playbook: none");
  });

  it("CLI: a --repo that is not on this machine prints no playbook line", () => {
    expect(cli(["--repo", OPTS.repo]).stderr).not.toContain("release playbook");
  });

  it("CLI: a --repo with no git tree leaves footprints unresolved, says so, and exits 0", () => {
    const r = cli(["--repo", OPTS.repo]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(
      `no tree: footprints unresolved (${OPTS.repo} has no origin/${OPTS.releaseBranch} or ${OPTS.releaseBranch})\n`,
    );
    const w = parseWaveFile(r.stdout);
    expect(w.tasks.i101?.footprint).toEqual({
      confidence: "none",
      unresolved: [`${P}/pipeline.ts`, `${P}/retry.ts`],
    });
    expect(w.tasks.i101?.files).toEqual([]);
  });
});
