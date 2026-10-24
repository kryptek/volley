import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lanAddress } from "volley-cli/commands/setup";
import { type IO, realIO } from "volley-cli/io";
import {
  type DoctorReport,
  type ExecResult as StepResult,
  isReady,
  machineAdd,
} from "volley-cli/machine/add";
import { Scripts, readHostKeys } from "volley-cli/machine/ssh";
import { isValidAgentId } from "volley-mcp/topics";
import { DAEMON_DEFAULTS } from "./config-defaults";
import { type ExecFn, type ExecOptions, exec as realExec } from "./exec";
import { isSshTarget, machineAddArgv, mintMachineAddToken } from "./fence";
import { shq } from "./launch";
import { RESERVED_NAMES } from "./peers";

/**
 * `machine_add` (SPEC §4.6.14): the Desk's Settings › Machines › Add a bare machine. volleyd runs
 * volley-cli's `volley machine add` step list (src/machine/add.ts) for an admin without a
 * terminal, each step through its fenced exec with a machine-add token (the fence's MACHINE ADD
 * rows), and streams each line as a progress row on the op's reply topic.
 *
 * What a terminal would do differently: the first ssh, which installs this machine's key on the
 * box, signs in with the person's key file (`ssh -i`) or password; a password is written to a
 * 0600 file in a fresh 0700 directory, read by an `SSH_ASKPASS` helper there, and the directory is
 * removed when that one step ends. A box lacking what only sudo installs gets install.sh with a
 * `SUDO_ASKPASS` helper on the box (volley-cli's `sudoPrelude`), announced first; without a sudo
 * password the run stops there. The two sign-ins are left to the Machines window's buttons.
 *
 * Neither password is journaled, logged or answered: every row and the answer have them (and the
 * pairing code, which add.ts already hides) cut out before they leave this module.
 */

export const MACHINE_ADD_STEPS = 7;

/** A parsed request: the box, its name, how the first ssh signs in, the sudo password. */
export type MachineAddRequest = {
  address: string;
  name: string;
  sudo?: string;
} & ({ key: string; password?: never } | { password: string; key?: never });

/** One progress row: a step starting (no `line`), a line of it, or its failure. */
export interface MachineRow {
  step: number;
  total: number;
  title: string;
  state: "running" | "failed";
  line?: string;
}

/** What a run needs from the supervisor's machine (the hub). */
export interface MachineAddEnv {
  exec: ExecFn;
  /** This machine's home: its ssh keys and authorized_keys. */
  home: string;
  platform: NodeJS.Platform;
  /** The supervisor's version: the box is installed at `v<version>`. */
  version: string;
  /** install.sh's text. */
  installer: () => string;
  /** This machine's ssh host keys (the box's known_hosts gets them). */
  hostKeys: () => string[];
  /** How the box reaches this machine over ssh (`user@address`). */
  hub: string;
  /** Where the askpass helper's directory is made. */
  tmp: string;
}

/** The real hub: this checkout's install.sh, `$USER@<this machine's LAN address>`. */
export function realMachineAddEnv(version: string): MachineAddEnv {
  const installer = fileURLToPath(new URL("../../../install.sh", import.meta.url));
  return {
    exec: realExec,
    home: homedir(),
    platform: process.platform,
    version,
    installer: () => readFileSync(installer, "utf-8"),
    hostKeys: () => readHostKeys(),
    hub: `${userInfo().username}@${lanAddress()}`,
    tmp: tmpdir(),
  };
}

/** The supervisor's pairing state. */
export interface MachineAddHub {
  /** The machines it paired. */
  paired: () => string[];
  /** Its configured hosts. */
  hosts: () => string[];
  /** A pairing code bound to `name` (journaled `peer_invited`, never the code). */
  mint: (name: string) => string;
}

export type MachineAddOutcome =
  | {
      ok: true;
      result: {
        name: string;
        target: string;
        ready: boolean;
        signin: { gh: boolean; claude: boolean };
        checks: DoctorReport["checks"];
        doctor_at?: string;
      };
    }
  | { ok: false; error: string; step?: number };

/** The short name of `host` (`box-a.lan` → `box-a`), as `volley machine add` defaults it. */
export function defaultMachineName(host: string): string {
  return (host.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 63);
}

/** The request's fields, checked (an error's text otherwise). */
export function parseMachineAdd(p: Record<string, unknown>): MachineAddRequest | string {
  const { address, auth, sudo_ref: sudo, name } = p;
  if (typeof address !== "string" || !address.includes("@") || !isSshTarget(address)) {
    return "address must be an ssh destination (user@host)";
  }
  const a = (typeof auth === "object" && auth !== null ? auth : {}) as Record<string, unknown>;
  const hasKey = a.key !== undefined;
  const hasPw = a.password_ref !== undefined;
  if (hasKey === hasPw) return "auth must be { key } or { password_ref }";
  if (hasKey && (typeof a.key !== "string" || !isAbsolute(a.key) || /[\n\0]/.test(a.key))) {
    return "auth.key must be an absolute path to a key file on the supervisor's machine";
  }
  if (hasPw && (typeof a.password_ref !== "string" || a.password_ref === "")) {
    return "auth.password_ref must be the password";
  }
  if (sudo !== undefined && (typeof sudo !== "string" || sudo === "")) {
    return "sudo_ref must be the box's sudo password";
  }
  const host = address.slice(address.lastIndexOf("@") + 1);
  const n = name ?? defaultMachineName(host);
  if (typeof n !== "string" || !isValidAgentId(n) || RESERVED_NAMES.has(n)) {
    return `name must match [a-z0-9][a-z0-9_-]{0,62} and not be one of ${[...RESERVED_NAMES].join(", ")}`;
  }
  return {
    address,
    name: n,
    ...(hasKey ? { key: a.key as string } : { password: a.password_ref as string }),
    ...(sudo !== undefined ? { sudo: sudo as string } : {}),
  } as MachineAddRequest;
}

