import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BriefVars,
  ROLES,
  briefExtra,
  briefGatePath,
  loadTemplate,
  renderBrief,
} from "../src/brief";
import { exec } from "../src/exec";
import { hygieneText } from "../src/reviews";
import { spawnAgent } from "../src/spawn";
import { SpawnError } from "../src/spawn-error";
import { type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";

const VARS: BriefVars = {
  agent_id: "w1-t1-implementer-1",
  namespace: "ns",
  wave: "w1",
  task: "T1",
  role: "implementer",
  issue: 42,
  issue_title: "Title with {{agent_id}} inside",
  issue_url: "https://github.com/example/repo/issues/42",
  model: "claude-opus-5-5",
  repo: "/w/repo",
  release_branch: "release/w1",
  branch: "w1/T1-implementer-1",
  worktree: "/wt/w1/T1-implementer",
  extra: "",
  hygiene_rule: hygieneText("p1").rule,
  hygiene_contract: hygieneText("p1").contract,
};

describe("brief templates", () => {
  it.each(ROLES)(
    "%s: no register step; narration, steering-ack and terminal-status rules",
    (role) => {
      const brief = renderBrief(loadTemplate(role), { ...VARS, role, issue_title: "Plain" });
      expect(brief).not.toMatch(/vol_register/);
      expect(brief).not.toContain("{{");
      // narration contract: progress channel, payload with progress + msg
      expect(brief).toContain('vol_publish(channel="progress", type="narration"');
      expect(brief).toMatch(/"progress": <0-100>, "msg":/);
      expect(brief).toContain("The field is literally `msg`");
      // steering: explicit prose ack + steering_acked publish
      expect(brief).toContain("`acknowledged: …`");
      expect(brief).toContain('type="steering_acked"');
      // terminal status, exactly once
      expect(brief).toMatch(/exactly once on channel `status`/);
      for (const t of ['type="done"', 'type="blocked"', 'type="failed"'])
        expect(brief).toContain(t);
      expect(brief).toContain("w1-t1-implementer-1");
      expect(brief).toContain("#42");
    },
  );

  it("reviewers and the fixup carry the pipeline's result contract", () => {
    const render = (role: (typeof ROLES)[number]) =>
      renderBrief(loadTemplate(role), { ...VARS, role });
    for (const role of ["spec_reviewer", "quality_reviewer"] as const) {
      const b = render(role);
      expect(b).toContain('vol_publish(channel="result", type="review"');
      expect(b).toContain(".volley/review.md");
      expect(b).toMatch(/`P1` blocks the merge/);
    }
    expect(render("fixup")).toContain('vol_publish(channel="result", type="fixup"');
    expect(render("fixup")).toContain(".volley/findings.md");
    expect(render("rebase")).toContain(".volley/rebase.md");
  });

  it("the implementer and the fixup record the change as a changes/ fragment, never in CHANGELOG.md", () => {
    const impl = renderBrief(loadTemplate("implementer"), VARS);
    expect(impl).toContain("`changes/42.<added|changed|fixed|removed|docs>.md`");
    expect(impl).toContain("never edit `CHANGELOG.md`");
    const fixup = renderBrief(loadTemplate("fixup"), { ...VARS, role: "fixup" });
    expect(fixup).toContain("`changes/42.");
    expect(fixup).toContain("never edit `CHANGELOG.md`");
  });

  it("the quality reviewer reviews the diff only; pipeline roles say what their worktree is cut from", () => {
    const render = (role: (typeof ROLES)[number]) =>
      renderBrief(loadTemplate(role), { ...VARS, role });
    const q = render("quality_reviewer");
    expect(q).not.toMatch(/Read `ISSUE\.md`/);
    expect(q).toMatch(/the diff only/);
    for (const role of ["spec_reviewer", "quality_reviewer", "fixup", "rebase"] as const)
      expect(render(role)).not.toMatch(/cut from `release/);
    expect(render("spec_reviewer")).toMatch(/detached checkout of the PR head/);
  });

  it("the rebase role's merge brief (branch_update: merge): the protocol block, and never a force-push", () => {
    const merge = renderBrief(loadTemplate("rebase", undefined, "merge"), {
      ...VARS,
      role: "rebase",
      issue_title: "Plain",
    });
    const rebase = renderBrief(loadTemplate("rebase"), { ...VARS, role: "rebase" });
    expect(merge).toMatch(/^# Merge for issue #42/);
    expect(merge).toContain(".volley/rebase.md");
    expect(merge).toContain("Merge `origin/release/w1` into the PR branch (never rebase it)");
    expect(merge).toContain("Never force-push, in any form");
    expect(merge).not.toMatch(/lease-guarded|The only force-push allowed/);
    expect(rebase).toContain("The only force-push allowed");
    // The protocol block is the rebase brief's, byte for byte.
    const protocol = (b: string) => b.slice(b.indexOf("## Volley protocol (mandatory)"));
    expect(protocol(merge)).toBe(
      protocol(
        renderBrief(loadTemplate("rebase"), { ...VARS, role: "rebase", issue_title: "Plain" }),
      ),
    );
    expect(merge).not.toMatch(/vol_register/);
    expect(merge).not.toContain("{{");
  });

  it("a merge-mode rebase spawn renders the merge brief", async () => {
    const env = await makeSpawnEnv();
    try {
      const out = await spawnAgent(
        env.request({
          role: "rebase",
          start: { ref: "a".repeat(40), detach: false },
          branch_update: "merge",
        }),
        env.deps,
      );
      expect(out.kind).toBe("launched");
      const wt = env.events.find((e) => e.type === "agent_spawned")?.data.worktree as string;
      expect(readFileSync(join(wt, ".volley", "brief.md"), "utf-8")).toMatch(/^# Merge for issue/m);
      expect(env.events.find((e) => e.type === "agent_spawned")?.data).toMatchObject({
        branch_update: "merge",
      });
    } finally {
      env.cleanup();
    }
  });

  it("substitutes in one pass (placeholders inside values stay literal)", () => {
    const brief = renderBrief(loadTemplate("implementer"), VARS);
    expect(brief).toContain("Title with {{agent_id}} inside");
  });

  it("an unknown placeholder is an error", () => {
    expect(() => renderBrief("hi {{nope}}", VARS)).toThrow(/unknown \{\{nope\}\}/);
  });

  it("repo extras come from <repo>/.volley/brief-extra.md", async () => {
    const env = await makeSpawnEnv();
    try {
      expect(briefExtra(env.repo)).toBe("");
      mkdirSync(join(env.repo, ".volley"), { recursive: true });
      writeFileSync(join(env.repo, ".volley", "brief-extra.md"), "Run `make verify`.\n");
      await spawnAgent(env.request(), env.deps);
      const brief = readFileSync(join(env.worktree, ".volley", "brief.md"), "utf-8");
      expect(brief).toContain("## Repository notes\n\nRun `make verify`.");
    } finally {
      await env.cleanup();
    }
  });
});

describe("brief gate", () => {
  let env: SpawnEnv;
  afterEach(() => env.cleanup());

  const gate = (body: string) => {
    const path = join(env.home, "brief-gate");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };

  it("$VOLLEYD_HOME/brief-gate is used only when executable", async () => {
    env = await makeSpawnEnv();
    expect(briefGatePath(env.home)).toBeNull();
    const path = gate("exit 0");
    expect(briefGatePath(env.home)).toBe(path);
    chmodSync(path, 0o644);
    expect(briefGatePath(env.home)).toBeNull();
  });

  it("a gate exiting 1 → SPAWN_BRIEF_REJECTED, journaled, and no launch", async () => {
    env = await makeSpawnEnv();
    // The real fenced exec runs the gate; everything else stays on the fake.
    const path = gate(
      'grep -q "forbidden" "$1" && exit 0; echo "brief lacks the marker" >&2; exit 1',
    );
    env.deps.briefGate = path;
    const realExec = env.deps.host.exec;
    (env.deps.host as { exec: typeof exec }).exec = async (argv, opts) =>
      argv[0] === path ? exec(argv, opts) : realExec(argv, opts);
    const err = await spawnAgent(env.request(), env.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpawnError);
    expect((err as SpawnError).code).toBe("SPAWN_BRIEF_REJECTED");
    expect(env.host.launches).toEqual([]);
    expect(env.host.fake.argvs(["volley"])).toEqual([]); // gated before credentials are minted
    expect(env.events.find((e) => e.type === "alarm_raised")?.data).toMatchObject({
      code: "SPAWN_BRIEF_REJECTED",
      exit: 1,
      stderr: "brief lacks the marker",
    });
  });

  it("a gate exiting 0 lets the spawn launch", async () => {
    env = await makeSpawnEnv();
    const path = gate('test -s "$1"');
    env.deps.briefGate = path;
    const realExec = env.deps.host.exec;
    (env.deps.host as { exec: typeof exec }).exec = async (argv, opts) =>
      argv[0] === path ? exec(argv, opts) : realExec(argv, opts);
    expect((await spawnAgent(env.request(), env.deps)).kind).toBe("launched");
    expect(env.host.launches).toHaveLength(1);
  });
});
