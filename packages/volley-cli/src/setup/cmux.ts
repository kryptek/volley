import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSecret } from "../auth/context";
import { CMUX_APP_BINS } from "./service-path";
import type { Change, ExecResult, SetupContext } from "./step";

/**
 * volleyd starts local agents in cmux workspaces. Out of the box cmux lets only programs started
 * inside cmux use its socket, and volleyd runs as a background service, so every spawn is refused.
 * cmux's answer is a socket password: `volley setup` explains where to set it in cmux, asks for
 * it (hidden), checks it the way the service runs cmux, and stores it like the coordinator's
 * login: the macOS keychain (service `volley-cmux`) and `$VOLLEYD_HOME/cmux.json` (mode 0600).
 * volleyd reads that file each time it runs cmux and hands the password to cmux in its
 * environment (`CMUX_SOCKET_PASSWORD`); it never goes in the service's plist.
 */

/** The keychain item holding the cmux socket password. */
export const CMUX_KEYCHAIN_SERVICE = "volley-cmux";
/** The file in $VOLLEYD_HOME volleyd reads the password from. */
export const CMUX_FILE = "cmux.json";

/** Where to set the password in cmux, step by step. */
export const CMUX_PASSWORD_STEPS =
  "In cmux, open cmux → Settings… (⌘,) → Automation → Socket control mode, choose “Password mode”, type a password and click Set.";

/** The cmux socket password volleyd uses, or null when none is stored (or the file is unusable). */
export function readCmuxPassword(volleydHome: string): string | null {
  const file = join(volleydHome, CMUX_FILE);
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, "utf-8")) as { socket_password?: unknown } | null;
    return typeof v?.socket_password === "string" && v.socket_password !== ""
      ? v.socket_password
      : null;
  } catch {
    return null;
  }
}

/** Store the password for volleyd (mode 0600, by rename). */
export function writeCmuxPassword(volleydHome: string, password: string): string {
  const file = join(volleydHome, CMUX_FILE);
  mkdirSync(volleydHome, { recursive: true, mode: 0o700 });
  writeSecret(file, `${JSON.stringify({ socket_password: password })}\n`);
  return file;
}

/**
 * The environment volleyd gives cmux: `CMUX_SOCKET_PASSWORD` from `$VOLLEYD_HOME/cmux.json`
 * (read each time, so a new password needs no restart) unless its own environment sets one.
 * Undefined when there is nothing to add.
 */
export function cmuxEnv(
  volleydHome: string,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
  if (env.CMUX_SOCKET_PASSWORD !== undefined && env.CMUX_SOCKET_PASSWORD !== "") return undefined;
  const password = readCmuxPassword(volleydHome);
  return password === null ? undefined : { ...env, CMUX_SOCKET_PASSWORD: password };
}

/** How a cmux command went, for a program outside cmux (volleyd's service). */
export type CmuxAccess = "ok" | "refused" | "not_running" | "missing" | "unknown";

/** Classify a cmux command's result. */
export function classifyCmux(r: Pick<ExecResult, "code" | "stdout" | "stderr">): CmuxAccess {
  if (r.code === 0) return "ok";
  const text = `${r.stderr}\n${r.stdout}`;
  if (
    /access denied|only processes started inside cmux|password|unauthori[sz]ed|authenticat/i.test(
      text,
    )
  )
    return "refused";
  if (r.code === 127 || /command not found|no such file or directory: cmux/i.test(text))
    return "missing";
  if (
    /not running|connection refused|ECONNREFUSED|ENOENT|no such file|socket.*(not found|missing)|could not connect|failed to connect/i.test(
      text,
    )
  )
    return "not_running";
  return "unknown";
}

/**
 * What to do when volleyd cannot use cmux, in plain words: the setup step's found line and the
 * spawn_failed decision's text. `hasPassword`: volleyd sent a stored password (so it is wrong, or
 * cmux is not in Password mode).
 */
export function cmuxAdvice(access: CmuxAccess, hasPassword: boolean): string {
  switch (access) {
    case "refused":
      return hasPassword
        ? `cmux refused the socket password volleyd has: it changed in cmux, or cmux is no longer in Password mode. ${CMUX_PASSWORD_STEPS} Then run \`volley setup --repair\` in a terminal and enter the same password.`
        : `cmux lets only programs started inside cmux use its socket, and volleyd runs as a background service, so it cannot open workspaces for agents. ${CMUX_PASSWORD_STEPS} Then run \`volley setup --repair\` in a terminal and enter the same password there.`;
    case "not_running":
      return "cmux is not running, and volleyd starts local agents in cmux workspaces: open cmux, then retry.";
    case "missing":
      return "volleyd cannot find the cmux command on its PATH: install cmux (or reinstall it in /Applications), then run `volley setup --repair`.";
    default:
      return "cmux failed in a way volleyd does not recognise: check that cmux is running and up to date, then run `volley setup --repair`.";
  }
}

