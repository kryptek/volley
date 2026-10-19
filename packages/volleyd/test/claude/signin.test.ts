import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAccount, profileDir, readRegistry } from "../../src/claude/profiles";
import {
  type SigninEvent,
  parseAuthStatus,
  parseSigninUrl,
  runSignin,
  signinDir,
  signinFlow,
  signinSession,
  stripTerminal,
} from "../../src/claude/signin";
import { renderSigninScript } from "../../src/claude/signin-script";
import { FenceError, assertAllowed, sealSigninScript } from "../../src/fence";
import { fakeExec } from "../helpers/fake-exec";

const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/claude/${name}`, import.meta.url), "utf-8");
const PRINTED = parseSigninUrl(fixture("auth-login-tmux.txt"));
const CALLBACK = fixture("browser-url.txt").trim();

describe("parsing claude auth login's output", () => {
  it("finds the printed (manual-code) URL in a tmux capture", () => {
    expect(PRINTED).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?code=true&/);
    expect(PRINTED).toContain("state=REDACTED");
    expect(signinFlow(PRINTED as string)).toBe("manual_code");
  });

  it("strips the OSC-8 hyperlink and SGR escapes of a piped stdout", () => {
    const raw = fixture("auth-login-piped.txt");
    expect(stripTerminal(raw)).not.toContain("\u001b");
    expect(parseSigninUrl(raw)).toBe(PRINTED);
  });

  it("the $BROWSER URL is the localhost-callback flow", () => {
    expect(parseSigninUrl(CALLBACK)).toBe(CALLBACK);
    expect(signinFlow(CALLBACK)).toBe("browser_callback");
  });

  it("no authorize URL → null; a non-https or foreign host is ignored", () => {
    expect(parseSigninUrl("Opening browser to sign in…\n")).toBeNull();
    expect(parseSigninUrl("visit: http://claude.com/cai/oauth/authorize?x=1")).toBeNull();
    expect(parseSigninUrl("visit: https://evil.example.com/oauth/authorize?x=1")).toBeNull();
  });

  it("claude auth status: loggedIn and the plan label, never anything else", () => {
    expect(
      parseAuthStatus(
        JSON.stringify({ loggedIn: true, email: "a@example.com", subscriptionType: "max" }),
      ),
    ).toEqual({ loggedIn: true, plan: "max" });
    expect(parseAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toEqual({ loggedIn: false });
    expect(parseAuthStatus("not json")).toBeNull();
  });
});

describe("the sign-in script and its fence seal", () => {
  const dir = "/srv/claude/.signin/work";
  const script = renderSigninScript({ configDir: "/srv/claude/work", signinDir: dir });

  it("exports the profile dir and the $BROWSER helper, strips credential env, runs auth login", () => {
    expect(script).toContain("export CLAUDE_CONFIG_DIR='/srv/claude/work'");
    expect(script).toContain("export BROWSER='/srv/claude/.signin/work/browser.sh'");
    expect(script).toMatch(
      /unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_SECURESTORAGE_CONFIG_DIR/,
    );
    expect(script.trimEnd().split("\n").at(-1)).toBe("exec claude auth login");
    expect(script).not.toMatch(/setup-token/);
  });

  it("seals only what renderSigninScript renders for that dir", () => {
    expect(() => sealSigninScript(dir, script)).not.toThrow();
    expect(() => sealSigninScript(dir, `${script}echo pwned\n`)).toThrow(FenceError);
    expect(() => sealSigninScript("/elsewhere", script)).toThrow(FenceError);
    const token = sealSigninScript(dir, script);
    const start = [
      "tmux",
      "new-session",
      "-d",
      "-s",
      signinSession("work"),
      "-c",
      dir,
      "bash signin.sh",
    ];
    expect(() => assertAllowed(start, { signin: token })).not.toThrow();
    expect(() => assertAllowed(start)).toThrow(FenceError);
    expect(() => assertAllowed([...start.slice(0, -1), "bash evil.sh"], { signin: token })).toThrow(
      FenceError,
    );
  });

  it("the fence lets volleyd read only claude auth status", () => {
    expect(() => assertAllowed(["claude", "auth", "status"])).not.toThrow();
    expect(() => assertAllowed(["claude", "setup-token"])).toThrow(FenceError);
    expect(() => assertAllowed(["claude", "auth", "login"])).toThrow(FenceError);
    expect(() => assertAllowed(["claude", "auth", "status", "--text"])).toThrow(FenceError);
  });

  it("local tmux reads and kills only sign-in sessions", () => {
    const s = signinSession("work");
    expect(() => assertAllowed(["tmux", "capture-pane", "-p", "-J", "-t", s])).not.toThrow();
    expect(() => assertAllowed(["tmux", "has-session", "-t", s])).not.toThrow();
    expect(() => assertAllowed(["tmux", "kill-session", "-t", s])).not.toThrow();
    expect(() => assertAllowed(["tmux", "kill-session", "-t", "agent-1"])).toThrow(FenceError);
    expect(() => assertAllowed(["tmux", "send-keys", "-t", s, "-l", "--", "code"])).toThrow(
      FenceError,
    );
  });
});

/** A fake world: tmux runs the sign-in, $BROWSER writes the url file, auth status flips. */
function world(opts: { browser?: boolean; signInAfter?: number; exitAfter?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "volley-signin-"));
  addAccount(root, { label: "work" }, "2026-10-18T12:00:00.000Z");
  let polls = 0;
  const fx = fakeExec()
    .on(["tmux", "new-session"], () => {
      if (opts.browser !== false) writeFileSync(join(signinDir(root, "work"), "url"), CALLBACK);
      return {};
    })
    .on(["tmux", "capture-pane"], () => ({ stdout: fixture("auth-login-tmux.txt") }))
    .on(["tmux", "has-session"], () => ({
      code: opts.exitAfter !== undefined && polls >= opts.exitAfter ? 1 : 0,
    }))
    .on(["claude", "auth", "status"], () => {
      polls++;
      const done = opts.signInAfter !== undefined && polls >= opts.signInAfter;
      return done
        ? { stdout: JSON.stringify({ loggedIn: true, subscriptionType: "max" }) }
        : { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
    });
  const events: SigninEvent[] = [];
  let clock = 0;
  const run = () =>
    runSignin({
      exec: fx.exec,
      root,
      acct: "work",
      publish: async (e) => {
        events.push(e);
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      pollMs: 1000,
      timeoutMs: 10_000,
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test", HOME: "/path/to/home" },
    });
  return { root, fx, events, run };
}

describe("runSignin", () => {
  it("starts claude auth login in a fenced tmux session under the profile", async () => {
    const w = world({ signInAfter: 2 });
    await w.run();
    const start = w.fx.argvs(["tmux", "new-session"])[0];
    expect(start).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "volley-signin-work",
      "-c",
      signinDir(w.root, "work"),
      "bash signin.sh",
    ]);
    const script = readFileSync(join(signinDir(w.root, "work"), "signin.sh"), "utf-8");
    expect(script).toContain(`export CLAUDE_CONFIG_DIR='${profileDir(w.root, "work")}'`);
    expect(statSync(signinDir(w.root, "work")).mode & 0o777).toBe(0o700);
  });

  it("publishes claude_signin_url with the $BROWSER (localhost-callback) URL, then done", async () => {
    const w = world({ signInAfter: 3 });
    const last = await w.run();
    expect(w.events[0]).toEqual({
      type: "claude_signin_url",
      acct: "work",
      url: CALLBACK,
      flow: "browser_callback",
      attach: "tmux attach -t volley-signin-work",
    });
    expect(w.events.filter((e) => e.type === "claude_signin_url")).toHaveLength(1);
    expect(last).toEqual({ type: "claude_signin_done", acct: "work", plan: "max" });
    expect(w.events.at(-1)).toEqual(last);
    expect(readRegistry(w.root).accounts[0]).toMatchObject({ id: "work", plan: "max" });
    // The URL is dropped once done, and the session is gone.
    expect(existsSync(join(signinDir(w.root, "work"), "url"))).toBe(false);
    expect(w.fx.argvs(["tmux", "kill-session"]).length).toBeGreaterThan(0);
  });

  it("auth status runs under the profile with the credential env stripped", async () => {
    const w = world({ signInAfter: 1 });
    await w.run();
    const call = w.fx.calls.find((c) => c.argv[0] === "claude");
    expect(call?.opts.env?.CLAUDE_CONFIG_DIR).toBe(profileDir(w.root, "work"));
    expect(call?.opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call?.opts.env?.PATH).toBe("/usr/bin");
  });

  it("without a $BROWSER call, falls back to the printed URL and the attach hint", async () => {
    const w = world({ browser: false, signInAfter: 4 });
    await w.run();
    expect(w.events[0]).toMatchObject({
      type: "claude_signin_url",
      url: PRINTED,
      flow: "manual_code",
      attach: "tmux attach -t volley-signin-work",
    });
  });

  it("the login exiting before sign-in → claude_signin_failed", async () => {
    const w = world({ exitAfter: 2 });
    const last = await w.run();
    expect(last).toMatchObject({ type: "claude_signin_failed", acct: "work" });
    expect(readRegistry(w.root).accounts[0]?.signed_in_at).toBeUndefined();
  });

  it("times out, kills the session and fails", async () => {
    const w = world();
    const last = await w.run();
    expect(last).toMatchObject({
      type: "claude_signin_failed",
      reason: expect.stringMatching(/timed out/),
    });
    expect(w.fx.argvs(["tmux", "kill-session"]).length).toBeGreaterThan(0);
  });

  it("no tmux → fails with the run-it-yourself command", async () => {
    const w = world();
    const last = await runSignin({
      exec: async () => {
        throw Object.assign(new Error("spawn tmux ENOENT"), { code: "ENOENT" });
      },
      root: w.root,
      acct: "work",
      publish: async () => {},
      sleep: async () => {},
      now: () => 0,
      pollMs: 1,
      timeoutMs: 1,
      env: {},
    });
    expect(last).toMatchObject({ type: "claude_signin_failed" });
    expect((last as { reason: string }).reason).toContain(
      `CLAUDE_CONFIG_DIR=${profileDir(w.root, "work")} claude auth login`,
    );
  });
});
