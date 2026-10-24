import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_DEFAULTS } from "volleyd/config-defaults";
import { managedClonePath, originToSlug, sameSlug } from "volleyd/repos";
import type { PeerExec } from "../commands/peer";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { claudeChecks, isRepoTrusted, loginIdentity, parseClaudeStatus } from "./checks/claude";
import { canonicalSlug, ghPermission, ghState, ghUser, githubChecks } from "./checks/github";
import {
  diskOf,
  machineChecks,
  memoryOf,
  reposWorktreeRoot,
  vmStatAvailablePct,
  worktreeRoot,
} from "./checks/machine";
import {
  type AccountProfile,
  accountProfilesCheck,
  gatherAccountProfiles,
  onboardingVersionOf,
} from "./checks/profiles";
import { GIT_QUIET, githubSlug, normalizeOrigin, repoChecks, reposChecks } from "./checks/repo";
import {
  ON_PATH,
  binOf,
  repoToolChecks,
  toolChecks,
  toolVersionOf,
  toolchainOf,
  versionOf,
} from "./checks/tools";
import {
  PROFILE_CHECKS,
  type ProfileFacts,
  type ProfileTarget,
  defaultTarget,
  gatherProfile,
  profileChecks,
} from "./provision";
import { type Requirements, requirementsOf } from "./requirements";
import {
  type ClaudeLogin,
  PROBE_FAMILIES,
  type UsageFetch,
  type UsageWindow,
  findLogins,
  probeLogins,
} from "./usage-probe";

export { normalizeOrigin } from "./checks/repo";
export { binOf } from "./checks/tools";

/**
 * `volley peer doctor`: everything an agent on this machine needs, checked (SPEC §4.6.15, the
 * machine record's Fleet fields). The shell here gathers facts through the injected exec and fs;
 * each check family (`checks/*.ts`) is a pure `(facts) => Check[]`; this module composes them,
 * renders the human and JSON forms, and plans and applies the safe fixes.
 *
 * Safe fixes write only inside the volley checkout (`bun install --frozen-lockfile`, a checkout of
 * the supervisor's version) or create the wave repo's clone at an empty path (`--clone`, with a
 * known origin URL). Everything else (a symlink that needs root, `gh auth login`, a Claude
 * sign-in, installing a tool) is printed for the person to run. The doctor never stores or
 * prints a credential: it keeps states and plain labels, and scrubs anything token-shaped from
 * what it prints. Its one read of a credential is the usage probe's (usage-probe.ts, SPEC
 * §4.6.11's exception): each login's own token, in memory, for one read-only usage request.
 */

export const TOOLS = ["bun", "git", "gh", "tmux", "nc", "base64", "cmp", "claude"] as const;
export type ToolName = (typeof TOOLS)[number];
/** The tools whose version the machine record carries. */
const VERSIONED = ["bun", "git", "gh", "tmux", "claude"] as const satisfies readonly ToolName[];

export const DOCTOR_DEFAULTS = {
  /** Below this much available memory, `machine.memory` warns. */
  mem_low_pct: 10,
  /** Below this much free disk where worktrees go, `machine.disk` warns. */
  disk_low_gb: 5,
  /** Each probe's limit (a fix's own commands get `fix_timeout_ms`). */
  exec_timeout_ms: 20_000,
  fix_timeout_ms: 600_000,
  /** `gh repo view <slug> --json nameWithOwner` (a repository's canonical name, D6). */
  gh_view_timeout_ms: 15_000,
  /**
   * sshd's default PATH for a non-interactive session (Debian/Ubuntu's OpenSSH; macOS's): what
   * volleyd's `ssh <box> bash -s` starts from before the login shell's non-interactive startup.
   * An estimate: sshd's SetEnv, ~/.ssh/environment, pam_env and other distros' compiled-in PATH
   * are invisible here, so the PATH checks only warn (the supervisor's own probe decides).
   */
  ssh_path_linux:
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games",
  ssh_path_darwin: "/usr/bin:/bin:/usr/sbin:/sbin",
} as const;

/** The checks a `--fix` can make pass by itself: each reports "already done" when it passes. */
const FIXABLE: string[] = [
  "volley.installed",
  "volley.version",
  "repo.clone",
  "repo.canonical",
  ...PROFILE_CHECKS,
  "claude.profiles",
];

/**
 * Warn checks that do not hold up a join but that the supervisor's readiness still needs (SPEC
 * §4.6.15: GitHub may push and Claude is signed in): the human output says so.
 */
const NEEDED_FOR_READY = ["gh.auth", "claude.signin"];

/**
 * In `node_modules`: the sha256 of the `bun.lock` the doctor last installed from. `bun install
 * --frozen-lockfile --dry-run` compares package.json with bun.lock, never node_modules, so this
 * is how the doctor tells a `git pull` without a reinstall from a current install.
 */
export const LOCK_MARKER = ".volley-lock-sha256";

export type Severity = "block" | "warn";
export type AuthGh = "ok" | "unauthenticated" | "missing" | "no_write";
export type AuthClaude = "signed_in" | "not_signed_in" | "missing" | "unknown";
export type AuthTrust = "ok" | "missing" | "unknown";

export interface Fix {
  /** What to run, as a person would type it. */
  command: string;
  /** Present on a safe fix only: the argv the doctor runs itself under `--fix`. */
  steps?: string[][];
  /** The fix runs only with `--clone`. */
  needsClone?: boolean;
  /** Edits the doctor makes itself under `--fix`, after the steps (never in the report). */
  apply?: { what: string; run: () => void }[];
  /** The steps run under `--fix` even while the check passes (fetching a repository, D7). */
  refresh?: boolean;
}

