import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMap, parseDocument } from "yaml";
import { writeSecret } from "../auth/context";
import {
  type KeychainItem,
  keychainAddLine,
  keychainReadItemArgv,
  storeInKeychain,
} from "./keychain";
import { CMUX_APP_BINS, serviceEnv } from "./service-path";
import type { Change, ExecResult, SetupContext, StepPlan } from "./step";
import { unifiedDiff } from "./step";

/**
 * The Terminal step of `volley setup`: which terminal volleyd starts local agents in, cmux or
 * tmux, recorded in `$VOLLEYD_HOME/config.yaml` (`fleet.local_terminal`) and setup.json
 * (`terminal`). On macOS with cmux installed it is cmux, and the step checks that volleyd's
 * service can use cmux's socket (below); otherwise (a Mac without cmux, every Linux machine) it
 * is tmux, and the step blocks while tmux is not on the services' PATH, printing how to install
 * it. An explicit `fleet.local_terminal` in config.yaml is kept while its terminal is installed.
 *
 * On macOS, volleyd starts local agents in cmux workspaces. Out of the box cmux lets only programs started
 * inside cmux use its socket, and volleyd runs as a background service, so every spawn is refused.
 * The fit for a service running as the user is cmux's Automation mode (any process of the user,
 * no password), which `volley setup` recommends. Password mode stays an option: setup then asks
 * for the password (hidden), checks it the way the service runs cmux, and stores it like the
 * coordinator's login: the macOS keychain (service `volley-cmux`) and `$VOLLEYD_HOME/cmux.json`
 * (mode 0600). volleyd reads that file each time it runs cmux and hands the password to cmux in
 * its environment (`CMUX_SOCKET_PASSWORD`); it never goes in the service's plist. The check is
 * what volleyd needs, not `cmux ping` (which cmux answers before it checks access):
 * `cmux capabilities --json` (the socket's access mode) and `cmux list-workspaces`.
 */

/** The keychain item holding the cmux socket password. */
export const CMUX_KEYCHAIN_SERVICE = "volley-cmux";
/** The file in $VOLLEYD_HOME volleyd reads the password from. */
export const CMUX_FILE = "cmux.json";

/** Where to set the password in cmux, step by step. */
export const CMUX_PASSWORD_STEPS =
  "In cmux, open cmux → Settings… (⌘,) → Automation → Socket control mode, choose “Password mode”, type a password and click Set.";

/** The recommended mode: where to choose it in cmux, and why. */
export const CMUX_AUTOMATION_STEPS =
  "In cmux, open cmux → Settings… (⌘,) → Automation → Socket control mode and choose “Automation mode”: any program running as you may use cmux's socket, with no password, which is what volleyd (a service running as you) needs.";

/** cmux's socket control modes, as `cmux capabilities --json` reports them (`access_mode`). */
export const CMUX_SOCKET_MODES = ["off", "cmuxOnly", "automation", "password", "allowAll"] as const;
export type CmuxSocketMode = (typeof CMUX_SOCKET_MODES)[number];

/** A mode as cmux's Settings name it. */
export const CMUX_MODE_LABEL: Record<CmuxSocketMode, string> = {
  off: "Off",
  cmuxOnly: "cmux processes only",
  automation: "Automation mode",
  password: "Password mode",
  allowAll: "Full open access",
};

export const isCmuxSocketMode = (v: unknown): v is CmuxSocketMode =>
  typeof v === "string" && (CMUX_SOCKET_MODES as readonly string[]).includes(v);

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

/**
 * Classify a cmux command's result. Any denial is `refused`: cmux's default mode ("only processes
 * started inside cmux can connect"), a wrong or missing socket password ("Invalid password",
 * "Authentication required", `auth_failed`), "Unable to verify client process", and the usual
 * wording of a refusal ("forbidden", "permission denied", "not authorized", "credentials").
 * `not_running` only for socket trouble, so a bad path in a cmux command never reads as "open cmux".
 */
