import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import type { DoctorReport } from "../peer/doctor";
import { GH_LOGIN, GH_SETUP_GIT } from "../setup/signin";
import {
  PUBKEY_RE,
  REMOTE_LOGIN_ARGV,
  Scripts,
  batchArgv,
  connectArgv,
  keygenArgv,
  machineFence,
  sq,
  ttyArgv,
} from "./ssh";

/**
 * `volley machine add <user@host>`: one command on the supervisor's machine (the hub) that makes a
 * bare box a ready paired machine. In order, each step skipped when it is in place already:
 *
 *   1. ssh        key-based ssh to the box; without it, one interactive ssh (ssh's own prompt)
 *                 that installs this machine's key there. BatchMode after that.
 *   2. Volley     `install.sh --peer --version <the hub's tag> --no-setup` sent on stdin (over
 *                 `ssh -t` instead, announced, when the box lacks what only sudo installs)
 *   3. Setup      `volley setup --peer --yes` on the box
 *   4. ssh back   the box's key in this machine's `authorized_keys` (join reaches the hub over
 *                 ssh), this machine's host key in the box's `known_hosts`; on a Mac hub,
 *                 Remote Login must be on
 *   5. Pairing    a code from `peer_invite { for: <name> }`, redeemed on the box with `volley peer
 *                 join <code> --to <hub> --name <name> --target <user@host>`
 *   6. Sign-ins   `gh auth login --web` over `ssh -t`; Claude through volleyd's remote sign-in
 *                 (`volley claude add <name> --machine <name> --wait`, which prints the link);
 *                 `--no-signin` defers both. Then, with GitHub signed in and git unable to commit,
 *                 `volley setup --peer --yes --git-identity` there (git's identity from that account)
 *   7. Doctor     `volley peer doctor --json` on the box: the readiness row; exit 1 when not ready
 *
 * Repositories need no flag: the hub's repositories assigned to all machines reach the box
 * through the clone orchestration. No line printed carries the pairing code or a password.
 */

export type { DoctorReport };

/** git's commit identity on the box, from its GitHub account (setup's, without the sign-ins). */
const GIT_IDENTITY = "volley setup --peer --yes --git-identity";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface MachineDeps {
  /**
   * Runs one command on this machine. `input`: its stdin (a script); `tty`: the command gets the
   * terminal (an interactive ssh), nothing is captured.
   */
  exec: (argv: string[], opts?: { input?: string; tty?: boolean }) => Promise<ExecResult>;
  /** This machine's home (its ssh keys). */
  home: string;
  platform: NodeJS.Platform;
  /** The hub's version: the box is installed at its tag, `v<version>`. */
  version: string;
  /** install.sh's text (sent to the box on stdin). */
  installer: () => string;
  /** argv that runs this volley CLI. */
  volleyArgv: string[];
  /** The machines volleyd has paired. */
  paired: () => string[];
  /** This machine's ssh host keys, `<type> <base64>` each (the box's known_hosts gets them). */
  hostKeys: () => string[];
  /** A pairing code bound to `name` (`peer_invite { for }`), or null (its error printed). */
  mintCode: (name: string) => Promise<string | null>;
  /** No terminal (volleyd's `machine_add`, for the Desk): what replaces each `ssh -t` step. */
  headless?: Headless;
  /** Each step as it starts (the Desk's progress rows). */
  step?: (i: number, title: string) => void;
  /** The doctor's report, once step 7 has it. */
  report?: (r: DoctorReport) => void;
}

/**
 * The run without a terminal: nobody answers a prompt, so ssh's own (the key install) becomes
 * `installKey` with the person's key or password, sudo's (install.sh on a box that lacks what
 * only sudo installs) a `SUDO_ASKPASS` helper on the box that reads `sudo` from a 0600 file
 * removed when the step ends, and the two sign-ins are left to the Machines window's buttons.
 */
export interface Headless {
  /** Every batch step's argv (volleyd's fenced form; `batchArgv` otherwise). */
  batchArgv: string[];
  /** The scripts this run may send (the fence's registry). */
  scripts: Scripts;
  /** Installs this machine's key on the box: runs the rendered `bash -s` script with the person's key or password. */
  installKey: (script: string) => Promise<ExecResult>;
  /** The box's sudo password, or undefined (then a box that needs sudo stops at step 2). */
  sudo?: string;
}

export interface MachineAddOptions {
  target: string;
  name: string;
  /** How the box reaches this machine over ssh (`user@address`): `join --to`. */
  hub: string;
  signin: boolean;
}

