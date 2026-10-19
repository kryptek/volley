import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { PeerExec } from "../commands/peer";
import { EXIT, type ExitCode } from "../exit-codes";
import type { IO } from "../io";
import { claudeChecks, isRepoTrusted, parseClaudeStatus } from "./checks/claude";
import { ghPermission, ghState, ghUser, githubChecks } from "./checks/github";
import {
  diskOf,
  machineChecks,
  memoryOf,
  vmStatAvailablePct,
  worktreeRoot,
} from "./checks/machine";
import { GIT_QUIET, githubSlug, normalizeOrigin, repoChecks } from "./checks/repo";
import { ON_PATH, binOf, toolChecks, versionOf } from "./checks/tools";

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
 * sign-in, installing a tool) is printed for the person to run. The doctor never reads, stores
 * or prints a credential: it keeps states and plain labels, and scrubs anything token-shaped from
 * what it prints.
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
const FIXABLE = ["volley.installed", "volley.version", "repo.clone"];

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
}

export interface Check {
  id: string;
  ok: boolean;
  severity: Severity;
  /** One line on what the check found (at most 200 characters). */
  detail: string;
  fix?: Fix;
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
  claude: { state: AuthClaude; plan: string | null; trust: AuthTrust };
  machine: {
    memory: Memory;
    disk: Disk | null;
    limits: { mem_low_pct: number; disk_low_gb: number };
  };
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
  uptime: () => number;
  /** `fs.statfs` of an existing path; null when it cannot be read. */
  statfs: (path: string) => StatFs | null;
  /** Asks the person at the terminal; absent or false without one. */
  confirm?: (question: string) => Promise<boolean>;
}

export interface DoctorOptions {
  /** This machine's clone of the wave repo. */
  repo?: string;
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
}

/** The record's check: no fix text (the doctor that reads a record supplies its own). */
export interface RecordCheck {
  id: string;
  ok: boolean;
  severity: Severity;
  detail: string;
}

/** `--json`: exactly the machine record's doctor fields, plus each failing check's fix text. */
export interface DoctorReport {
  checks: (RecordCheck & { fix?: string })[];
  versions: Record<"peer" | "volley" | "bun" | "git", string | null> &
    Partial<Record<"gh" | "tmux" | "claude", string | null>>;
  auth: { gh: AuthGh; claude: AuthClaude; trust: AuthTrust; claude_plan?: string };
  repo?: {
    path: string;
    exists: boolean;
    origin?: string;
    release_branch?: string;
    fetched_at: string | null;
  };
  memory: Memory;
  disk?: Disk;
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
  const sh = (argv: string[]) =>
    deps
      .exec(argv, { timeoutMs: DOCTOR_DEFAULTS.exec_timeout_ms })
      .catch(() => ({ code: -1, stdout: "", stderr: "" }));
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

  // The wave repo's clone.
  const path = opts.repo !== undefined ? resolve(opts.repo) : null;
  const exists = path !== null && existsSync(path);
  let empty = false;
  if (exists) {
    try {
      empty = statSync(path).isDirectory() && readdirSync(path).length === 0;
    } catch {}
  }
  const isGit =
    exists &&
    !empty &&
    gitBin !== null &&
    firstLine((await sh([gitBin, "-C", path, "rev-parse", "--is-inside-work-tree"])).stdout) ===
      "true";
  let origin: string | null = null;
  let fetchable: boolean | null = null;
  let fetchedAt: string | null = null;
  const release = opts.release ?? null;
  if (isGit && gitBin !== null) {
    const r = await sh([gitBin, "-C", path, "remote", "get-url", "origin"]);
    origin = r.code === 0 ? normalizeOrigin(firstLine(r.stdout)) : null;
    const ref = release !== null ? `refs/heads/${release}` : "HEAD";
    fetchable =
      (await sh([...GIT_QUIET, gitBin, "-C", path, "ls-remote", "--exit-code", "origin", ref]))
        .code === 0;
    try {
      fetchedAt = statSync(join(path, ".git", "FETCH_HEAD")).mtime.toISOString();
    } catch {}
  }
  const expected = opts.origin !== undefined ? normalizeOrigin(opts.origin) : null;

  // GitHub.
  const ghPresent = ghBin !== null;
  const signedIn = ghBin !== null && (await sh([ghBin, "auth", "status"])).code === 0;
  const user =
    signedIn && ghBin !== null
      ? ghUser((await sh([ghBin, "api", "user", "--jq", ".login"])).stdout)
      : null;
  const slug = githubSlug(origin ?? expected);
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

  // Claude Code: sign-in state and folder trust.
  let claude: { state: AuthClaude; plan: string | null } = { state: "missing", plan: null };
  if (claudeBin !== null) {
    const r = await sh([claudeBin, "auth", "status"]);
    claude = parseClaudeStatus(r.code, r.stdout);
  }
  let trust: AuthTrust = "unknown";
  if (path !== null) {
    const file = join(deps.home, ".claude.json");
    if (!existsSync(file)) trust = "missing";
    else {
      const j = readJson(file);
      trust = j === undefined ? "unknown" : isRepoTrusted(j, path) ? "ok" : "missing";
    }
  }

