import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

/**
 * The simulated GitHub (and Claude sign-in) world: one JSON file under `$VOLLEY_SIM_HOME`, read
 * and written by every `gh` / `claude` process under an advisory lock, so separate processes see
 * one consistent world. It is the file-backed port of volleyd's soak world
 * (`packages/volleyd/test/helpers/soak-world.ts`) with one difference: git is real. A repository's
 * commits live in a real bare origin; the world keeps what GitHub adds on top (PRs, issues,
 * labels, CI runs, the logins) and reads every head from the origin, so a push moves a PR the way
 * it does on GitHub, and a merge writes the commit into the origin with git's own plumbing.
 */

export const WORLD_VERSION = 1;
/** The GitHub login the fake `gh` is signed in as. */
export const SIM_LOGIN = "volley-sim";
/** The account `gh api user` answers (setup derives git's identity from it: name, id, login). */
export const SIM_GH_USER = { login: SIM_LOGIN, id: 1, name: "Volley Sim" } as const;
/** Every repository's web root. */
export const WEB = "https://github.com";

/** An author for the commits the world writes (and the tests make), with signing off. */
export const GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: "Volley Sim",
  GIT_AUTHOR_EMAIL: "sim@volley.invalid",
  GIT_COMMITTER_NAME: "Volley Sim",
  GIT_COMMITTER_EMAIL: "sim@volley.invalid",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "tag.gpgsign",
  GIT_CONFIG_VALUE_1: "false",
};

export interface Repo {
  /** `owner/name`. */
  slug: string;
  visibility: "PUBLIC" | "PRIVATE" | "INTERNAL";
  /** The bare origin (absolute, real path); null: a repository with no local git (reads only). */
  origin: string | null;
  defaultBranch: string;
}

export interface Pr {
  number: number;
  repo: string;
  url: string;
  title: string;
  body: string;
  headRefName: string;
  baseRefName: string;
  /** The head when last read from the origin (frozen once the PR is merged or closed). */
  headRefOid: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  mergeCommit: string | null;
  mergedAt: string | null;
  createdAt: string;
}

export interface Issue {
  number: number;
  repo: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  comments: string[];
}

export interface Label {
  name: string;
  description: string;
  color: string;
}

/** A CI run: computed once per (head, event) on first read. Always green. */
export interface Run {
  id: number;
  repo: string;
  head: string;
  event: "pull_request" | "push";
  branch: string;
  conclusion: "success" | "failure";
  createdAt: string;
}

export interface World {
  version: number;
  gh: { signedIn: boolean; setupGit: boolean };
  /** Claude Code sign-ins by profile (`CLAUDE_CONFIG_DIR`, or `default`). */
  claude: { logins: Record<string, boolean> };
  repos: Record<string, Repo>;
  /** The next issue/PR number per repository (GitHub shares one sequence between them). */
  next: Record<string, number>;
  runId: number;
  prs: Pr[];
  issues: Issue[];
  labels: Record<string, Label[]>;
  runs: Run[];
  /** Every merge the fake GitHub performed, in order. */
  merges: { repo: string; pr: number; head: string; sha: string }[];
}

export const emptyWorld = (): World => ({
  version: WORLD_VERSION,
  gh: { signedIn: false, setupGit: false },
  claude: { logins: {} },
  repos: {},
  next: {},
  runId: 7000,
  prs: [],
  issues: [],
  labels: {},
  runs: [],
  merges: [],
});

export const worldPath = (home: string) => join(home, "world.json");
export const lockPath = (home: string) => join(home, "world.json.lock");
export const unknownPath = (home: string) => join(home, "unknown.jsonl");
/** Where `gh repo create` puts a repository's bare origin. */
export const originsDir = (home: string) => join(home, "origins");

/** The world as it is on disk (an empty one when there is no file yet). Takes no lock. */
export function readWorld(home: string): World {
  const p = worldPath(home);
  if (!existsSync(p)) return emptyWorld();
  const w = JSON.parse(readFileSync(p, "utf8")) as World;
  if (w.version !== WORLD_VERSION)
    throw new Error(
      `${p}: world version ${w.version}, expected ${WORLD_VERSION} (volley sim reset)`,
    );
  return w;
}

