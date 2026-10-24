import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAccount, profileDir, readRegistry } from "../../src/claude/profiles";
import {
  SUPERSEDED,
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
import { FenceError, assertAllowed, mintSigninEntryToken, sealSigninScript } from "../../src/fence";
import { fakeExec } from "../helpers/fake-exec";
import { tempDir } from "../helpers/tmp";

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

  it("claude auth status: loggedIn, the plan label and the login's identity, never anything else", () => {
    expect(
      parseAuthStatus(
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "A@Example.com",
          orgId: "0000",
          orgName: "Example Org",
          subscriptionType: "max",
        }),
      ),
    ).toEqual({ loggedIn: true, plan: "max", email: "a@example.com", org: "Example Org" });
    // an e-mail that is not well-formed is left out
    expect(parseAuthStatus(JSON.stringify({ loggedIn: true, email: "not an address" }))).toEqual({
      loggedIn: true,
    });
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

  it("a pasted code is typed into a sign-in session once, only with its entry token", () => {
    const s = signinSession("work");
    const typed = ["tmux", "send-keys", "-t", s, "-l", "--", "abc123#def"];
    expect(() => assertAllowed(["tmux", "send-keys", "-t", s, "Enter"])).not.toThrow();
    expect(() => assertAllowed(["tmux", "send-keys", "-t", "agent-1", "Enter"])).toThrow(
      FenceError,
    );
    expect(() => assertAllowed(typed)).toThrow(FenceError);
    const token = mintSigninEntryToken({ session: s, code: "abc123#def" });
    expect(() => assertAllowed([...typed.slice(0, -1), "other"], { signinEntry: token })).toThrow(
      FenceError,
    );
    expect(() => assertAllowed(typed, { signinEntry: token })).not.toThrow();
    expect(() => assertAllowed(typed, { signinEntry: token })).toThrow(FenceError);
    expect(() => mintSigninEntryToken({ session: "agent-1", code: "abc" })).toThrow(FenceError);
    expect(() => mintSigninEntryToken({ session: s, code: "-rf" })).toThrow(FenceError);
    expect(() => mintSigninEntryToken({ session: s, code: "a b" })).toThrow(FenceError);
  });

  it("a pasted redirect is requested once, exactly, on 127.0.0.1 only", () => {
    const s = signinSession("work");
    const url = "http://127.0.0.1:51051/callback?code=abc&state=xyz";
    const curl = ["curl", "-fsS", "--max-time", "10", url];
    expect(() => assertAllowed(curl)).toThrow(FenceError);
    const token = mintSigninEntryToken({ session: s, url });
    expect(() =>
      assertAllowed([...curl.slice(0, -1), `${url}&x=1`], { signinEntry: token }),
    ).toThrow(FenceError);
    expect(() => assertAllowed(["curl", "-o", "/tmp/x", url], { signinEntry: token })).toThrow(
      FenceError,
    );
    expect(() => assertAllowed(curl, { signinEntry: token })).not.toThrow();
    expect(() => assertAllowed(curl, { signinEntry: token })).toThrow(FenceError);
    for (const bad of [
      "http://evil.example.com:51051/callback?code=abc",
      "http://127.0.0.1:80/callback?code=abc",
      "http://127.0.0.1:51051/callback?code=a'b",
    ])
      expect(() => mintSigninEntryToken({ session: s, url: bad })).toThrow(FenceError);
  });
});