const TOTAL = 7;

/** The box's facts, from the probe. */
interface BoxFacts {
  os: string;
  volley: string;
  peer: string;
  missing: string[];
}

/**
 * What `install.sh` runs sudo for when the box lacks it (Linux: apt; a Mac: Homebrew's installer).
 * On Linux it also installs ca-certificates (a package, not a command: asked of dpkg) and, when
 * bun is absent, unzip for bun's installer: the probe's last two lines, `install_linux`'s rules.
 */
const SUDO_TOOLS = { linux: ["git", "tmux", "curl", "gh"], darwin: ["brew"] } as const;

const PROBE = [
  'printf "os=%s\\n" "$(uname -s)"',
  'printf "volley=%s\\n" "$(volley --version 2>/dev/null | head -n 1)"',
  'peer=; if [ -f "$HOME/.volley/peer.json" ]; then peer=$(sed -n \'s/.*"name": *"\\([^"]*\\)".*/\\1/p\' "$HOME/.volley/peer.json" | head -n 1); fi',
  'printf "peer=%s\\n" "$peer"',
  `case "$(uname -s)" in Darwin) tools="${SUDO_TOOLS.darwin.join(" ")}" ;; *) tools="${SUDO_TOOLS.linux.join(" ")}" ;; esac`,
  'missing=; for t in $tools; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done',
  'if [ "$(uname -s)" != Darwin ]; then',
  '  if command -v dpkg >/dev/null 2>&1 && ! dpkg -s ca-certificates >/dev/null 2>&1; then missing="$missing ca-certificates"; fi',
  '  if ! command -v bun >/dev/null 2>&1 && ! command -v unzip >/dev/null 2>&1; then missing="$missing unzip"; fi',
  "fi",
  'printf "missing=%s\\n" "$missing"',
].join("\n");

const INSTALLER_EOF = "VOLLEY_INSTALLER_EOF";

function parseFacts(stdout: string): BoxFacts {
  const get = (k: string) => (new RegExp(`^${k}=(.*)$`, "m").exec(stdout)?.[1] ?? "").trim();
  return {
    os: get("os"),
    volley: get("volley"),
    peer: get("peer"),
    missing: get("missing").split(/\s+/).filter(Boolean),
  };
}

/** The doctor's `--json` report, or null when it printed none. */
export function parseReport(stdout: string): DoctorReport | null {
  try {
    const r = JSON.parse(stdout) as DoctorReport;
    return Array.isArray(r.checks) ? r : null;
  } catch {
    return null;
  }
}

type Check = DoctorReport["checks"][number];

/** A repository's own check: it blocks that repository there, never the machine. */
const repoCheck = (c: Check): boolean => c.repo !== undefined || c.id.startsWith("repo.");

/** Ready: no failing block check about the machine itself (SPEC §4.6.15's readiness). */
export const isReady = (r: DoctorReport): boolean =>
  !r.checks.some((c) => c.severity === "block" && !c.ok && !repoCheck(c));

const isTool = (c: Check) =>
  c.id.startsWith("tool.") || c.id.startsWith("volley.") || c.id.startsWith("machine.");

/**
 * The readiness row: tools, gh, claude, trust, repositories, then ready or not, and the fix of
 * each failing check that has one.
 */
