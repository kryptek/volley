import { basename, dirname } from "node:path";
import type { Check, Facts, ToolFact, ToolName } from "../doctor";

/**
 * The toolchain checks: every tool an agent's session or volleyd's remote steps need, whether
 * `claude` and `bun` resolve on the non-interactive ssh PATH (the PATH volleyd's `ssh <box> bash
 * -s` gets: estimated here, so those two only warn), and the volley checkout (installed from its
 * current bun.lock, and at the supervisor's version when known).
 */

/**
 * Where a tool runs from: the copy on the (estimated) non-interactive ssh PATH, which agents get,
 * else the doctor's own shell's. Every probe and fix runs a tool by this absolute path, so a
 * service with a thin PATH (launchd's) reads the same machine as a terminal does.
 */
export const binOf = (t: ToolFact): string | null => t.sshPath ?? t.path;

/** The package each tool comes in, per Linux package manager. */
const PACKAGES: Record<"apt" | "dnf", Partial<Record<ToolName, string>>> = {
  apt: {
    git: "git",
    tmux: "tmux",
    nc: "netcat-openbsd",
    base64: "coreutils",
    cmp: "diffutils",
  },
  dnf: {
    git: "git",
    gh: "gh",
    tmux: "tmux",
    nc: "nmap-ncat",
    base64: "coreutils",
    cmp: "diffutils",
  },
};

/** How to install a tool on this machine: printed, never run (the doctor explains, never installs). */
function installFix(f: Facts, tool: ToolName): string {
  if (tool === "bun") return "curl -fsSL https://bun.sh/install | bash";
  if (tool === "claude") return "curl -fsSL https://claude.ai/install.sh | bash";
  if (f.platform === "darwin") {
    if (tool === "git") return "xcode-select --install";
    if (tool === "nc" || tool === "base64" || tool === "cmp") {
      return `${tool} ships with macOS in /usr/bin: this shell's PATH is missing /usr/bin`;
    }
    return `brew install ${tool}`;
  }
  if (tool === "gh" && f.pkg !== "dnf") {
    return "install gh from GitHub's own package repository: https://cli.github.com (the distribution's package is old or missing)";
  }
  const name = f.pkg !== null ? PACKAGES[f.pkg][tool] : undefined;
  if (f.pkg !== null && name !== undefined) {
    return `sudo ${f.pkg === "apt" ? "apt-get" : "dnf"} install -y ${name}`;
  }
  return `install ${tool} with this machine's package manager`;
}

/** gh only warns: GitHub's own check (gh.auth) says what pushing needs. */
const WARN_ONLY = new Set<ToolName>(["gh"]);

/** The tools whose non-interactive PATH the supervisor checks (readiness `path_ok`). */
export const ON_PATH = ["bun", "claude"] as const satisfies readonly ToolName[];

/** `1.3.2` out of `bun 1.3.2`, `git version 2.43.0`, `2.0.14 (Claude Code)`: digits only. */
export function versionOf(out: string): string | null {
  const first = out.split("\n")[0] ?? "";
  return /(\d+\.\d+(?:\.\d+)?)/.exec(first)?.[1] ?? null;
}

/**
 * The tag a version names (`0.4.0` → `v0.4.0`); anything else (a sha) as it is. Null for a ref
 * git would read as an option.
 */
export const refFor = (required: string): string | null =>
  required.startsWith("-")
    ? null
    : /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(required)
      ? `v${required}`
      : required;

/** A commit id shortened for display (a full 40-hex id reads like a token to the scrubber). */
const short = (ref: string) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref);

/**
 * How to put `path`'s tool on the non-interactive ssh PATH: printed, never run. ssh runs the
 * login shell with `-c`, so only a file that shell reads non-interactively can extend it.
 */
function pathFix(f: Facts, tool: string, path: string): string {
  const shell = basename(f.shell);
  const dir = dirname(path);
  // zsh reads ~/.zshenv for every shell, fish its universal variables.
  if (shell === "zsh" && f.platform === "darwin") {
    return `echo 'export PATH="${dir}:$PATH"' >> ~/.zshenv`;
  }
  if (shell === "fish") return `fish -c 'fish_add_path -U ${dir}'`;
  // Linux's sshd PATH has /usr/local/bin, whatever the shell.
  if (f.platform !== "darwin") return `sudo ln -s ${path} /usr/local/bin/${tool}`;
  // macOS's sshd PATH has no /usr/local/bin, /usr/bin is read-only, and `bash -c` (or another
  // shell) reads no startup file: nothing the user can write reaches it.
  return `${shell} -c reads no startup file on macOS: make zsh the login shell (chsh -s /bin/zsh, then echo 'export PATH="${dir}:$PATH"' >> ~/.zshenv), or have an admin add SetEnv PATH=${dir}:/usr/bin:/bin:/usr/sbin:/sbin to /etc/ssh/sshd_config; the supervisor's own probe (path_ok) confirms`;
}

