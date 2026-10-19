import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DAEMON_DEFAULTS } from "../config-defaults";
import type { ExecFn } from "../exec";
import { sealSigninScript } from "../fence";
import { markSignedIn, profileDir } from "./profiles";
import {
  BROWSER_HELPER,
  CREDENTIAL_ENV,
  SIGNIN_COMMAND,
  SIGNIN_SCRIPT,
  SIGNIN_URL_FILE,
  renderBrowserHelper,
  renderSigninScript,
} from "./signin-script";

/**
 * Background sign-in of a Claude account profile through Claude Code's own flow (the accounts
 * spike, section (b)): `claude auth login` under the profile's `CLAUDE_CONFIG_DIR`, in a
 * detached tmux session, with `$BROWSER` set to a helper that writes down the authorize URL.
 *
 *   start   → tmux new-session -d -s volley-signin-<acct> -c <root>/.signin/<acct> 'bash signin.sh'
 *   the URL → `claude_signin_url { acct, url, flow, attach }`, once:
 *             `browser_callback` — the URL Claude Code passed to `$BROWSER` (its redirect is
 *               Claude Code's own localhost listener: open it in a browser on this machine);
 *             `manual_code` — no `$BROWSER` call, so the URL it printed: the page then shows a
 *               code to paste into that terminal (`attach`), never into anything of Volley's.
 *   done    → `claude auth status` (polled) reports `loggedIn` → `claude_signin_done`, the
 *             registry entry gets `signed_in_at` and the plan label; the session is killed.
 *   failed  → the login exited first, the timeout passed, or tmux is missing.
 *
 * volleyd sees an authorize URL and the plan label, never a code, a token or a Keychain item.
 */

/**
 * The abort reason of a sign-in replaced by a newer one for the same account: it ends without
 * touching the shared tmux session or URL file and publishes nothing (both are the new one's).
 */
export const SUPERSEDED = "superseded";

export const signinSession = (acct: string) => `volley-signin-${acct}`;
export const signinDir = (root: string, acct: string) => join(root, ".signin", acct);

export type SigninFlow = "browser_callback" | "manual_code";

export type SigninEvent =
  | { type: "claude_signin_url"; acct: string; url: string; flow: SigninFlow; attach: string }
  | { type: "claude_signin_done"; acct: string; plan?: string }
  | { type: "claude_signin_failed"; acct: string; reason: string };

/** Drop OSC (hyperlinks: `ESC ] 8 ;; url ESC \`), CSI (colours) and other ESC sequences. */
export function stripTerminal(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes
      .replace(/\u001b[@-_]/g, "")
  );
}

/** Claude Code's authorize endpoints: https only, on claude.com / claude.ai. */
const AUTHORIZE_URL =
  /https:\/\/(?:[a-z-]+\.)*claude\.(?:com|ai)\/[\w/-]*oauth\/authorize\?[^\s"'<>\p{Cc}]+/gu;

/** The last authorize URL in `text` (a transcript or the helper's file), or null. */
export function parseSigninUrl(text: string): string | null {
  return stripTerminal(text).match(AUTHORIZE_URL)?.at(-1) ?? null;
}

/** Which flow a URL belongs to, by its `redirect_uri`: Claude Code's localhost listener or not. */
export function signinFlow(url: string): SigninFlow {
  let redirect = "";
  try {
    redirect = new URL(url).searchParams.get("redirect_uri") ?? "";
  } catch {}
  return /^http:\/\/(?:localhost|127\.0\.0\.1)[:/]/.test(redirect)
    ? "browser_callback"
    : "manual_code";
}

/** `claude auth status` JSON: whether the profile is logged in, and its plan label. */
export function parseAuthStatus(stdout: string): { loggedIn: boolean; plan?: string } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as { loggedIn?: unknown; subscriptionType?: unknown };
  return {
    loggedIn: s.loggedIn === true,
    ...(typeof s.subscriptionType === "string" ? { plan: s.subscriptionType } : {}),
  };
}

/** The profile's env for a `claude` child: the caller's, minus every credential variable. */
export function profileEnv(
  env: Record<string, string | undefined>,
  configDir: string,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, CLAUDE_CONFIG_DIR: configDir };
  for (const k of CREDENTIAL_ENV) delete out[k];
  return out;
}

