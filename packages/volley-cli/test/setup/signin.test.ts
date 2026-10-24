import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSetupDeps, setup } from "../../src/commands/setup";
import { makeBufferIO } from "../../src/io";
import {
  CLAUDE_INSTALL,
  CLAUDE_LOGIN,
  GH_LOGIN,
  GH_SETUP_GIT,
  maskLogin,
  planSignin,
} from "../../src/setup/signin";
import { setupFence } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, NOW, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

describe("the Sign-ins step", () => {
  let dir: string;
  let fake: FakeDynsec;
  let m: FakeMachine;
  beforeEach(async () => {
    dir = tempDir("volley-signin-");
    fake = await startFakeDynsec();
    m = fakeMachine(fake, dir);
  });
  afterEach(async () => {
    await fake.close();
  });

  const apply = async () => {
    const plan = await planSignin(m.ctx);
    const lines: string[] = [];
    for (const c of plan.changes) lines.push(...(await c.apply()));
    return { plan, lines, problems: (await plan.verify?.()) ?? [] };
  };
  const ttyCalls = () => m.execCalls.filter((a) => a[1] === "auth" && a[2] === "login");

  it("blocks when Claude Code is missing, naming the installer", async () => {
    m.claude.installed = false;
    const plan = await planSignin(m.ctx);
    expect(plan.blocked).toContain(CLAUDE_INSTALL);
    expect(plan.changes).toEqual([]);
  });

  it("signed out of Claude Code: one change that runs `claude auth login` on the terminal, counted as a sign-in", async () => {
    m.claude.signedIn = false;
    let signIns = 0;
    m.ctx.metrics = { signIn: () => signIns++ };
    const plan = await planSignin(m.ctx);
    expect(plan.found).toContain("Claude Code: not signed in");
    expect(plan.changes.map((c) => c.summary)).toEqual([
      "Sign in to Claude Code (opens your browser)",
      expect.stringContaining("permissions.additionalDirectories"),
    ]);
    // Planning ran no login.
    expect(ttyCalls()).toEqual([]);
    await plan.changes[0]?.apply();
    expect(m.execCalls).toContainEqual([...CLAUDE_LOGIN]);
    const i = m.execCalls.findIndex((a) => a.join(" ") === CLAUDE_LOGIN.join(" "));
    expect(m.execEnvs[i]).toBeUndefined();
    expect(signIns).toBe(1);
    expect(m.questions).toEqual([]);
  });

  it("signed in: ✓ Claude Code: signed in (<plan>), the e-mail only with --show-email", async () => {
    writeFileSync(
      m.claudeJson,
      JSON.stringify({
        oauthAccount: { emailAddress: "Owner@Example.com" },
        hasCompletedOnboarding: true,
      }),
    );
    const plan = await planSignin(m.ctx);
    expect(plan.row).toContain("✓ Claude Code: signed in (max)");
    expect(JSON.stringify(plan)).not.toContain("example.com");
    m.ctx.showEmail = true;
    const shown = await planSignin(m.ctx);
    expect(shown.row).toContain("✓ Claude Code: signed in (max, owner@example.com)");
    // The first-run screens are reported, never written here.
    expect(plan.row).toContain("✓ first-run screens answered");
    expect(plan.changes.some((c) => /first-run|onboarding/i.test(c.summary))).toBe(false);
  });

  it("GitHub signed out: one change, `gh auth login --web --git-protocol https` then `gh auth setup-git`", async () => {
    m.gh.signedIn = false;
    rmSync(join(m.ctx.home, ".gitconfig"));
    const plan = await planSignin(m.ctx);
    const gh = plan.changes.filter((c) => c.summary.includes("GitHub"));
    expect(gh).toHaveLength(1);
    await gh[0]?.apply();
    const at = (argv: readonly string[]) =>
      m.execCalls.findIndex((a) => a.join(" ") === argv.join(" "));
    expect(at(GH_LOGIN)).toBeGreaterThanOrEqual(0);
    expect(at(GH_SETUP_GIT)).toBeGreaterThan(at(GH_LOGIN));
  });

  it("GitHub signed in but git not using it: only setup-git; the login is masked", async () => {
    rmSync(join(m.ctx.home, ".gitconfig"));
    const plan = await planSignin(m.ctx);
    expect(plan.changes.map((c) => c.summary)).toContain(
      "Let git push with your GitHub login (gh auth setup-git)",
    );
    expect(plan.changes.some((c) => c.summary.startsWith("Sign in to GitHub"))).toBe(false);
    expect(plan.found).toContain("GitHub: signed in as o•••");
    expect(JSON.stringify(plan.found)).not.toContain("octo-volley");
    expect(maskLogin("octo-volley")).toBe("o•••");
  });

  it("adds the checkout to permissions.additionalDirectories (diff shown, the old file backed up); present: done", async () => {
    const settings = m.settingsFile;
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(
      settings,
      `${JSON.stringify({ theme: "dark", permissions: { allow: ["Bash"] } }, null, 2)}\n`,
    );
    const plan = await planSignin(m.ctx);
    const change = plan.changes.find((c) => c.summary.includes("additionalDirectories"));
    expect(change?.detail).toContain(`+      "${m.deps.repoRoot}"`);
    await change?.apply();
    const after = JSON.parse(readFileSync(settings, "utf-8"));
    expect(after).toEqual({
      theme: "dark",
      permissions: { allow: ["Bash"], additionalDirectories: [m.deps.repoRoot] },
    });
    expect(readdirSync(dirname(settings)).some((f) => f.startsWith("settings.json.bak-"))).toBe(
      true,
    );
    const again = await planSignin(m.ctx);
    expect(again.changes).toEqual([]);
    expect(again.row).toContain(`✓ Claude Code may read the Volley checkout (${m.deps.repoRoot})`);
  });

  it("everything signed in: applies, verifies, and a rerun plans nothing", async () => {
    const { problems } = await apply();
    expect(problems).toEqual([]);
    expect((await planSignin(m.ctx)).changes).toEqual([]);
  });

  it("--yes with nobody at the terminal and a sign-in pending: skipped, saying sign in then rerun (never hangs)", async () => {
    m.claude.signedIn = false;
    m.deps.interactive = false;
    m.ctx.yes = true;
    const plan = await planSignin(m.ctx);
    expect(plan.skipped).toMatch(/sign in .* then rerun `volley setup`/);
    expect(ttyCalls()).toEqual([]);
    // --check reports it pending instead.
    m.ctx.check = true;
    const checked = await planSignin(m.ctx);
    expect(checked.skipped).toBeUndefined();
    expect(checked.changes[0]?.summary).toBe("Sign in to Claude Code (opens your browser)");
  });

  it("the setup command runs a sign-in through the fence, with the terminal handed over", async () => {
    m.claude.signedIn = false;
    const io = makeBufferIO({ now: () => new Date(NOW) });
    const tty: boolean[] = [];
    const exec = m.deps.exec;
    m.deps.exec = async (argv, opts) => {
      if (argv.join(" ") === CLAUDE_LOGIN.join(" ")) tty.push(opts?.tty === true);
      return exec(argv, opts);
    };
    const env = {
      HOME: m.ctx.home,
      VOLLEYD_HOME: m.ctx.volleydHome,
      VOLLEY_AUTH_DIR: m.layout.authDir,
      VOLLEY_BROKER_URL: fake.url,
    };
    expect(await setup({ argv: ["--yes", "--lan"], env, io }, m.deps)).toBe(0);
    expect(tty).toEqual([true]);
    expect(io.readStdout()).toContain("1 sign-in");
  });

  it("the fence allows exactly the sign-ins' commands", () => {
    const fence = setupFence({ restart: "x", repoRoot: "/path/to/repo", bun: "bun" });
    for (const argv of [
      ["claude", "auth", "status"],
      [...CLAUDE_LOGIN],
      ["gh", "auth", "status"],
      [...GH_LOGIN],
      [...GH_SETUP_GIT],
      ["gh", "api", "user", "--jq", ".login"],
    ]) {
      expect(() => fence(argv), argv.join(" ")).not.toThrow();
    }
    for (const argv of [
      ["claude", "auth", "logout"],
      ["gh", "auth", "token"],
      ["gh", "auth", "login", "--with-token"],
      ["gh", "api", "user/emails"],
    ]) {
      expect(() => fence(argv), argv.join(" ")).toThrow(/does not run/);
    }
  });

  it("under VOLLEY_SIMULATED=1 the fakes answer the sign-ins and nothing opens", async () => {
    const deps = realSetupDeps({ VOLLEY_SIMULATED: "1", PATH: "" });
    expect((await deps.exec(["claude", "auth", "status"])).stdout).toContain('"loggedIn":true');
    expect((await deps.exec([...CLAUDE_LOGIN], { tty: true })).code).toBe(0);
    expect((await deps.exec([...GH_LOGIN], { tty: true })).code).toBe(0);
    expect((await deps.exec(["gh", "auth", "status"])).code).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });
});