export function classifyCmux(r: Pick<ExecResult, "code" | "stdout" | "stderr">): CmuxAccess {
  if (r.code === 0) return "ok";
  const text = `${r.stderr}\n${r.stdout}`;
  if (
    /access denied|only processes started inside cmux|password|unauthori[sz]ed|not authori[sz]ed|authenticat|auth_failed|auth failed|credential|forbidden|permission denied|unable to verify client/i.test(
      text,
    )
  )
    return "refused";
  if (r.code === 127 || /command not found|no such file or directory: cmux/i.test(text))
    return "missing";
  if (
    /not running|connection refused|ECONNREFUSED|cmux\.sock|socket|could not connect|failed to connect/i.test(
      text,
    )
  )
    return "not_running";
  return "unknown";
}

/** ` (cmux said: <its first line>)`, or nothing when it said nothing. */
export function cmuxSaid(output: string): string {
  const first = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return first === undefined ? "" : ` (cmux said: ${first})`;
}

/** Password mode, the optional alternative to Automation mode. */
const PASSWORD_INSTEAD = `Password mode works too: ${CMUX_PASSWORD_STEPS} Then run \`volley setup --repair\` in a terminal and enter the same password there.`;

/**
 * What to do when volleyd cannot use cmux, in plain words: the setup step's found line and the
 * spawn_failed decision's text. `hasPassword`: volleyd sent a stored password (so it is wrong, or
 * cmux is not in Password mode).
 */
export function cmuxAdvice(access: CmuxAccess, hasPassword: boolean): string {
  switch (access) {
    case "refused":
      return hasPassword
        ? `cmux refused the socket password volleyd has: it changed in cmux, or cmux is no longer in Password mode. ${CMUX_AUTOMATION_STEPS} Then run \`volley setup --repair\`. ${PASSWORD_INSTEAD}`
        : `cmux lets only programs started inside cmux use its socket, and volleyd runs as a background service, so it cannot open workspaces for agents. ${CMUX_AUTOMATION_STEPS} Then run \`volley setup --repair\`. ${PASSWORD_INSTEAD}`;
    case "not_running":
      return `volleyd cannot reach cmux's socket, and it starts local agents in cmux workspaces: open cmux and retry. If cmux is open, its socket is off: ${CMUX_AUTOMATION_STEPS} Then run \`volley setup --repair\`. ${PASSWORD_INSTEAD}`;
    case "missing":
      return "volleyd cannot find the cmux command on its PATH: install cmux (or reinstall it in /Applications), then run `volley setup --repair`.";
    default:
      return `cmux failed in a way volleyd does not recognise. If cmux refuses programs it did not start: ${CMUX_AUTOMATION_STEPS} Then run \`volley setup --repair\`. ${PASSWORD_INSTEAD}`;
  }
}

/**
 * The service-like check, from a process cmux did not start: `cmux capabilities --json` (the
 * socket's access mode) and `cmux list-workspaces`, a workspace call behind the same access check
 * as the `new-workspace` volleyd runs (`cmux ping` is answered before that check, so it passes
 * where real work is refused). The shell exits at once, so its background subshell is handed to
 * launchd before it runs cmux (a child of setup, itself often inside cmux, would pass cmux's check
 * when the service would not). The outputs and exit codes land in `$1`.
 */
export const CMUX_CHECK_SCRIPT =
  '( sleep 1; { cmux capabilities --json; printf \'\\nvolley-cmux-caps=%s\\n\' "$?"; cmux list-workspaces; printf \'\\nvolley-cmux-exit=%s\\n\' "$?"; } >"$1" 2>&1 ) </dev/null >/dev/null 2>&1 &';

/** What the service-like check found: volleyd's access, what cmux said, the socket's mode. */
export interface CmuxCheck {
  access: CmuxAccess;
  output: string;
  /** The access mode cmux reported, or inferred from its refusal; null when it did not say. */
  mode: CmuxSocketMode | null;
}

