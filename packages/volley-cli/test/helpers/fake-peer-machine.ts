import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ExecResult, PeerExec } from "../../src/commands/peer";
import { type DoctorDeps, LOCK_MARKER, type ToolName, lockHash } from "../../src/peer/doctor";
import { tempDir } from "./tmp";

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
  /** `~/.claude/skills/{volley,volley-issues}`: links to the checkout, absent, a real folder, a link elsewhere, a dangling link. */
  skills?: "linked" | "absent" | "stray" | "elsewhere" | "broken";
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
  /** git tracks the wave repo's `.mcp.json` (`git ls-files --error-unmatch` succeeds). */
  trackedMcpJson?: boolean;
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
  profile?: FakeProfile;
  /** More clones, by path: the per-repository doctor's (#435). */
  clones?: Record<string, FakeClone>;
  /**
   * `gh repo view <slug> --json nameWithOwner`: lower-cased slug → the name GitHub reports (null:
   * not found). A slug not listed reports itself.
   */
  canonical?: Record<string, string | null>;
  /**
   * `gh repo view <slug> --json nameWithOwner,viewerPermission`'s permission: lower-cased slug →
   * `viewerPermission`. A slug not listed has `gh.permission`.
   */
  permissions?: Record<string, string>;
  /** Tools beyond the doctor's own (`java`, `mvn`…): absent unless listed. */
  extraTools?: Record<string, Partial<FakeTool>>;
  /**
   * setup.json's network record (null: none; default Tailscale) and Tailscale's backend state as
   * `tailscale status --json` reports it (null: not installed; default Running).
   */
  network?: { record?: Record<string, unknown> | null; tailscale?: string | null };
  /** git's commit identity (`git var GIT_COMMITTER_IDENT`'s `Name <email>`); null: none. */
  gitIdentity?: string | null;
}

/** The default network record of the fake box (Tailscale, signed in). */
export const BOX_NETWORK = { kind: "tailscale", name: "box.example.ts.net", address: "100.64.0.9" };

/** A git clone on the box. */
export interface FakeClone {
  origin: string;
  /** The checked-out branch; null: a detached HEAD. Default `main`. */
  branch?: string | null;
  /** `origin/HEAD`'s branch (default `main`); null: none. */
  default?: string | null;
  /** `git status --porcelain` prints something. */
  dirty?: boolean;
  /** Files at the clone's root (its manifests). */
  files?: Record<string, string>;
  /**
   * `git -C <clone> var GIT_COMMITTER_IDENT`'s `Name <email>` (a repo-level identity); null: git
   * cannot commit there; unset: the home's `gitIdentity`, as git falls back to the global one.
   */
  identity?: string | null;
}

