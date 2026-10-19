import { dirname } from "node:path";
import type { Check, Facts, ToolName } from "../doctor";

/**
 * The toolchain checks: every tool an agent's session or volleyd's remote steps need, whether
 * `claude` and `bun` resolve on the non-interactive ssh PATH (the PATH volleyd's `ssh <box> bash
 * -s` gets), and the volley checkout (installed, and at the supervisor's version when known).
 */

/** How to install each tool: printed, never run (the doctor explains, never installs). */
const INSTALL: Record<ToolName, string> = {
  bun: "install bun: curl -fsSL https://bun.sh/install | bash",
  git: "install git with your package manager (apt install git, brew install git)",
  gh: "install gh: https://cli.github.com (apt install gh, brew install gh)",
  tmux: "install tmux with your package manager (apt install tmux, brew install tmux)",
  nc: "install nc with your package manager (apt install netcat-openbsd)",
  base64: "install base64 (coreutils) with your package manager",
  cmp: "install cmp (diffutils) with your package manager",
  claude: "install Claude Code: curl -fsSL https://claude.ai/install.sh | bash",
};

/** gh only warns: GitHub's own check (gh.auth) says what pushing needs. */
const WARN_ONLY = new Set<ToolName>(["gh"]);

/** The tools whose non-interactive PATH the supervisor checks (readiness `path_ok`). */
export const ON_PATH = ["bun", "claude"] as const satisfies readonly ToolName[];

/** `1.3.2` out of `bun 1.3.2`, `git version 2.43.0`, `2.0.14 (Claude Code)`: digits only. */
export function versionOf(out: string): string | null {
  const first = out.split("\n")[0] ?? "";
  return /(\d+\.\d+(?:\.\d+)?)/.exec(first)?.[1] ?? null;
}

/** The tag a version names (`0.4.0` → `v0.4.0`); anything else (a sha) as it is. */
export const refFor = (required: string) =>
  /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(required) ? `v${required}` : required;

/** A commit id shortened for display (a full 40-hex id reads like a token to the scrubber). */
const short = (ref: string) => (/^[0-9a-f]{40}$/.test(ref) ? ref.slice(0, 12) : ref);

/** How to put `path`'s tool on the non-interactive ssh PATH: printed, never run. */
function pathFix(platform: NodeJS.Platform, tool: string, path: string): string {
  // macOS's sshd PATH has no /usr/local/bin and /usr/bin is read-only: the login shell's
  // non-interactive startup file (zsh's ~/.zshenv) is the one place left.
  if (platform === "darwin") return `echo 'export PATH="${dirname(path)}:$PATH"' >> ~/.zshenv`;
  return `sudo ln -s ${path} /usr/local/bin/${tool}`;
}

export function toolChecks(f: Facts): Check[] {
  const checks: Check[] = [];
  for (const [name, t] of Object.entries(f.tools) as [ToolName, Facts["tools"][ToolName]][]) {
    const at = t.path ?? t.sshPath;
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
            fix: { command: INSTALL[name] },
          },
    );
  }
  for (const name of ON_PATH) {
    const t = f.tools[name];
    const id = `${name}_on_path`;
    if (t.sshPath !== null) {
      checks.push({
        id,
        ok: true,
        severity: "block",
        detail: `${name} resolves on the non-interactive ssh PATH (${t.sshPath})`,
      });
    } else if (t.path === null) {
      checks.push({ id, ok: false, severity: "block", detail: `${name} is not installed` });
    } else {
      checks.push({
        id,
        ok: false,
        severity: "block",
        detail: `${name} is at ${t.path}, which the non-interactive ssh PATH volleyd uses does not reach`,
        fix: { command: pathFix(f.platform, name, t.path) },
      });
    }
  }
  return [...checks, ...volleyChecks(f)];
}

function volleyChecks(f: Facts): Check[] {
  const v = f.volley;
  const bunReady = f.tools.bun.path !== null;
  const install = ["bun", "install", "--cwd", v.dir, "--frozen-lockfile"];
  const installFix = {
    command: install.join(" "),
    ...(bunReady ? { steps: [install] } : {}),
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
  } else if (!v.installed || !v.lockClean) {
    checks.push({
      id: "volley.installed",
      ok: false,
      severity: "block",
      detail: !v.installed
        ? `volley ${v.version} in ${v.dir} has no dependencies installed (no node_modules/.bin)`
        : `volley ${v.version} in ${v.dir}: dependencies differ from bun.lock`,
      fix: installFix,
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
    const ref = refFor(v.required);
    const steps = [
      ["git", "-C", v.dir, "fetch", "origin", "--tags"],
      ["git", "-C", v.dir, "checkout", "--detach", ref],
      install,
    ];
    checks.push({
      id: "volley.version",
      ok: false,
      severity: "block",
      detail: `volley ${v.version ?? "unknown"} in ${v.dir}; the supervisor runs ${short(v.required)}`,
      fix: {
        command: steps.map((s) => s.join(" ")).join(" && "),
        ...(bunReady && f.tools.git.path !== null ? { steps } : {}),
      },
    });
  }
  return checks;
}