/**
 * Run the step list for `req`, calling `row` with each progress row as it happens. Refusals that
 * need nothing run (a host configured by hand, a key file that is not there) come first.
 */
export async function runMachineAdd(
  req: MachineAddRequest,
  env: MachineAddEnv,
  hub: MachineAddHub,
  row: (r: MachineRow) => void,
): Promise<MachineAddOutcome> {
  const { address: target, name } = req;
  if (hub.hosts().includes(name) && !hub.paired().includes(name)) {
    return {
      ok: false,
      error: `"${name}" is a host configured by hand, not one this supervisor paired: pick another name`,
    };
  }
  if (req.key !== undefined && !existsSync(req.key)) {
    return { ok: false, error: `no key file at ${req.key} on the supervisor's machine` };
  }
  const secrets = [req.password, req.sudo]
    .filter((s): s is string => s !== undefined && s !== "")
    .flatMap((s) => [s, Buffer.from(s, "utf-8").toString("base64")]);
  const redact = (s: string) => secrets.reduce((t, x) => t.split(x).join("<password>"), s);

  const scripts = new Scripts();
  const base = { target, home: env.home, scripts, key: req.key ?? null, askpass: null };
  const token = mintMachineAddToken(base);
  const timeoutMs = DAEMON_DEFAULTS.machine_add_step_timeout_ms;
  const run = (argv: string[], o: ExecOptions) => env.exec(argv, { timeoutMs, ...o });

  const installKey = async (script: string): Promise<StepResult> => {
    if (req.key !== undefined) {
      return run(machineAddArgv(target, "key", req.key), { machineAdd: token, input: script });
    }
    // The password: a 0600 file in a fresh 0700 directory, read by the helper ssh runs.
    const dir = mkdtempSync(join(env.tmp, "volleyd-askpass-"));
    try {
      const file = join(dir, "pw");
      writeFileSync(file, req.password, { mode: 0o600 });
      const askpass = join(dir, "askpass");
      writeFileSync(askpass, `#!/bin/sh\ncat ${shq(file)}\n`, { mode: 0o700 });
      return await run(machineAddArgv(target, "password"), {
        machineAdd: mintMachineAddToken({ ...base, askpass }),
        input: script,
        env: {
          ...process.env,
          SSH_ASKPASS: askpass,
          SSH_ASKPASS_REQUIRE: "force",
          SUDO_ASKPASS: undefined,
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  let step = 0;
  let title = "";
  let failure: string | null = null;
  let report: DoctorReport | null = null;
  const emit = (text: string, failed: boolean) => {
    if (step === 0) return; // the run's own first line, before step 1
    for (const raw of text.split("\n")) {
      const line = redact(raw.trim());
      if (line === "" || /^\[\d+\/\d+\] /.test(line)) continue;
      row({ step, total: MACHINE_ADD_STEPS, title, state: failed ? "failed" : "running", line });
    }
  };
  const io: IO = {
    stdout: (s) => emit(s, false),
    stderr: (s) => {
      failure = redact(s.replace(/^volley machine add: /, "").trim());
      emit(failure, true);
    },
    now: realIO.now,
  };

  await machineAdd(
    { target, name, hub: env.hub, signin: false },
    {
      exec: (argv, o) =>
        run(argv, { machineAdd: token, ...(o?.input !== undefined ? { input: o.input } : {}) }),
      home: env.home,
      platform: env.platform,
      version: env.version,
      installer: env.installer,
      volleyArgv: [],
      paired: hub.paired,
      hostKeys: env.hostKeys,
      mintCode: async (n) => hub.mint(n),
      headless: {
        batchArgv: machineAddArgv(target, "batch"),
        scripts,
        installKey,
        ...(req.sudo !== undefined ? { sudo: req.sudo } : {}),
      },
      step: (i, t) => {
        step = i;
        title = t;
        row({ step: i, total: MACHINE_ADD_STEPS, title: t, state: "running" });
      },
      report: (r) => {
        report = r;
      },
    },
    io,
  );
  const r = report as DoctorReport | null;
  if (r === null) {
    return {
      ok: false,
      error: `${step > 0 ? `step ${step} (${title}): ` : ""}${failure ?? "the run stopped"}`,
      ...(step > 0 ? { step } : {}),
    };
  }
  return {
    ok: true,
    result: {
      name,
      target,
      ready: isReady(r),
      signin: {
        gh: r.auth.gh === "ok" || r.auth.gh === "no_write",
        claude: r.auth.claude === "signed_in" || (r.claude_logins ?? []).length > 0,
      },
      checks: r.checks,
      ...(r.doctor_at !== undefined ? { doctor_at: r.doctor_at } : {}),
    },
  };
}
