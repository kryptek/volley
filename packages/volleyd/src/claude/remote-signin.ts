import { posix } from "node:path";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn, ExecResult } from "../exec";
import { type RemoteStep, mintSigninForwardToken, sealRemoteSigninScript } from "../fence";
import type { RemoteHost } from "../hosts/ssh-tmux";
import { type Forward, openForward } from "./forward";
import { loginIdentity } from "./identity";
import { PRIMARY_ACCOUNT, isValidAccountId } from "./profiles";
import {
  SUPERSEDED,
  type SigninEvent,
  parseAuthStatus,
  parseSigninUrl,
  showsCodePrompt,
  signinFlow,
  signinSession,
  statusIdentity,
  stoppedReason,
  urlEvent,
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
 * from the Desk, or a profile the supervisor created there (`<acct>@<name>`, `profile: true`):
 * Claude Code's own `claude auth login` runs on the box, in a detached tmux session, as the local
 * sign-in does (signin.ts), every step a fenced REMOTE step over `SshTmuxHost.run`:
 *
 *   start    → printenv HOME; mkdir -p <home>/.volley/signin/<acct>; the sealed signin.sh and
 *              browser.sh (no CLAUDE_CONFIG_DIR: the box's default profile), an empty url file;
 *              tmux new-session -d -s volley-signin-<acct> -c <dir> 'bash signin.sh'.
 *              A profile also gets mkdir -p + chmod 700 <home>/.volley/claude/<acct>, and its
 *              signin.sh exports that dir as CLAUDE_CONFIG_DIR.
 *   the URL  → `cat <dir>/url` (the helper's localhost-callback URL) and the session's
 *              `capture-pane` (the printed code-page URL and the `Paste code here` prompt), every
 *              poll until both are known. The printed URL is the link (`url` = `manual_url`,
 *              `flow: manual_code`, as signin.ts's `urlEvent`), with `attach: "ssh <target> -t
 *              tmux attach -t volley-signin-<acct>"`. For the callback URL's port p the
 *              supervisor tries to hold `ssh -N -L 127.0.0.1:p:127.0.0.1:p <target>` (forward.ts,
 *              with the token minted here and nowhere else): best-effort, it only makes the
 *              callback URL a shortcut for a browser on the supervisor's machine, so the event
 *              carries `callback_url` only while the forward is up, and a port taken here never
 *              fails the sign-in. The callback URL itself goes to `onCallback` either way: a
 *              redirect pasted from any device is completed on the box (service.ts).
 *   done     → the box's `claude auth status` (a profile's under its CLAUDE_CONFIG_DIR) reports
 *              loggedIn: `claude_signin_done { plan }`; a profile's also carries the identity in
 *              its `.claude.json` (`cat .claude.json` in the profile dir: `{ email?, org? }`, no
 *              other key of the file).
 *   failed   → the login exited, the timeout passed, ssh or tmux failed (no tmux: the command to
 *              run there by hand).
 *   Every end kills the session (no consent: it holds no agent's work) and the forward; a
 *   superseded sign-in drops only its forward (the session is the newer one's).
 *
 * volleyd sees authorize URLs and a plan label, never a token: a code or redirect the owner
 * pastes passes through once, to the box (service.ts), or the browser's redirect goes through
 * the forward (bytes never read).
 */

/**
 * A profile on a paired machine: `<acct>@<name>` (SPEC §4.6.12 naming); `primary@<name>` is the
 * box's own default profile.
 */
export const remoteAccount = (acct: string, name: string) => `${acct}@${name}`;

/** `<acct>@<name>` → its halves (each in the id grammar); null for any other account id. */
export function remoteAccountHost(id: string): { acct: string; name: string } | null {
  const [acct, name, ...rest] = id.split("@");
  if (acct === undefined || name === undefined || rest.length > 0) return null;
  return isValidAccountId(acct) && isValidAccountId(name) ? { acct, name } : null;
}

/** `<home>/.volley/signin/<acct>`: the session's cwd on the box. */
export const remoteSigninDir = (home: string, acct: string) =>
  posix.join(home, ".volley", "signin", acct);

/** `<home>/.volley/claude/<acct>`: a profile the supervisor created on the box. */
export const remoteProfileDir = (home: string, acct: string) =>
  posix.join(home, ".volley", "claude", acct);

/** The one-line command that reaches the sign-in terminal on the box. */
export const remoteAttach = (target: string, acct: string = PRIMARY_ACCOUNT) =>
  `ssh ${target} -t tmux attach -t ${signinSession(acct)}`;

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
  /** The profile on the box (default `primary`, the box's own default profile). */
  acct?: string;
  /**
   * A profile the supervisor created there: `<home>/.volley/claude/<acct>` as its
   * CLAUDE_CONFIG_DIR. Without it, the box's default profile (no CLAUDE_CONFIG_DIR).
   */
  profile?: true;
  /** The box's HOME, once the sign-in learned it (`printenv HOME`). */
  onHome?: (home: string) => void;
  /** The `$BROWSER` (localhost-callback) URL, once known: its port and `state`, kept in memory. */
  onCallback?: (url: string) => void;
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
  const id = d.acct ?? PRIMARY_ACCOUNT;
  const acct = remoteAccount(id, d.host.name);
  const target = d.host.spec.target;
  const session = signinSession(id);
  const attach = remoteAttach(target, id);
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
  /** A profile's login identity, the T0 way: its `.claude.json`'s email and org, nothing else. */
  const identity = async (profileDir: string) => {
    const r = await run([{ argv: ["cat", ".claude.json"], cwd: profileDir }]);
    if (r?.code !== 0) return {};
    try {
      const json: unknown = JSON.parse(r.stdout);
      return typeof json === "object" && json !== null && !Array.isArray(json)
        ? loginIdentity(json as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };

  const home = await run([{ argv: ["printenv", "HOME"] }]);
  const homeDir = home?.code === 0 ? home.stdout.trim() : "";
  if (!homeDir.startsWith("/") || homeDir.includes("\n"))
    return fail(`could not reach ${target} over ssh: ${why(home)}`);
  d.onHome?.(homeDir);
  const dir = remoteSigninDir(homeDir, id);
  const profileDir = d.profile === true ? remoteProfileDir(homeDir, id) : null;
  const script = renderSigninScript(
    profileDir !== null ? { configDir: profileDir, signinDir: dir } : { signinDir: dir },
  );
  const signin = sealRemoteSigninScript(dir, script);
  const urlFile = posix.join(dir, SIGNIN_URL_FILE);
  const wrote = await run([
    ...(profileDir !== null
      ? [{ argv: ["mkdir", "-p", dir, profileDir] }, { argv: ["chmod", "700", profileDir] }]
      : [{ argv: ["mkdir", "-p", dir] }]),
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
  /** The last URL event published (JSON), and whether there is anything left to learn. */
  let published: string | null = null;
  let settled = false;
  let callback: string | null = null;
  /** The callback URL a forward was tried for (once), and whether it is up. */
  let tried = false;
  for (let poll = 1; ; poll++) {
    if (aborted()) {
      if (d.signal?.reason !== SUPERSEDED) return fail(stoppedReason(d.signal));
      return superseded();
    }
    if (!settled) {
      if (callback === null) {
        const file = await run([{ argv: ["cat", urlFile] }]);
        const url = file?.code === 0 ? parseSigninUrl(file.stdout) : null;
        if (url !== null && signinFlow(url) === "browser_callback") {
          callback = url;
          d.onCallback?.(url);
        }
      }
      const pane = await run([{ argv: ["tmux", "capture-pane", "-p", "-J", "-t", session] }]);
      const screen = pane?.code === 0 ? pane.stdout : "";
      const printedUrl = parseSigninUrl(screen);
      const printed =
        printedUrl !== null && signinFlow(printedUrl) === "manual_code" ? printedUrl : null;
      const port = callback !== null ? callbackPort(callback) : null;
      if (!tried && port !== null) {
        tried = true;
        try {
          const token = mintSigninForwardToken(target, port, d.reservedPorts);
          const opened = await openForward(d.exec, token, () => d.sleep(settleMs));
          if (opened.ok) forward = opened.forward;
        } catch {
          // A broker tunnel's port: no forward, the code page and a pasted redirect still work.
        }
        // Aborted while the forward settled: the loop's top drops it.
        if (aborted()) continue;
      }
      const e = urlEvent(acct, attach, {
        printed,
        callback: forward !== null ? callback : null,
        prompt: showsCodePrompt(screen),
      });
      if (e !== null && JSON.stringify(e) !== published) {
        published = JSON.stringify(e);
        await d.publish(e);
      }
      settled =
        (printed !== null && e?.code_prompt === true && callback !== null) ||
        (published !== null && poll > 5);
    }
    const status = await run(
      [
        {
          argv: ["claude", "auth", "status"],
          ...(profileDir !== null ? { env: { CLAUDE_CONFIG_DIR: profileDir } } : {}),
        },
      ],
      { timeoutMs: DAEMON_DEFAULTS.claude_auth_status_timeout_ms },
    );
    // Aborted during the round trip: the loop's top settles it.
    if (aborted()) continue;
    const s = status !== null ? parseAuthStatus(status.stdout) : null;
    if (s?.loggedIn === true)
      return finish({
        type: "claude_signin_done",
        acct,
        ...(s.plan !== undefined ? { plan: s.plan } : {}),
        ...(profileDir !== null ? await statusIdentity(s, () => identity(profileDir)) : {}),
      });
    if ((await run([{ argv: ["tmux", "has-session", "-t", session] }]))?.code !== 0)
      return fail("claude auth login exited before the sign-in finished");
    if (d.now() >= deadline) return fail(`timed out after ${Math.round(d.timeoutMs / 1000)} s`);
    await d.sleep(d.pollMs);
  }
}