/** The socket's mode from `cmux capabilities --json`'s answer (or from its refusal). */
export function cmuxModeOf(code: number, text: string): CmuxSocketMode | null {
  if (code === 0) {
    const m = /"access_mode"\s*:\s*"([A-Za-z_-]+)"/.exec(text);
    const v = m?.[1]?.replace(/[-_]([a-z])/g, (_, c: string) => c.toUpperCase());
    return isCmuxSocketMode(v) ? v : null;
  }
  if (/only processes started inside cmux|unable to verify client/i.test(text)) return "cmuxOnly";
  if (/password|auth_required|authenticat/i.test(text)) return "password";
  return null;
}

/** Parse the check's output file; null until it is complete. */
export function parseCmuxCheck(text: string): CmuxCheck | null {
  const exit = /^volley-cmux-exit=(\d+)$/m.exec(text);
  if (exit === null) return null;
  const caps = /^volley-cmux-caps=(\d+)$/m.exec(text);
  const before = (re: RegExp, s: string) => s.slice(0, s.search(re));
  const capsOut = caps === null ? "" : before(/^volley-cmux-caps=/m, text).trim();
  const rest = caps === null ? text : text.slice((caps.index ?? 0) + caps[0].length);
  const output = before(/^volley-cmux-exit=/m, rest).trim();
  const mode = caps === null ? null : cmuxModeOf(Number(caps[1]), capsOut);
  return {
    access: classifyCmux({ code: Number(exit[1]), stdout: output, stderr: "" }),
    output: output !== "" || mode !== null ? output : capsOut,
    mode,
  };
}

/** The output file of the service-like check (in a fresh temp dir). */
export const CMUX_CHECK_OUT = "cmux-check.out";

export const cmuxCheckArgv = (out: string) => ["sh", "-c", CMUX_CHECK_SCRIPT, "sh", out];

/** How long setup waits for the service-like check to report. */
const CHECK_WAIT_MS = 10_000;
const CHECK_POLL_MS = 250;

/** Whether cmux is installed: the app's command-line tool, or `cmux` on the services' PATH. */
export function cmuxInstalled(
  home: string,
  servicePath: string,
  exists: (p: string) => boolean = existsSync,
): boolean {
  return [...CMUX_APP_BINS(home), ...servicePath.split(":")]
    .filter((d) => d !== "")
    .some((d) => exists(join(d, "cmux")));
}

/**
 * Run the check the way volleyd's service would: outside cmux, with the service's environment
 * (and `password` as `CMUX_SOCKET_PASSWORD`, never on argv). Null when setup cannot tell (the
 * command was refused, or nothing reported in time).
 */
export async function checkCmuxAsService(
  ctx: SetupContext,
  serviceEnv: Record<string, string>,
  password: string | null,
): Promise<CmuxCheck | null> {
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
): Promise<CmuxCheck | null> {
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
    const done = parseCmuxCheck(existsSync(out) ? readFileSync(out, "utf-8") : "");
    if (done !== null) {
      if (done.mode !== null) ctx.cmuxSocketMode = done.mode;
      return done;
    }
    await ctx.deps.sleep(CHECK_POLL_MS);
  }
  return null;
}

/** The keychain item holding the cmux socket password. */
const CMUX_ITEM: KeychainItem = {
  service: CMUX_KEYCHAIN_SERVICE,
  account: "volleyd",
  label: "Volley: cmux socket password (volleyd)",
};

/** The `security -i` command that stores the cmux socket password (fed on stdin). */
export const cmuxKeychainAddCommand = (password: string) => keychainAddLine(CMUX_ITEM, password);

const keychainRead = keychainReadItemArgv(CMUX_ITEM);
/** ` (Automation mode)`: the socket's mode as cmux names it, or nothing when it did not say. */
const modeNote = (mode: CmuxSocketMode | null) =>
  mode === null ? "" : ` (cmux's socket control mode: ${CMUX_MODE_LABEL[mode]})`;

/** How the check ran, for the lines that say it passed. */
const HOW_CHECKED =
  "`cmux capabilities` and `cmux list-workspaces`, run the way the service runs them";

