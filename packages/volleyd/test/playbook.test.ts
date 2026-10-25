import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  DEFAULT_PLAYBOOK,
  PlaybookError,
  type PlaybookStage,
  formatPlaybook,
  nextVersion,
  parsePlaybook,
  playbookPath,
  readPlaybook,
  releaseDate,
  substitute,
  substituteStage,
  trainState,
  wavePlaybook,
} from "../src/autopilot/playbook";
import type { JournalEvent } from "../src/types";
import { tempDir } from "./helpers/tmp";

const EXAMPLE = JSON.parse(
  readFileSync(
    new URL("../../../spec/examples/valid/release-playbook.json", import.meta.url),
    "utf-8",
  ),
) as { stages: { name: string }[] };

const errorsOf = (yaml: string) => {
  try {
    parsePlaybook(yaml, "release.yaml");
  } catch (e) {
    expect(e).toBeInstanceOf(PlaybookError);
    return (e as PlaybookError).errors;
  }
  throw new Error("expected a PlaybookError");
};

describe("parsePlaybook", () => {
  it("the spec example parses to its stages in order, gate defaulted to auto", () => {
    const p = parsePlaybook(stringify(EXAMPLE));
    expect(p.version).toBe(1);
    expect(p.stages.map((s) => s.name)).toEqual(EXAMPLE.stages.map((s) => s.name));
    for (const s of p.stages) expect(["auto", "owner"]).toContain(s.gate);
    // A stage without gate: is auto; without run: has none; without phase: prepare.
    const bare = parsePlaybook("version: 1\nstages:\n  - { name: smoke, brief: Run the smoke. }\n");
    expect(bare.stages).toEqual([
      { name: "smoke", brief: "Run the smoke.", run: [], gate: "auto", phase: "prepare" },
    ]);
  });

  it("the Volley repository's own playbook is the spec example: bump, release-pr, tag, deploy", () => {
    const own = readFileSync(new URL("../../../.volley/release.yaml", import.meta.url), "utf-8");
    const p = parsePlaybook(own, ".volley/release.yaml");
    expect(p).toEqual(parsePlaybook(stringify(EXAMPLE)));
    expect(p.stages.map((s) => [s.name, s.phase, s.gate])).toEqual([
      ["bump", "prepare", "auto"],
      ["release-pr", "prepare", "auto"],
      ["tag", "ship", "auto"],
      ["deploy", "ship", "auto"],
    ]);
    expect(p.stages[0]?.run).toEqual([
      ["bun", "scripts/release-version.ts", "--set", "{{version}}"],
      ["bun", "run", "changelog", "--version", "{{version}}", "--date", "{{date}}"],
    ]);
    expect(p.stages[1]?.verify).toEqual({ release_pr: true });
    expect(p.stages[2]?.verify).toEqual({ tag: "v{{version}}" });
    expect(p.stages[3]?.run).toEqual([["volley", "deploy", "v{{version}}"]]);
    expect(p.stages[3]?.verify).toEqual({ result: { deployed: "v{{version}}" } });
  });

  it("phase defaults to prepare; phase: later is a path-qualified error", () => {
    expect(errorsOf("version: 1\nstages:\n  - { name: a, brief: b, phase: later }\n")).toEqual([
      expect.objectContaining({ path: "stages[0].phase" }),
    ]);
  });

  it("an unknown {{variable}} is refused where it is written", () => {
    const yaml = [
      "version: 1",
      "stages:",
      "  - name: bump",
      "    brief: Bump to {{version}}.",
      "    run:",
      "      - [git, status]",
      "      - [bun, run, changelog, --version, '{{ver}}']",
      "",
    ].join("\n");
    expect(errorsOf(yaml)).toEqual([
      { path: "stages[0].run[1][4]", reason: "unknown variable {{ver}}" },
    ]);
    expect(errorsOf("version: 1\nstages:\n  - { name: a, brief: 'at {{merged_sha}}' }\n")).toEqual([
      { path: "stages[0].brief", reason: "{{merged_sha}} is known in a ship stage only" },
    ]);
    expect(
      errorsOf(
        "version: 1\nstages:\n  - { name: a, brief: b, verify: { tag: 'v{{tag}}', result: { x: '{{y}}' } } }\n",
      ),
    ).toEqual([
      { path: "stages[0].verify.tag", reason: "unknown variable {{tag}}" },
      { path: "stages[0].verify.result.x", reason: "unknown variable {{y}}" },
    ]);
  });

  it("a ship stage never verifies commits_on_release, and needs a prepare stage verifying release_pr", () => {
    const pr = "  - { name: pr, brief: Open it., verify: { release_pr: true } }\n";
    expect(
      errorsOf(
        `version: 1\nstages:\n${pr}  - { name: tag, brief: t, phase: ship, verify: { commits_on_release: true } }\n`,
      ),
    ).toEqual([
      {
        path: "stages[1].verify.commits_on_release",
        reason: "a ship stage pushes nothing but a tag (the release branch is merged and gone)",
      },
    ]);
    expect(errorsOf("version: 1\nstages:\n  - { name: tag, brief: t, phase: ship }\n")).toEqual([
      {
        path: "stages[0].phase",
        reason:
          "a ship stage needs a prepare stage that verifies release_pr (the PR volleyd merges on the go)",
      },
    ]);
    expect(
      errorsOf(`version: 1\nstages:\n  - { name: tag, brief: t, phase: ship }\n${pr}`).map(
        (e) => e.path,
      ),
    ).toEqual(["stages[1].phase"]);
  });

  it("substituteStage fills brief, run elements, verify.tag and verify.result values", () => {
    const [s] = parsePlaybook(stringify(EXAMPLE)).stages.slice(3);
    const vars = { version: "0.13.3", date: "2026-10-25", wave: "w1" };
    const deploy = substituteStage(s as PlaybookStage, vars);
    expect(deploy.run).toEqual([["volley", "deploy", "v0.13.3"]]);
    expect(deploy.verify).toEqual({ result: { deployed: "v0.13.3" } });
    expect(deploy.brief).toContain("Deploy v0.13.3");
    const tag = substituteStage(parsePlaybook(stringify(EXAMPLE)).stages[2] as PlaybookStage, vars);
    expect(tag.verify?.tag).toBe("v0.13.3");
    // A variable not known yet is left as written.
    expect(substitute("{{merged_sha}} {{version}}", vars)).toBe("{{merged_sha}} 0.13.3");
  });

  it("a duplicate stage name is reported at the second one", () => {
    expect(
      errorsOf(
        "version: 1\nstages:\n  - { name: smoke, brief: a }\n  - { name: smoke, brief: b }\n",
      ),
    ).toEqual([{ path: "stages[1].name", reason: "duplicate stage 'smoke'" }]);
  });

  it("gate: later is a path-qualified error", () => {
    const errs = errorsOf("version: 1\nstages:\n  - { name: smoke, brief: a, gate: later }\n");
    expect(errs.map((e) => e.path)).toEqual(["stages[0].gate"]);
  });

  it("run must be argv arrays of strings: a bare string is refused", () => {
    const errs = errorsOf(
      "version: 1\nstages:\n  - name: bump\n    brief: a\n    run: ['bun run changelog']\n",
    );
    expect(errs.map((e) => e.path)).toEqual(["stages[0].run[0]"]);
  });

  it("unknown keys, no stages and bad YAML are refused with their path", () => {
    expect(errorsOf("version: 1\nstages:\n  - { name: a, brief: b, deploy: prod }\n")).toEqual([
      { path: "stages[0].deploy", reason: "unknown key" },
    ]);
    expect(errorsOf("version: 1\nstages: []\n").map((e) => e.path)).toEqual(["stages"]);
    expect(errorsOf("version: 1\nstages: [\n")[0]?.path).toBe("(root)");
  });

  it("the error message names the file", () => {
    expect(() => parsePlaybook("version: 2\nstages: []\n", "x/release.yaml")).toThrow(
      /^RELEASE_PLAYBOOK_INVALID: x\/release\.yaml: invalid release playbook:\n {2}version: /,
    );
  });
});

