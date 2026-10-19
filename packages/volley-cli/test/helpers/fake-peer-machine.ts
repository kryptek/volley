import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExecResult, PeerExec } from "../../src/commands/peer";
import { type DoctorDeps, LOCK_MARKER, type ToolName, lockHash } from "../../src/peer/doctor";

/**
 * A fake machine for `volley peer doctor`: real temp directories (home, the volley checkout, the
 * wave repo's parent) and a scripted exec that answers `command -v`, `--version`, `gh`, `claude`,
 * `git` and `bun` like a box would, and changes state when a fix runs (`bun install` creates
 * `node_modules/.bin`, `git clone` creates the clone). Its Claude profile (`~/.claude`) is what
 * the profile installers act on: the skill installers link `~/.claude/skills/<skill>`, the hooks
 * installer writes `settings.json` (or prints it under `--dry-run`), `claude mcp` edits
 * `~/.claude.json`'s `mcpServers`.
 */

/** The Claude profile volley provisions (default: everything in place, with no broker URL). */
export interface FakeProfile {
  /** `~/.claude/skills/{volley,volley-issues}`: links to the checkout, absent, a real folder, a link elsewhere. */
  skills?: "linked" | "absent" | "stray" | "elsewhere";
  hooks?: "installed" | "absent";
  /** The broker URL the installed hooks and MCP entry carry (none by default). */
  url?: string;
  /** `mcpServers.volley` in `~/.claude.json`: this checkout's, none, or the given entry. */
  mcp?: "registered" | "absent" | Record<string, unknown>;
}

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
  memPressurePct?: number;
  profile?: FakeProfile;
}

export interface Call {
  argv: string[];
  input?: string;
}

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

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

/** The two skills the profile links, and their packages in the checkout. */
export const FAKE_SKILLS = [
  ["volley", "volley-skill"],
  ["volley-issues", "volley-issues"],
] as const;

