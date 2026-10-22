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
 *              `capture-pane` (the printed manual-code URL), every poll until one is known.
 *              For the callback URL's port p the supervisor holds `ssh -N -L 127.0.0.1:p:
 *              127.0.0.1:p <target>` (forward.ts, with the token minted here and nowhere else),
 *              then publishes `claude_signin_url { url, flow: browser_callback, manual_url,
 *              attach: "ssh <target> -t tmux attach -t volley-signin-<acct>" }`. A port taken on
 *              this machine restarts the sign-in once (Claude Code picks a fresh port), then
 *              fails naming the port.
 *   done     → the box's `claude auth status` (a profile's under its CLAUDE_CONFIG_DIR) reports
 *              loggedIn: `claude_signin_done { plan }`; a profile's also carries the identity in
 *              its `.claude.json` (`cat .claude.json` in the profile dir: `{ email?, org? }`, no
 *              other key of the file).
 *   failed   → the login exited, the timeout passed, ssh or tmux failed (no tmux: the command to
 *              run there by hand).
 *   Every end kills the session (no consent: it holds no agent's work) and the forward; a
 *   superseded sign-in drops only its forward (the session is the newer one's).
 *
 * volleyd sees authorize URLs and a plan label, never a code or a token: the code goes from the
 * browser through the forward (bytes never read) or is typed into the box's terminal by the
 * owner.
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
        ...(profileDir !== null ? await identity(profileDir) : {}),
      });
    if ((await run([{ argv: ["tmux", "has-session", "-t", session] }]))?.code !== 0)
      return fail("claude auth login exited before the sign-in finished");
    if (d.now() >= deadline) return fail(`timed out after ${Math.round(d.timeoutMs / 1000)} s`);
    await d.sleep(d.pollMs);
  }
}