export interface Check {
  id: string;
  ok: boolean;
  severity: Severity;
  /** One line on what the check found (at most 200 characters). */
  detail: string;
  /** The repository (`owner/name`) a per-repository check is about. */
  repo?: string;
  fix?: Fix;
}

/** A configured repository's clone (peer.json's `repos`), as the doctor found it. */
export interface RepoFacts {
  slug: string;
  path: string;
  /** At its managed path (`<repo_root>/<owner>/<name>`); else adopted: fetched, never moved. */
  managed: boolean;
  exists: boolean;
  empty: boolean;
  isGit: boolean;
  origin: string | null;
  fetchable: boolean | null;
  fetchedAt: string | null;
  /**
   * GitHub's canonical `owner/name` for the configured slug and for the remote's (D6), asked only
   * when the two differ and gh is signed in; null otherwise (or when GitHub did not answer).
   */
  canonical: { configured: string | null; remote: string | null } | null;
  /** The checked-out branch (null: detached), `origin/HEAD`'s branch, and a clean worktree. */
  head: string | null;
  defaultBranch: string | null;
  clean: boolean;
  /** Its toolchain (requirements.ts), or why its requirements file is invalid. */
  requirements: Requirements | { error: string };
}

export interface Memory {
  total_mb: number;
  available_pct: number;
}
export interface Disk {
  path: string;
  free_gb: number;
  free_pct: number;
}
export interface StatFs {
  bsize: number;
  blocks: number;
  bavail: number;
}

export interface ToolFact {
  /** `command -v` in the doctor's own shell. */
  path: string | null;
  /** `command -v` on the non-interactive ssh PATH (probed for `ON_PATH` tools; else `path`). */
  sshPath: string | null;
  version: string | null;
}

export interface Facts {
  platform: NodeJS.Platform;
  /** The login shell the ssh PATH estimate ran through. */
  shell: string;
  /** Linux's package manager (what the install fixes name); null on macOS or when unknown. */
  pkg: "apt" | "dnf" | null;
  peerVersion: string;
  tools: Record<ToolName, ToolFact>;
  volley: {
    dir: string;
    installed: boolean;
    /**
     * `synced`: installed from the current bun.lock; `stale`: from another (or by hand: not
     * verified); `drift`: package.json and bun.lock disagree; `unknown`: no bun to ask.
     */
    lock: "synced" | "stale" | "drift" | "unknown";
    version: string | null;
    required: string | null;
  };
  /** peer.json's repositories, by slug (empty: the legacy single `repo`). */
  repos: RepoFacts[];
  /** The tools a repository needs beyond `TOOLS` (`java`, `mvn`…), probed only when needed. */
  extraTools: Record<string, ToolFact>;
  repo: {
    path: string | null;
    exists: boolean;
    empty: boolean;
    isGit: boolean;
    origin: string | null;
    expected: string | null;
    cloneUrl: string | null;
    release: string | null;
    fetchable: boolean | null;
    fetchedAt: string | null;
  };
  github: {
    present: boolean;
    signedIn: boolean;
    user: string | null;
    slug: string | null;
    permission: string | null;
  };
  claude: {
    state: AuthClaude;
    plan: string | null;
    trust: AuthTrust;
    /** The default profile's login identity (checks/claude.ts loginIdentity). */
    email: string | null;
    org: string | null;
    /** Each login's usage probe (usage-probe.ts); null when the doctor has no fetch to call it. */
    logins: ClaudeLogin[] | null;
    /** The signed-in account profiles under volleyd's profiles root (checks/profiles.ts). */
    profiles: AccountProfile[];
    /** The default profile's `lastOnboardingVersion`: a seed's version when no `claude` answers. */
    onboardingVersion: string | null;
  };
  machine: {
    /** Logical CPUs (the size a paired machine's derived `max_agents` reads). */
    cores: number;
    memory: Memory;
    disk: Disk | null;
    limits: { mem_low_pct: number; disk_low_gb: number };
  };
  /** The machine's own Claude profile (provision.ts). */
  profile: ProfileFacts;
}

/** sha256 of `<dir>/bun.lock`; null without one. */
export function lockHash(dir: string): string | null {
  try {
    return createHash("sha256")
      .update(readFileSync(join(dir, "bun.lock")))
      .digest("hex");
  } catch {
    return null;
  }
}

/**
 * The files of the volley checkout `dir` whose change can change a doctor run's result: its
 * version, its lockfile and the marker of the doctor's last install from it. `volley peer run`
 * re-runs its doctor as soon as one of them changes.
 */
export const doctorInputs = (dir: string): string[] => [
  join(dir, "package.json"),
  join(dir, "bun.lock"),
  join(dir, "node_modules", LOCK_MARKER),
];

/** After the doctor's own install: remember the bun.lock it installed from. */
function markInstalled(dir: string): void {
  const h = lockHash(dir);
  try {
    if (h !== null) writeFileSync(join(dir, "node_modules", LOCK_MARKER), `${h}\n`);
  } catch {}
}