/**
 * The cmux part of the Terminal step (macOS): what it found (the socket's mode included, which
 * setup.json records), and the change cmux needs, or null. cmux refusing the service is fixed in
 * cmux: Automation mode (recommended; the change checks again when applied, and asks for the
 * password then if cmux was put in Password mode instead), or Password mode (asked for, hidden).
 */
export async function planCmux(
  ctx: SetupContext,
  serviceEnv: Record<string, string>,
  found: string[],
): Promise<Change | null> {
  if (ctx.deps.platform !== "darwin") return null;
  if (!cmuxInstalled(ctx.home, serviceEnv.PATH ?? "", ctx.deps.exists)) {
    found.push(
      "cmux: not installed, so volleyd starts local agents in tmux (`volley setup --step terminal` checks it)",
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
  const askSecret =
    ctx.deps.interactive && ctx.deps.askSecret !== undefined ? ctx.deps.askSecret : null;
  if (check.access === "ok") {
    // The stored password matters only in Password mode (or a mode cmux did not name).
    const usesPassword = stored !== null && (check.mode === null || check.mode === "password");
    found.push(
      `cmux: volleyd's service reaches it${modeNote(check.mode)} (${HOW_CHECKED}${usesPassword ? ", with the stored socket password" : ""})`,
    );
    if (!usesPassword) return null;
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
        if (missing) await storeInKeychain(ctx.deps.exec, CMUX_ITEM, stored);
        return ["Stored the cmux socket password."];
      },
    };
  }
  // cmux does not let the service in. Never "already done": every case below is a change, whose
  // apply checks again and fails with what cmux said and what to do, so a run that cannot fix it
  // (`--yes` from a script, the Desk) does not report success.
  const said = cmuxSaid(check.output);
  if (check.access === "not_running" || check.access === "missing") {
    const advice = cmuxAdvice(check.access, stored !== null);
    found.push(`cmux: ${advice}${said}`);
    return {
      summary: `Make volleyd's service reach cmux (${check.access === "missing" ? "cmux is not on its PATH" : "cmux's socket is not answering"}): checked again when applied`,
      detail: advice,
      apply: async () => {
        const now = readCmuxPassword(ctx.volleydHome);
        const again = await checkCmuxAsService(ctx, serviceEnv, now);
        if (again?.access === "ok") return ["volleyd's service reaches cmux now."];
        throw new Error(
          again === null
            ? "setup could not check cmux again; run `volley setup --repair` in a terminal"
            : `${cmuxAdvice(again.access, now !== null)}${cmuxSaid(again.output)}`,
        );
      },
    };
  }
  // Refused, or failed in a way setup does not recognise. In Password mode (or a stored password
  // refused when cmux did not say its mode) the password is what is missing; otherwise the fix is
  // cmux's Automation mode.
  const passwordMode = check.mode === "password" || (check.mode === null && stored !== null);
  if (!passwordMode) {
    found.push(
      `cmux: ${cmuxAdvice(check.access, false).replace(/ Then run .*$/, "")}${modeNote(check.mode)}${said}`,
    );
    return {
      summary:
        "Make volleyd's service reach cmux (choose Automation mode in cmux's Settings): checked again when applied",
      detail: `${CMUX_AUTOMATION_STEPS}\n${PASSWORD_OPTION(askSecret !== null)}`,
      apply: async () => {
        const now = readCmuxPassword(ctx.volleydHome);
        const again = await checkCmuxAsService(ctx, serviceEnv, now);
        if (again?.access === "ok") {
          return [`volleyd's service reaches cmux now${modeNote(again.mode)}.`];
        }
        if (again?.mode === "password" && askSecret !== null) {
          return askAndStorePassword(ctx, serviceEnv, askSecret);
        }
        throw new Error(
          again === null
            ? "setup could not check cmux again; run `volley setup --repair` in a terminal"
            : `cmux still does not let volleyd's service in${modeNote(again.mode)}${cmuxSaid(again.output)}. ${CMUX_AUTOMATION_STEPS} Then rerun \`volley setup --step terminal\`.`,
        );
      },
    };
  }
  found.push(
    `cmux: ${cmuxAdvice(check.access, stored !== null).replace(/ Then run .*$/, "")}${modeNote(check.mode)}${said}`,
    `cmux: or keep Password mode and give volleyd its password: ${CMUX_PASSWORD_STEPS}`,
  );
  if (askSecret === null) {
    const where =
      "run `volley setup --step terminal` in a terminal on this machine to enter the socket password (it is asked for there, hidden), or choose Automation mode in cmux instead";
    found.push(`cmux: ${where}`);
    return {
      summary:
        "Give volleyd the cmux socket password (needs a terminal: `volley setup --step terminal`)",
      detail: `${CMUX_PASSWORD_STEPS}\nThen ${where}.`,
      apply: async () => {
        // Switched to Automation mode meanwhile: nothing to enter.
        const again = await checkCmuxAsService(ctx, serviceEnv, readCmuxPassword(ctx.volleydHome));
        if (again?.access === "ok") {
          return [`volleyd's service reaches cmux now${modeNote(again.mode)}.`];
        }
        throw new Error(
          `cmux does not let volleyd's service in${said}, and nobody is here to enter its socket password. ${CMUX_PASSWORD_STEPS} Then ${where}`,
        );
      },
    };
  }
  return {
    summary: `Give volleyd the cmux socket password (asked for now, hidden; stored in the macOS keychain, service ${CMUX_KEYCHAIN_SERVICE}, and ${file}, mode 0600)`,
    detail: `${CMUX_PASSWORD_STEPS}\nThen enter the same password when asked. It is checked with ${HOW_CHECKED} before it is stored, and volleyd reads it from ${file} each time it runs cmux (never from its plist). Automation mode needs no password: ${CMUX_AUTOMATION_STEPS}`,
    apply: () => askAndStorePassword(ctx, serviceEnv, askSecret),
  };
}

