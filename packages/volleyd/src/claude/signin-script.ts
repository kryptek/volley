import { join } from "node:path";
import { shq } from "../launch";

/**
 * The two files a background sign-in runs (signin.ts), in `<root>/.signin/<acct>/`. Pure, so the
 * fence can re-render a script to check it byte for byte (`sealSigninScript`).
 */

/** Env a sign-in (and a spawned agent under a profile) must not inherit: each would pick a
 * credential other than the profile's own login. */
export const CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
] as const;

export const SIGNIN_SCRIPT = "signin.sh";
export const BROWSER_HELPER = "browser.sh";
/** Where the `$BROWSER` helper leaves the URL Claude Code asked it to open. */
export const SIGNIN_URL_FILE = "url";
/** The one command a sign-in tmux session runs. */
export const SIGNIN_COMMAND = `bash ${SIGNIN_SCRIPT}`;

export interface SigninScriptVars {
  /** The profile's `CLAUDE_CONFIG_DIR`. */
  configDir: string;
  /** `<root>/.signin/<acct>`: the session's cwd, holding the helper and the url file. */
  signinDir: string;
}

/**
 * `signin.sh`: `claude auth login` under the profile, with `$BROWSER` set to the helper. Claude
 * Code hands the helper its localhost-callback authorize URL, so the browser returns the code to
 * the `claude` process itself; volleyd only ever sees the URL (PKCE: the verifier never leaves
 * that process). Never `setup-token`: that prints a bearer token volleyd would have to carry.
 */
export function renderSigninScript(v: SigninScriptVars): string {
  return [
    "#!/usr/bin/env bash",
    "# Written by volleyd for one Claude sign-in. Do not edit.",
    "set -euo pipefail",
    `export CLAUDE_CONFIG_DIR=${shq(v.configDir)}`,
    `export BROWSER=${shq(join(v.signinDir, BROWSER_HELPER))}`,
    `unset ${CREDENTIAL_ENV.join(" ")}`,
    "exec claude auth login",
    "",
  ].join("\n");
}

/** `browser.sh`: writes the URL it is asked to open to the url file (atomically), opens nothing. */
export function renderBrowserHelper(signinDir: string): string {
  const url = shq(join(signinDir, SIGNIN_URL_FILE));
  return [
    "#!/usr/bin/env bash",
    "# Written by volleyd: Claude Code's $BROWSER during a sign-in. Do not edit.",
    "umask 077",
    `printf '%s\\n' "$1" > ${url}.tmp && mv -f ${url}.tmp ${url}`,
    "",
  ].join("\n");
}