describe("nextVersion (SPEC §4.6.19)", () => {
  const tags = ["refs/tags/v0.13.2", "refs/tags/v0.13.1", "refs/tags/v0.14.0-rc.1", "v0.9.0"];
  it("the newest release tag, patch-bumped by fixed/changed/docs fragments", () => {
    expect(nextVersion(tags, ["changes/600.fixed.md", "changes/README.md"])).toEqual({
      version: "0.13.3",
      newest: "v0.13.2",
    });
    expect(nextVersion(tags, ["changes/601.docs.md", "changes/602.changed.md"])).toMatchObject({
      version: "0.13.3",
    });
    expect(nextVersion(tags, [])).toMatchObject({ version: "0.13.3" });
  });
  it("minor on any added or removed fragment", () => {
    expect(nextVersion(tags, ["changes/1.fixed.md", "changes/2.added.md"])).toMatchObject({
      version: "0.14.0",
    });
    expect(nextVersion(tags, ["3.removed.md"])).toMatchObject({ version: "0.14.0" });
    expect(nextVersion(["v1.2.3"], ["4.added.md"])).toMatchObject({ version: "1.3.0" });
  });
  it("no tag: 0.1.0", () => {
    expect(nextVersion([], ["1.added.md"])).toEqual({ version: "0.1.0" });
    expect(nextVersion(["v0.14.0-rc.1"], [])).toEqual({ version: "0.1.0" });
  });
  it("release_version overrides, refused unless greater than the newest tag", () => {
    expect(nextVersion(tags, ["1.fixed.md"], "1.0.0")).toEqual({
      version: "1.0.0",
      newest: "v0.13.2",
    });
    expect(nextVersion(tags, [], "0.13.2")).toEqual({
      error: "release_version 0.13.2 is not greater than the newest tag v0.13.2",
    });
    expect(nextVersion(tags, [], "1.0")).toEqual({ error: "release_version 1.0 is not X.Y.Z" });
    expect(nextVersion([], [], "0.0.1")).toEqual({ version: "0.0.1" });
  });
  it("releaseDate is the UTC day", () => {
    expect(releaseDate(Date.parse("2026-10-25T23:59:59Z"))).toBe("2026-10-25");
  });
});

