import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  type IssueInput,
  type WaveOptions,
  parseDependsOn,
  taskIdFor,
  waveFromIssues,
} from "../scripts/wave-from-issues";

const VOLLEYD_CLI = fileURLToPath(new URL("../../volleyd/src/cli.ts", import.meta.url));
const HELPER_CLI = fileURLToPath(new URL("../scripts/wave-from-issues.ts", import.meta.url));

const OPTS: WaveOptions = {
  wave: "2026-10-18-example",
  repo: "/tmp/example-repo",
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

const tmp = mkdtempSync(join(tmpdir(), "wave-from-issues-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function volleydValidate(yaml: string): { code: number | null; out: string } {
  const file = join(tmp, `wave-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(file, yaml);
  const r = spawnSync("bun", [VOLLEYD_CLI, "validate", file], { encoding: "utf-8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

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

  it("errors on a tag used by two issues, naming both", () => {
    const dup: IssueInput[] = [
      { number: 80, title: "O1: first", body: "" },
      { number: 81, title: "O1 — second", body: "" },
    ];
    expect(() => waveFromIssues(dup, OPTS)).toThrow(/task id 'O1'.*#80.*#81/);
  });

  it("errors when a tag collides with another issue's fallback id, ignoring case", () => {
    // volleyd rejects task ids that differ only in case, so the helper must not emit them.
    const clash: IssueInput[] = [
      { number: 90, title: "Untagged", body: "" },
      { number: 91, title: "I90: tagged like a fallback", body: "" },
    ];
    expect(() => waveFromIssues(clash, OPTS)).toThrow(/#90.*#91/);
  });
});

describe("wave-from-issues CLI", () => {
  it("reads issues JSON and writes the wave file", () => {
    const input = join(tmp, "issues.json");
    const out = join(tmp, "cli-wave.yaml");
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
      { encoding: "utf-8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const v = spawnSync("bun", [VOLLEYD_CLI, "validate", out], { encoding: "utf-8" });
    expect(v.status).toBe(0);
  });

  it("exits 1 naming the outside dependency", () => {
    const input = join(tmp, "bad.json");
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
    const input = join(tmp, "pipe.json");
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
    const input = join(tmp, "slug.json");
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
      { encoding: "utf-8" },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("after: [i7]");
  });

  it("exits 2 on a --satisfied entry that is not an issue number", () => {
    const input = join(tmp, "one.json");
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