/** What the doctor touches on this machine: the `PeerDeps` subset, injectable for tests. */
export interface DoctorDeps {
  exec: PeerExec;
  home: string;
  platform: NodeJS.Platform;
  /** The user's login shell: ssh runs it (`<shell> -c 'bash -s'`) for volleyd's remote steps. */
  shell: () => string;
  user: () => string;
  /** This machine's volley checkout. */
  volleyDir: string;
  /** This CLI's own version (the record's `versions.peer`). */
  version: string;
  now: () => Date;
  totalmem: () => number;
  freemem: () => number;
  cpus: () => number;
  uptime: () => number;
  /** `fs.statfs` of an existing path; null when it cannot be read. */
  statfs: (path: string) => StatFs | null;
  /** Asks the person at the terminal; absent or false without one. */
  confirm?: (question: string) => Promise<boolean>;
  /** The usage probe's one request (usage-probe.ts); absent, no login is probed. */
  fetch?: UsageFetch;
  /** This process's environment: `$USER` (the Keychain account), `$VOLLEY_CLAUDE_DIR`. */
  env?: Record<string, string | undefined>;
  /** The Claude account profiles' root (default `<home>/.volley/claude`). */
  claudeRoot?: string;
}

export interface DoctorOptions {
  /** This machine's clone of the wave repo (the legacy single repository). */
  repo?: string;
  /**
   * peer.json's repositories: `owner/name` → its clone's absolute path. Non-empty, every repo
   * check runs per repository and `repo` is ignored.
   */
  repos?: Record<string, string>;
  /** The wave repo's URL: compared with the clone's origin, and what `--clone` clones. */
  origin?: string;
  /** The release branch to check is fetchable. */
  release?: string;
  /** The supervisor's volley version (its readiness `requirements.volley`), when known. */
  requiredVolley?: string | null;
  json?: boolean;
  fix?: boolean;
  yes?: boolean;
  clone?: boolean;
  /** What the Claude profile is checked against (default: the default modes, no broker URL). */
  profile?: ProfileTarget;
  /**
   * The supervisor's `hosts.<name>.volley_dir` (where it launches this machine's agents from):
   * every volley MCP entry must run it as well as this checkout.
   */
  volleyDir?: string;
  /**
   * Only the usage probe of this one login (`default`, or a profile id): a supervisor priming a
   * login it just signed in. The report is `{ claude_logins, doctor_at }`; no check runs.
   */
  probeLogin?: string;
}

/** The record's check: no fix text (the doctor that reads a record supplies its own). */
export interface RecordCheck {
  id: string;
  ok: boolean;
  severity: Severity;
  detail: string;
  repo?: string;
}

/** A repository's toolchain on this machine: the tools it needs that are missing or too old. */
export interface Toolchain {
  ok: boolean;
  missing: string[];
  outdated: string[];
}

/** One configured repository, as the machine record carries it (`repos[]`). */
export interface RepoReport {
  slug: string;
  path: string;
  exists: boolean;
  origin?: string;
  managed: boolean;
  fetched_at: string | null;
  release_branch?: string;
  toolchain: Toolchain;
}

/** A fix `--fix` applied: the report's journal of what changed (never in the record). */
export interface FixRecord {
  id: string;
  repo?: string;
  command: string;
  ok: boolean;
}

/** `--json`: exactly the machine record's doctor fields, plus each failing check's fix text. */
export interface DoctorReport {
  checks: (RecordCheck & { fix?: string })[];
  versions: Record<"peer" | "volley" | "bun" | "git", string | null> &
    Partial<Record<"gh" | "tmux" | "claude", string | null>>;
  auth: {
    gh: AuthGh;
    claude: AuthClaude;
    trust: AuthTrust;
    claude_plan?: string;
    claude_email?: string;
    claude_org?: string;
  };
  repo?: {
    path: string;
    exists: boolean;
    origin?: string;
    release_branch?: string;
    fetched_at: string | null;
  };
  repos?: RepoReport[];
  memory: Memory;
  disk?: Disk;
  /** Each signed-in login's usage windows: numbers and states only (SPEC §4.6.14). */
  claude_logins?: ClaudeLogin[];
  /** Under `--fix`: each fix it applied to a failing check, and whether it worked. */
  fixes?: FixRecord[];
  doctor_at: string;
}

// ---------------------------------------------------------------------------------------------
// Secrets: nothing token-shaped leaves the doctor
// ---------------------------------------------------------------------------------------------

/** Anthropic keys and OAuth tokens, GitHub tokens, and a bare 40-hex OAuth token. */
const SECRET_RE =
  /sk-ant-[A-Za-z0-9_-]+|\bgh[pousr]_[A-Za-z0-9]{16,}|\bgithub_pat_[A-Za-z0-9_]+|\b[0-9a-fA-F]{40}\b/g;

export const looksSecret = (s: string) => new RegExp(SECRET_RE.source).test(s);

/** Every string in `value` with token-shaped text replaced. */
export function scrub<T>(value: T): T {
  if (typeof value === "string") return value.replace(SECRET_RE, "[redacted]") as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)])) as T;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Gathering facts
// ---------------------------------------------------------------------------------------------

const firstLine = (s: string) => (s.split("\n")[0] ?? "").trim();