interface CloneState {
  isGit: boolean;
  origin: string;
  branch: string | null;
  default: string | null;
  dirty: boolean;
  identity?: string | null;
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

/** What the fake hooks installer merges: one hook, its prefix carrying the broker URL and namespace if any. */
export const fakeHooksSettings = (volleyDir: string, url?: string, namespace?: string) =>
  `${JSON.stringify(
    {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `VOLLEY_HOOKS_COORDINATOR=1 ${url !== undefined ? `VOLLEY_BROKER_URL=${url} ` : ""}${namespace !== undefined ? `VOLLEY_NAMESPACE=${namespace} ` : ""}bun run "${volleyDir}/packages/volley-hooks/src/hooks/stop.ts"`,
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
  const root = tempDir("volley-fake-box-");
  const home = join(root, "home");
  const networkRecord = opts.network?.record === undefined ? BOX_NETWORK : opts.network.record;
  if (networkRecord !== null) {
    mkdirSync(join(home, ".volley", "volleyd"), { recursive: true });
    writeFileSync(
      join(home, ".volley", "volleyd", "setup.json"),
      JSON.stringify({ network: networkRecord }),
    );
  }
  const tailscale = opts.network?.tailscale === undefined ? "Running" : opts.network.tailscale;
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
    branch: "main" as string | null,
    default: "main" as string | null,
    dirty: false,
  };
  /** Every clone but the wave repo's (`state`), by path. */
  const clones = new Map<string, CloneState>();
  for (const [path, c] of Object.entries(opts.clones ?? {})) {
    mkdirSync(join(path, ".git"), { recursive: true });
    for (const [f, text] of Object.entries(c.files ?? {})) {
      mkdirSync(dirname(join(path, f)), { recursive: true });
      writeFileSync(join(path, f), text);
    }
    clones.set(path, {
      isGit: true,
      origin: c.origin,
      branch: c.branch === undefined ? "main" : c.branch,
      default: c.default === undefined ? "main" : c.default,
      dirty: c.dirty ?? false,
      ...(c.identity !== undefined ? { identity: c.identity } : {}),
    });
  }
  const cloneAt = (path: string | undefined): CloneState | undefined =>
    path === repoPath ? state : path !== undefined ? clones.get(path) : undefined;
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
    if (skillsState === "broken") symlinkSync(join(root, "deleted", pkg), at);
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
  const extra: Record<string, FakeTool> = {};
  for (const [t, o] of Object.entries(opts.extraTools ?? {})) {
    extra[t] = { path: `/usr/bin/${t}`, sshPath: `/usr/bin/${t}`, version: `${t} 1.0.0`, ...o };
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
      const t =
        name === undefined
          ? undefined
          : Object.hasOwn(tools, name)
            ? tools[name as ToolName]
            : extra[name];
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
    const more = Object.hasOwn(extra, cmd) ? extra[cmd] : undefined;
    if (more !== undefined && /^-{0,2}version$/.test(a[0] ?? "")) {
      // java prints its version on stderr.
      return cmd === "java" ? { stderr: `${more.version}\n` } : { stdout: `${more.version}\n` };
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
    // The copy-mode skill fixes act on the real temp folders.
    if (cmd === "rm" && a.length === 1) {
      rmSync(a[0] as string);
      return {};
    }
    if (cmd === "cp" && a[0] === "-R") {
      cpSync(a[1] as string, a[2] as string, { recursive: true });
      return {};
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
        // The installer never reads VOLLEY_BROKER_URL from its env: only its flags.
        const flag = (f: string) => {
          const i = envArgs.indexOf(f);
          return i > 1 ? envArgs[i + 1] : undefined;
        };
        const out = fakeHooksSettings(volleyDir, flag("--broker-url"), flag("--namespace"));
        if (envArgs.includes("--dry-run")) return { stdout: out };
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
      const c = cloneAt(git[0] === "-C" ? git[1] : undefined);
      if (sub[0] === "checkout") {
        checkout((sub.at(-1) as string).replace(/^v/, ""));
        return {};
      }
      if (sub[0] === "rev-parse") return c?.isGit === true ? { stdout: "true\n" } : { code: 128 };
      if (sub[0] === "var" && sub[1] === "GIT_COMMITTER_IDENT") {
        // A clone's own identity wins over the global one (repo > global), as git resolves it.
        const id =
          c?.identity !== undefined
            ? c.identity
            : opts.gitIdentity === undefined
              ? "Octo Cat <1+octocat@users.noreply.github.com>"
              : opts.gitIdentity;
        return id !== null
          ? { stdout: `${id} 1760000000 +0000\n` }
          : { code: 128, stderr: "fatal: unable to auto-detect email address\n" };
      }
      if (sub[0] === "remote" && sub[1] === "set-url") {
        if (c === undefined) return { code: 2 };
        c.origin = sub.at(-1) as string;
        return {};
      }
      if (sub[0] === "remote") return c?.isGit === true ? { stdout: `${c.origin}\n` } : { code: 2 };
      if (sub[0] === "symbolic-ref") {
        if (sub.includes("HEAD") && !sub.includes("refs/remotes/origin/HEAD")) {
          return c?.branch != null ? { stdout: `${c.branch}\n` } : { code: 1 };
        }
        return c?.default != null ? { stdout: `origin/${c.default}\n` } : { code: 128 };
      }
      if (sub[0] === "status") return { stdout: c?.dirty === true ? " M README.md\n" : "" };
      if (sub[0] === "ls-remote") return { code: (opts.fetchable ?? true) ? 0 : 2 };
      if (sub[0] === "ls-files") return { code: opts.trackedMcpJson === true ? 0 : 1 };
      if (sub[0] === "clone") {
        const [url, path] = sub.slice(1).filter((w) => w !== "--");
        mkdirSync(join(path as string, ".git"), { recursive: true });
        if (path === repoPath) {
          state.isGit = true;
          state.origin = url as string;
        } else {
          clones.set(path as string, {
            isGit: true,
            origin: url as string,
            branch: "main",
            default: "main",
            dirty: false,
          });
        }
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
      if (a[0] === "repo" && a[1] === "view" && a.some((x) => x.startsWith("nameWithOwner"))) {
        const slug = a[2] as string;
        const known = opts.canonical ?? {};
        const name = Object.hasOwn(known, slug.toLowerCase()) ? known[slug.toLowerCase()] : slug;
        if (name === null || name === undefined)
          return { code: 1, stderr: `GraphQL: Could not resolve to a Repository (${slug})\n` };
        if (a.includes("nameWithOwner,viewerPermission")) {
          const viewerPermission = opts.permissions?.[slug.toLowerCase()] ?? gh.permission;
          return { stdout: `${JSON.stringify({ nameWithOwner: name, viewerPermission })}\n` };
        }
        return { stdout: `${name}\n` };
      }
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
    if (cmd === "tailscale" && a.join(" ") === "status --json") {
      if (tailscale === null) return { code: 127, stderr: "tailscale: not found" };
      return {
        stdout: JSON.stringify({
          BackendState: tailscale,
          Self:
            tailscale === "Running"
              ? { DNSName: `${BOX_NETWORK.name}.`, TailscaleIPs: [BOX_NETWORK.address] }
              : null,
        }),
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
    cpus: () => 8,
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
    extra,
    state,
    clones,
    exec,
    calls,
    deps,
    ran,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export type FakePeerMachine = ReturnType<typeof fakePeerMachine>;