// --- the lock -----------------------------------------------------------------------------------

/** How long a process waits for the lock before giving up. */
const LOCK_TIMEOUT_MS = 30_000;
/** A lock older than this is stale whatever its pid says (a holder never takes this long). */
const LOCK_STALE_MS = 60_000;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Whether the lock at `p` was left by a process that is gone (or is older than any holder). */
function stale(p: string): boolean {
  try {
    const pid = Number(readFileSync(p, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) return true;
    return Date.now() - statSync(p).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Take the advisory lock: create `world.json.lock` exclusively (O_EXCL) with this pid in it,
 * retrying until the holder removes it; a lock whose process is gone is removed first.
 */
function lock(home: string): () => void {
  mkdirSync(home, { recursive: true });
  const p = lockPath(home);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(p, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        try {
          unlinkSync(p);
        } catch {}
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (stale(p)) {
      try {
        unlinkSync(p);
      } catch {}
      continue;
    }
    if (Date.now() > deadline) throw new Error(`volley-sim: ${p} is held: gave up after 30 s`);
    sleep(5 + Math.min(attempt, 10) * 5 + Math.floor(Math.random() * 10));
  }
}

/**
 * Read the world under the lock, let `fn` change it, write it back atomically (a temp file
 * renamed over it) and release the lock. A throw from `fn` writes nothing.
 */
export function withWorld<T>(home: string, fn: (w: World) => T): T {
  const release = lock(home);
  try {
    const w = readWorld(home);
    const out = fn(w);
    const tmp = `${worldPath(home)}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(w, null, 2)}\n`);
    renameSync(tmp, worldPath(home));
    return out;
  } finally {
    release();
  }
}

/** Record an argv no rule answered (`unknown.jsonl`, one JSON object per line). */
export function appendUnknown(home: string, argv: string[], cwd: string): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(
    unknownPath(home),
    `${JSON.stringify({ at: new Date().toISOString(), cwd, argv })}\n`,
  );
}

// --- git (real) ---------------------------------------------------------------------------------

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the real git; never throws. */
export function git(args: string[], cwd?: string): GitResult {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    ...(cwd !== undefined ? { cwd } : {}),
    env: { ...process.env, ...GIT_IDENTITY },
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** git against a bare origin (`git --git-dir <origin> …`). */
export const bare = (origin: string, args: string[]) => git(["--git-dir", origin, ...args]);

/** The sha `ref` names in `origin`, or null. */
export function revParse(origin: string, ref: string): string | null {
  const r = bare(origin, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** A branch's tip on the origin, or null. */
export const branchTip = (origin: string, branch: string) =>
  revParse(origin, `refs/heads/${branch}`);

export const isAncestor = (origin: string, a: string, b: string) =>
  bare(origin, ["merge-base", "--is-ancestor", a, b]).code === 0;

/** The files `head` changes since it forked from `base` (`git diff --name-only base...head`). */
export function changedFiles(origin: string, base: string, head: string): string[] {
  const r = bare(origin, ["diff", "--name-only", `${base}...${head}`]);
  return r.code === 0 ? r.stdout.split("\n").filter((l) => l !== "") : [];
}

/**
 * Write a merge of `head` into `onto` on the origin: the tree git's merge makes, committed with
 * `parents` (a squash: just `onto`; a merge commit: `onto` and `head`). Null on a conflict.
 */
export function mergeOnOrigin(
  origin: string,
  onto: string,
  head: string,
  parents: string[],
  message: string,
): string | null {
  const tree = bare(origin, ["merge-tree", "--write-tree", onto, head]);
  if (tree.code !== 0) return null;
  const oid = tree.stdout.split("\n")[0]?.trim() ?? "";
  const c = bare(origin, ["commit-tree", oid, ...parents.flatMap((p) => ["-p", p]), "-m", message]);
  return c.code === 0 ? c.stdout.trim() : null;
}

/** Move `branch` on the origin from `from` to `to` (refused if it moved meanwhile). */
export const updateBranch = (origin: string, branch: string, to: string, from: string) =>
  bare(origin, ["update-ref", `refs/heads/${branch}`, to, from]).code === 0;

export const deleteBranch = (origin: string, branch: string) =>
  bare(origin, ["update-ref", "-d", `refs/heads/${branch}`]).code === 0;

// --- repositories -------------------------------------------------------------------------------

/** A remote URL as a local path (absolute, real), or null when it is not a local repository. */
export function localPath(url: string, cwd: string): string | null {
  let p = url.trim();
  if (p.startsWith("file://")) p = p.slice("file://".length);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /^[^/]+@[^:]+:/.test(p)) return null;
  p = isAbsolute(p) ? p : resolve(cwd, p);
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/** `owner/name` of a GitHub URL (https or ssh), or null. */
export function slugOfUrl(url: string): string | null {
  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m === null ? null : `${m[1]}/${m[2]}`;
}

/** `owner/name` from a `--repo` value (`owner/name` or `host/owner/name`), or null. */
export function slugOfFlag(v: string): string | null {
  const parts = v.split("/");
  if (parts.length === 2 || parts.length === 3) {
    const [o, n] = parts.slice(-2) as [string, string];
    if (o !== "" && n !== "") return `${o}/${n}`;
  }
  return null;
}

/**
 * The repository a command run in `cwd` acts on: its origin remote's. A local bare origin the
 * world does not know yet is adopted as `volley-sim/<name>` (the local bare origin of
 * `--simulated` runs); a GitHub URL as its own slug, with no local git. Null: no origin remote.
 */
export function repoOfCwd(w: World, cwd: string): Repo | null {
  const r = git(["remote", "get-url", "origin"], cwd);
  if (r.code !== 0) return null;
  const url = r.stdout.trim();
  const path = localPath(url, cwd);
  if (path !== null) {
    const known = Object.values(w.repos).find((x) => x.origin === path);
    if (known !== undefined) return known;
    const name = basename(path).replace(/\.git$/, "");
    return adopt(w, { slug: `${SIM_LOGIN}/${name}`, origin: path });
  }
  const slug = slugOfUrl(url);
  if (slug === null) return null;
  return w.repos[slug] ?? adopt(w, { slug, origin: null });
}

function adopt(w: World, o: { slug: string; origin: string | null }): Repo {
  const head =
    o.origin !== null ? bare(o.origin, ["symbolic-ref", "--short", "HEAD"]).stdout.trim() : "";
  const repo: Repo = {
    slug: o.slug,
    visibility: "PRIVATE",
    origin: o.origin,
    defaultBranch: head !== "" ? head : "main",
  };
  w.repos[o.slug] = repo;
  return repo;
}

/** The next issue/PR number of `repo`. */
export function nextNumber(w: World, repo: string): number {
  const n = w.next[repo] ?? 1;
  w.next[repo] = n + 1;
  return n;
}

/** Refresh an open PR's head from the origin (GitHub follows the branch). */
export function refreshPr(w: World, pr: Pr): Pr {
  if (pr.state !== "OPEN") return pr;
  const origin = w.repos[pr.repo]?.origin;
  if (origin === null || origin === undefined) return pr;
  const tip = branchTip(origin, pr.headRefName);
  if (tip !== null) pr.headRefOid = tip;
  return pr;
}

/** CI on `head` for `event`: computed once (green), then the same run on every read. */
export function ciOf(w: World, repo: string, head: string, event: Run["event"], branch: string) {
  let rs = w.runs.filter((r) => r.repo === repo && r.head === head && r.event === event);
  if (rs.length === 0) {
    const run: Run = {
      id: ++w.runId,
      repo,
      head,
      event,
      branch,
      conclusion: "success",
      createdAt: new Date().toISOString(),
    };
    w.runs.push(run);
    rs = [run];
  }
  return rs;
}
