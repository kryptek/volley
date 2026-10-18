import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalCmuxHost } from "../src/hosts/local-cmux";
import { HOOKS_DIR, LAUNCH_COMMAND, hooksSettingsPath, renderLaunchScript } from "../src/launch";
import { spawnAgent } from "../src/spawn";
import { type SpawnEnv, makeSpawnEnv } from "./helpers/fake-host";

describe("launch.sh", () => {
  const script = renderLaunchScript({
    hooksDir: "/opt/volley/packages/volley-hooks",
    model: "claude-opus-5-5",
    agentId: "w1-t1-implementer-1",
  });

  it("is a bash script that exports VOLLEY_HOOKS_DIR and passes the hooks via --settings", () => {
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain("export VOLLEY_HOOKS_DIR='/opt/volley/packages/volley-hooks'");
    expect(script).toContain(
      "--settings '/opt/volley/packages/volley-hooks/settings.volley-hooks.json'",
    );
    expect(script).toContain("--model 'claude-opus-5-5'");
    expect(script).toContain("--name 'w1-t1-implementer-1'");
    expect(script).toContain('"$(cat .volley/brief.md)"');
    expect(script).not.toContain("--mcp-config");
  });

  it("the hooks settings template exists where HOOKS_DIR points", () => {
    expect(JSON.parse(readFileSync(hooksSettingsPath(HOOKS_DIR), "utf-8")).hooks).toBeDefined();
  });
});

describe("launch (local cmux host)", () => {
  let env: SpawnEnv;
  afterEach(() => env.cleanup());

  async function launchWithCmux() {
    env = await makeSpawnEnv();
    const fake = env.host.fake
      .on(["git", "-C", env.repo, "rev-parse", "--git-common-dir"], { stdout: ".git\n" })
      .on(["cmux", "new-workspace"], { stdout: "OK workspace:7\n" });
    env.deps.host = new LocalCmuxHost(fake.exec);
    const out = await spawnAgent(env.request(), env.deps);
    return { out, fake };
  }

  it("cmux --command is exactly '  bash .volley/launch.sh' and no argv carries the brief", async () => {
    const { out, fake } = await launchWithCmux();
    expect(out.kind).toBe("launched");
    if (out.kind === "launched") expect(out.workspace).toBe("workspace:7");
    const cmux = fake.argvs(["cmux", "new-workspace"]);
    expect(cmux).toEqual([
      [
        "cmux",
        "new-workspace",
        "--cwd",
        env.worktree,
        "--name",
        "w1 T1 implementer",
        "--command",
        "  bash .volley/launch.sh",
      ],
    ]);
    expect(LAUNCH_COMMAND).toBe("  bash .volley/launch.sh");
    const brief = readFileSync(join(env.worktree, ".volley", "brief.md"), "utf-8");
    const line = brief.split("\n").find((l) => l.includes("Volley protocol")) as string;
    for (const c of fake.calls) {
      expect(c.argv.join("\n")).not.toContain(line);
      expect(c.argv).not.toContain("--mcp-config");
    }
    // nothing but the launch command is ever typed into the pane
    expect(fake.argvs(["cmux", "send"])).toEqual([]);
    expect(fake.argvs(["cmux", "send-key"])).toEqual([]);
  });

  it("cuts the worktree from the release branch and keeps .volley/ out of git", async () => {
    const { out, fake } = await launchWithCmux();
    expect(fake.argvs(["git", "-C", env.repo, "worktree", "add"])).toEqual([
      [
        "git",
        "-C",
        env.repo,
        "worktree",
        "add",
        env.worktree,
        "-b",
        "w1/T1-implementer-1",
        "release/w1",
      ],
    ]);
    const exclude = readFileSync(join(env.repo, ".git", "info", "exclude"), "utf-8");
    expect(exclude.split("\n")).toContain(".volley/");
    // once only, however often agents are spawned into the repo
    if (out.kind === "launched") out.lock.release();
    fake
      .on(["git", "-C", env.worktree, "rev-parse", "--is-inside-work-tree"], { stdout: "true\n" })
      .on(["git", "-C", env.worktree, "rev-parse", "--abbrev-ref", "HEAD"], {
        stdout: "w1/T1-implementer-1\n",
      });
    expect((await spawnAgent(env.request({ attempt: 2 }), env.deps)).kind).toBe("launched");
    // a reused worktree reports the branch it really has
    const reused = env.events.filter((e) => e.type === "agent_spawned").at(-1);
    expect(reused?.data).toMatchObject({ worktree_reused: true, branch: "w1/T1-implementer-1" });
    expect(fake.argvs(["git", "-C", env.repo, "worktree", "add"])).toHaveLength(1);
    const again = readFileSync(join(env.repo, ".git", "info", "exclude"), "utf-8");
    expect(again.split("\n").filter((l) => l === ".volley/")).toHaveLength(1);
  });

  it("launch.sh, run by bash, execs claude with the brief as one positional argument", async () => {
    await launchWithCmux();
    // A stand-in claude that records its argv and env.
    const bin = join(env.dir, "bin");
    mkdirSync(bin);
    const record = join(env.dir, "claude-args");
    writeFileSync(
      join(bin, "claude"),
      `#!/usr/bin/env bash\nprintf '%s\\0' "$VOLLEY_HOOKS_DIR" "$@" > ${JSON.stringify(record)}\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    execFileSync("bash", [".volley/launch.sh"], {
      cwd: env.worktree,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: env.dir },
    });
    const [hooksDir, ...args] = readFileSync(record, "utf-8").split("\0").slice(0, -1);
    const brief = readFileSync(join(env.worktree, ".volley", "brief.md"), "utf-8");
    expect(hooksDir).toBe("/opt/volley/packages/volley-hooks");
    expect(args).toEqual([
      "--dangerously-skip-permissions",
      "--model",
      "claude-opus-5-5",
      "--settings",
      "/opt/volley/packages/volley-hooks/settings.volley-hooks.json",
      "--name",
      "w1-t1-implementer-1",
      brief.replace(/\n+$/, ""), // $(…) strips trailing newlines
    ]);
  });
});
