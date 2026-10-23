import { describe, expect, it } from "vitest";
import { parsePlaybook } from "../src/autopilot/playbook";
import { renderStageMd, stageBriefVars } from "../src/autopilot/release-train";
import { type BriefVars, NO_STAGE, loadTemplate, renderBrief } from "../src/brief";

// The release role's brief (SPEC §4.6.19): `.volley/stage.md` and briefs/release.md.tmpl.

const [BUMP, TAG] = parsePlaybook(`version: 1
stages:
  - name: bump
    brief: Bump the version and write the changelog.
    run:
      - [bun, run, changelog, --version, 0.5.0, --commit]
      - [git, commit, -m, "release: v0.5.0"]
    verify: { commits_on_release: true, files: [CHANGELOG.md], result: { bumped: true } }
  - { name: tag, brief: Tag the release., heavy: deploy, verify: { tag: "v0.5.*" } }
`).stages;
if (BUMP === undefined || TAG === undefined) throw new Error("playbook");

const VARS: BriefVars = {
  agent_id: "w1-release-bump-1",
  namespace: "ns",
  wave: "w1",
  task: "_release",
  role: "release",
  issue: 0,
  issue_title: "",
  issue_url: "",
  model: "claude-opus-5-5",
  repo: "/w/repo",
  release_branch: "release/w1",
  branch: "w1/release-bump-1",
  worktree: "/wt/w1/_release-release-bump-1",
  extra: "",
  hygiene_rule: "",
  hygiene_contract: "",
  ...NO_STAGE,
};

describe("renderStageMd", () => {
  it("lists the run argvs as fenced shell lines in order, the verify facts in prose and the result contract", () => {
    const md = renderStageMd(BUMP, { wave: "w1", release_branch: "release/w1", attempt: 1 });
    expect(md).toContain("Bump the version and write the changelog.");
    const block = md.slice(md.indexOf("```sh"), md.indexOf("```", md.indexOf("```sh") + 5));
    expect(block.split("\n").slice(1)).toEqual([
      "bun run changelog --version 0.5.0 --commit",
      "git commit -m 'release: v0.5.0'",
      "",
    ]);
    expect(md).toContain("Stop at the first one that exits non-zero");
    expect(md).toMatch(/At least one new commit is on `release\/w1`/);
    expect(md).toContain("`CHANGELOG.md` exists on `release/w1`");
    expect(md).toContain("`bumped: true`");
    expect(md).toContain("git push origin HEAD:release/w1");
    expect(md).toContain('vol_publish(channel="result", type="stage", payload={ "stage": "bump"');
    expect(md).not.toContain("volley lease acquire");
  });

  it("the release PR body (#416): one Closes line per done task's issue; none without any", () => {
    const md = renderStageMd(BUMP, {
      wave: "w1",
      release_branch: "release/w1",
      attempt: 1,
      closes: [412, 414],
    });
    const at = md.indexOf("## Release PR body");
    expect(at).toBeGreaterThan(md.indexOf("## Verified after your done"));
    expect(at).toBeLessThan(md.indexOf("## Result contract"));
    expect(md.match(/^Closes #\d+$/gm)).toEqual(["Closes #412", "Closes #414"]);
    const none = renderStageMd(BUMP, { wave: "w1", release_branch: "release/w1", attempt: 1 });
    expect(none).not.toContain("## Release PR body");
    expect(none).not.toContain("Closes #");
  });

  it("a heavy stage takes its lease first", () => {
    const md = renderStageMd(TAG, { wave: "w1", release_branch: "release/w1", attempt: 2 });
    expect(md).toContain("`volley lease acquire --pool deploy`");
    expect(md).toContain("`volley lease release --pool deploy --lease-id <id>`");
    expect(md.indexOf("volley lease acquire")).toBeLessThan(md.indexOf("names no commands"));
    expect(md).toContain("A tag matching `v0.5.*` exists on origin at the head of `release/w1`");
  });
});

describe("briefs/release.md.tmpl", () => {
  it("renders with no placeholder left, the stage's commands and the protocol block", () => {
    const brief = renderBrief(loadTemplate("release"), {
      ...VARS,
      ...stageBriefVars(BUMP, "release/w1"),
    });
    expect(brief).not.toContain("{{");
    expect(brief).toMatch(/^# Release stage `bump` of wave w1/);
    expect(brief).toContain(".volley/stage.md");
    expect(brief).toContain("bun run changelog --version 0.5.0 --commit");
    expect(brief).toContain('type="stage", payload={ "stage": "bump"');
    expect(brief).toContain("never deploy to production");
    expect(brief).toContain("## Volley protocol (mandatory)");
    expect(brief).not.toMatch(/vol_register/);
  });
});