/**
 * The service-like check: `cmux ping` from a process cmux did not start. The shell exits at
 * once, so its background subshell is handed to launchd before it runs cmux (a child of setup,
 * itself often inside cmux, would pass cmux's check when the service would not). The output and
 * exit code land in `$1`.
 */
export const CMUX_CHECK_SCRIPT =
  '( sleep 1; cmux ping >"$1" 2>&1; echo "volley-cmux-exit=$?" >>"$1" ) </dev/null >/dev/null 2>&1 &';

/** The output file of the service-like check (in a fresh temp dir). */
export const CMUX_CHECK_OUT = "cmux-check.out";

export const cmuxCheckArgv = (out: string) => ["sh", "-c", CMUX_CHECK_SCRIPT, "sh", out];

/** How long setup waits for the service-like check to report. */
const CHECK_WAIT_MS = 10_000;
const CHECK_POLL_MS = 250;

/** Whether cmux is installed: the app's command-line tool, or `cmux` on the services' PATH. */
export function cmuxInstalled(home: string, servicePath: string): boolean {
  return [...CMUX_APP_BINS(home), ...servicePath.split(":")]
    .filter((d) => d !== "")
    .some((d) => existsSync(join(d, "cmux")));
}

/**
 * Run `cmux ping` the way volleyd's service would: outside cmux, with the service's environment
 * (and `password` as `CMUX_SOCKET_PASSWORD`, never on argv). Null when setup cannot tell (the
 * command was refused, or nothing reported in time).
 */
