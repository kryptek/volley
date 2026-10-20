import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  DEFAULT_PLAYBOOK,
  PlaybookError,
  formatPlaybook,
  parsePlaybook,
  playbookPath,
  readPlaybook,
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
    expect(p.stages.some((s) => s.gate === "owner")).toBe(true);
    // A stage without gate: is auto; without run: has none.
    const bare = parsePlaybook("version: 1\nstages:\n  - { name: smoke, brief: Run the smoke. }\n");
    expect(bare.stages).toEqual([
      { name: "smoke", brief: "Run the smoke.", run: [], gate: "auto" },
    ]);
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