/** The nearest existing folder at or above `path` (statfs needs one). */
function nearestExisting(path: string): string {
  let p = resolve(path);
  while (!existsSync(p) && dirname(p) !== p) p = dirname(p);
  return p;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

export async function gatherFacts(deps: DoctorDeps, opts: DoctorOptions): Promise<Facts> {
  const sh = (argv: string[], timeoutMs: number = DOCTOR_DEFAULTS.exec_timeout_ms) =>
    deps.exec(argv, { timeoutMs }).catch(() => ({ code: -1, stdout: "", stderr: "" }));
  const found = async (argv: string[]) => {
    const r = await sh(argv);
    const p = firstLine(r.stdout);
    return r.code === 0 && p.startsWith("/") && !/\s/.test(p) ? p : null;
  };
  const sshPath =
    deps.platform === "darwin" ? DOCTOR_DEFAULTS.ssh_path_darwin : DOCTOR_DEFAULTS.ssh_path_linux;

  const shell = deps.shell();
  // Tools: where each is, on the (estimated) non-interactive ssh PATH too, and its version
  // (the copy agents get when there is one: binOf).
  const tools = {} as Record<ToolName, ToolFact>;
  for (const t of TOOLS) {
    const path = await found(["sh", "-c", `command -v ${t}`]);
    const ssh = (ON_PATH as readonly string[]).includes(t)
      ? await found([
          "env",
          "-i",
          `HOME=${deps.home}`,
          `USER=${deps.user()}`,
          `PATH=${sshPath}`,
          shell,
          "-c",
          `command -v ${t}`,
        ])
      : path;
    const fact: ToolFact = { path, sshPath: ssh, version: null };
    const bin = binOf(fact);
    if (bin !== null && (VERSIONED as readonly string[]).includes(t)) {
      const r = await sh([bin, t === "tmux" ? "-V" : "--version"]);
      fact.version = r.code === 0 ? versionOf(r.stdout) : null;
    }
    tools[t] = fact;
  }
  const bun = binOf(tools.bun);
  const gitBin = binOf(tools.git);
  const ghBin = binOf(tools.gh);
  const claudeBin = binOf(tools.claude);
  let pkg: Facts["pkg"] = null;
  if (deps.platform === "linux") {
    if ((await found(["sh", "-c", "command -v apt-get"])) !== null) pkg = "apt";
    else if ((await found(["sh", "-c", "command -v dnf"])) !== null) pkg = "dnf";
  }

  // The volley checkout.
  const dir = resolve(deps.volleyDir);
  const pkgVersion = (readJson(join(dir, "package.json")) as { version?: unknown } | undefined)
    ?.version;
  const installed = existsSync(join(dir, "node_modules", ".bin"));
  let lock: Facts["volley"]["lock"] = "unknown";
  if (installed && bun !== null) {
    if ((await sh([bun, "install", "--cwd", dir, "--frozen-lockfile", "--dry-run"])).code !== 0) {
      lock = "drift";
    } else {
      let marker: string | null = null;
      try {
        marker = readFileSync(join(dir, "node_modules", LOCK_MARKER), "utf-8").trim();
      } catch {}
      lock = marker !== null && marker === lockHash(dir) ? "synced" : "stale";
    }
  }

  // A clone: there, a git work tree, its origin, fetchable without a prompt, last fetched.
  const clone = async (at: string, release: string | null) => {
    const exists = existsSync(at);
    let empty = false;
    if (exists) {
      try {
        empty = statSync(at).isDirectory() && readdirSync(at).length === 0;
      } catch {}
    }
    const isGit =
      exists &&
      !empty &&
      gitBin !== null &&
      firstLine((await sh([gitBin, "-C", at, "rev-parse", "--is-inside-work-tree"])).stdout) ===
        "true";
    let origin: string | null = null;
    let fetchable: boolean | null = null;
    let fetchedAt: string | null = null;
    if (isGit && gitBin !== null) {
      const r = await sh([gitBin, "-C", at, "remote", "get-url", "origin"]);
      origin = r.code === 0 ? normalizeOrigin(firstLine(r.stdout)) : null;
      const ref = release !== null ? `refs/heads/${release}` : "HEAD";
      fetchable =
        (await sh([...GIT_QUIET, gitBin, "-C", at, "ls-remote", "--exit-code", "origin", ref]))
          .code === 0;
      try {
        fetchedAt = statSync(join(at, ".git", "FETCH_HEAD")).mtime.toISOString();
      } catch {}
    }
    return { exists, empty, isGit, origin, fetchable, fetchedAt };
  };

  // The wave repo's clone (the legacy single repository).
  const path = opts.repo !== undefined ? resolve(opts.repo) : null;
  const release = opts.release ?? null;
  const legacy =
    path !== null
      ? await clone(path, release)
      : {
          exists: false,
          empty: false,
          isGit: false,
          origin: null,
          fetchable: null,
          fetchedAt: null,
        };
  const { exists, empty, isGit, origin, fetchable, fetchedAt } = legacy;
  const expected = opts.origin !== undefined ? normalizeOrigin(opts.origin) : null;

  // GitHub.
  const ghPresent = ghBin !== null;
  const signedIn = ghBin !== null && (await sh([ghBin, "auth", "status"])).code === 0;
  const user =
    signedIn && ghBin !== null
      ? ghUser((await sh([ghBin, "api", "user", "--jq", ".login"])).stdout)
      : null;
  // peer.json's repositories, sorted by slug (the first is the one gh.auth checks push access to).
  const configured = Object.entries(opts.repos ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const slug =
    configured.length > 0 ? (configured[0]?.[0] ?? null) : githubSlug(origin ?? expected);
  const permission =
    signedIn && ghBin !== null && slug !== null
      ? ghPermission(
          (
            await sh([
              ghBin,
              "repo",
              "view",
              slug,
              "--json",
              "viewerPermission",
              "--jq",
              ".viewerPermission",
            ])
          ).stdout,
        )
      : null;

  // Each repository: its clone, GitHub's canonical names when its remote names another (D6:
  // one `gh repo view` per slug per run), its branch state (D7) and its toolchain.
  const canonicals = new Map<string, string | null>();
  const canonicalOf = async (s: string): Promise<string | null> => {
    const key = s.toLowerCase();
    if (!canonicals.has(key)) {
      const r =
        signedIn && ghBin !== null
          ? await sh(
              [ghBin, "repo", "view", s, "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
              DOCTOR_DEFAULTS.gh_view_timeout_ms,
            )
          : null;
      canonicals.set(key, r !== null && r.code === 0 ? canonicalSlug(r.stdout) : null);
    }
    return canonicals.get(key) ?? null;
  };
  const managedRoot = CONFIG_DEFAULTS.fleet.repo_root;
  const repos: RepoFacts[] = [];
  for (const [repoSlug, repoPath] of configured) {
    const at = resolve(repoPath);
    const c = await clone(at, null);
    const managed = at === resolve(managedClonePath(managedRoot, repoSlug, deps.home));
    const remote = originToSlug(c.origin);
    const canonical =
      remote !== undefined && !sameSlug(remote, repoSlug) && signedIn && ghBin !== null
        ? { configured: await canonicalOf(repoSlug), remote: await canonicalOf(remote) }
        : null;
    let head: string | null = null;
    let defaultBranch: string | null = null;
    let clean = false;
    if (c.isGit && managed && gitBin !== null) {
      const h = await sh([gitBin, "-C", at, "symbolic-ref", "--short", "-q", "HEAD"]);
      head = h.code === 0 && firstLine(h.stdout) !== "" ? firstLine(h.stdout) : null;
      const d = await sh([gitBin, "-C", at, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      const ref = firstLine(d.stdout);
      defaultBranch = d.code === 0 && ref.startsWith("origin/") ? ref.slice(7) || null : null;
      const st = await sh([gitBin, "-C", at, "status", "--porcelain"]);
      clean = st.code === 0 && st.stdout.trim() === "";
    }
    let requirements: RepoFacts["requirements"] = { tools: [], min: {} };
    if (c.isGit) {
      try {
        requirements = requirementsOf(at);
      } catch (e) {
        requirements = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    repos.push({
      slug: repoSlug,
      path: at,
      managed,
      ...c,
      canonical,
      head,
      defaultBranch,
      clean,
      requirements,
    });
  }
  // The tools a repository needs beyond the doctor's own: only those, each probed once.
  const extraTools: Record<string, ToolFact> = {};
  for (const r of repos) {
    if ("error" in r.requirements) continue;
    for (const t of r.requirements.tools) {
      if ((TOOLS as readonly string[]).includes(t) || Object.hasOwn(extraTools, t)) continue;
      const at = await found(["sh", "-c", `command -v ${t}`]);
      const fact: ToolFact = { path: at, sshPath: at, version: null };
      if (at !== null) {
        // java prints its version on stderr, go has no --version.
        const v = await sh([at, t === "java" ? "-version" : t === "go" ? "version" : "--version"]);
        fact.version = v.code === 0 ? toolVersionOf(`${v.stdout}${v.stderr}`.trim()) : null;
      }
      extraTools[t] = fact;
    }
  }

  // Claude Code: sign-in state and folder trust.
  let claude: { state: AuthClaude; plan: string | null } = { state: "missing", plan: null };
  if (claudeBin !== null) {
    const r = await sh([claudeBin, "auth", "status"]);
    claude = parseClaudeStatus(r.code, r.stdout);
  }
  // One parse of ~/.claude.json: the trust table and the login's identity, nothing else of it.
  const claudeJsonFile = join(deps.home, ".claude.json");
  const claudeJson = existsSync(claudeJsonFile) ? readJson(claudeJsonFile) : undefined;
  // Trust: every repository's folder (or the legacy clone's).
  const trustPaths = repos.length > 0 ? repos.map((r) => r.path) : path !== null ? [path] : [];
  let trust: AuthTrust = "unknown";
  if (trustPaths.length > 0) {
    if (!existsSync(claudeJsonFile)) trust = "missing";
    else
      trust =
        claudeJson === undefined
          ? "unknown"
          : trustPaths.every((p) => isRepoTrusted(claudeJson, p))
            ? "ok"
            : "missing";
  }
  const identity = loginIdentity(
    typeof claudeJson === "object" && claudeJson !== null && !Array.isArray(claudeJson)
      ? (claudeJson as Record<string, unknown>)
      : null,
  );

  // The machine: memory (macOS: vm_stat's reclaimable pages, as free pages under-count) and the
  // worktrees' disk.
  let available: number | null = null;
  if (deps.platform === "darwin")
    available = vmStatAvailablePct((await sh(["vm_stat"])).stdout, deps.totalmem());
  // Managed repositories' worktrees go under ~/.volley/worktrees; the legacy clone's beside it.
  const root = repos.length > 0 ? reposWorktreeRoot(deps.home) : worktreeRoot(path, deps.home);
  const st = deps.statfs(nearestExisting(root));

  // The usage probe: each login read on this machine, numbers only out.
  const logins =
    deps.fetch === undefined
      ? null
      : await probeLogins(
          {
            exec: deps.exec,
            fetch: deps.fetch,
            platform: deps.platform,
            home: deps.home,
            env: deps.env ?? {},
            claudeVersion: tools.claude.version,
          },
          deps.now(),
        ).catch(() => null);

  const accountProfiles = await gatherAccountProfiles(
    sh,
    deps.claudeRoot ?? join(deps.home, ".volley", "claude"),
  );

  const profile = await gatherProfile(
    sh,
    {
      home: deps.home,
      volleyDir: dir,
      bun,
      claude: claudeBin,
      git: gitBin,
      // The wave repo's `.mcp.json`: the one repository's, when there is exactly one.
      repo: repos.length > 0 ? (repos.length === 1 ? (repos[0]?.path ?? null) : null) : path,
      ...(deps.claudeRoot !== undefined ? { claudeRoot: deps.claudeRoot } : {}),
      ...(opts.volleyDir !== undefined ? { supervisorDir: opts.volleyDir } : {}),
    },
    opts.profile ?? defaultTarget(),
  );

  return {
    platform: deps.platform,
    shell,
    pkg,
    peerVersion: deps.version,
    tools,
    extraTools,
    repos,
    volley: {
      dir,
      installed,
      lock,
      version:
        typeof pkgVersion === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(pkgVersion)
          ? pkgVersion
          : null,
      required: opts.requiredVolley ?? null,
    },
    repo: {
      path,
      exists,
      empty,
      isGit,
      origin,
      expected,
      cloneUrl: opts.origin ?? null,
      release,
      fetchable,
      fetchedAt,
    },
    github: { present: ghPresent, signedIn, user, slug, permission },
    claude: {
      ...claude,
      trust,
      email: identity.email ?? null,
      org: identity.org ?? null,
      logins,
      profiles: accountProfiles,
      onboardingVersion: onboardingVersionOf(claudeJson),
    },
    machine: {
      cores: deps.cpus(),
      memory: memoryOf(deps.totalmem(), deps.freemem(), available),
      disk: st !== null ? diskOf(root, st) : null,
      limits: {
        mem_low_pct: DOCTOR_DEFAULTS.mem_low_pct,
        disk_low_gb: DOCTOR_DEFAULTS.disk_low_gb,
      },
    },
    profile,
  };
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export function checksOf(f: Facts): Check[] {
  return [
    ...toolChecks(f),
    // peer.json's repositories, each check carrying `repo`; else the legacy single clone.
    ...(f.repos.length > 0 ? [...reposChecks(f), ...repoToolChecks(f)] : repoChecks(f)),
    ...githubChecks(f),
    ...claudeChecks(f),
    ...profileChecks(f.profile),
    accountProfilesCheck(f),
    ...machineChecks(f),
  ].map((c) => ({ ...c, detail: c.detail.slice(0, 200) }));
}

export function reportOf(f: Facts, checks: Check[], at: Date): DoctorReport {
  const v = (t: ToolName) => f.tools[t].version;
  const r = f.repo;
  return scrub({
    checks: checks.map((c) => ({
      id: c.id,
      ok: c.ok,
      severity: c.severity,
      detail: c.detail,
      ...(c.repo !== undefined ? { repo: c.repo } : {}),
      ...(!c.ok && c.fix !== undefined ? { fix: c.fix.command } : {}),
    })),
    versions: {
      peer: f.peerVersion,
      volley: f.volley.version,
      bun: v("bun"),
      git: v("git"),
      gh: v("gh"),
      tmux: v("tmux"),
      claude: v("claude"),
    },
    auth: {
      gh: ghState(f),
      claude: f.claude.state,
      trust: f.claude.trust,
      ...(f.claude.state === "signed_in" && f.claude.plan !== null
        ? { claude_plan: f.claude.plan }
        : {}),
      // The login's identity only while it is signed in.
      ...(f.claude.state === "signed_in" && f.claude.email !== null
        ? { claude_email: f.claude.email }
        : {}),
      ...(f.claude.state === "signed_in" && f.claude.org !== null
        ? { claude_org: f.claude.org }
        : {}),
    },
    ...(r.path !== null && f.repos.length === 0
      ? {
          repo: {
            path: r.path,
            exists: r.exists,
            ...(r.origin !== null ? { origin: r.origin } : {}),
            ...(r.release !== null ? { release_branch: r.release } : {}),
            fetched_at: r.fetchedAt,
          },
        }
      : {}),
    // Exactly one repository: the legacy `repo` too, for one release (SPEC §4.6.14).
    ...(f.repos.length === 1 && f.repos[0] !== undefined
      ? {
          repo: {
            path: f.repos[0].path,
            exists: f.repos[0].exists,
            ...(f.repos[0].origin !== null ? { origin: f.repos[0].origin } : {}),
            fetched_at: f.repos[0].fetchedAt,
          },
        }
      : {}),
    ...(f.repos.length > 0
      ? {
          repos: f.repos.map(
            (x): RepoReport => ({
              slug: x.slug,
              path: x.path,
              exists: x.exists,
              ...(x.origin !== null ? { origin: x.origin } : {}),
              managed: x.managed,
              fetched_at: x.fetchedAt,
              toolchain: toolchainOf(f, x),
            }),
          ),
        }
      : {}),
    memory: f.machine.memory,
    ...(f.machine.disk !== null ? { disk: f.machine.disk } : {}),
    ...(f.claude.logins !== null ? { claude_logins: f.claude.logins } : {}),
    doctor_at: at.toISOString(),
  });
}

/**
 * Run every check once. The report's `doctor_at` is when the run started: its facts are no older
 * than that, so a run that began before a `doctor --fix` (or a Repair) and ended after it never
 * reads as a run from after it.
 */
export async function runDoctor(
  deps: DoctorDeps,
  opts: DoctorOptions,
): Promise<{ report: DoctorReport; checks: Check[]; facts: Facts }> {
  const at = deps.now();
  const facts = await gatherFacts(deps, opts);
  const checks = checksOf(facts);
  return { report: reportOf(facts, checks, at), checks, facts };
}

/** The record's checks: the report's, without fix text. */
export const recordChecks = (r: DoctorReport): RecordCheck[] =>
  r.checks.map(({ id, ok, severity, detail, repo }) => ({
    id,
    ok,
    severity,
    detail,
    ...(repo !== undefined ? { repo } : {}),
  }));

/** A failing `block` check: the machine cannot run an agent until it is fixed. */
export const blocking = (r: DoctorReport) =>
  r.checks.filter((c) => !c.ok && c.severity === "block");

const mark = (c: { ok: boolean; severity: Severity }) =>
  c.ok ? "✓" : c.severity === "block" ? "✗" : "!";

/** A check's name in the output: its id, and the repository it is about. */
const nameOf = (c: { id: string; repo?: string }) =>
  c.repo !== undefined ? `${c.id} (${c.repo})` : c.id;

/**
 * One line per check (`✓` / `!` / `✗`), the fix under a failing one, and a closing line naming
 * the `!` checks the supervisor's readiness still needs.
 */
export function renderHuman(checks: DoctorReport["checks"]): string {
  const lines = checks
    .map(
      (c) =>
        `${mark(c)} ${nameOf(c)}: ${c.detail}\n${!c.ok && c.fix !== undefined ? `    fix: ${c.fix}\n` : ""}`,
    )
    .join("");
  const needed = checks.filter((c) => !c.ok && NEEDED_FOR_READY.includes(c.id)).map((c) => c.id);
  return needed.length > 0
    ? `${lines}${needed.length} warning(s) still keep this machine from being ready for agents (the supervisor needs them): ${needed.join(", ")}\n`
    : lines;
}

const pctOf = (w: UsageWindow) => `${Math.round(w.pct)}%`;

function ageOf(iso: string, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 60_000));
  if (min < 1) return "just now";
  return min < 120 ? `${min} min ago` : `${Math.floor(min / 60)} h ago`;
}

const WHY: Record<Exclude<ClaudeLogin["state"], "ok">, string> = {
  expired: "login expired; Claude Code renews it on its next request",
  no_credential: "no stored login",
  rate_limited: "the usage endpoint asked to slow down",
  rejected: "the usage endpoint refused the login",
  error: "the usage endpoint did not answer",
};

/**
 * One line per login: `Claude usage: default 5h 37% · 7d 56% · Fable 12% (read 2 min ago)`, or
 * `—` and why when there is no reading.
 */
export function renderUsage(logins: readonly ClaudeLogin[], now: Date): string {
  return logins
    .map((l) => {
      const r = l.reading;
      const why = l.state === "ok" ? null : WHY[l.state];
      if (r === undefined) return `Claude usage: ${l.profile} — (${why ?? "no reading yet"})\n`;
      const parts = [
        ...(r.five_hour !== undefined ? [`5h ${pctOf(r.five_hour)}`] : []),
        ...(r.weekly !== undefined ? [`7d ${pctOf(r.weekly)}`] : []),
        ...PROBE_FAMILIES.flatMap((f) => {
          const w = r.model_weekly?.[f];
          return w !== undefined ? [`${f[0]?.toUpperCase()}${f.slice(1)} ${pctOf(w)}`] : [];
        }),
      ];
      const age = `read ${ageOf(r.read_at, now)}`;
      return `Claude usage: ${l.profile} ${parts.join(" · ") || "—"} (${why === null ? age : `${age}; ${why}`})\n`;
    })
    .join("");
}

// ---------------------------------------------------------------------------------------------
// Fixes
// ---------------------------------------------------------------------------------------------

export interface FixPlan {
  /** Fixable checks that already pass. */
  done: Check[];
  /** Fixable checks that pass only because nothing was known to check against. */
  unchecked: Check[];
  /** Safe fixes the doctor runs (after asking, unless --yes). */
  run: Check[];
  /** Failing checks the person fixes: their commands, printed. */
  manual: Check[];
}

export function planFixes(checks: Check[], opts: DoctorOptions): FixPlan {
  const plan: FixPlan = { done: [], unchecked: [], run: [], manual: [] };
  for (const c of checks) {
    if (c.ok && c.fix?.refresh === true && c.fix.steps !== undefined) {
      // A refresh (fetching a repository): run under --fix while the check passes.
      plan.run.push(c);
    } else if (c.ok) {
      if (c.id === "volley.version" && (opts.requiredVolley ?? null) === null) {
        plan.unchecked.push(c);
      } else if (FIXABLE.includes(c.id)) plan.done.push(c);
    } else if (c.fix?.steps !== undefined && (c.fix.needsClone !== true || opts.clone === true)) {
      plan.run.push(c);
    } else if (c.fix !== undefined) plan.manual.push(c);
  }
  return plan;
}

/**
 * The verb: check, print (human or `--json`), and under `--fix` print the plan, ask (unless
 * `--yes`), run the safe fixes, and check again. Exit 1 while a `block` check fails.
 */
export async function doctor(io: IO, deps: DoctorDeps, opts: DoctorOptions): Promise<ExitCode> {
  if (opts.probeLogin !== undefined) return probeOnly(io, deps, opts.probeLogin, opts);
  let { report, checks } = await runDoctor(deps, opts);
  if (opts.fix === true) {
    // Under --json the plan goes to stderr: stdout is the report alone.
    const say = (s: string) => (opts.json === true ? io.stderr(s) : io.stdout(s));
    const plan = planFixes(checks, opts);
    const lines: string[] = [];
    for (const c of plan.done) lines.push(`✓ ${nameOf(c)}: already done`);
    for (const c of plan.unchecked) {
      lines.push(`· ${c.id}: not checked (the supervisor's requirement is not known here)`);
    }
    for (const c of plan.run) {
      lines.push(`→ ${nameOf(c)}: ${c.fix?.command}`);
      // The edits it makes, named before the yes.
      for (const a of c.fix?.apply ?? []) lines.push(`    ${a.what}`);
    }
    for (const c of plan.manual) {
      const hint =
        c.fix?.needsClone === true ? " (or pass --clone to let the doctor clone it)" : "";
      lines.push(`${mark(c)} ${nameOf(c)}: run it yourself: ${c.fix?.command}${hint}`);
    }
    say(`Fixes:\n${scrub(lines.join("\n"))}\n\n`);
    if (plan.run.length > 0) {
      const go =
        opts.yes === true ||
        (await (deps.confirm?.(`Apply the ${plan.run.length} fix(es) marked →?`) ?? false));
      if (!go) {
        say("Nothing changed (answer yes, or pass --yes).\n\n");
      } else {
        // Every step in plan order; a step two fixes share runs once, at its LAST place: the
        // install volley.installed asks for is the one volley.version ends with, after its
        // checkout (installing before the checkout only would leave the old dependencies).
        const all = plan.run.flatMap((c) => (c.fix?.steps ?? []).map((step) => ({ c, step })));
        const key = (step: string[]) => step.join("\0");
        const todo = all.filter(
          ({ step }, i) => !all.slice(i + 1).some((later) => key(later.step) === key(step)),
        );
        // Per check and repository: one repository's failed clone never skips another's.
        const failed = new Set<string>();
        for (const { c, step } of todo) {
          // A failed step stops the rest of its own fix (a checkout's install needs the checkout).
          if (failed.has(nameOf(c))) continue;
          say(scrub(`$ ${step.join(" ")}\n`));
          const r = await deps
            .exec(step, { timeoutMs: DOCTOR_DEFAULTS.fix_timeout_ms })
            .catch((e: unknown) => ({ code: -1, stdout: "", stderr: String(e) }));
          if (r.code !== 0) {
            const why = r.stderr.trim().split("\n").pop() ?? "";
            say(
              scrub(`✗ ${nameOf(c)}: fix failed (exit ${r.code})${why !== "" ? `: ${why}` : ""}\n`),
            );
            failed.add(nameOf(c));
          } else if (
            basename(step[0] ?? "") === "bun" &&
            step[1] === "install" &&
            step[2] === "--cwd"
          ) {
            markInstalled(step[3] as string);
          }
        }
        for (const c of plan.run) {
          if (failed.has(nameOf(c))) continue;
          for (const a of c.fix?.apply ?? []) {
            say(scrub(`~ ${a.what}\n`));
            try {
              a.run();
            } catch (e) {
              const why = e instanceof Error ? e.message : String(e);
              say(scrub(`✗ ${nameOf(c)}: fix failed: ${why}\n`));
              failed.add(nameOf(c));
              break;
            }
          }
        }
        say("\n");
        ({ report, checks } = await runDoctor(deps, opts));
        // The journal: each repair it applied (a refresh, passing already, is routine).
        const fixes = plan.run
          .filter((c) => !c.ok)
          .map(
            (c): FixRecord => ({
              id: c.id,
              ...(c.repo !== undefined ? { repo: c.repo } : {}),
              command: c.fix?.command ?? "",
              ok: !failed.has(nameOf(c)),
            }),
          );
        if (fixes.length > 0) report = { ...report, fixes: scrub(fixes) };
      }
    }
  }
  io.stdout(
    opts.json === true
      ? `${JSON.stringify(report, null, 2)}\n`
      : `${renderHuman(report.checks)}${renderUsage(report.claude_logins ?? [], deps.now())}`,
  );
  return blocking(report).length > 0 ? EXIT.ERROR : EXIT.OK;
}

/** `--probe-login <profile>`: that login's usage probe alone, reported as the doctor reports it. */
async function probeOnly(
  io: IO,
  deps: DoctorDeps,
  profile: string,
  opts: DoctorOptions,
): Promise<ExitCode> {
  const fetch = deps.fetch;
  const held = findLogins(deps.home, deps.env ?? {}).some((l) => l.profile === profile);
  if (fetch === undefined || !held) {
    io.stderr(
      fetch === undefined
        ? "volley peer doctor: the usage probe is not available here\n"
        : `volley peer doctor: no Claude login '${profile}' on this machine\n`,
    );
    // An empty report, not none: volleyd reads no report as a volley older than the flag.
    if (opts.json === true)
      io.stdout(
        `${JSON.stringify({ claude_logins: [], doctor_at: deps.now().toISOString() }, null, 2)}\n`,
      );
    return EXIT.ERROR;
  }
  // The installed Claude Code's version is the probe's User-Agent, as in a full run.
  const v = await deps
    .exec(["claude", "--version"], { timeoutMs: DOCTOR_DEFAULTS.exec_timeout_ms })
    .catch(() => null);
  const now = deps.now();
  const logins = await probeLogins(
    {
      exec: deps.exec,
      fetch,
      platform: deps.platform,
      home: deps.home,
      env: deps.env ?? {},
      claudeVersion: v?.code === 0 ? versionOf(v.stdout) : null,
    },
    now,
    { only: profile },
  );
  const report = scrub({ claude_logins: logins, doctor_at: now.toISOString() });
  io.stdout(
    opts.json === true
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderUsage(report.claude_logins, deps.now()),
  );
  return EXIT.OK;
}