export interface SigninDeps {
  exec: ExecFn;
  /** The profiles root (`claudeRoot()`). */
  root: string;
  acct: string;
  publish: (e: SigninEvent) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pollMs: number;
  timeoutMs: number;
  /** Bound on one `claude auth status`. */
  statusTimeoutMs?: number;
  /** The env `claude auth status` starts from (default process.env). */
  env?: Record<string, string | undefined>;
  /** Stops the sign-in (the daemon stopping): kills the session, resolves `failed`. */
  signal?: AbortSignal;
}

/** Run one sign-in to its end; resolves with the terminal event (also published). */
export async function runSignin(d: SigninDeps): Promise<SigninEvent> {
  const configDir = profileDir(d.root, d.acct);
  const dir = signinDir(d.root, d.acct);
  const session = signinSession(d.acct);
  const urlFile = join(dir, SIGNIN_URL_FILE);
  const attach = `tmux attach -t ${session}`;
  const finish = async (e: SigninEvent): Promise<SigninEvent> => {
    await d.exec(["tmux", "kill-session", "-t", session]).catch(() => undefined);
    rmSync(urlFile, { force: true });
    await d.publish(e);
    return e;
  };
  const fail = (reason: string) => finish({ type: "claude_signin_failed", acct: d.acct, reason });

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  rmSync(urlFile, { force: true });
  writeFileSync(join(dir, BROWSER_HELPER), renderBrowserHelper(dir), { mode: 0o700 });
  const script = renderSigninScript({ configDir, signinDir: dir });
  const signin = sealSigninScript(dir, script);
  writeFileSync(join(dir, SIGNIN_SCRIPT), script, { mode: 0o700 });

  try {
    // A sign-in still running for this account from before is replaced.
    await d.exec(["tmux", "kill-session", "-t", session]);
    const started = await d.exec(
      ["tmux", "new-session", "-d", "-s", session, "-c", dir, SIGNIN_COMMAND],
      { signin },
    );
    if (started.code !== 0) return fail(`tmux new-session failed: ${started.stderr.trim()}`);
  } catch (e) {
    return fail(
      `could not start a background sign-in (${e instanceof Error ? e.message : String(e)}); run \`CLAUDE_CONFIG_DIR=${configDir} claude auth login\` in a terminal`,
    );
  }

  const env = profileEnv(d.env ?? process.env, configDir);
  const deadline = d.now() + d.timeoutMs;
  let published = false;
  for (let poll = 1; ; poll++) {
    if (d.signal?.aborted === true)
      return d.signal.reason === SUPERSEDED
        ? { type: "claude_signin_failed", acct: d.acct, reason: "superseded by a newer sign-in" }
        : fail("the supervisor stopped");
    if (!published) {
      let file: string | null = null;
      try {
        file = readFileSync(urlFile, "utf-8");
      } catch {}
      let url = file !== null ? parseSigninUrl(file) : null;
      // No $BROWSER call after a poll: the printed (manual-code) URL from the session's screen.
      if (url === null && poll > 1) {
        const pane = await d.exec(["tmux", "capture-pane", "-p", "-J", "-t", session]);
        url = pane.code === 0 ? parseSigninUrl(pane.stdout) : null;
      }
      if (url !== null) {
        published = true;
        await d.publish({
          type: "claude_signin_url",
          acct: d.acct,
          url,
          flow: signinFlow(url),
          attach,
        });
      }
    }
    const status = await d.exec(["claude", "auth", "status"], {
      env,
      timeoutMs: d.statusTimeoutMs ?? DAEMON_DEFAULTS.claude_auth_status_timeout_ms,
    });
    const s = parseAuthStatus(status.stdout);
    if (s?.loggedIn === true) {
      markSignedIn(
        d.root,
        d.acct,
        s.plan !== undefined ? { plan: s.plan } : {},
        new Date(d.now()).toISOString(),
      );
      return finish({
        type: "claude_signin_done",
        acct: d.acct,
        ...(s.plan !== undefined ? { plan: s.plan } : {}),
      });
    }
    if ((await d.exec(["tmux", "has-session", "-t", session])).code !== 0)
      return fail("claude auth login exited before the sign-in finished");
    if (d.now() >= deadline) return fail(`timed out after ${Math.round(d.timeoutMs / 1000)} s`);
    await d.sleep(d.pollMs);
  }
}