/** The Automation change's note on Password mode. */
const PASSWORD_OPTION = (canAsk: boolean) =>
  `Password mode works too: ${CMUX_PASSWORD_STEPS} ${canAsk ? "Setup then asks for the same password when this change is applied (hidden)." : "Then run `volley setup --step terminal` in a terminal on this machine and enter the same password there."}`;

/** Ask for the socket password (hidden), check it the way the service runs cmux, store it. */
async function askAndStorePassword(
  ctx: SetupContext,
  serviceEnv: Record<string, string>,
  askSecret: (prompt: string) => Promise<string | null>,
): Promise<string[]> {
  // Only the line ending goes: a password may start or end with a space.
  const password =
    (await askSecret("cmux socket password (hidden): "))?.replace(/\r?\n$/, "") ?? "";
  if (password === "") {
    throw new Error(
      "no password entered: nothing was stored. Set one in cmux, then rerun `volley setup --step terminal`",
    );
  }
  const again = await checkCmuxAsService(ctx, serviceEnv, password);
  if (again?.access !== "ok") {
    throw new Error(
      again === null
        ? "setup could not check the password with cmux; nothing was stored. Rerun `volley setup --step terminal`"
        : again.access === "refused" || again.access === "unknown"
          ? `cmux refused that password${cmuxSaid(again.output)}; nothing was stored. ${CMUX_PASSWORD_STEPS} Then rerun \`volley setup --step terminal\` and enter the same password`
          : `${cmuxAdvice(again.access, true)}${cmuxSaid(again.output)} Nothing was stored`,
    );
  }
  const written = writeCmuxPassword(ctx.volleydHome, password);
  await storeInKeychain(ctx.deps.exec, CMUX_ITEM, password);
  return [
    `Stored the cmux socket password in the macOS keychain (service ${CMUX_KEYCHAIN_SERVICE}) and ${written} (mode 0600).`,
    `volleyd's service reaches cmux now (${HOW_CHECKED}).`,
  ];
}

/** The terminals volleyd starts local agents in (`fleet.local_terminal`). */
export const LOCAL_TERMINALS = ["cmux", "tmux"] as const;
export type LocalTerminal = (typeof LOCAL_TERMINALS)[number];

