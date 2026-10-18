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