export function toolChecks(f: Facts): Check[] {
  const checks: Check[] = [];
  for (const [name, t] of Object.entries(f.tools) as [ToolName, Facts["tools"][ToolName]][]) {
    const at = binOf(t);
    checks.push(
      at !== null
        ? {
            id: `tool.${name}`,
            ok: true,
            severity: WARN_ONLY.has(name) ? "warn" : "block",
            detail: `${name}${t.version !== null ? ` ${t.version}` : ""} at ${at}`,
          }
        : {
            id: `tool.${name}`,
            ok: false,
            severity: WARN_ONLY.has(name) ? "warn" : "block",
            detail: `${name} is not installed`,
            fix: { command: installFix(f, name) },
          },
    );
  }
  // An estimate (sshd's SetEnv, ~/.ssh/environment, pam_env are invisible here): these warn, and
  // the supervisor's own probe of the real ssh PATH (readiness path_ok) decides.
  const via = `sshd's default PATH through ${f.shell} -c`;
  for (const name of ON_PATH) {
    const t = f.tools[name];
    const id = `${name}_on_path`;
    if (t.sshPath !== null) {
      checks.push({
        id,
        ok: true,
        severity: "warn",
        detail: `estimated: ${name} resolves on the non-interactive ssh PATH (${via}) at ${t.sshPath}; the supervisor's own probe (path_ok) decides`,
      });
    } else if (t.path === null) {
      checks.push({ id, ok: false, severity: "warn", detail: `${name} is not installed` });
    } else {
      checks.push({
        id,
        ok: false,
        severity: "warn",
        detail: `estimated: ${name} is at ${t.path}, which the non-interactive ssh PATH (${via}) does not reach; the supervisor's own probe (path_ok) decides`,
        fix: { command: pathFix(f, name, t.path) },
      });
    }
  }
  return [...checks, ...volleyChecks(f)];
}

function volleyChecks(f: Facts): Check[] {
  const v = f.volley;
  const bun = binOf(f.tools.bun);
  const git = binOf(f.tools.git);
  const install = [bun ?? "bun", "install", "--cwd", v.dir, "--frozen-lockfile"];
  const reinstall = {
    command: install.join(" "),
    ...(bun !== null ? { steps: [install] } : {}),
  };
  const checks: Check[] = [];
  if (v.version === null) {
    checks.push({
      id: "volley.installed",
      ok: false,
      severity: "block",
      detail: `${v.dir} is not a volley checkout (no package.json version)`,
      fix: { command: "pass --volley-dir <your volley checkout>" },
    });
  } else if (v.installed && v.lock === "drift") {
    // A frozen install would fail the same way: nothing the doctor may run fixes it.
    checks.push({
      id: "volley.installed",
      ok: false,
      severity: "block",
      detail: `volley ${v.version} in ${v.dir}: package.json and bun.lock disagree (local edits?)`,
      fix: { command: `git -C ${v.dir} status (restore or commit the edits, then bun install)` },
    });
  } else if (v.installed && v.lock === "unknown") {
    checks.push({
      id: "volley.installed",
      ok: false,
      severity: "block",
      detail: `volley ${v.version} in ${v.dir}: cannot verify its dependencies without bun`,
    });
  } else if (!v.installed || v.lock === "stale") {
    checks.push({
      id: "volley.installed",
      ok: false,
      severity: "block",
      detail: !v.installed
        ? `volley ${v.version} in ${v.dir} has no dependencies installed (no node_modules/.bin)`
        : `volley ${v.version} in ${v.dir}: dependencies not installed from its current bun.lock (changed since the doctor's last install)`,
      fix: reinstall,
    });
  } else {
    checks.push({
      id: "volley.installed",
      ok: true,
      severity: "block",
      detail: `volley ${v.version} installed in ${v.dir}`,
    });
  }
  if (v.required === null) {
    checks.push({
      id: "volley.version",
      ok: true,
      severity: "block",
      detail: `volley ${v.version ?? "unknown"} (the supervisor's requirement is not known here)`,
    });
  } else if (v.version === v.required) {
    checks.push({
      id: "volley.version",
      ok: true,
      severity: "block",
      detail: `volley ${v.version}, as the supervisor requires`,
    });
  } else {
    const ref = refFor(v.required) ?? v.required;
    const steps = [
      [git ?? "git", "-C", v.dir, "fetch", "origin", "--tags"],
      [git ?? "git", "-C", v.dir, "checkout", "--detach", ref],
      install,
    ];
    checks.push({
      id: "volley.version",
      ok: false,
      severity: "block",
      detail: `volley ${v.version ?? "unknown"} in ${v.dir}; the supervisor runs ${short(v.required)}`,
      fix: {
        command: steps.map((s) => s.join(" ")).join(" && "),
        ...(bun !== null && git !== null && refFor(v.required) !== null ? { steps } : {}),
      },
    });
  }
  return checks;
}
