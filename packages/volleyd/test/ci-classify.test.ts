import { describe, expect, it } from "vitest";
import { type ClassifyInput, classify, testFile } from "../src/autopilot/ci-classify";

/**
 * A red head is classified before anyone is asked (SPEC §4.6.16): the PR's own change, a flake
 * in code it did not touch, or an infra incident (an infra-shaped run, GitHub's status page).
 */

const OK = { incident: false, components: [] };
const INCIDENT = {
  incident: true,
  components: [{ name: "Actions", status: "major_outage" }],
};

const base: ClassifyInput = {
  failing_tests: ["test/clock.test.ts > sleep > resolves on abort"],
  pr_files: ["packages/volleyd/src/pipeline.ts", "test/pipeline.test.ts"],
  release: { state: "green", failing_tests: [] },
  infra: null,
  status_page: OK,
};

describe("testFile", () => {
  it.each([
    ["test/clock.test.ts > sleep > resolves on abort", "test/clock.test.ts"],
    ["packages/volleyd/test/a.spec.tsx > x", "packages/volleyd/test/a.spec.tsx"],
    ["test/clock.test.ts", "test/clock.test.ts"],
    ["test/clock.test.ts [ test/clock.test.ts ]", "test/clock.test.ts"],
    // bun's `(fail) <name>` ids carry no file.
    ["sleep > resolves on abort", null],
    ["resolves on abort", null],
  ])("%s → %s", (id, file) => {
    expect(testFile(id)).toBe(file);
  });
});

describe("classify", () => {
  it.each<[string, Partial<ClassifyInput>, string]>([
    [
      "a failing test's file is in the PR's changed files",
      { failing_tests: ["test/pipeline.test.ts > p > q"] },
      "own_change",
    ],
    [
      "the test file is untouched and the release branch fails on the same test",
      { release: { state: "red", failing_tests: [base.failing_tests[0] as string] } },
      "flake",
    ],
    ["the test file is untouched, the release branch green, not infra", {}, "flake"],
    ["an infra-shaped run (steps)", { infra: "steps", failing_tests: [] }, "infra_incident"],
    ["an infra shape wins over flake evidence", { infra: "startup" }, "infra_incident"],
    ["a status-page incident with flake evidence", { status_page: INCIDENT }, "infra_incident"],
    [
      "own_change wins over a status-page incident",
      { failing_tests: ["test/pipeline.test.ts > p"], status_page: INCIDENT },
      "own_change",
    ],
    [
      "no mappable test ids, release green",
      { failing_tests: ["sleep > resolves on abort"] },
      "own_change",
    ],
    ["no failing tests at all, release green", { failing_tests: [] }, "own_change"],
    [
      "no mappable test ids, release red on something else",
      {
        failing_tests: ["formula > renders the brew formula"],
        release: { state: "red", failing_tests: ["test/other.test.ts > x > y"] },
      },
      "own_change",
    ],
    [
      "no mappable test ids, release red on an unrelated job (no failing tests read)",
      {
        failing_tests: ["formula > renders the brew formula"],
        release: { state: "red", failing_tests: [] },
      },
      "own_change",
    ],
    [
      "no mappable test ids, release red on the same id",
      {
        failing_tests: ["sleep > resolves on abort"],
        release: { state: "red", failing_tests: ["sleep > resolves on abort"] },
      },
      "flake",
    ],
    [
      "a mix: one unmapped id the release branch fails and one it does not",
      { failing_tests: ["a > b", "c > d"], release: { state: "red", failing_tests: ["a > b"] } },
      "own_change",
    ],
    ["PR files unreadable: own_change (the conservative route)", { pr_files: null }, "own_change"],
    [
      "no failing tests anywhere, release red: no test to fix, so own_change",
      { failing_tests: [], release: { state: "red", failing_tests: [] } },
      "own_change",
    ],
  ])("%s → %s", (_name, over, want) => {
    expect(classify({ ...base, ...over }).classification).toBe(want);
  });

  it("evidence names the failing tests, their files, the PR files, release CI and the status page", () => {
    const r = classify({ ...base, release: { state: "red", failing_tests: [] } });
    expect(r.evidence).toEqual({
      failing_tests: base.failing_tests,
      test_files: ["test/clock.test.ts"],
      pr_files: base.pr_files,
      release_ci: { state: "red", failing_tests: [] },
      status_page: OK,
    });
  });

  it("a flake names its test: one that also fails on the release branch first", () => {
    const r = classify({
      ...base,
      failing_tests: ["test/a.test.ts > x", "test/clock.test.ts > y"],
      release: { state: "red", failing_tests: ["test/clock.test.ts > y"] },
    });
    expect(r.classification).toBe("flake");
    expect(r.flake).toEqual({
      test: "test/clock.test.ts > y",
      test_file: "test/clock.test.ts",
      tests: ["test/a.test.ts > x", "test/clock.test.ts > y"],
    });
  });

  it("an infra incident names what it is", () => {
    expect(classify({ ...base, status_page: INCIDENT }).incident).toBe(
      "GitHub Actions major_outage",
    );
    expect(classify({ ...base, infra: "steps" }).incident).toBe(
      "runner, checkout or network step failed",
    );
  });
});