describe("playbookPath / readPlaybook", () => {
  it("default .volley/release.yaml under the repo; a relative path is the repo's; none is null", () => {
    expect(DEFAULT_PLAYBOOK).toBe(".volley/release.yaml");
    expect(playbookPath("/r", undefined)).toBe("/r/.volley/release.yaml");
    expect(playbookPath("/r", "ops/release.yaml")).toBe("/r/ops/release.yaml");
    expect(playbookPath("/r", "/abs/p.yaml")).toBe("/abs/p.yaml");
    expect(playbookPath("/r", "none")).toBeNull();
  });

  it("reads a playbook with its sha256 and size; a missing file is null; a bad one throws", () => {
    const dir = tempDir("volleyd-playbook-");
    mkdirSync(join(dir, ".volley"));
    const path = join(dir, ".volley", "release.yaml");
    expect(readPlaybook(path)).toBeNull();
    const text = "version: 1\nstages:\n  - { name: smoke, brief: a, gate: owner }\n";
    writeFileSync(path, text);
    const r = readPlaybook(path);
    expect(r?.sha256).toBe(createHash("sha256").update(text).digest("hex"));
    expect(r?.bytes).toBe(Buffer.byteLength(text));
    expect(r?.playbook.stages[0]?.gate).toBe("owner");
    writeFileSync(path, "version: 1\nstages: []\n");
    expect(() => readPlaybook(path)).toThrow(PlaybookError);
  });

  it("a playbook path that cannot be read (a directory) throws PlaybookError, not a raw error", () => {
    const dir = tempDir("volleyd-playbook-");
    expect(() => readPlaybook(dir)).toThrow(PlaybookError);
    expect(() => readPlaybook(dir)).toThrow(/^RELEASE_PLAYBOOK_INVALID: .*: cannot read: EISDIR/);
  });

  it("wavePlaybook: none, the default absent, or a repo not here → null; a configured one missing → error", () => {
    const repo = tempDir("volleyd-playbook-repo-");
    expect(wavePlaybook({ repo, playbook: "none" })).toBeNull();
    expect(wavePlaybook({ repo })).toBeNull();
    expect(wavePlaybook({ repo: join(repo, "not-here"), playbook: "ops/release.yaml" })).toBeNull();
    expect(() => wavePlaybook({ repo, playbook: "ops/release.yaml" })).toThrow(
      `RELEASE_PLAYBOOK_INVALID: ${join(repo, "ops/release.yaml")}: no such file`,
    );
    mkdirSync(join(repo, "ops"));
    writeFileSync(
      join(repo, "ops", "release.yaml"),
      "version: 1\nstages:\n  - { name: a, brief: b }\n",
    );
    expect(wavePlaybook({ repo, playbook: "ops/release.yaml" })).toMatchObject({
      display: "ops/release.yaml",
      path: join(repo, "ops", "release.yaml"),
    });
  });

  it("formats the validate line", () => {
    const p = parsePlaybook(
      "version: 1\nstages:\n  - { name: a, brief: x }\n  - { name: b, brief: y, gate: owner }\n",
    );
    expect(formatPlaybook(".volley/release.yaml", p)).toBe(
      "release playbook: .volley/release.yaml (2 stages, 1 owner-gated)",
    );
    expect(formatPlaybook(null, null)).toBe("release playbook: none");
  });
});

