import { describe, expect, it } from "vitest";
import { forwardArgv } from "../../src/claude/forward";
import {
  callbackPort,
  remoteAccount,
  remoteAccountHost,
  remoteProfileDir,
  remoteSigninDir,
  runRemoteSignin,
} from "../../src/claude/remote-signin";
import { SUPERSEDED, type SigninEvent, parseSigninUrl } from "../../src/claude/signin";
import {
  CREDENTIAL_ENV,
  renderBrowserHelper,
  renderSigninScript,
} from "../../src/claude/signin-script";
import { SshTmuxHost } from "../../src/hosts/ssh-tmux";
import { flushMicrotasks } from "../helpers/fake-clock";
import {
  SIGNIN_CALLBACK as CALLBACK,
  type SigninBoxOptions,
  SIGNIN_TRANSCRIPT as TRANSCRIPT,
  fakeSigninBox,
} from "../helpers/fake-host";

const PRINTED = parseSigninUrl(TRANSCRIPT) as string;
const TARGET = "dev@box-a";
const DIR = remoteSigninDir("/path/to/home", "primary");
const SPEC = {
  name: "box-a",
  target: TARGET,
  repo: "/srv/repo",
  worktree_root: "/srv/wt",
  volley_dir: "/opt/volley",
  tunnel: { remote_port: 18830, supervise: true },
};