export const isLocalTerminal = (v: unknown): v is LocalTerminal =>
  typeof v === "string" && (LOCAL_TERMINALS as readonly string[]).includes(v);

/** The first line of a YAML parser error (the rest quotes the file). */
const yamlError = (message: string | undefined) => (message ?? "").split("\n")[0];

/** volleyd's config file in $VOLLEYD_HOME. */
export const VOLLEYD_CONFIG = "config.yaml";

/**
 * `text` (config.yaml's contents) with `fleet.local_terminal` set to `terminal`, every other key
 * and comment kept. Throws when the text is not YAML, or not a mapping (volleyd would refuse it).
 */
export function withLocalTerminal(text: string, terminal: LocalTerminal): string {
  const doc = parseDocument(text);
  if (doc.errors.length > 0)
    throw new Error(`not valid YAML: ${yamlError(doc.errors[0]?.message)}`);
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new Error("not a YAML mapping of volleyd's settings");
  }
  const fleet = doc.get("fleet");
  if (fleet !== undefined && fleet !== null && !isMap(fleet)) {
    throw new Error("its `fleet` is not a mapping");
  }
  // No `fleet`, or an empty one (`fleet:`, `fleet: ~`, which `get` reads as undefined): set the
  // whole mapping (`setIn` cannot step through a null).
  if (fleet === undefined || fleet === null)
    doc.set("fleet", doc.createNode({ local_terminal: terminal }));
  else doc.setIn(["fleet", "local_terminal"], terminal);
  return doc.toString();
}

/**
 * `fleet.local_terminal` in `text` (config.yaml's contents): the terminal, or null when it is not
 * set (or not one volleyd knows). Throws when `text` is not YAML.
 */
export function localTerminalOf(text: string): LocalTerminal | null {
  const doc = parseDocument(text);
  if (doc.errors.length > 0)
    throw new Error(`not valid YAML: ${yamlError(doc.errors[0]?.message)}`);
  const v = isMap(doc.contents) ? doc.getIn(["fleet", "local_terminal"]) : undefined;
  return isLocalTerminal(v) ? v : null;
}