describe("trainState", () => {
  let seq = 0;
  const ev = (type: string, data: Record<string, unknown> = {}): JournalEvent =>
    ({ seq: ++seq, at: "2026-10-20T00:00:00.000Z", type, data }) as JournalEvent;
  const started = ev("release_started", {
    playbook: {
      path: "/r/.volley/release.yaml",
      sha256: "0".repeat(64),
      stages: [
        { name: "smoke", brief: "a", run: [], gate: "auto" },
        { name: "deploy", brief: "b", run: [], gate: "owner" },
      ],
    },
  });

  it("no release_started: null", () => {
    expect(trainState([ev("wave_complete")])).toBeNull();
  });

  it("started → every stage pending; entered → running (the current stage); verified", () => {
    expect(trainState([started])).toEqual({
      stage: null,
      phase: "prepare",
      stages: [
        { name: "smoke", state: "pending" },
        { name: "deploy", state: "pending" },
      ],
    });
    const entered = ev("release_stage_entered", { stage: "smoke" });
    expect(trainState([started, entered])?.stage).toBe("smoke");
    expect(
      trainState([started, entered, ev("release_stage_verified", { stage: "smoke" })]),
    ).toEqual({
      stage: null,
      phase: "prepare",
      stages: [
        { name: "smoke", state: "verified" },
        { name: "deploy", state: "pending" },
      ],
    });
  });

  it("a stage_go decision marks its stage awaiting_go; a failed stage is failed", () => {
    const s = trainState([
      started,
      ev("decision_opened", { decision_id: "stage_go-1", kind: "stage_go", stage: "deploy" }),
    ]);
    expect(s).toEqual({
      stage: "deploy",
      phase: "prepare",
      stages: [
        { name: "smoke", state: "pending" },
        { name: "deploy", state: "awaiting_go" },
      ],
    });
    const f = trainState([
      started,
      ev("release_stage_entered", { stage: "smoke" }),
      ev("release_stage_failed", { stage: "smoke", reason: "no tag" }),
    ]);
    expect(f?.stages[0]).toEqual({ name: "smoke", state: "failed" });
    expect(f?.stage).toBeNull();
  });
});