/** What the fake hooks installer merges: one hook, its prefix carrying the broker URL if any. */
export const fakeHooksSettings = (volleyDir: string, url?: string) =>
  `${JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `VOLLEY_HOOKS_COORDINATOR=1 ${url !== undefined ? `VOLLEY_BROKER_URL=${url} ` : ""}bun run "${volleyDir}/packages/volley-hooks/src/hooks/stop.ts"`,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;

/** This checkout's MCP registration, as `claude mcp add-json` stores it. */
export const fakeMcpEntry = (volleyDir: string, url?: string) => ({
  type: "stdio",
  command: "/usr/bin/bun",
  args: ["run", join(volleyDir, "packages", "volley-mcp", "src", "index.ts")],
  env: { VOLLEY_AGENT_ID: "coordinator", ...(url !== undefined ? { VOLLEY_BROKER_URL: url } : {}) },
});

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
  // The Claude profile: the checkout's packages, and what is installed from them.
  const profile = opts.profile ?? {};
  const claudeDir = join(home, ".claude");
  const skillsDir = join(claudeDir, "skills");
  const settingsFile = join(claudeDir, "settings.json");
  const claudeJsonFile = join(home, ".claude.json");
  for (const [, pkg] of FAKE_SKILLS) {
    mkdirSync(join(volleyDir, "packages", pkg, "scripts"), { recursive: true });
    writeFileSync(join(volleyDir, "packages", pkg, "SKILL.md"), `# ${pkg}\n`);
    writeFileSync(join(volleyDir, "packages", pkg, "scripts", "install.sh"), "#!/bin/sh\n");
  }
  mkdirSync(join(volleyDir, "packages", "volley-hooks", "scripts"), { recursive: true });
  writeFileSync(
    join(volleyDir, "packages", "volley-hooks", "scripts", "install.sh"),
    "#!/bin/sh\n",
  );
  mkdirSync(join(volleyDir, "packages", "volley-mcp", "src"), { recursive: true });
  writeFileSync(join(volleyDir, "packages", "volley-mcp", "src", "index.ts"), "");
  mkdirSync(skillsDir, { recursive: true });
  const skillsState = profile.skills ?? "linked";
  for (const [skill, pkg] of FAKE_SKILLS) {
    const at = join(skillsDir, skill);
    if (skillsState === "linked") symlinkSync(join(volleyDir, "packages", pkg), at);
    if (skillsState === "stray") mkdirSync(at);
    if (skillsState === "elsewhere") {
      mkdirSync(join(root, "elsewhere", pkg), { recursive: true });
      symlinkSync(join(root, "elsewhere", pkg), at);
    }
  }
  if ((profile.hooks ?? "installed") === "installed") {
    writeFileSync(settingsFile, fakeHooksSettings(volleyDir, profile.url));
  }
  const mcp = profile.mcp ?? "registered";
  const servers =
    mcp === "absent"
      ? undefined
      : { volley: mcp === "registered" ? fakeMcpEntry(volleyDir, profile.url) : mcp };
  const claudeJsonOut =
    servers === undefined
      ? claudeJson
      : typeof claudeJson === "object" && claudeJson !== null
        ? { ...claudeJson, mcpServers: servers }
        : claudeJson === undefined
          ? { mcpServers: servers }
          : claudeJson;
  if (claudeJsonOut !== undefined) writeFileSync(claudeJsonFile, JSON.stringify(claudeJsonOut));
  const readClaudeJson = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(claudeJsonFile, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

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
    // `env [-u VAR] VAR=value ... git ...`: the git probes and the clone run with a quiet
    // environment; the profile installers with the profile's paths and the broker URL.
    let envArgs: string[] | null = null;
    const envVars: Record<string, string> = {};
    if (cmd === "env" && a[0] !== "-i") {
      let i = 0;
      while (i < a.length && (a[i] === "-u" || /^[A-Z_]+=/.test(a[i] as string))) {
        if (a[i] === "-u") i++;
        else {
          const kv = a[i] as string;
          envVars[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
        }
        i++;
      }
      envArgs = a.slice(i);
    }
    if (envArgs?.[0] === "bash") {
      const script = envArgs[1] ?? "";
      const skill = FAKE_SKILLS.find(([, pkg]) => script.endsWith(`/${pkg}/scripts/install.sh`));
      if (skill !== undefined) {
        const at = join(envVars.HOME ?? home, ".claude", "skills", skill[0]);
        const pkgDir = join(volleyDir, "packages", skill[1]);
        mkdirSync(dirname(at), { recursive: true });
        if (existsSync(at) || lstatOrNull(at) !== null) {
          if (lstatOrNull(at)?.isSymbolicLink() === true) rmSync(at);
          else renameSync(at, `${at}.backup.20261019-090000`);
        }
        symlinkSync(pkgDir, at);
        return { stdout: `/${skill[0]} skill installed\n` };
      }
      if (script.endsWith("/volley-hooks/scripts/install.sh")) {
        const out = fakeHooksSettings(volleyDir, envVars.VOLLEY_BROKER_URL);
        if (envArgs[2] === "--dry-run") return { stdout: out };
        const file = envVars.CLAUDE_SETTINGS ?? settingsFile;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, out);
        return { stdout: `installed volley-hooks into ${file}\n` };
      }
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
    if (cmd === "claude" && a[0] === "mcp") {
      const j = readClaudeJson();
      const servers = { ...((j.mcpServers ?? {}) as Record<string, unknown>) };
      if (a[1] === "add-json") {
        const [, , , scope, name, json] = a;
        if (scope !== "user") return { code: 1, stderr: "only -s user here\n" };
        if (Object.hasOwn(servers, name as string)) {
          return { code: 1, stderr: `MCP server ${name} already exists in user config\n` };
        }
        servers[name as string] = { type: "stdio", ...JSON.parse(json as string) };
      } else if (a[1] === "remove") {
        const name = a.at(-1) as string;
        if (!Object.hasOwn(servers, name)) return { code: 1, stderr: `No MCP server ${name}\n` };
        delete servers[name];
      }
      writeFileSync(claudeJsonFile, JSON.stringify({ ...j, mcpServers: servers }));
      return {};
    }
    if (cmd === "memory_pressure") {
      return {
        stdout: `The system has 17179869184 (4194304 pages with a page size of 4096).\nSystem-wide memory free percentage: ${opts.memPressurePct ?? 42}%\n`,
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
    claudeDir,
    skillsDir,
    settingsFile,
    claudeJsonFile,
    readClaudeJson,
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