export async function checkCmuxAsService(
  ctx: SetupContext,
  serviceEnv: Record<string, string>,
  password: string | null,
): Promise<{ access: CmuxAccess; output: string } | null> {
  // A fresh directory per check: planning changes nothing on the machine.
  const tmp = mkdtempSync(join(tmpdir(), "volley-cmux-check-"));
  try {
    return await runCheck(ctx, serviceEnv, password, join(tmp, CMUX_CHECK_OUT));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runCheck(
  ctx: SetupContext,
  serviceEnv: Record<string, string>,
  password: string | null,
  out: string,
): Promise<{ access: CmuxAccess; output: string } | null> {
  const pick = (k: string) => (ctx.auth.env[k] !== undefined ? { [k]: ctx.auth.env[k] } : {});
  const env: Record<string, string | undefined> = {
    ...serviceEnv,
    HOME: ctx.home,
    ...pick("USER"),
    ...pick("LOGNAME"),
    ...pick("TMPDIR"),
    ...(password !== null ? { CMUX_SOCKET_PASSWORD: password } : {}),
  };
  const started = await ctx.deps.exec(cmuxCheckArgv(out), { env }).catch(() => null);
  if (started === null || started.code !== 0) return null;
  for (let waited = 0; waited <= CHECK_WAIT_MS; waited += CHECK_POLL_MS) {
    const text = existsSync(out) ? readFileSync(out, "utf-8") : "";
    const m = /^volley-cmux-exit=(\d+)$/m.exec(text);
    if (m !== null) {
      const output = text.replace(/^volley-cmux-exit=\d+\n?/m, "").trim();
      return { access: classifyCmux({ code: Number(m[1]), stdout: output, stderr: "" }), output };
    }
    await ctx.deps.sleep(CHECK_POLL_MS);
  }
  return null;
}

/** A double-quoted word for `security -i`'s command line (`\` and `"` escaped). */
const securityQuote = (s: string) => `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

/** The `security -i` command that stores the cmux socket password (fed on stdin). */
export function cmuxKeychainAddCommand(password: string): string {
  return [
    "add-generic-password",
    "-U",
    "-s",
    CMUX_KEYCHAIN_SERVICE,
    "-a",
    "volleyd",
    "-l",
    securityQuote("Volley: cmux socket password (volleyd)"),
    "-w",
    securityQuote(password),
  ].join(" ");
}

const keychainRead = [
  "security",
  "find-generic-password",
  "-s",
  CMUX_KEYCHAIN_SERVICE,
  "-a",
  "volleyd",
  "-w",
];

/** Store `password` in the keychain, reading it back (-i reports failures on stderr only). */
async function storeInKeychain(ctx: SetupContext, password: string): Promise<void> {
  const r = await ctx.deps.exec(["security", "-i"], {
    input: `${cmuxKeychainAddCommand(password)}\n`,
  });
  const back = await ctx.deps.exec(keychainRead);
  if (r.code !== 0 || back.code !== 0 || back.stdout.replace(/\n$/, "") !== password) {
    throw new Error(
      `security add-generic-password failed (exit ${r.code}): ${(r.stderr || back.stderr).trim()}`,
    );
  }
}

/**
 * The cmux part of the Services step (macOS): what it found, and the change that gives volleyd
 * the socket password when cmux refuses it (asked for when applied, hidden), or null.
 */
export async function planCmux(
  ctx: SetupContext,
  serviceEnv: Record<string, string>,
  found: string[],
): Promise<Change | null> {
  if (ctx.deps.platform !== "darwin") return null;
  if (!cmuxInstalled(ctx.home, serviceEnv.PATH ?? "")) {
    found.push(
      "cmux: not installed. volleyd starts local agents in cmux workspaces: install cmux, then rerun `volley setup --step services`",
    );
    return null;
  }
  const stored = readCmuxPassword(ctx.volleydHome);
  const file = join(ctx.volleydHome, CMUX_FILE);
  const check = await checkCmuxAsService(ctx, serviceEnv, stored);
  if (check === null) {
    found.push(
      "cmux: setup could not check that volleyd's service reaches it; run `volley setup --repair` in a terminal",
    );
    return null;
  }
  if (check.access === "ok") {
    found.push(
      `cmux: volleyd's service reaches it (\`cmux ping\`, run the way the service runs it${stored !== null ? ", with the stored socket password" : ""})`,
    );
    if (stored === null) return null;
    const loose = (statSync(file).mode & 0o077) !== 0;
    const k = await ctx.deps.exec(keychainRead).catch(() => null);
    // Exit 44: no such item. Anything else (no keychain to ask) is no change to offer.
    const inKeychain = k !== null && k.code === 0 && k.stdout.replace(/\n$/, "") === stored;
    const missing = k !== null && (k.code === 44 || (k.code === 0 && !inKeychain));
    if (!loose && !missing) return null;
    return {
      summary: `Store the cmux socket password safely (${[...(missing ? [`the macOS keychain, service ${CMUX_KEYCHAIN_SERVICE}`] : []), ...(loose ? [`${file}, mode 0600`] : [])].join("; ")})`,
      detail: "security -i, fed on stdin (never on a command line)",
      apply: async () => {
        if (loose) writeCmuxPassword(ctx.volleydHome, stored);
        if (missing) await storeInKeychain(ctx, stored);
        return ["Stored the cmux socket password."];
      },
    };
  }
  if (check.access !== "refused") {
    found.push(
      `cmux: ${cmuxAdvice(check.access, stored !== null)}${check.output !== "" ? ` (cmux said: ${check.output.split("\n")[0]})` : ""}`,
    );
    return null;
  }
  found.push(`cmux: ${cmuxAdvice("refused", stored !== null).replace(/ Then run .*$/, "")}`);
  if (!ctx.deps.interactive || ctx.deps.askSecret === undefined) {
    found.push(
      "cmux: run `volley setup --step services` in a terminal to enter the socket password (it is asked for there, hidden)",
    );
    return null;
  }
  const askSecret = ctx.deps.askSecret;
  return {
    summary: `Give volleyd the cmux socket password (asked for now, hidden; stored in the macOS keychain, service ${CMUX_KEYCHAIN_SERVICE}, and ${file}, mode 0600)`,
    detail: `${CMUX_PASSWORD_STEPS}\nThen enter the same password when asked. It is checked with \`cmux ping\` the way volleyd's service runs it before it is stored, and volleyd reads it from ${file} each time it runs cmux (never from its plist).`,
    apply: async () => {
      const password = (await askSecret("cmux socket password (hidden): "))?.trim() ?? "";
      if (password === "") {
        throw new Error(
          "no password entered: nothing was stored. Set one in cmux, then rerun `volley setup --step services`",
        );
      }
      const again = await checkCmuxAsService(ctx, serviceEnv, password);
      if (again?.access !== "ok") {
        throw new Error(
          again === null
            ? "setup could not check the password with cmux; nothing was stored. Rerun `volley setup --step services`"
            : again.access === "refused"
              ? `cmux refused that password; nothing was stored. ${CMUX_PASSWORD_STEPS} Then rerun \`volley setup --step services\` and enter the same password`
              : `${cmuxAdvice(again.access, true)} Nothing was stored`,
        );
      }
      const written = writeCmuxPassword(ctx.volleydHome, password);
      await storeInKeychain(ctx, password);
      return [
        `Stored the cmux socket password in the macOS keychain (service ${CMUX_KEYCHAIN_SERVICE}) and ${written} (mode 0600).`,
        "volleyd's service reaches cmux now (`cmux ping`, run the way the service runs it).",
      ];
    },
  };
}
