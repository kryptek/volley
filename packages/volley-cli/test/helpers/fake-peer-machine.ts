import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ExecResult, PeerExec } from "../../src/commands/peer";
import { type DoctorDeps, LOCK_MARKER, type ToolName, lockHash } from "../../src/peer/doctor";

/**
 * A fake machine for `volley peer doctor`: real temp directories (home, the volley checkout, the
 * wave repo's parent) and a scripted exec that answers `command -v`, `--version`, `gh`, `claude`,
 * `git` and `bun` like a box would, and changes state when a fix runs (`bun install` creates
 * `node_modules/.bin`, `git clone` creates the clone).
 */

export interface FakeTool {
  /** Where `command -v` finds it in the doctor's own shell (null: not installed there). */
  path: string | null;
  /** Where it resolves on the non-interactive ssh PATH (null: not there). */
  sshPath: string | null;
  version: string;
}

export interface FakeMachineOptions {
  platform?: NodeJS.Platform;
  tools?: Partial<Record<ToolName, Partial<FakeTool>>>;
  /** `node_modules/.bin` exists in the volley checkout, installed from its current `bun.lock`. */
  volleyInstalled?: boolean;
  /** Installed, but from an older `bun.lock` (a `git pull` without a reinstall). */
  staleInstall?: boolean;
  /** `package.json` and `bun.lock` disagree (`bun install --frozen-lockfile` fails). */
  lockDrift?: boolean;
  volleyVersion?: string;
  /** The login shell (default `/bin/bash`). */
  shell?: string;
  /** Linux's package manager on PATH (default apt). */
  pkg?: "apt" | "dnf" | null;
  /** The wave repo: absent (no dir), an empty dir, or a git clone. */
  repo?: "clone" | "empty" | "absent";
  origin?: string;
  /** `git ls-remote` of the release branch succeeds. */
  fetchable?: boolean;
  gh?: { signedIn?: boolean; user?: string; permission?: string };
  /** `claude auth status`'s JSON (or raw text), and its exit code. */
  claudeStatus?: unknown;
  claudeCode?: number;
  claudeJson?: unknown;
  /** Write a `~/.claude.json` that trusts the repo's folder. */
  trusted?: boolean;
  /** A token-shaped string appended to every output the box prints. */
  plant?: string;
  /** `vm_stat`'s output (macOS memory); the default reads 42% available on 16 GB. */
  vmStat?: string;
}

export interface Call {
  argv: string[];
  input?: string;
}

const TOOL_VERSIONS: Record<ToolName, string> = {
  bun: "1.3.2",
  git: "git version 2.43.0",
  gh: "gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases/tag/v2.62.0",
  tmux: "tmux 3.4",
  nc: "",
  base64: "base64 (GNU coreutils) 9.4",
  cmp: "cmp (GNU diffutils) 3.10",
  claude: "2.0.14 (Claude Code)",
};