/** The sign-in against a fake box behind a real SshTmuxHost (every script passes the fence). */
function world(
  o: SigninBoxOptions & { reserved?: number[]; acct?: string; profile?: boolean } = {},
) {
  const b = fakeSigninBox(o);
  const host = new SshTmuxHost(SPEC, b.exec);
  const events: SigninEvent[] = [];
  let t = 0;
  const run = (signal?: AbortSignal, onEvent?: (e: SigninEvent) => void) =>
    runRemoteSignin({
      host,
      exec: b.exec,
      publish: async (e) => {
        events.push(e);
        onEvent?.(e);
      },
      // A macrotask turn, so a forward that exits at once is seen before its settle ends.
      sleep: async (ms) => {
        t += ms;
        await flushMicrotasks(1);
      },
      now: () => t,
      pollMs: 10,
      timeoutMs: 200,
      settleMs: 5,
      reservedPorts: o.reserved ?? [18830, 1883],
      ...(o.acct !== undefined ? { acct: o.acct } : {}),
      ...(o.profile === true ? { profile: true as const } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  return { ...b, events, run };
}

describe("remote sign-in helpers", () => {
  it("<acct>@<name> names a profile on a paired machine (primary@<name>: its own login)", () => {
    expect(remoteAccount("primary", "box-a")).toBe("primary@box-a");
    expect(remoteAccount("work", "box-a")).toBe("work@box-a");
    expect(remoteAccountHost("primary@box-a")).toEqual({ acct: "primary", name: "box-a" });
    expect(remoteAccountHost("work@peer-a")).toEqual({ acct: "work", name: "peer-a" });
    expect(remoteAccountHost("primary")).toBeNull();
    expect(remoteAccountHost("primary@")).toBeNull();
    expect(remoteAccountHost("@box-a")).toBeNull();
    expect(remoteAccountHost("work")).toBeNull();
    expect(remoteAccountHost("Work@box-a")).toBeNull();
    expect(remoteAccountHost("work@box a")).toBeNull();
    expect(remoteAccountHost("a@b@c")).toBeNull();
  });

  it("the sign-in and profile dirs on the box", () => {
    expect(remoteSigninDir("/path/to/home", "work")).toBe("/path/to/home/.volley/signin/work");
    expect(remoteProfileDir("/path/to/home", "work")).toBe("/path/to/home/.volley/claude/work");
  });

  it("the forwarded port is the callback URL's redirect port", () => {
    expect(callbackPort(CALLBACK)).toBe(51051);
    expect(callbackPort(PRINTED)).toBeNull();
    expect(callbackPort("not a url")).toBeNull();
  });
});

describe("runRemoteSignin", () => {
  it("writes exactly the sealed scripts on the box and starts the tmux session there", async () => {
    const w = world({ signInAfter: 3 });
    await w.run();
    const script = w.box.files.get(`${DIR}/signin.sh`) as string;
    expect(script).toBe(renderSigninScript({ signinDir: DIR }));
    expect(w.box.files.get(`${DIR}/browser.sh`)).toBe(renderBrowserHelper(DIR));
    // The box's own default profile: no CLAUDE_CONFIG_DIR, the credential env unset.
    expect(script).not.toContain("CLAUDE_CONFIG_DIR");
    expect(script).toContain(`unset ${CREDENTIAL_ENV.join(" ")}`);
    expect(script).toContain("exec claude auth login");
    expect(w.ran("tmux", "new-session")).toEqual([
      ["tmux", "new-session", "-d", "-s", "volley-signin-primary", "-c", DIR, "bash signin.sh"],
    ]);
    expect(w.ran("mkdir")).toEqual([["mkdir", "-p", DIR]]);
  });

  it("publishes one claude_signin_url (the code-page link first, callback_url, ssh attach) and holds one forward", async () => {
    const w = world({ signInAfter: 3 });
    const callbacks: string[] = [];
    await runRemoteSignin({
      host: new SshTmuxHost(SPEC, w.exec),
      exec: w.exec,
      publish: async (e) => {
        w.events.push(e);
      },
      sleep: async () => {
        await flushMicrotasks(1);
      },
      now: () => 0,
      pollMs: 10,
      timeoutMs: 200,
      settleMs: 5,
      reservedPorts: [18830, 1883],
      onCallback: (url) => callbacks.push(url),
    });
    expect(callbacks).toEqual([CALLBACK]);
    const urls = w.events.filter((e) => e.type === "claude_signin_url");
    expect(urls).toEqual([
      {
        type: "claude_signin_url",
        acct: "primary@box-a",
        url: PRINTED,
        flow: "manual_code",
        manual_url: PRINTED,
        callback_url: CALLBACK,
        code_prompt: true,
        attach: "ssh dev@box-a -t tmux attach -t volley-signin-primary",
      },
    ]);
    const redirect = new URL(CALLBACK).searchParams.get("redirect_uri");
    expect(redirect).toBe("http://localhost:51051/callback");
    expect(w.forwards.map((f) => f.argv)).toEqual([forwardArgv(TARGET, 51051)]);
    expect(forwardArgv(TARGET, 51051).slice(0, 4)).toEqual([
      "ssh",
      "-N",
      "-L",
      "127.0.0.1:51051:127.0.0.1:51051",
    ]);
  });

  it("the box's `claude auth status` loggedIn → done with the plan; the session and forward go", async () => {
    const w = world({ signInAfter: 3 });
    const last = await w.run();
    expect(last).toEqual({ type: "claude_signin_done", acct: "primary@box-a", plan: "max" });
    expect(w.events.at(-1)).toEqual(last);
    expect(w.ran("claude")).toContainEqual(["claude", "auth", "status"]);
    expect(w.steps().at(-1)).toEqual(["tmux", "kill-session", "-t", "volley-signin-primary"]);
    expect(w.box.session).toBe(false);
    expect(w.forwards.every((f) => f.stopped)).toBe(true);
  });

  it("times out: fails and kills both the session and the forward", async () => {
    const w = world();
    const last = await w.run();
    expect(last).toMatchObject({
      type: "claude_signin_failed",
      acct: "primary@box-a",
      reason: expect.stringMatching(/timed out/),
    });
    expect(w.box.session).toBe(false);
    expect(w.forwards).toHaveLength(1);
    expect(w.forwards[0]?.stopped).toBe(true);
  });

  it("a local port already in use: no restart, the code-page link without callback_url, and the sign-in proceeds", async () => {
    const w = world({ signInAfter: 4, busy: 1 });
    const last = await w.run();
    expect(last).toMatchObject({ type: "claude_signin_done" });
    expect(w.box.starts).toBe(1);
    expect(w.forwards.map((f) => f.argv)).toEqual([forwardArgv(TARGET, 51051)]);
    expect(w.events.filter((e) => e.type === "claude_signin_url")).toEqual([
      {
        type: "claude_signin_url",
        acct: "primary@box-a",
        url: PRINTED,
        flow: "manual_code",
        manual_url: PRINTED,
        code_prompt: true,
        attach: "ssh dev@box-a -t tmux attach -t volley-signin-primary",
      },
    ]);
  });

  it("never forwards a broker tunnel's port; the sign-in still proceeds without a callback_url", async () => {
    const w = world({ reserved: [51051], signInAfter: 3 });
    const last = await w.run();
    expect(w.forwards).toEqual([]);
    expect(last).toMatchObject({ type: "claude_signin_done" });
    const url = w.events.find((e) => e.type === "claude_signin_url");
    expect(url).toMatchObject({ url: PRINTED, flow: "manual_code" });
    expect(url).not.toHaveProperty("callback_url");
  });

  it("a box without tmux fails with the command to run there by hand", async () => {
    const w = world({ noTmux: true });
    const last = await w.run();
    expect(last).toMatchObject({ type: "claude_signin_failed", acct: "primary@box-a" });
    expect((last as { reason: string }).reason).toContain("ssh dev@box-a -t claude auth login");
    expect(w.forwards).toEqual([]);
  });

  it("without a $BROWSER call: the printed URL as manual_code, and no forward", async () => {
    const w = world({ browser: false, signInAfter: 4 });
    await w.run();
    expect(w.events[0]).toEqual({
      type: "claude_signin_url",
      acct: "primary@box-a",
      url: PRINTED,
      flow: "manual_code",
      manual_url: PRINTED,
      code_prompt: true,
      attach: "ssh dev@box-a -t tmux attach -t volley-signin-primary",
    });
    expect(w.forwards).toEqual([]);
  });

  it("superseded: nothing of it is published after, its forward goes, the session stays", async () => {
    const w = world();
    const abort = new AbortController();
    const last = await w.run(abort.signal, (e) => {
      if (e.type === "claude_signin_url") abort.abort(SUPERSEDED);
    });
    expect(last).toMatchObject({
      type: "claude_signin_failed",
      reason: expect.stringMatching(/superseded/),
    });
    expect(w.events.map((e) => e.type)).toEqual(["claude_signin_url"]);
    expect(w.forwards[0]?.stopped).toBe(true);
    // Only the start's replace-the-old-session kill: the session is the newer sign-in's now.
    expect(w.ran("tmux", "kill-session")).toHaveLength(1);
    expect(w.box.session).toBe(true);
  });

  it("superseded while `claude auth status` is in flight: the newer session is not killed, nothing published", async () => {
    const abort = new AbortController();
    // The newer sign-in aborts this one and has killed the old session, not yet started its own.
    const w = world({
      onAuthStatus: (box) => {
        if (abort.signal.aborted) return;
        abort.abort(SUPERSEDED);
        box.session = false;
      },
    });
    const last = await w.run(abort.signal);
    expect(last).toMatchObject({
      type: "claude_signin_failed",
      reason: expect.stringMatching(/superseded/),
    });
    expect(w.events.map((e) => e.type)).toEqual(["claude_signin_url"]);
    expect(w.ran("tmux", "kill-session")).toHaveLength(1);
    expect(w.ran("tmux", "has-session")).toEqual([]);
    expect(w.forwards[0]?.stopped).toBe(true);
  });

  it("the daemon stopping fails it and cleans up", async () => {
    const w = world();
    const abort = new AbortController();
    const last = await w.run(abort.signal, (e) => {
      if (e.type === "claude_signin_url") abort.abort();
    });
    expect(last).toMatchObject({ reason: "the supervisor stopped" });
    expect(w.box.session).toBe(false);
    expect(w.forwards[0]?.stopped).toBe(true);
  });
});

describe("runRemoteSignin of a profile the supervisor created there (profile: true)", () => {
  const HOME = "/path/to/home";
  const WDIR = remoteSigninDir(HOME, "work");
  const PROFILE = remoteProfileDir(HOME, "work");
  const CLAUDE_JSON = JSON.stringify({
    oauthAccount: {
      emailAddress: "Owner@Example.com",
      organizationName: "Example Org",
      accountUuid: "secret-uuid",
    },
    userID: "user-id-never-seen",
    primaryApiKey: "never-seen",
  });
  const profileWorld = (o: SigninBoxOptions = {}) =>
    world({
      ...o,
      acct: "work",
      profile: true,
      files: { [`${PROFILE}/.claude.json`]: CLAUDE_JSON, ...o.files },
    });

  it("makes the profile dir 700, writes the sealed profile script, starts volley-signin-work", async () => {
    const w = profileWorld({ signInAfter: 3 });
    await w.run();
    expect(w.ran("mkdir")).toEqual([["mkdir", "-p", WDIR, PROFILE]]);
    expect(w.ran("chmod", "700", PROFILE)).toEqual([["chmod", "700", PROFILE]]);
    expect(w.box.files.get(`${WDIR}/signin.sh`)).toBe(
      renderSigninScript({ configDir: PROFILE, signinDir: WDIR }),
    );
    expect(w.box.files.get(`${WDIR}/browser.sh`)).toBe(renderBrowserHelper(WDIR));
    expect(w.ran("tmux", "new-session")).toEqual([
      ["tmux", "new-session", "-d", "-s", "volley-signin-work", "-c", WDIR, "bash signin.sh"],
    ]);
  });

  it("publishes the URL under work@<name> with the attach naming volley-signin-work", async () => {
    const w = profileWorld({ signInAfter: 3 });
    await w.run();
    expect(w.events.filter((e) => e.type === "claude_signin_url")).toEqual([
      {
        type: "claude_signin_url",
        acct: "work@box-a",
        url: PRINTED,
        flow: "manual_code",
        manual_url: PRINTED,
        callback_url: CALLBACK,
        code_prompt: true,
        attach: "ssh dev@box-a -t tmux attach -t volley-signin-work",
      },
    ]);
  });

  it("polls `claude auth status` under the profile; done carries only plan, email and org", async () => {
    const w = profileWorld({ signInAfter: 3 });
    const last = await w.run();
    const polls = w.remoteSteps().filter((s) => s.argv[0] === "claude");
    expect(polls.length).toBeGreaterThan(0);
    for (const s of polls) expect(s.env).toEqual({ CLAUDE_CONFIG_DIR: PROFILE });
    expect(w.remoteSteps()).toContainEqual({ argv: ["cat", ".claude.json"], cwd: PROFILE });
    expect(last).toEqual({
      type: "claude_signin_done",
      acct: "work@box-a",
      plan: "max",
      email: "owner@example.com",
      org: "Example Org",
    });
    expect(w.events.at(-1)).toEqual(last);
    const text = JSON.stringify(w.events);
    for (const secret of ["secret-uuid", "user-id-never-seen", "never-seen"])
      expect(text).not.toContain(secret);
    expect(w.steps().at(-1)).toEqual(["tmux", "kill-session", "-t", "volley-signin-work"]);
  });

  it("an unreadable .claude.json: done with the plan alone", async () => {
    const w = world({ acct: "work", profile: true, signInAfter: 2 });
    expect(await w.run()).toEqual({ type: "claude_signin_done", acct: "work@box-a", plan: "max" });
  });

  it("the box's default profile (no profile flag) is untouched: no env, no cat of .claude.json", async () => {
    const w = world({ signInAfter: 3 });
    await w.run();
    expect(w.remoteSteps().every((s) => s.env === undefined)).toBe(true);
    expect(w.ran("cat", ".claude.json")).toEqual([]);
  });
});