/** Set `fleet.local_terminal` in $VOLLEYD_HOME/config.yaml (by rename); returns its path. */
export function writeLocalTerminal(volleydHome: string, terminal: LocalTerminal): string {
  const file = join(volleydHome, VOLLEYD_CONFIG);
  const before = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const after = withLocalTerminal(before, terminal);
  mkdirSync(volleydHome, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, after);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

/** The `tmux` on `path` (the services' PATH), or null when there is none. */
export function tmuxOnPath(
  path: string,
  exists: (p: string) => boolean = existsSync,
): string | null {
  for (const d of path.split(":")) {
    if (d !== "" && exists(join(d, "tmux"))) return join(d, "tmux");
  }
  return null;
}

/** How to install tmux here: printed, never run. */
export function tmuxInstallLine(
  platform: NodeJS.Platform,
  exists: (p: string) => boolean = existsSync,
): string {
  if (platform === "darwin") return "brew install tmux";
  if (exists("/usr/bin/apt-get")) return "sudo apt-get install -y tmux";
  if (exists("/usr/bin/dnf")) return "sudo dnf install -y tmux";
  return "install tmux with this machine's package manager (Debian, Ubuntu: sudo apt-get install -y tmux; Fedora: sudo dnf install -y tmux)";
}

/**
 * Step 4 of `volley setup`: the terminal volleyd starts local agents in. macOS with cmux: cmux,
 * and the service-like cmux check (`planCmux`); otherwise tmux, which must be on the services'
 * PATH (Linux never hears of cmux). The choice goes in config.yaml (`fleet.local_terminal`, the
 * change this step makes) and setup.json (`terminal`, recorded when the run ends).
 */
export async function planTerminal(ctx: SetupContext): Promise<StepPlan> {
  const plan: StepPlan = { step: "terminal", title: "Terminal", found: [], changes: [] };
  if (ctx.auth.deps.invokingUser(ctx.auth.env) !== null) {
    plan.skipped =
      "running as root, and volleyd's terminal is your user's: run `volley setup --step terminal` as that user (without sudo)";
    return plan;
  }
  const env = serviceEnv(ctx);
  const exists = ctx.deps.exists ?? existsSync;
  const mac = ctx.deps.platform === "darwin";
  const cmux = mac && cmuxInstalled(ctx.home, env.PATH ?? "", exists);
  const tmux = tmuxOnPath(env.PATH ?? "", exists);
  const file = join(ctx.volleydHome, VOLLEYD_CONFIG);
  const before = existsSync(file) ? readFileSync(file, "utf-8") : "";
  let current: LocalTerminal | null;
  try {
    current = localTerminalOf(before);
  } catch (e) {
    plan.blocked = `${file} is ${e instanceof Error ? e.message : String(e)}: fix it (volleyd cannot start with it either), then rerun \`volley setup --step terminal\``;
    plan.row = `${file} is not valid YAML`;
    return plan;
  }
  const installed = (t: LocalTerminal) => (t === "cmux" ? cmux : tmux !== null);
  const chosen: LocalTerminal | null =
    current !== null && installed(current)
      ? current
      : cmux
        ? "cmux"
        : tmux !== null
          ? "tmux"
          : null;
  if (chosen === null) {
    const line = tmuxInstallLine(ctx.deps.platform, exists);
    plan.blocked = mac
      ? `neither cmux nor tmux is installed, and volleyd starts local agents in one of them: install tmux (${line}), or cmux, then rerun \`volley setup --step terminal\``
      : `tmux is not installed, and volleyd starts local agents in it: install it (${line}), then rerun \`volley setup --step terminal\``;
    plan.row = `missing: ${mac ? "cmux or tmux" : "tmux"} (${line})`;
    return plan;
  }
  if (current !== null && current !== chosen) {
    plan.found.push(
      mac
        ? `${file} chose ${current}, which is not installed here: volleyd starts local agents in ${chosen} instead`
        : `${file} names a terminal volleyd does not run on Linux: volleyd starts local agents in ${chosen} instead`,
    );
  }
  plan.found.push(
    chosen === "cmux"
      ? "Terminal: cmux (volleyd starts local agents in cmux workspaces)"
      : `Terminal: tmux at ${tmux} (volleyd starts local agents in tmux sessions${mac && cmux ? `; ${file} chose it over cmux` : mac ? "; cmux is not installed" : ""})`,
  );
  if (current === chosen) {
    plan.found.push(`fleet.local_terminal: ${chosen} in ${file}`);
    ctx.terminal = chosen;
  } else {
    const after = withLocalTerminal(before, chosen);
    plan.changes.push({
      summary: `Record the local terminal in ${file} (fleet.local_terminal: ${chosen})`,
      detail: unifiedDiff(file, before, after),
      apply: async () => {
        writeLocalTerminal(ctx.volleydHome, chosen);
        ctx.terminal = chosen;
        return [
          `Wrote ${file}: volleyd starts local agents in ${chosen} (a running volleyd from its next start).`,
        ];
      },
    });
  }
  // cmux (macOS): volleyd's service must reach its socket. Its change is applied last: one only a
  // terminal can make fails after the choice is on record.
  if (chosen === "cmux") {
    const change = await planCmux(ctx, env, plan.found);
    if (change !== null) plan.changes.push(change);
  }
  plan.row =
    chosen === "cmux"
      ? `cmux${ctx.cmuxSocketMode !== undefined ? ` (socket control mode: ${CMUX_MODE_LABEL[ctx.cmuxSocketMode]})` : ""}`
      : `tmux (${tmux})`;
  plan.verify = async () => {
    const again = await planTerminal(ctx);
    return [
      ...(again.blocked !== undefined ? [again.blocked] : []),
      ...again.changes.map((c) => `still not in place: ${c.summary}`),
    ];
  };
  return plan;
}
