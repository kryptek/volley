import { describe, expect, it } from "vitest";
import { flakeIssue, renderFlakeBrief } from "../src/autopilot/flake-brief";
import { type BriefVars, NO_STAGE, loadTemplate, renderBrief } from "../src/brief";
import { hygieneText } from "../src/reviews";
import type { FixerRemediation } from "../src/types";

const R: FixerRemediation = {
  kind: "fix_flake",
  test: "test/clock.test.ts > sleep > resolves on abort",
  test_file: "test/clock.test.ts",
  run_urls: ["https://example.test/runs/9", "https://example.test/runs/11"],
  for: ["T3", "T7"],
};

describe("renderFlakeBrief (the fixer's ISSUE.md, SPEC §4.6.16)", () => {
  const md = renderFlakeBrief(R, { task: "fix-test-clock-test-ts-sleep-resolves-on-abort" });

  it("names the test, its file, the run URLs and the blocked tasks", () => {
    expect(md).toContain("# Fix flaky test test/clock.test.ts > sleep > resolves on abort");
    expect(md).toContain("`test/clock.test.ts`");
    expect(md).toContain("https://example.test/runs/9");
    expect(md).toContain("https://example.test/runs/11");
    expect(md).toContain("T3, T7");
  });

  it("carries the four rules: reproduce, find the cause, test-first, never re-run / skip / quarantine", () => {
    expect(md).toMatch(/Reproduce it locally/);
    expect(md).toMatch(/alone and in the full suite/);
    expect(md).toMatch(/under load/);
    for (const cause of [
      "shared state",
      "timing",
      "ports",
      "the clock",
      "temp dirs",
      "retained broker state",
    ])
      expect(md).toContain(cause);
    expect(md).toMatch(/test-first/);
    expect(md).toMatch(/Never re-run CI as a fix/);
    for (const banned of ["`skip`", "`.only`", "retry wrappers", "quarantine"])
      expect(md).toContain(banned);
    expect(md).toMatch(/publish `blocked` with the reason/);
  });

  it("an unknown file and no runs say so", () => {
    const bare = renderFlakeBrief({ ...R, test_file: null, run_urls: [] }, { task: "fix-x" });
    expect(bare).toContain("unknown (find it from the test name)");
    expect(bare).toContain("none recorded");
  });

  it("flakeIssue: issue 0, the fixer's title, the first run URL", () => {
    expect(flakeIssue(R, "fix-x")).toEqual({
      number: 0,
      title: "Fix flaky test test/clock.test.ts > sleep > resolves on abort",
      url: "https://example.test/runs/9",
      body: renderFlakeBrief(R, { task: "fix-x" }),
    });
  });
});

describe("the flake fixer brief template", () => {
  const VARS: BriefVars = {
    agent_id: "w1-fix-x-implementer-1",
    namespace: "ns",
    wave: "w1",
    task: "fix-x",
    role: "implementer",
    issue: 0,
    issue_title: "Fix flaky test {{agent_id}}",
    issue_url: "https://example.test/runs/9",
    model: "claude-opus-5-5",
    repo: "/w/repo",
    release_branch: "release/w1",
    branch: "w1/fix-x-implementer-1",
    worktree: "/wt/w1/fix-x-implementer",
    extra: "",
    hygiene_rule: hygieneText("p1").rule,
    hygiene_contract: hygieneText("p1").contract,
    ...NO_STAGE,
  };

  it('loadTemplate("implementer", dir, "flake") loads flake-fixer.md.tmpl', () => {
    const t = loadTemplate("implementer", undefined, "flake");
    expect(t).toContain("root cause");
    expect(t).not.toBe(loadTemplate("implementer"));
  });

  it("renders with no placeholder left, the protocol, the root-cause rules and the PR target", () => {
    const brief = renderBrief(loadTemplate("implementer", undefined, "flake"), VARS);
    expect(brief).not.toMatch(/\{\{\s*(?!agent_id)[a-z_]+\s*\}\}/);
    expect(brief).toContain("Fix flaky test {{agent_id}}");
    expect(brief).toContain("open a pull request against `release/w1`");
    expect(brief).toContain('vol_publish(channel="progress", type="narration"');
    expect(brief).toMatch(/exactly once on channel `status`/);
    expect(brief).toMatch(/Never re-run CI as a fix/);
    expect(brief).toMatch(/publish `blocked`/);
    expect(brief).not.toContain("issue #0");
  });
});
