import { posix } from "node:path";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecResult } from "../exec";
import { type RemoteStep, mintSigninForwardToken, sealRemoteSigninScript } from "../fence";
import type { RemoteHost } from "../hosts/ssh-tmux";
import { type Forward, openForward } from "./forward";
import { PRIMARY_ACCOUNT } from "./profiles";
import {
  SUPERSEDED,
  type SigninEvent,
  parseAuthStatus,
  parseSigninUrl,
  signinFlow,
  signinSession,
} from "./signin";
import {
  BROWSER_HELPER,
  SIGNIN_COMMAND,
  SIGNIN_SCRIPT,
  SIGNIN_URL_FILE,
  renderBrowserHelper,
  renderSigninScript,
} from "./signin-script";

/**
 * Signing a paired machine's own default profile (`primary@<name>`, SPEC §4.6.11) in to Claude,
 * from the Desk: Claude Code's own `claude auth login` runs on the box, in a detached tmux
 * session, as the local sign-in does (signin.ts), every step a fenced REMOTE step over
 * `SshTmuxHost.run`:
 *
 *   start    → printenv HOME; mkdir -p <home>/.volley/signin/primary; the sealed signin.sh and
 *              browser.sh (no CLAUDE_CONFIG_DIR: the box's default profile), an empty url file;
 *              tmux new-session -d -s volley-signin-primary -c <dir> 'bash signin.sh'
 *   the URL  → `cat <dir>/url` (the helper's localhost-callback URL) and the session's
 *              `capture-pane` (the printed manual-code URL), every poll until one is known.
 *              For the callback URL's port p the supervisor holds `ssh -N -L 127.0.0.1:p:
 *              127.0.0.1:p <target>` (forward.ts, with the token minted here and nowhere else),
 *              then publishes `claude_signin_url { url, flow: browser_callback, manual_url,
 *              attach: "ssh <target> -t tmux attach -t volley-signin-primary" }`. A port taken on
 *              this machine restarts the sign-in once (Claude Code picks a fresh port), then
 *              fails naming the port.
 *   done     → the box's `claude auth status` reports loggedIn: `claude_signin_done { plan }`.
 *   failed   → the login exited, the timeout passed, ssh or tmux failed (no tmux: the command to
 *              run there by hand).
 *   Every end kills the session (no consent: it holds no agent's work) and the forward; a
 *   superseded sign-in drops only its forward (the session is the newer one's).
 *
 * volleyd sees authorize URLs and a plan label, never a code or a token: the code goes from the
 * browser through the forward (bytes never read) or is typed into the box's terminal by the
 * owner.
 */

/** A paired machine's own Claude login: `primary@<name>` (SPEC §4.6.12 naming). */
export const remoteAccount = (name: string) => `${PRIMARY_ACCOUNT}@${name}`;

/** `primary@<name>` → `<name>`; null for any other account id. */
export function remoteAccountHost(acct: string): string | null {
  const prefix = `${PRIMARY_ACCOUNT}@`;
  return acct.startsWith(prefix) && acct.length > prefix.length ? acct.slice(prefix.length) : null;
}

/** The sign-in's tmux session on the box. */
export const REMOTE_SIGNIN_SESSION = signinSession(PRIMARY_ACCOUNT);

/** `<home>/.volley/signin/primary`: the session's cwd on the box. */
export const remoteSigninDir = (home: string) =>
  posix.join(home, ".volley", "signin", PRIMARY_ACCOUNT);

/** The one-line command that reaches the sign-in terminal on the box. */
export const remoteAttach = (target: string) =>
  `ssh ${target} -t tmux attach -t ${REMOTE_SIGNIN_SESSION}`;

/** What the owner runs on a box without tmux. */
export const remoteManualCommand = (target: string) => `ssh ${target} -t claude auth login`;