export function fakePeerMachine(opts: FakeMachineOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "volley-fake-box-"));
  const home = join(root, "home");
  const volleyDir = join(root, "volley");
  const repoPath = join(root, "src", "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(volleyDir, { recursive: true });
  const checkout = (version: string) => {
    writeFileSync(join(volleyDir, "package.json"), JSON.stringify({ name: "volley", version }));
    writeFileSync(join(volleyDir, "bun.lock"), `{ "lockfileVersion": 1, "for": "${version}" }\n`);
  };
  checkout(opts.volleyVersion ?? "0.4.0");
  const state = {
    installed: opts.volleyInstalled ?? true,
    isGit: (opts.repo ?? "clone") === "clone",
    origin: opts.origin ?? "git@github.com:example-org/example-repo.git",
  };
  if (state.installed) {
    mkdirSync(join(volleyDir, "node_modules", ".bin"), { recursive: true });
    // What the doctor's own install leaves behind: the hash of the bun.lock it installed.
    writeFileSync(
      join(volleyDir, "node_modules", LOCK_MARKER),
      opts.staleInstall === true ? "0".repeat(64) : (lockHash(volleyDir) as string),
    );
  }
  if (opts.repo !== "absent") mkdirSync(repoPath, { recursive: true });
  if (state.isGit) mkdirSync(join(repoPath, ".git"), { recursive: true });
  const claudeJson =
    opts.claudeJson ??
    (opts.trusted === true
      ? { projects: { [repoPath]: { hasTrustDialogAccepted: true } } }
      : undefined);
  if (claudeJson !== undefined)
    writeFileSync(join(home, ".claude.json"), JSON.stringify(claudeJson));

  const tools = {} as Record<ToolName, FakeTool>;
  for (const t of Object.keys(TOOL_VERSIONS) as ToolName[]) {
    const def = `/usr/bin/${t}`;
    tools[t] = {
      path: def,
      sshPath: def,
      version: TOOL_VERSIONS[t],
      ...(opts.tools?.[t] ?? {}),
    };
  }
  const gh = { signedIn: true, user: "octocat", permission: "WRITE", ...(opts.gh ?? {}) };
  const plant = opts.plant;
  const calls: Call[] = [];

  const pkg = opts.platform === "darwin" ? null : opts.pkg === undefined ? "apt" : opts.pkg;
  const managers: Record<string, string | null> = {
    "apt-get": pkg === "apt" ? "/usr/bin/apt-get" : null,
    dnf: pkg === "dnf" ? "/usr/bin/dnf" : null,
  };

  const answer = (argv: string[]): Partial<ExecResult> => {
    const [first, ...a] = argv;
    // A tool runs by its bare name or by the absolute path the doctor resolved.
    const cmd = basename(first ?? "");
    const lookup = (word: string | undefined, ssh: boolean) => {
      const name = /^command -v (\S+)$/.exec(word ?? "")?.[1];
      if (name !== undefined && Object.hasOwn(managers, name)) {
        const m = managers[name];
        return m === null || m === undefined ? { code: 1 } : { stdout: `${m}\n` };
      }
      const t = name !== undefined ? tools[name as ToolName] : undefined;
      const p = t === undefined ? null : ssh ? t.sshPath : t.path;
      return p === null ? { code: 1 } : { stdout: `${p}\n` };
    };
    if (cmd === "sh" && a[0] === "-c") return lookup(a[1], false);
    if (cmd === "env" && a[0] === "-i") {
      const c = a.indexOf("-c");
      return lookup(a[c + 1], true);
    }
    const tool = tools[cmd as ToolName];
    if (tool !== undefined && (a[0] === "--version" || (cmd === "tmux" && a[0] === "-V"))) {
      return tool.path === null && tool.sshPath === null
        ? { code: 127, stderr: `${cmd}: not found` }
        : { stdout: `${tool.version}\n` };
    }
    if (cmd === "bun" && a[0] === "install") {
      if (opts.lockDrift === true) {
        return { code: 1, stderr: "error: lockfile had changes, but lockfile is frozen\n" };
      }
      if (a.includes("--dry-run")) return {};
      mkdirSync(join(volleyDir, "node_modules", ".bin"), { recursive: true });
      state.installed = true;
      return {};
    }
    // `env VAR=value ... git ...`: the git probes and the clone run with a quiet environment.
    let envArgs: string[] | null = null;
    if (cmd === "env" && a[0] !== "-i") {
      let i = 0;
      while (i < a.length && /^[A-Z_]+=/.test(a[i] as string)) i++;
      envArgs = a.slice(i);
    }
    const git =
      cmd === "git"
        ? a
        : envArgs !== null && basename(envArgs[0] ?? "") === "git"
          ? envArgs.slice(1)
          : null;
    if (git !== null) {
      const sub = git[0] === "-C" ? git.slice(2) : git;
      if (sub[0] === "checkout") {
        checkout((sub.at(-1) as string).replace(/^v/, ""));
        return {};
      }
      if (sub[0] === "rev-parse") return state.isGit ? { stdout: "true\n" } : { code: 128 };
      if (sub[0] === "remote") return state.isGit ? { stdout: `${state.origin}\n` } : { code: 2 };
      if (sub[0] === "ls-remote") return { code: (opts.fetchable ?? true) ? 0 : 2 };
      if (sub[0] === "clone") {
        const [url, path] = sub.slice(1).filter((w) => w !== "--");
        mkdirSync(join(path as string, ".git"), { recursive: true });
        state.isGit = true;
        state.origin = url as string;
        return {};
      }
      return {};
    }
    if (cmd === "gh") {
      if (tools.gh.path === null) return { code: 127 };
      if (a[0] === "auth" && a[1] === "status") {
        return gh.signedIn
          ? { stderr: `github.com\n  ✓ Logged in to github.com account ${gh.user}\n` }
          : { code: 1, stderr: "You are not logged into any GitHub hosts.\n" };
      }
      if (a[0] === "api" && a[1] === "user")
        return gh.signedIn ? { stdout: `${gh.user}\n` } : { code: 1 };
      if (a[0] === "repo" && a[1] === "view") return { stdout: `${gh.permission}\n` };
    }
    if (cmd === "claude" && a[0] === "auth") {
      const s = opts.claudeStatus ?? {
        loggedIn: true,
        authMethod: "claude.ai",
        subscriptionType: "max",
      };
      return {
        code: opts.claudeCode ?? 0,
        stdout: typeof s === "string" ? s : JSON.stringify(s),
      };
    }
    if (cmd === "vm_stat") {
      return {
        stdout:
          opts.vmStat ??
          "Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free:  1761608.\n",
      };
    }
    return {};
  };

  const exec: PeerExec = async (argv, o = {}) => {
    calls.push({ argv, ...(o.input !== undefined ? { input: o.input } : {}) });
    const r: ExecResult = { code: 0, stdout: "", stderr: "", ...answer(argv) };
    if (plant === undefined) return r;
    // The planted token appears everywhere a careless doctor might copy text from.
    if (basename(argv[0] ?? "") === "claude" && r.stdout.startsWith("{")) {
      const j = JSON.parse(r.stdout) as Record<string, unknown>;
      r.stdout = JSON.stringify({ ...j, accessToken: plant, email: `${plant}@example.com` });
    } else r.stdout = `${r.stdout}${plant}\n`;
    r.stderr = `${r.stderr}token: ${plant}\n`;
    return r;
  };

  const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
    exec,
    home,
    platform: opts.platform ?? "linux",
    shell: () => opts.shell ?? "/bin/bash",
    user: () => "dev",
    volleyDir,
    version: "0.4.0",
    now: () => new Date("2026-10-19T09:00:00.000Z"),
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 8 * 1024 ** 3,
    uptime: () => 86_400,
    statfs: () => ({ bsize: 4096, blocks: 262_144_000, bavail: 131_072_000 }),
    ...over,
  });

  /** Calls whose argv starts with `prefix` (a tool's absolute path matches its bare name). */
  const ran = (...prefix: string[]) =>
    calls
      .filter((c) =>
        prefix.every((p, i) => c.argv[i] === p || (i === 0 && basename(c.argv[0] ?? "") === p)),
      )
      .map((c) => c.argv);

  return {
    root,
    home,
    volleyDir,
    repoPath,
    tools,
    state,
    exec,
    calls,
    deps,
    ran,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export type FakePeerMachine = ReturnType<typeof fakePeerMachine>;