/** A fake world: tmux runs the sign-in, $BROWSER writes the url file, auth status flips. */
function world(opts: { browser?: boolean; signInAfter?: number; exitAfter?: number } = {}) {
  const root = tempDir("volley-signin-");
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
  const run = (signal?: AbortSignal) =>
    runSignin({
      ...(signal !== undefined ? { signal } : {}),
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

  it("publishes claude_signin_url with the printed (code-page) URL first, the $BROWSER one as callback_url, then done", async () => {
    const w = world({ signInAfter: 3 });
    const last = await w.run();
    expect(w.events[0]).toEqual({
      type: "claude_signin_url",
      acct: "work",
      url: PRINTED,
      flow: "manual_code",
      manual_url: PRINTED,
      callback_url: CALLBACK,
      code_prompt: true,
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

  it("done carries the login's email and org from the profile's .claude.json, nothing else of it", async () => {
    const w = world({ signInAfter: 2 });
    writeFileSync(
      join(profileDir(w.root, "work"), ".claude.json"),
      JSON.stringify({
        userID: "c0ffee",
        oauthAccount: {
          accountUuid: "11111111-2222-3333-4444-555555555555",
          emailAddress: "Owner@Example.com",
          organizationName: "Example Org",
        },
        mcpServers: { volley: { env: { TOKEN: "secret" } } },
      }),
    );
    const last = await w.run();
    expect(last).toEqual({
      type: "claude_signin_done",
      acct: "work",
      plan: "max",
      email: "owner@example.com",
      org: "Example Org",
    });
    expect(readRegistry(w.root).accounts[0]).toMatchObject({
      plan: "max",
      email: "owner@example.com",
      org: "Example Org",
    });
    const published = JSON.stringify(w.events);
    for (const key of ["userID", "accountUuid", "mcpServers", "secret"])
      expect(published).not.toContain(key);
  });

  it("auth status runs under the profile with the credential env stripped", async () => {
    const w = world({ signInAfter: 1 });
    await w.run();
    const call = w.fx.calls.find((c) => c.argv[0] === "claude");
    expect(call?.opts.env?.CLAUDE_CONFIG_DIR).toBe(profileDir(w.root, "work"));
    expect(call?.opts.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(call?.opts.env?.PATH).toBe("/usr/bin");
  });

  it("hands the callback URL to onCallback; the event carries no port or state of its own", async () => {
    const w = world({ signInAfter: 3 });
    const seen: string[] = [];
    await runSignin({
      exec: w.fx.exec,
      root: w.root,
      acct: "work",
      publish: async (e) => {
        w.events.push(e);
      },
      sleep: async () => {},
      now: () => 0,
      pollMs: 1,
      timeoutMs: 10_000,
      env: {},
      onCallback: (url) => seen.push(url),
    });
    expect(seen).toEqual([CALLBACK]);
    const url = w.events.find((e) => e.type === "claude_signin_url") as Record<string, unknown>;
    expect(Object.keys(url).sort()).toEqual(
      ["acct", "attach", "callback_url", "code_prompt", "flow", "manual_url", "type", "url"].sort(),
    );
  });

  it("code_prompt follows the screen: published again once `Paste code here` shows", async () => {
    const w = world({ signInAfter: 4 });
    const [urlLine] = fixture("auth-login-tmux.txt").split("\n\n");
    let captures = 0;
    w.fx.on(["tmux", "capture-pane"], () => ({
      stdout: ++captures < 2 ? (urlLine as string) : fixture("auth-login-tmux.txt"),
    }));
    await w.run();
    const urls = w.events.filter((e) => e.type === "claude_signin_url");
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toHaveProperty("code_prompt");
    expect(urls[1]).toMatchObject({ url: PRINTED, code_prompt: true, callback_url: CALLBACK });
  });

  it("only the $BROWSER URL (nothing printed yet): browser_callback at once, the code-page link once printed", async () => {
    const w = world({ signInAfter: 4 });
    let captures = 0;
    w.fx.on(["tmux", "capture-pane"], () => ({
      stdout: ++captures < 3 ? "Opening browser to sign in…\n" : fixture("auth-login-tmux.txt"),
    }));
    await w.run();
    expect(w.events.filter((e) => e.type === "claude_signin_url")).toEqual([
      {
        type: "claude_signin_url",
        acct: "work",
        url: CALLBACK,
        flow: "browser_callback",
        callback_url: CALLBACK,
        attach: "tmux attach -t volley-signin-work",
      },
      {
        type: "claude_signin_url",
        acct: "work",
        url: PRINTED,
        flow: "manual_code",
        manual_url: PRINTED,
        callback_url: CALLBACK,
        code_prompt: true,
        attach: "tmux attach -t volley-signin-work",
      },
    ]);
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

  it("superseded by a newer sign-in: ends without touching its session or publishing", async () => {
    const w = world();
    const abort = new AbortController();
    // The newer sign-in replaces this one while it is inside `claude auth status`.
    w.fx.on(["claude", "auth", "status"], () => {
      abort.abort(SUPERSEDED);
      return { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
    });
    const last = await w.run(abort.signal);
    expect(last).toMatchObject({
      type: "claude_signin_failed",
      reason: expect.stringMatching(/superseded/),
    });
    // Only the start's own replace-the-old-session kill; none after the abort.
    expect(w.fx.argvs(["tmux", "kill-session"])).toHaveLength(1);
    expect(existsSync(join(signinDir(w.root, "work"), "url"))).toBe(true);
    expect(w.events.map((e) => e.type)).toEqual(["claude_signin_url"]);
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
