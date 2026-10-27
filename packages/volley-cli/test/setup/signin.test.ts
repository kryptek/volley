import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { realSetupDeps, setup } from "../../src/commands/setup";
import { makeBufferIO } from "../../src/io";
import {
  CLAUDE_INSTALL,
  CLAUDE_LOGIN,
  GH_API_USER,
  GH_LOGIN,
  GH_SETUP_GIT,
  GH_USER,
  GIT_IDENT_PROBE,
  identityFromGhUser,
  identityOf,
  maskLogin,
  planGitIdentity,
  planSignin,
  simulatedExec,
} from "../../src/setup/signin";
import { setupFence } from "../../src/setup/step";
import { type FakeDynsec, startFakeDynsec } from "../helpers/fake-dynsec";
import { type FakeMachine, NOW, OCTO_IDENTITY, fakeMachine } from "../helpers/setup-machine";
import { tempDir } from "../helpers/tmp";

describe("git's commit identity, the pure parts", () => {
  it("identityFromGhUser: the account's name and its noreply address; the login without a name", () => {
    const sim = { login: "volley-sim", id: 1, name: "Volley Sim" };
    expect(identityFromGhUser(JSON.stringify(sim))).toEqual({
      name: "Volley Sim",
      email: "1+volley-sim@users.noreply.github.com",
    });
    for (const name of [null, "", "   "]) {
      expect(identityFromGhUser(JSON.stringify({ ...sim, name }))?.name).toBe("volley-sim");
    }
    expect(identityFromGhUser(JSON.stringify({ ...sim, name: "  Volley Sim " }))?.name).toBe(
      "Volley Sim",
    );
    expect(identityFromGhUser(JSON.stringify({ login: "volley-sim", name: "x" }))).toBeNull();
    expect(identityFromGhUser(JSON.stringify({ ...sim, id: "1" }))).toBeNull();
    expect(identityFromGhUser(JSON.stringify({ ...sim, login: "volley_sim" }))).toBeNull();
    expect(identityFromGhUser("not json")).toBeNull();
  });

  it("identityOf: `git var GIT_COMMITTER_IDENT` without its timestamp and zone", () => {
    expect(
      identityOf("Volley Sim <1+volley-sim@users.noreply.github.com> 1760000000 +0000\n"),
    ).toBe("Volley Sim <1+volley-sim@users.noreply.github.com>");
    expect(identityOf("")).toBeNull();
  });
});

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

  it("simulated (--simulated or VOLLEY_SIMULATED=1): git's credential helper is not asked for", async () => {
    // The fake `gh auth setup-git` writes no git config, so a fresh machine never verified.
    rmSync(join(m.ctx.home, ".gitconfig"));
    for (const sim of [
      { ...m.ctx, firstWave: { simulated: true } },
      { ...m.ctx, auth: { ...m.ctx.auth, env: { ...m.ctx.auth.env, VOLLEY_SIMULATED: "1" } } },
    ]) {
      const plan = await planSignin(sim);
      expect(plan.changes.map((c) => c.summary)).not.toContain(
        "Let git push with your GitHub login (gh auth setup-git)",
      );
      expect(plan.row).toContain("✓ GitHub: signed in as o•••");
    }
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

  describe("git's commit identity", () => {
    const SUMMARY =
      'Give git a commit identity from your GitHub account: user.name "Octo Volley", user.email 1+octo-volley@users.noreply.github.com (git config --global)';
    const ran = (argv: readonly string[]) =>
      m.execCalls.filter((a) => a.join(" ") === argv.join(" "));
    const gitConfigs = () => m.execCalls.filter((a) => a[0] === "git" && a[1] === "config");

    it("none, gh signed in: one change named with the account's values; applied, verified, rerun is empty", async () => {
      const today = await planSignin({ ...m.ctx, check: true });
      m.git.identity = null;
      const plan = await planSignin(m.ctx);
      expect(plan.found).toContain("git has no commit identity (user.name/user.email)");
      expect(plan.changes).toHaveLength(today.changes.length + 1);
      const change = plan.changes.find((c) => c.summary.startsWith("Give git"));
      expect(change?.summary).toBe(SUMMARY);
      expect(change?.detail).toContain('git config --global user.name "Octo Volley"');
      expect(change?.detail).toContain(
        "git config --global user.email 1+octo-volley@users.noreply.github.com",
      );
      expect(plan.row).toContain("git has no commit identity (user.name/user.email)");
      expect(gitConfigs()).toEqual([]);
      await change?.apply();
      expect(gitConfigs()).toEqual([
        ["git", "config", "--global", "user.name", "Octo Volley"],
        ["git", "config", "--global", "user.email", "1+octo-volley@users.noreply.github.com"],
      ]);
      const i = m.execCalls.findIndex((a) => a[0] === "git" && a[1] === "config");
      expect(m.execEnvs[i]?.HOME).toBe(m.ctx.home);
      expect(m.execEnvs[i]?.GIT_TERMINAL_PROMPT).toBe("0");
      const gitconfig = readFileSync(join(m.ctx.home, ".gitconfig"), "utf-8");
      expect(gitconfig).toContain("name = Octo Volley");
      expect(gitconfig).toContain("email = 1+octo-volley@users.noreply.github.com");
      for (const c of plan.changes) if (c !== change) await c.apply();
      expect((await plan.verify?.()) ?? []).toEqual([]);
      const again = await planSignin(m.ctx);
      expect(again.changes).toEqual([]);
      expect(again.row).toContain(`✓ git commits as ${OCTO_IDENTITY}`);
    });

    it("#631: no global identity, a clone with its own: plans the global write only, never touches the clone", async () => {
      const clone = join(m.ctx.home, "work", "repo");
      const REPO_ID = "Repo Level <1+repo@users.noreply.github.com>";
      m.git.identity = null;
      m.git.clones[clone] = REPO_ID;
      const plan = await planSignin(m.ctx);
      const ids = plan.changes.filter((c) => c.summary.startsWith("Give git"));
      expect(ids.map((c) => c.summary)).toEqual([SUMMARY]);
      await ids[0]?.apply();
      expect(gitConfigs()).toEqual([
        ["git", "config", "--global", "user.name", "Octo Volley"],
        ["git", "config", "--global", "user.email", "1+octo-volley@users.noreply.github.com"],
      ]);
      const scoped = m.execCalls.filter(
        (a) => a[0] === "git" && (a.includes("--local") || (a[1] === "-C" && a.includes("config"))),
      );
      expect(scoped).toEqual([]);
      expect(m.git.clones[clone]).toBe(REPO_ID);
      for (const c of plan.changes) if (!ids.includes(c)) await c.apply();
      const again = await planSignin(m.ctx);
      expect(again.changes).toEqual([]);
    });

    it("none, gh signed out: the GitHub sign-in first, then the identity, read after the sign-in", async () => {
      m.git.identity = null;
      m.gh.signedIn = false;
      const plan = await planSignin(m.ctx);
      const summaries = plan.changes.map((c) => c.summary);
      const signin = summaries.findIndex((s) => s.startsWith("Sign in to GitHub"));
      const identity = summaries.findIndex((s) => s.startsWith("Give git"));
      expect(signin).toBe(0);
      expect(identity).toBeGreaterThan(signin);
      expect(summaries[identity]).toBe(
        "Give git a commit identity from your GitHub account once signed in (user.name from its name, user.email its noreply address; git config --global)",
      );
      expect(ran(GH_API_USER)).toEqual([]);
      for (const c of plan.changes) await c.apply();
      expect(ran(GH_API_USER)).toHaveLength(1);
      expect(m.git.identity).toBe(OCTO_IDENTITY);
      expect(m.questions).toEqual([]);
    });

    it("none, and the sign-in left gh signed out: the identity's apply says to sign in first", async () => {
      m.git.identity = null;
      m.gh.signedIn = false;
      const plan = await planSignin(m.ctx);
      const change = plan.changes.find((c) => c.summary.startsWith("Give git"));
      await expect(change?.apply()).rejects.toThrow(/gh auth login --web/);
      expect(gitConfigs()).toEqual([]);
    });

    it("none, gh not installed: reported, with nothing to derive one from (no change)", async () => {
      m.git.identity = null;
      m.gh.installed = false;
      const plan = await planSignin(m.ctx);
      expect(plan.found).toContain("git has no commit identity (user.name/user.email)");
      expect(plan.row).toContain(
        "git has no commit identity (user.name/user.email): set one (git config --global user.name …; … user.email …) or install gh and rerun",
      );
      expect(plan.changes.some((c) => c.summary.startsWith("Give git"))).toBe(false);
    });

    it("present: no change, the ✓ row, and the account is not read", async () => {
      const plan = await planSignin(m.ctx);
      expect(plan.changes.some((c) => c.summary.startsWith("Give git"))).toBe(false);
      expect(plan.row).toContain(`✓ git commits as ${OCTO_IDENTITY}`);
      expect(ran(GIT_IDENT_PROBE)).toHaveLength(1);
      const i = m.execCalls.findIndex((a) => a.join(" ") === GIT_IDENT_PROBE.join(" "));
      expect(m.execEnvs[i]?.HOME).toBe(m.ctx.home);
      expect(ran(GH_API_USER)).toEqual([]);
    });

    it("--check: pending with the change's summary, nothing written", async () => {
      m.git.identity = null;
      const plan = await planSignin({ ...m.ctx, check: true });
      expect(plan.changes.map((c) => c.summary)).toContain(SUMMARY);
      expect(gitConfigs()).toEqual([]);
    });
  });

  describe("--git-identity (planGitIdentity): the identity alone (#595)", () => {
    it("Claude Code signed out: only the identity's change, no sign-in, nothing of Claude Code's", async () => {
      m.git.identity = null;
      m.claude.signedIn = false;
      const plan = await planGitIdentity(m.ctx);
      expect(plan.skipped).toBeUndefined();
      expect(plan.changes.map((c) => c.summary)).toEqual([
        'Give git a commit identity from your GitHub account: user.name "Octo Volley", user.email 1+octo-volley@users.noreply.github.com (git config --global)',
      ]);
      expect(m.execCalls.some((a) => a[0] === "claude")).toBe(false);
      await plan.changes[0]?.apply();
      expect(m.git.identity).toBe(OCTO_IDENTITY);
      expect((await plan.verify?.()) ?? []).toEqual([]);
      expect(existsSync(m.settingsFile)).toBe(false);
    });

    it("Claude Code not installed: not blocked, the identity all the same", async () => {
      m.git.identity = null;
      m.claude.installed = false;
      const plan = await planGitIdentity(m.ctx);
      expect(plan.blocked).toBeUndefined();
      expect(plan.changes).toHaveLength(1);
    });

    it("gh signed out: skipped with the sign-in to run first, nothing applied", async () => {
      m.git.identity = null;
      m.gh.signedIn = false;
      const plan = await planGitIdentity(m.ctx);
      expect(plan.skipped).toContain("gh auth login --web");
      expect(plan.changes).toEqual([]);
    });

    it("present: nothing to change, the ✓ row", async () => {
      const plan = await planGitIdentity(m.ctx);
      expect(plan.changes).toEqual([]);
      expect(plan.row).toBe(`✓ git commits as ${OCTO_IDENTITY}`);
    });
  });

  it("under VOLLEY_SIMULATED=1 the fakes answer the sign-ins and nothing opens", async () => {
    const deps = realSetupDeps({ VOLLEY_SIMULATED: "1", PATH: "" });
    expect((await deps.exec(["claude", "auth", "status"])).stdout).toContain('"loggedIn":true');
    expect((await deps.exec([...CLAUDE_LOGIN], { tty: true })).code).toBe(0);
    expect((await deps.exec([...GH_LOGIN], { tty: true })).code).toBe(0);
    expect((await deps.exec(["gh", "auth", "status"])).code).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  it("simulated, the account is volley-sim's; git's commands go through to the machine", async () => {
    const sim = simulatedExec(m.deps.exec);
    expect(JSON.parse((await sim([...GH_API_USER])).stdout)).toEqual({
      login: "volley-sim",
      id: 1,
      name: "Volley Sim",
    });
    expect((await sim([...GH_USER])).stdout).toBe("volley-sim\n");
    m.git.identity = null;
    expect((await sim([...GIT_IDENT_PROBE])).code).toBe(128);
    await sim(["git", "config", "--global", "user.name", "Volley Sim"]);
    expect(m.execCalls).toContainEqual([...GIT_IDENT_PROBE]);
    expect(m.execCalls).toContainEqual(["git", "config", "--global", "user.name", "Volley Sim"]);
  });
});
