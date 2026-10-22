import { describe, expect, it } from "vitest";
import { forwardArgv } from "../../src/claude/forward";
import {
  callbackPort,
  remoteAccountHost,
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
const DIR = remoteSigninDir("/path/to/home");
const SPEC = {
  name: "box-a",
  target: TARGET,
  repo: "/srv/repo",
  worktree_root: "/srv/wt",
  volley_dir: "/opt/volley",
  tunnel: { remote_port: 18830, supervise: true },
};

/** The sign-in against a fake box behind a real SshTmuxHost (every script passes the fence). */
function world(o: SigninBoxOptions & { reserved?: number[] } = {}) {
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
      ...(signal !== undefined ? { signal } : {}),
    });
  return { ...b, events, run };
}

describe("remote sign-in helpers", () => {
  it("primary@<name> names a paired machine's own login", () => {
    expect(remoteAccountHost("primary@box-a")).toBe("box-a");
    expect(remoteAccountHost("primary")).toBeNull();
    expect(remoteAccountHost("primary@")).toBeNull();
    expect(remoteAccountHost("work")).toBeNull();
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

  it("publishes one claude_signin_url (browser_callback, manual_url, ssh attach) and holds one forward", async () => {
    const w = world({ signInAfter: 3 });
    await w.run();
    const urls = w.events.filter((e) => e.type === "claude_signin_url");
    expect(urls).toEqual([
      {
        type: "claude_signin_url",
        acct: "primary@box-a",
        url: CALLBACK,
        flow: "browser_callback",
        manual_url: PRINTED,
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

  it("a local port already in use restarts the sign-in once, on Claude Code's fresh port", async () => {
    const w = world({
      signInAfter: 4,
      busy: 1,
      callbacks: [CALLBACK, CALLBACK.replace("51051", "51052")],
    });
    const last = await w.run();
    expect(last).toMatchObject({ type: "claude_signin_done" });
    expect(w.box.starts).toBe(2);
    expect(w.forwards.map((f) => f.argv)).toEqual([
      forwardArgv(TARGET, 51051),
      forwardArgv(TARGET, 51052),
    ]);
    const urls = w.events.filter((e) => e.type === "claude_signin_url");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatchObject({ url: CALLBACK.replace("51051", "51052") });
  });

  it("a port still taken after the restart fails with the reason, naming the port", async () => {
    const w = world({ busy: 2 });
    const last = await w.run();
    expect(last).toMatchObject({ type: "claude_signin_failed" });
    const reason = (last as { reason: string }).reason;
    expect(reason).toContain("port 51051");
    expect(reason).toMatch(/local forwarding|in use/);
    expect(w.box.starts).toBe(2);
    expect(w.events.filter((e) => e.type === "claude_signin_url")).toEqual([]);
    expect(w.box.session).toBe(false);
  });

  it("never forwards a broker tunnel's port: it counts as taken", async () => {
    const w = world({ reserved: [51051] });
    const last = await w.run();
    expect(w.forwards).toEqual([]);
    expect((last as { reason: string }).reason).toContain("port 51051");
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
