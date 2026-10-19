import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeRoot, profileDir } from "../../src/claude/profiles";
import { spawnAgent } from "../../src/spawn";
import { type SpawnEnv, makeSpawnEnv } from "../helpers/fake-host";
import { withEnv } from "../helpers/with-env";

/** spawnAgent under a Claude account profile (the daemon resolves `account` with selectAccount). */

let env: SpawnEnv;
afterEach(() => env.cleanup());

function profile(trusted: boolean) {
  const dir = join(env.dir, "claude", "work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".claude.json"),
    JSON.stringify({
      projects: trusted ? { [env.repo]: { hasTrustDialogAccepted: true } } : {},
    }),
  );
  return dir;
}

describe("spawn under a Claude account", () => {
  it("launch.sh exports the profile's CLAUDE_CONFIG_DIR; agent.json and the journal record it", async () => {
    env = await makeSpawnEnv();
    const dir = profile(true);
    const prepared: string[] = [];
    env.deps.prepareAccount = async (a) => {
      prepared.push(a.id);
    };
    const out = await spawnAgent(env.request({ account: { id: "work", dir } }), env.deps);
    expect(out.kind).toBe("launched");
    const script = readFileSync(join(env.worktree, ".volley", "launch.sh"), "utf-8");
    expect(script).toContain(`export CLAUDE_CONFIG_DIR='${dir}'`);
    const agent = JSON.parse(readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"));
    expect(agent.claude_account).toBe("work");
    const spawned = env.events.find((e) => e.type === "agent_spawned");
    expect(spawned?.data.claude_account).toBe("work");
    // sharing + MCP sync run before the launch, once per attempt
    expect(prepared).toEqual(["work"]);
  });

  it("the primary: no CLAUDE_CONFIG_DIR, recorded as primary", async () => {
    env = await makeSpawnEnv();
    const out = await spawnAgent(env.request(), env.deps);
    expect(out.kind).toBe("launched");
    const script = readFileSync(join(env.worktree, ".volley", "launch.sh"), "utf-8");
    expect(script).not.toContain("CLAUDE_CONFIG_DIR");
    const agent = JSON.parse(readFileSync(join(env.worktree, ".volley", "agent.json"), "utf-8"));
    expect(agent.claude_account).toBe("primary");
  });

  it("folder trust is read from the profile's own .claude.json", async () => {
    // Trusted in the primary (makeSpawnEnv), not in the profile → the profile's question.
    env = await makeSpawnEnv();
    const dir = profile(false);
    const out = await spawnAgent(env.request({ account: { id: "work", dir } }), env.deps);
    expect(out.kind).toBe("decision");
    const opened = env.events.find((e) => e.type === "decision_opened");
    expect(opened?.data).toMatchObject({
      kind: "repo_untrusted",
      repo: env.repo,
      claude_config_dir: dir,
    });
  });

  it("a resume note is appended to the brief", async () => {
    env = await makeSpawnEnv();
    const dir = profile(true);
    await spawnAgent(
      env.request({ account: { id: "work", dir }, resumeNote: "## Resume\n\nPick up here." }),
      env.deps,
    );
    const brief = readFileSync(join(env.worktree, ".volley", "brief.md"), "utf-8");
    expect(brief.trimEnd().endsWith("## Resume\n\nPick up here.")).toBe(true);
  });

  it("a failed profile preparation refuses the spawn", async () => {
    env = await makeSpawnEnv();
    const dir = profile(true);
    env.deps.prepareAccount = async () => {
      throw new Error("lock held");
    };
    await expect(
      spawnAgent(env.request({ account: { id: "work", dir } }), env.deps),
    ).rejects.toMatchObject({ code: "CLAUDE_ACCOUNT_PREPARE_FAILED" });
    expect(env.events.find((e) => e.type === "alarm_raised")?.data.code).toBe(
      "CLAUDE_ACCOUNT_PREPARE_FAILED",
    );
  });

  it("an account move of a reviewer continues in its earlier attempt's worktree and inputs", async () => {
    env = await makeSpawnEnv();
    const dir = profile(true);
    const first = join(env.dir, "wt", "w1", "T1-spec_reviewer-1");
    mkdirSync(join(first, ".volley"), { recursive: true });
    writeFileSync(join(first, ".volley", "review.md"), "# review the head\n");
    const out = await spawnAgent(
      env.request({
        role: "spec_reviewer",
        attempt: 2,
        start: { ref: "abc123", detach: true },
        worktreeAttempt: 1,
        account: { id: "work", dir },
        resumeNote: "## Resume",
      }),
      env.deps,
    );
    expect(out.kind).toBe("launched");
    expect(env.host.worktrees.at(-1)).toMatchObject({ path: first, base: "abc123", detach: true });
    expect(readFileSync(join(first, ".volley", "review.md"), "utf-8")).toBe("# review the head\n");
    expect(readFileSync(join(first, ".volley", "launch.sh"), "utf-8")).toContain(
      `export CLAUDE_CONFIG_DIR='${dir}'`,
    );
    const spawned = env.events.find((e) => e.type === "agent_spawned");
    expect(spawned?.data).toMatchObject({
      attempt: 2,
      worktree_attempt: 1,
      start: "abc123",
      detached: true,
      worktree: first,
    });
  });

  it("a profile in the DEFAULT root (~/.volley/claude/<acct>) passes the real fence", async () => {
    // The owner's smoke: every spawn under a profile there was FENCE_DENIED (launch.sh), because
    // the fence refused any CLAUDE_CONFIG_DIR with a `.volley` segment.
    env = await makeSpawnEnv();
    await withEnv({ HOME: env.home, VOLLEY_CLAUDE_DIR: undefined }, async () => {
      const dir = profileDir(claudeRoot(), "work");
      expect(dir).toBe(join(env.home, ".volley", "claude", "work"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, ".claude.json"),
        JSON.stringify({ projects: { [env.repo]: { hasTrustDialogAccepted: true } } }),
      );
      const out = await spawnAgent(env.request({ account: { id: "work", dir } }), env.deps);
      expect(out.kind).toBe("launched");
      const script = readFileSync(join(env.worktree, ".volley", "launch.sh"), "utf-8");
      expect(script).toContain(`export CLAUDE_CONFIG_DIR='${dir}'`);
      expect(env.events.some((e) => e.type === "agent_spawned")).toBe(true);
    });
  });
});