/** The port of a localhost-callback URL's `redirect_uri`; null when it names none. */
export function callbackPort(url: string): number | null {
  try {
    const redirect = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
    const port = Number(redirect.port);
    return redirect.port !== "" && Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

export interface RemoteSigninDeps {
  host: Pick<RemoteHost, "name" | "spec" | "run">;
  /** The local fenced exec the forward runs under. */
  exec: ExecFn;
  publish: (e: SigninEvent) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
  timeoutMs: number;
  /** How long the forward must stay up (default `signin_forward_settle_ms`). */
  settleMs?: number;
  /** Ports never forwarded: the config's broker tunnels (and the broker's own). */
  reservedPorts: readonly number[];
  /** Stops the sign-in: `SUPERSEDED` (a newer one) or the daemon stopping. */
  signal?: AbortSignal;
}

const b64 = (s: string) => Buffer.from(s, "utf-8").toString("base64");
const write = (path: string, content: string): RemoteStep => ({
  argv: ["base64", "-d"],
  stdin: b64(content),
  stdout: path,
});
const why = (r: ExecResult | null) =>
  r === null
    ? "no result"
    : r.timedOut
      ? "timed out"
      : r.stderr.trim().split("\n").at(-1) || `exit ${r.code}`;
/** `tmux` is not installed on the box (bash: command not found). */
const noTmux = (r: ExecResult) => r.code === 127 || /tmux: (?:command )?not found/.test(r.stderr);

/** Run one remote sign-in to its end; resolves with the terminal event (also published). */
export async function runRemoteSignin(d: RemoteSigninDeps): Promise<SigninEvent> {
  const acct = remoteAccount(d.host.name);
  const target = d.host.spec.target;
  const session = REMOTE_SIGNIN_SESSION;
  const attach = remoteAttach(target);
  const run = (steps: RemoteStep[], opts: Parameters<typeof d.host.run>[1] = {}) =>
    d.host.run(steps, opts).catch(() => null);
  const aborted = () => d.signal?.aborted === true;
  let forward: Forward | null = null;
  const dropForward = async () => {
    const f = forward;
    forward = null;
    await f?.stop();
  };
  // A newer sign-in or the daemon stopping frees the port at once, not at the next poll.
  d.signal?.addEventListener("abort", () => void dropForward(), { once: true });
  const kill = () => run([{ argv: ["tmux", "kill-session", "-t", session] }]);
  const superseded = async (): Promise<SigninEvent> => {
    await dropForward();
    return { type: "claude_signin_failed", acct, reason: "superseded by a newer sign-in" };
  };
  /**
   * Kill the session, drop the forward, publish. Superseded mid-step (an ssh round trip takes
   * seconds), the session and the topic are the newer sign-in's: only the forward goes.
   */
  const finish = async (e: SigninEvent): Promise<SigninEvent> => {
    if (aborted() && d.signal?.reason === SUPERSEDED) return superseded();
    await kill();
    await dropForward();
    await d.publish(e);
    return e;
  };
  const fail = (reason: string) => finish({ type: "claude_signin_failed", acct, reason });

  const home = await run([{ argv: ["printenv", "HOME"] }]);
  const homeDir = home?.code === 0 ? home.stdout.trim() : "";
  if (!homeDir.startsWith("/") || homeDir.includes("\n"))
    return fail(`could not reach ${target} over ssh: ${why(home)}`);
  const dir = remoteSigninDir(homeDir);
  const script = renderSigninScript({ signinDir: dir });
  const signin = sealRemoteSigninScript(dir, script);
  const urlFile = posix.join(dir, SIGNIN_URL_FILE);
  const wrote = await run([
    { argv: ["mkdir", "-p", dir] },
    write(posix.join(dir, BROWSER_HELPER), renderBrowserHelper(dir)),
    write(posix.join(dir, SIGNIN_SCRIPT), script),
    { argv: ["chmod", "700", posix.join(dir, BROWSER_HELPER), posix.join(dir, SIGNIN_SCRIPT)] },
  ]);
  if (wrote?.code !== 0)
    return fail(`could not write the sign-in script on ${target}: ${why(wrote)}`);

  /** (Re)start the login: replace any earlier session, empty the url file. Null, or why not. */
  const start = async (): Promise<string | null> => {
    await kill();
    const r = await run(
      [
        write(urlFile, ""),
        { argv: ["tmux", "new-session", "-d", "-s", session, "-c", dir, SIGNIN_COMMAND] },
      ],
      { signin },
    );
    if (r?.code === 0) return null;
    if (r !== null && noTmux(r))
      return `no tmux on ${target}; run \`${remoteManualCommand(target)}\` in a terminal and sign in there`;
    return `could not start the sign-in on ${target}: ${why(r)}`;
  };
  const started = await start();
  if (started !== null) return fail(started);

  const settleMs = d.settleMs ?? DAEMON_DEFAULTS.signin_forward_settle_ms;
  const deadline = d.now() + d.timeoutMs;
  let restarted = false;
  let published = false;
  for (let poll = 1; ; poll++) {
    if (aborted()) {
      if (d.signal?.reason !== SUPERSEDED) return fail("the supervisor stopped");
      return superseded();
    }
    if (!published) {
      const file = await run([{ argv: ["cat", urlFile] }]);
      const callback = file?.code === 0 ? parseSigninUrl(file.stdout) : null;
      const pane = await run([{ argv: ["tmux", "capture-pane", "-p", "-J", "-t", session] }]);
      const printed = pane?.code === 0 ? parseSigninUrl(pane.stdout) : null;
      const manual = printed !== null && signinFlow(printed) === "manual_code" ? printed : null;
      const port = callback !== null ? callbackPort(callback) : null;
      if (callback !== null && signinFlow(callback) === "browser_callback" && port !== null) {
        let opened: Awaited<ReturnType<typeof openForward>>;
        try {
          const token = mintSigninForwardToken(target, port, d.reservedPorts);
          opened = await openForward(d.exec, token, () => d.sleep(settleMs));
        } catch (e) {
          opened = { ok: false, busy: true, reason: e instanceof Error ? e.message : String(e) };
        }
        if (!opened.ok) {
          if (!opened.busy)
            return fail(`the sign-in forward to ${target} failed: ${opened.reason}`);
          if (restarted)
            return fail(
              `port ${port} on this machine is taken (${opened.reason}), so the sign-in on ${target} cannot reach this browser; run \`${attach}\` and sign in there`,
            );
          restarted = true;
          // start() kills the session first, which may be a newer sign-in's by now.
          if (aborted()) continue;
          const again = await start();
          if (again !== null) return fail(again);
          await d.sleep(d.pollMs);
          continue;
        }
        forward = opened.forward;
        // Aborted while the forward settled: the loop's top drops it.
        if (aborted()) continue;
        published = true;
        await d.publish({
          type: "claude_signin_url",
          acct,
          url: callback,
          flow: "browser_callback",
          attach,
          ...(manual !== null ? { manual_url: manual } : {}),
        });
      } else if (manual !== null && poll > 1) {
        // No $BROWSER call: the printed URL, whose code is typed into the box's terminal.
        published = true;
        await d.publish({
          type: "claude_signin_url",
          acct,
          url: manual,
          flow: "manual_code",
          attach,
        });
      }
    }
    const status = await run([{ argv: ["claude", "auth", "status"] }], {
      timeoutMs: DAEMON_DEFAULTS.claude_auth_status_timeout_ms,
    });
    // Aborted during the round trip: the loop's top settles it.
    if (aborted()) continue;
    const s = status !== null ? parseAuthStatus(status.stdout) : null;
    if (s?.loggedIn === true)
      return finish({
        type: "claude_signin_done",
        acct,
        ...(s.plan !== undefined ? { plan: s.plan } : {}),
      });
    if ((await run([{ argv: ["tmux", "has-session", "-t", session] }]))?.code !== 0)
      return fail("claude auth login exited before the sign-in finished");
    if (d.now() >= deadline) return fail(`timed out after ${Math.round(d.timeoutMs / 1000)} s`);
    await d.sleep(d.pollMs);
  }
}