export function renderRow(name: string, target: string, r: DoctorReport): string {
  const ready = isReady(r);
  const failing = (p: (c: Check) => boolean) => r.checks.filter((c) => p(c) && !c.ok);
  const line = (label: string, bad: Check[], good: string) =>
    `  ${label.padEnd(13)}${bad.length === 0 ? `✓ ${good}` : `✗ ${bad.map((c) => c.detail).join("; ")}`}`;
  const v = r.versions;
  const tools = ["volley", "bun", "git", "tmux", "gh", "claude"]
    .map((t) => [t, (v as Record<string, string | null | undefined>)[t]] as const)
    .filter(([, ver]) => typeof ver === "string" && ver !== "")
    .map(([t, ver]) => `${t} ${ver}`)
    .join(", ");
  const repos = r.repos ?? [];
  const none = repos.length === 0 && r.repo === undefined;
  const lines = [
    `${name} (${target}): ${ready ? "ready ✓" : "not ready ✗"}`,
    line("tools", failing(isTool), tools === "" ? "in place" : tools),
    line(
      "gh",
      failing((c) => c.id === "gh.auth"),
      "signed in",
    ),
    line(
      "claude",
      failing((c) => c.id.startsWith("claude.") && c.id !== "claude.trust"),
      `signed in${r.auth.claude_plan !== undefined ? ` (${r.auth.claude_plan})` : ""}`,
    ),
    none
      ? `  ${"trust".padEnd(13)}– no repository yet`
      : line(
          "trust",
          failing((c) => c.id === "claude.trust"),
          "trusted",
        ),
    none
      ? `  ${"repositories".padEnd(13)}– none yet: the hub's repositories for all machines arrive with its clone orchestration (\`volley repo add <owner/name> --machines ${name}\` for one of its own)`
      : line(
          "repositories",
          failing((c) => c.repo !== undefined || c.id.startsWith("repo.")),
          repos.map((x) => x.slug).join(", ") || (r.repo?.path ?? ""),
        ),
  ];
  for (const c of r.checks) {
    if (!c.ok && c.fix !== undefined && c.fix !== "") lines.push(`  fix: ${c.fix}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What a headless install.sh runs first on the box: `sudo` on its PATH is a wrapper running the
 * real one with `-A`, whose `SUDO_ASKPASS` helper reads the password from a 0600 file in a 0700
 * directory; the trap removes the directory when the step ends (an `exit` in install.sh too). The
 * password travels base64 in the script on ssh's stdin: never in an argv, never echoed.
 */
export function sudoPrelude(password: string): string {
  const b64 = Buffer.from(password, "utf-8").toString("base64");
  return [
    'volley_sudo=$(umask 077 && mktemp -d "${TMPDIR:-/tmp}/volley-sudo.XXXXXX")',
    `trap 'rm -rf "$volley_sudo"' EXIT`,
    `( umask 077 && printf '%s' ${sq(b64)} | base64 -d > "$volley_sudo/pw" )`,
    `printf '#!/bin/sh\\ncat "%s/pw"\\n' "$volley_sudo" > "$volley_sudo/askpass"`,
    "volley_real_sudo=$(command -v sudo || true)",
    'if [ -n "$volley_real_sudo" ]; then',
    `  printf '#!/bin/sh\\nSUDO_ASKPASS="%s/askpass" exec "%s" -A "$@"\\n' "$volley_sudo" "$volley_real_sudo" > "$volley_sudo/sudo"`,
    '  chmod 700 "$volley_sudo/askpass" "$volley_sudo/sudo"',
    '  export PATH="$volley_sudo:$PATH"',
    "fi",
  ].join("\n");
}

export async function machineAdd(
  opts: MachineAddOptions,
  deps: MachineDeps,
  io: IO,
): Promise<ExitCode> {
  const { target, name, hub } = opts;
  const headless = deps.headless;
  const scripts = headless?.scripts ?? new Scripts();
  const batchAt = headless?.batchArgv ?? batchArgv(target);
  const fence = machineFence({
    target,
    name,
    home: deps.home,
    volleyArgv: deps.volleyArgv,
    scripts,
    batch: batchAt,
  });
  // Once minted, the code never reaches the terminal (a relayed line included).
  let secret: string | null = null;
  const redact = (s: string) => (secret === null ? s : s.split(secret).join("<code>"));
  const out = (s: string) => io.stdout(redact(s));
  const err = (s: string) => io.stderr(redact(s));
  const run = async (argv: string[], o?: { input?: string; tty?: boolean }) => {
    fence(argv, o);
    return deps.exec(argv, o);
  };
  const batch = (body: string) => run(batchAt, { input: scripts.script(body) });
  const relay = (r: ExecResult) => {
    for (const l of `${r.stdout}${r.stderr}`.split("\n")) if (l.trim() !== "") out(`      ${l}\n`);
  };
  const header = (i: number, title: string) => {
    deps.step?.(i, title);
    out(`\n[${i}/${TOTAL}] ${title}\n`);
  };
  const fail = (msg: string) => {
    err(`volley machine add: ${msg}\n`);
    return EXIT.ERROR;
  };
  const why = (r: ExecResult) =>
    (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`).split("\n").pop() ?? "";

  out(`volley machine add ${target} (as ${name}; it reaches this machine at ${hub})\n`);

  // 1. ssh: the hub's key on the box, after one interactive ssh at most.
  header(1, "ssh");
  let probe = await batch(PROBE);
  if (probe.code === 255) {
    const keyFile = join(deps.home, ".ssh", "id_ed25519.pub");
    const pubFile = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"]
      .map((f) => join(deps.home, ".ssh", f))
      .find((f) => existsSync(f));
    let pub = pubFile;
    if (pub === undefined) {
      out(
        `  → Create this machine's ssh key (${keyFile}, no passphrase: every later step is BatchMode)\n`,
      );
      const k = await run(keygenArgv(deps.home));
      if (k.code !== 0 || !existsSync(keyFile)) return fail(`ssh-keygen failed: ${why(k)}`);
      pub = keyFile;
    }
    const key = readFileSync(pub, "utf-8").trim();
    if (!PUBKEY_RE.test(key)) return fail(`${pub} is not a public key`);
    const body = [
      "umask 077",
      'mkdir -p "$HOME/.ssh"',
      'touch "$HOME/.ssh/authorized_keys"',
      `grep -qxF ${sq(key)} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${sq(key)} >> "$HOME/.ssh/authorized_keys"`,
    ].join("\n");
    if (headless !== undefined) {
      out(`  → Install this machine's key (${pub}) in ${target}'s ~/.ssh/authorized_keys\n`);
      const c = await headless.installKey(scripts.script(body));
      if (c.code !== 0) {
        return fail(
          `could not sign in to ${target} to install this machine's key (${why(c)}): check the address and the key or password`,
        );
      }
    } else {
      out(
        `  → Install this machine's key (${pub}) in ${target}'s ~/.ssh/authorized_keys: ssh connects once on this terminal, and any prompt is ssh's own\n`,
      );
      const c = await run(connectArgv(target, scripts.command(body)), { tty: true });
      if (c.code !== 0)
        return fail(
          `the ssh to ${target} that installs this machine's key failed (exit ${c.code})`,
        );
    }
    probe = await batch(PROBE);
  }
  if (probe.code !== 0) {
    return fail(
      `cannot reach ${target} with BatchMode ssh (${why(probe)}); check \`ssh ${target} true\``,
    );
  }
  out(`  ✓ key-based ssh to ${target}\n`);
  const facts = parseFacts(probe.stdout);
  const tag = `v${deps.version}`;

  // 2–3. Volley in peer mode at the hub's tag, then its setup.
  header(2, "Volley");
  const pairedHere = deps.paired().includes(name);
  const boxPaired = facts.peer !== "";
  if (boxPaired && facts.peer !== name) {
    return fail(
      `${target} is paired as ${facts.peer} already: run \`volley machine add ${target} --name ${facts.peer}\``,
    );
  }
  let installed = false;
  if (boxPaired) {
    out(
      `  ✓ volley ${facts.volley || "(unknown version)"} on ${name}, paired already${facts.volley === deps.version ? "" : ` (moving it to ${tag} is \`volley deploy ${tag}\`)`}\n`,
    );
  } else if (facts.volley === deps.version) {
    out(`  ✓ volley ${facts.volley} on ${name}\n`);
  } else {
    const args = ["--peer", "--version", tag, "--no-setup"];
    const installer = deps.installer();
    if (installer.split("\n").includes(INSTALLER_EOF))
      return fail("install.sh cannot be sent as is");
    let r: ExecResult;
    const them = facts.missing.length === 1 ? "it" : "them";
    if (facts.missing.length > 0 && headless !== undefined) {
      if (headless.sudo === undefined) {
        return fail(
          `${name} lacks ${facts.missing.join(", ")}, and only sudo installs ${them} there: give its sudo password, or install ${them} on ${target} and add it again`,
        );
      }
      out(
        `  ${name} lacks ${facts.missing.join(", ")}: the installer runs sudo there to install ${them}, with the sudo password you gave (a 0600 file there, removed when this step ends).\n`,
      );
      out(`  → install.sh ${args.join(" ")}\n`);
      // In a subshell, removed after it too: a trap install.sh set would replace the prelude's.
      r = await batch(
        `${sudoPrelude(headless.sudo)}\n(\nset -- ${args.join(" ")}\n${installer}\n)\nvolley_rc=$?\nrm -rf "$volley_sudo"\nexit "$volley_rc"`,
      );
      relay(r);
    } else if (facts.missing.length > 0) {
      out(
        `  ${name} lacks ${facts.missing.join(", ")}: the installer runs sudo there to install ${them}, on this terminal (the password prompt is sudo's).\n`,
      );
      const up = await batch(
        `mkdir -p "$HOME/.volley" && cat > "$HOME/.volley/install.sh" <<'${INSTALLER_EOF}'\n${installer.replace(/\n$/, "")}\n${INSTALLER_EOF}`,
      );
      if (up.code !== 0) return fail(`could not copy install.sh to ${target}: ${why(up)}`);
      out(`  → install.sh ${args.join(" ")} (over ssh -t)\n`);
      r = await run(
        ttyArgv(target, scripts.command(`sh "$HOME/.volley/install.sh" ${args.join(" ")}`)),
        {
          tty: true,
        },
      );
    } else {
      out(`  → install.sh ${args.join(" ")}\n`);
      r = await batch(`set -- ${args.join(" ")}\n${installer}`);
      relay(r);
    }
    if (r.code !== 0) return fail(`install.sh failed on ${target} (exit ${r.code})`);
    installed = true;
  }

  header(3, "Setup");
  if (boxPaired && !installed) {
    out("  ✓ set up already (`volley setup --peer` on the box checks it again)\n");
  } else {
    out("  → volley setup --peer --yes\n");
    const r = await batch("volley setup --peer --yes");
    relay(r);
    if (r.code !== 0) return fail(`volley setup --peer failed on ${target} (exit ${r.code})`);
  }

  // 4. ssh back: join reaches this machine over ssh.
  header(4, "ssh back");
  if (deps.platform === "darwin") {
    const rl = await run([...REMOTE_LOGIN_ARGV]);
    if (rl.code !== 0) {
      const blocked = `Remote Login is off on this Mac, and ${name} reaches it over ssh. Turn it on (System Settings → General → Sharing → Remote Login, or \`sudo systemsetup -setremotelogin on\`), then run this again.`;
      // Headless (volleyd's machine_add): through fail(), so the answer and the row carry the fix.
      if (headless !== undefined) return fail(blocked);
      out(`  ✗ Blocked: ${blocked}\n`);
      return EXIT.ERROR;
    }
    out("  ✓ Remote Login is on\n");
  }
  const hubHost = hub.slice(hub.lastIndexOf("@") + 1);
  const known = deps
    .hostKeys()
    .filter((k) => /^[a-z0-9-]+ [A-Za-z0-9+/=]+$/.test(k))
    .map((k) => `${hubHost} ${k}`);
  const keys = await batch(
    [
      "set -e",
      "umask 077",
      'mkdir -p "$HOME/.ssh"',
      `[ -f "$HOME/.ssh/id_ed25519.pub" ] || { ssh-keygen -t ed25519 -N '' -q -f "$HOME/.ssh/id_ed25519" </dev/null; echo volley-key-created; }`,
      'touch "$HOME/.ssh/known_hosts"',
      ...known.map(
        (l) =>
          `grep -qxF ${sq(l)} "$HOME/.ssh/known_hosts" || { printf '%s\\n' ${sq(l)} >> "$HOME/.ssh/known_hosts"; echo volley-known-host-added; }`,
      ),
      'printf "volley-pubkey=%s\\n" "$(cat "$HOME/.ssh/id_ed25519.pub")"',
    ].join("\n"),
  );
  const boxKey = (/^volley-pubkey=(.*)$/m.exec(keys.stdout)?.[1] ?? "").trim();
  if (keys.code !== 0 || !PUBKEY_RE.test(boxKey)) {
    return fail(`could not read ${name}'s ssh key: ${why(keys)}`);
  }
  if (keys.stdout.includes("volley-key-created"))
    out(`  → Created ${name}'s ssh key (~/.ssh/id_ed25519 there)\n`);
  if (keys.stdout.includes("volley-known-host-added")) {
    out(`  → ${name} trusts this machine's host key as ${hubHost} (its ~/.ssh/known_hosts)\n`);
  }
  const authorized = join(deps.home, ".ssh", "authorized_keys");
  const lines = existsSync(authorized) ? readFileSync(authorized, "utf-8").split("\n") : [];
  if (lines.some((l) => l.trim() === boxKey)) {
    out(`  ✓ ${name}'s key is in ~/.ssh/authorized_keys here\n`);
  } else {
    mkdirSync(join(deps.home, ".ssh"), { recursive: true, mode: 0o700 });
    const text =
      lines.length > 0 && lines[lines.length - 1] !== "" ? `\n${boxKey}\n` : `${boxKey}\n`;
    appendFileSync(authorized, text, { mode: 0o600 });
    chmodSync(authorized, 0o600);
    out(
      `  → Authorized ${name}'s key in ~/.ssh/authorized_keys here: \`volley peer join\` there reaches this machine over ssh\n`,
    );
  }

  // 5. Pairing.
  header(5, "Pairing");
  if (boxPaired && pairedHere) {
    out(`  ✓ paired as ${name}\n`);
  } else {
    const code = await deps.mintCode(name);
    if (code === null)
      return fail(`no pairing code for ${name}: nothing was changed on ${target} for it`);
    secret = code;
    const replace = pairedHere;
    out(
      `  → ${replace ? "Re-pair" : "Pair"} ${name}: a code bound to it (volley peer invite --for ${name}), redeemed there (volley peer join <code> --to ${hub} --name ${name} --target ${target}${replace ? " --replace" : ""})\n`,
    );
    const r = await batch(
      `volley peer join ${sq(code)} --to ${sq(hub)} --name ${sq(name)} --target ${sq(target)}${replace ? " --replace" : ""}`,
    );
    relay(r);
    if (r.code !== 0) return fail(`volley peer join failed on ${target} (exit ${r.code})`);
  }

  // 6–7. The doctor, the sign-ins it shows missing, and the row.
  const doctor = async () => {
    const r = await batch("volley peer doctor --json");
    return parseReport(r.stdout) ?? why(r);
  };
  let report = await doctor();
  header(6, "Sign-ins");
  if (typeof report === "string")
    return fail(`volley peer doctor printed no report on ${target}: ${report}`);
  const ghIn = report.auth.gh === "ok" || report.auth.gh === "no_write";
  const claudeIn = report.auth.claude === "signed_in" || (report.claude_logins ?? []).length > 0;
  if (ghIn && claudeIn) {
    out("  ✓ GitHub and Claude are signed in\n");
  } else if (headless !== undefined) {
    out(
      `  – ${[ghIn ? null : "GitHub", claudeIn ? null : "Claude"].filter(Boolean).join(" and ")}: the sign-in buttons on ${name}'s card\n`,
    );
  } else if (!opts.signin) {
    out(
      `  – deferred (--no-signin): later, \`ssh -t ${target} ${GH_LOGIN.join(" ")}\` and \`volley claude add ${name} --machine ${name}\`\n`,
    );
  } else {
    let ran = false;
    if (!ghIn) {
      out(
        `  → GitHub: ${GH_LOGIN.join(" ")} on ${name}, on this terminal (gh prints the code to enter in your browser)\n`,
      );
      const g = await run(
        ttyArgv(target, scripts.command(`${GH_LOGIN.join(" ")} && ${GH_SETUP_GIT.join(" ")}`)),
        { tty: true },
      );
      if (g.code !== 0) out(`  ✗ the GitHub sign-in did not finish (exit ${g.code})\n`);
      ran = true;
    } else out("  ✓ GitHub is signed in\n");
    if (!claudeIn) {
      out(`  → Claude: volleyd signs ${name} in (it prints the link to open, on any device)\n`);
      const c = await run(
        [...deps.volleyArgv, "claude", "add", name, "--machine", name, "--wait"],
        {
          tty: true,
        },
      );
      if (c.code !== 0) out(`  ✗ the Claude sign-in did not finish (exit ${c.code})\n`);
      ran = true;
    } else out("  ✓ Claude is signed in\n");
    if (ran) report = await doctor();
    if (typeof report === "string")
      return fail(`volley peer doctor printed no report on ${target}: ${report}`);
  }
  // git's commit identity, from the box's GitHub account once it is signed in (an agent's first
  // commit dies "Author identity unknown" without one): that alone, never the box's sign-ins.
  const identity = report.checks.find((c) => c.id === "git.identity");
  const ghNow = report.auth.gh === "ok" || report.auth.gh === "no_write";
  if (identity !== undefined && !identity.ok) {
    if (ghNow) {
      out(`  → git: a commit identity from the GitHub account (${GIT_IDENTITY} on ${name})\n`);
      const r = await batch(GIT_IDENTITY);
      relay(r);
      if (r.code !== 0) out(`  ✗ git's commit identity was not set (exit ${r.code})\n`);
      report = await doctor();
      if (typeof report === "string")
        return fail(`volley peer doctor printed no report on ${target}: ${report}`);
    } else {
      out(`  – git's commit identity: once GitHub is signed in, \`${GIT_IDENTITY}\` on ${name}\n`);
    }
  }

  header(7, "Doctor");
  deps.report?.(report);
  out(renderRow(name, target, report));
  return isReady(report) ? EXIT.OK : EXIT.ERROR;
}