  // The machine: memory (macOS: vm_stat's reclaimable pages, as free pages under-count) and the
  // worktrees' disk.
  let available: number | null = null;
  if (deps.platform === "darwin")
    available = vmStatAvailablePct((await sh(["vm_stat"])).stdout, deps.totalmem());
  const root = worktreeRoot(path, deps.home);
  const st = deps.statfs(nearestExisting(root));

  return {
    platform: deps.platform,
    shell,
    pkg,
    peerVersion: deps.version,
    tools,
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
    claude: { ...claude, trust },
    machine: {
      memory: memoryOf(deps.totalmem(), deps.freemem(), available),
      disk: st !== null ? diskOf(root, st) : null,
      limits: {
        mem_low_pct: DOCTOR_DEFAULTS.mem_low_pct,
        disk_low_gb: DOCTOR_DEFAULTS.disk_low_gb,
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

export function checksOf(f: Facts): Check[] {
  return [
    ...toolChecks(f),
    ...repoChecks(f),
    ...githubChecks(f),
    ...claudeChecks(f),
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
    },
    ...(r.path !== null
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
    memory: f.machine.memory,
    ...(f.machine.disk !== null ? { disk: f.machine.disk } : {}),
    doctor_at: at.toISOString(),
  });
}

/** Run every check once. */
export async function runDoctor(
  deps: DoctorDeps,
  opts: DoctorOptions,
): Promise<{ report: DoctorReport; checks: Check[]; facts: Facts }> {
  const facts = await gatherFacts(deps, opts);
  const checks = checksOf(facts);
  return { report: reportOf(facts, checks, deps.now()), checks, facts };
}

/** The record's checks: the report's, without fix text. */
export const recordChecks = (r: DoctorReport): RecordCheck[] =>
  r.checks.map(({ id, ok, severity, detail }) => ({ id, ok, severity, detail }));

/** A failing `block` check: the machine cannot run an agent until it is fixed. */
export const blocking = (r: DoctorReport) =>
  r.checks.filter((c) => !c.ok && c.severity === "block");

const mark = (c: { ok: boolean; severity: Severity }) =>
  c.ok ? "✓" : c.severity === "block" ? "✗" : "!";

/**
 * One line per check (`✓` / `!` / `✗`), the fix under a failing one, and a closing line naming
 * the `!` checks the supervisor's readiness still needs.
 */
export function renderHuman(checks: DoctorReport["checks"]): string {
  const lines = checks
    .map(
      (c) =>
        `${mark(c)} ${c.id}: ${c.detail}\n${!c.ok && c.fix !== undefined ? `    fix: ${c.fix}\n` : ""}`,
    )
    .join("");
  const needed = checks.filter((c) => !c.ok && NEEDED_FOR_READY.includes(c.id)).map((c) => c.id);
  return needed.length > 0
    ? `${lines}${needed.length} warning(s) still keep this machine from being ready for agents (the supervisor needs them): ${needed.join(", ")}\n`
    : lines;
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
    if (c.ok) {
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
  let { report, checks } = await runDoctor(deps, opts);
  if (opts.fix === true) {
    // Under --json the plan goes to stderr: stdout is the report alone.
    const say = (s: string) => (opts.json === true ? io.stderr(s) : io.stdout(s));
    const plan = planFixes(checks, opts);
    const lines: string[] = [];
    for (const c of plan.done) lines.push(`✓ ${c.id}: already done`);
    for (const c of plan.unchecked) {
      lines.push(`· ${c.id}: not checked (the supervisor's requirement is not known here)`);
    }
    for (const c of plan.run) lines.push(`→ ${c.id}: ${c.fix?.command}`);
    for (const c of plan.manual) {
      const hint =
        c.fix?.needsClone === true ? " (or pass --clone to let the doctor clone it)" : "";
      lines.push(`${mark(c)} ${c.id}: run it yourself: ${c.fix?.command}${hint}`);
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
        const failed = new Set<string>();
        for (const { c, step } of todo) {
          // A failed step stops the rest of its own fix (a checkout's install needs the checkout).
          if (failed.has(c.id)) continue;
          say(scrub(`$ ${step.join(" ")}\n`));
          const r = await deps
            .exec(step, { timeoutMs: DOCTOR_DEFAULTS.fix_timeout_ms })
            .catch((e: unknown) => ({ code: -1, stdout: "", stderr: String(e) }));
          if (r.code !== 0) {
            const why = r.stderr.trim().split("\n").pop() ?? "";
            say(scrub(`✗ ${c.id}: fix failed (exit ${r.code})${why !== "" ? `: ${why}` : ""}\n`));
            failed.add(c.id);
          } else if (
            basename(step[0] ?? "") === "bun" &&
            step[1] === "install" &&
            step[2] === "--cwd"
          ) {
            markInstalled(step[3] as string);
          }
        }
        say("\n");
        ({ report, checks } = await runDoctor(deps, opts));
      }
    }
  }
  io.stdout(
    opts.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderHuman(report.checks),
  );
  return blocking(report).length > 0 ? EXIT.ERROR : EXIT.OK;
}
