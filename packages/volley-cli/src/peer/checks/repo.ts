import { mkdirSync } from "node:fs";
import { originToSlug } from "volleyd/repos";
import type { Check, Facts, RepoFacts } from "../doctor";
import { PUSH, ghChecks, sameRepository } from "./github";
import { binOf } from "./tools";

/**
 * The wave repo's clone on this machine (or each repository's, #435): there (a git clone at
 * `--repo`), pointing at the wave repo (`origin`, normalised), and fetchable without a prompt. A
 * wrong origin is explained, never changed; a missing clone is cloned only with `--clone` and a
 * known origin URL.
 */

/**
 * The environment of every git command that reaches the wave repo's host: no prompt of any kind
 * (git's own, an askpass helper, or ssh's for a key passphrase or an unknown host key), so a
 * probe answers for the unattended agent, not for the person at this terminal.
 */
export const GIT_QUIET = [
  "env",
  "GIT_TERMINAL_PROMPT=0",
  "GIT_ASKPASS=",
  "SSH_ASKPASS=",
  "GIT_SSH_COMMAND=ssh -o BatchMode=yes",
];

/**
 * `origin` as `<host>[:port]/<path>`: no scheme, user or credentials, no `.git`, ssh and https
 * forms folded (`git@github.com:o/r.git` and `https://github.com/o/r` are both
 * `github.com/o/r`; GitHub's names are case-insensitive, so its path is lower-cased). Null for a
 * local path or anything else without a host.
 */
export function normalizeOrigin(url: string): string | null {
  const u = url.trim();
  let host: string;
  let port = "";
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(u);
  if (scheme !== null) {
    if ((scheme[1] as string).toLowerCase() === "file") return null;
    const authority = (scheme[2] as string).replace(/^.*@/, "");
    const hp = /^([^:]+)(?::(\d{1,5}))?$/.exec(authority);
    if (hp === null) return null;
    host = hp[1] as string;
    // The scheme's default port says nothing: fold it away.
    if (hp[2] !== undefined && !["22", "443", "80", "9418"].includes(hp[2])) port = `:${hp[2]}`;
    path = scheme[3] ?? "";
  } else {
    // scp-like: [user@]host:path (a colon before any slash).
    const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(u);
    if (scp === null) return null;
    host = scp[1] as string;
    path = scp[2] as string;
  }
  path = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  host = host.toLowerCase();
  if (host === "github.com") path = path.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || path === "" || /[\s@:]/.test(path)) return null;
  const out = `${host}${port}/${path}`;
  return out.length <= 512 ? out : null;
}

/** `owner/repo` of a github.com origin, for `gh repo view`. */
export function githubSlug(origin: string | null): string | null {
  const m = /^github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(origin ?? "");
  return m?.[1] ?? null;
}

/** One clone as the clone checks read it: the legacy wave repo's, or one repository's. */
interface CloneView {
  path: string;
  exists: boolean;
  empty: boolean;
  isGit: boolean;
  origin: string | null;
  /** The origin it should have, normalised; null when unknown. */
  expected: string | null;
  cloneUrl: string | null;
  release: string | null;
  fetchable: boolean | null;
}

/** `repo.clone`, then (for a clone) `repo.origin` unless `origin` decides it, then `repo.fetch`. */
function cloneChecks(
  f: Facts,
  r: CloneView,
  origin: ((r: CloneView) => Check[]) | null = null,
  fetch: Check["fix"] = undefined,
): Check[] {
  if (r.exists && !r.empty && !r.isGit) {
    return [
      {
        id: "repo.clone",
        ok: false,
        severity: "block",
        detail: `${r.path} exists and is not a git clone`,
        fix: { command: `move ${r.path} aside, or pass --repo with the clone's path` },
      },
    ];
  }
  if (!r.isGit) {
    const git = binOf(f.tools.git);
    // `--`: the URL is never read as an option.
    const steps =
      r.cloneUrl !== null && git !== null
        ? [[...GIT_QUIET, git, "clone", "--", r.cloneUrl, r.path]]
        : null;
    return [
      {
        id: "repo.clone",
        ok: false,
        severity: "block",
        detail: `no clone at ${r.path}`,
        fix:
          steps !== null
            ? { command: `git clone ${r.cloneUrl} ${r.path}`, steps, needsClone: true }
            : {
                command: `git clone ${r.cloneUrl ?? "<the wave repo's URL>"} ${r.path} (or run volley peer doctor --fix --clone --origin <url> --repo ${r.path} to let the doctor do it)`,
              },
      },
    ];
  }
  const checks: Check[] = [
    { id: "repo.clone", ok: true, severity: "block", detail: `clone at ${r.path}` },
  ];
  if (r.origin === null) {
    checks.push({
      id: "repo.origin",
      ok: false,
      severity: "block",
      detail: `${r.path} has no origin remote with a host (git remote get-url origin)`,
      fix: { command: `git -C ${r.path} remote add origin <the wave repo's URL>` },
    });
  } else if (r.expected !== null && r.expected !== r.origin) {
    checks.push(
      ...(origin?.(r) ?? [
        {
          id: "repo.origin",
          ok: false,
          severity: "block",
          detail: `origin is ${r.origin}, but the wave repo is ${r.expected}`.slice(0, 200),
          fix: {
            command: `check ${r.path} is the clone you meant; to repoint it yourself: git -C ${r.path} remote set-url origin <url>`,
          },
        },
      ]),
    );
  } else {
    checks.push({ id: "repo.origin", ok: true, severity: "block", detail: `origin ${r.origin}` });
  }
  const ref = r.release !== null ? `origin/${r.release}` : "origin";
  checks.push(
    r.fetchable === true
      ? {
          id: "repo.fetch",
          ok: true,
          severity: "warn",
          detail: `${ref} is fetchable without a prompt`,
          ...(fetch !== undefined && !checks.some((c) => !c.ok && c.severity === "block")
            ? { fix: fetch }
            : {}),
        }
      : {
          id: "repo.fetch",
          ok: false,
          severity: "warn",
          detail: `cannot fetch ${ref} without a prompt`,
          fix: {
            command:
              "gh auth setup-git (https origins), or add this machine's ssh key to the git host (ssh origins)",
          },
        },
  );
  return checks;
}

/** The legacy single wave repo's clone (`--repo`, peer.json's `repo`). */
export function repoChecks(f: Facts): Check[] {
  const r = f.repo;
  if (r.path === null) {
    return [
      {
        id: "repo.clone",
        ok: false,
        severity: "block",
        detail:
          "no wave repo: pass --repo <path> (this machine's clone of the wave repository), or --repo-add <owner/name>",
      },
    ];
  }
  return cloneChecks(f, { ...r, path: r.path });
}

/** A repository's GitHub URL: what `--clone` clones and a repoint sets. */
export const githubUrl = (slug: string) => `https://github.com/${slug}.git`;

/**
 * Every repository in peer.json's `repos`, each check carrying `repo`. D6: a remote that names
 * the repository's old owner or name (GitHub reports one `nameWithOwner` for both) passes
 * `repo.origin` and warns `repo.canonical`, whose fix repoints it; any other mismatch blocks and
 * is never changed. D7: `--fix` fetches every repository, and fast-forwards a managed clone's
 * checked-out default branch while its worktree is clean; an adopted clone is fetched only.
 */
export function reposChecks(f: Facts): Check[] {
  const git = binOf(f.tools.git);
  return f.repos.flatMap((r) => {
    const view: CloneView = {
      ...r,
      expected: `github.com/${r.slug.toLowerCase()}`,
      cloneUrl: githubUrl(r.slug),
      release: null,
    };
    const renamed = (v: CloneView): Check[] => {
      if (!sameRepository(r.canonical)) return [];
      const remote = originToSlug(v.origin);
      if (remote !== undefined && remote.toLowerCase() === r.canonical.configured.toLowerCase()) {
        // The remote already names GitHub's name: peer.json's slug is the stale one. Repointing
        // would set the URL origin has, so the person updates peer.json instead.
        return [
          {
            id: "repo.origin",
            ok: true,
            severity: "block",
            detail: `origin ${v.origin}: GitHub's ${r.canonical.configured}`,
          },
          {
            id: "repo.canonical",
            ok: false,
            severity: "warn",
            detail: `peer.json names the old owner or name: ${r.slug} is now ${r.canonical.configured}`,
            fix: {
              command: `volley peer doctor --repo-remove ${r.slug} --repo-add ${r.canonical.configured}=${r.path}`,
            },
          },
        ];
      }
      const url = githubUrl(r.canonical.configured);
      const step = [git ?? "git", "-C", r.path, "remote", "set-url", "origin", url];
      return [
        {
          id: "repo.origin",
          ok: true,
          severity: "block",
          detail: `origin ${v.origin}: GitHub's ${r.canonical.configured}`,
        },
        {
          id: "repo.canonical",
          ok: false,
          severity: "warn",
          detail: `the remote names the old owner or name: ${originToSlug(v.origin) ?? v.origin} is now ${r.canonical.configured}`,
          fix: { command: step.join(" "), ...(git !== null ? { steps: [step] } : {}) },
        },
      ];
    };
    const origin = (v: CloneView): Check[] => {
      const same = renamed(v);
      return same.length > 0
        ? same
        : [
            {
              id: "repo.origin",
              ok: false,
              severity: "block",
              detail: `origin is ${v.origin}, but the repository is ${v.expected}`.slice(0, 200),
              fix: {
                command: `check ${r.path} is ${r.slug}'s clone; to repoint it yourself: git -C ${r.path} remote set-url origin ${githubUrl(r.slug)}`,
              },
            },
          ];
    };
    const fetchStep = [...GIT_QUIET, git ?? "git", "-C", r.path, "fetch", "--quiet", "origin"];
    const ff =
      r.managed &&
      r.clean &&
      r.head !== null &&
      r.defaultBranch !== null &&
      r.head === r.defaultBranch
        ? [git ?? "git", "-C", r.path, "merge", "--ff-only", "--quiet", `origin/${r.defaultBranch}`]
        : null;
    const steps = ff !== null ? [fetchStep, ff] : [fetchStep];
    const fetch =
      git !== null
        ? { command: steps.map((s) => s.join(" ")).join(" && "), steps, refresh: true }
        : undefined;
    return [...cloneChecks(f, view, origin, fetch), pushCheck(f, r), worktreesCheck(r)].map(
      (c) => ({ ...c, repo: r.slug }),
    );
  });
}

/**
 * `repo.push` (#610): this machine's own gh may push to this repository (`viewerPermission`
 * WRITE, MAINTAIN or ADMIN). Without gh signed in it fails with gh.auth's fix, so readiness blocks
 * the repository rather than letting it through unchecked.
 */
function pushCheck(f: Facts, r: RepoFacts): Check {
  const g = f.github;
  const who = g.user ?? "the signed-in GitHub user";
  const fail = (detail: string, command: string): Check => ({
    id: "repo.push",
    ok: false,
    severity: "block",
    detail,
    fix: { command },
  });
  if (!g.present || !g.signedIn) {
    const auth = ghChecks(f)[0];
    return fail(
      `cannot check push access to ${r.slug}: ${auth?.detail ?? "gh is not signed in"}`,
      auth?.fix?.command ?? "gh auth login && gh auth setup-git",
    );
  }
  const ask = `ask for write access to ${r.slug} for ${who}, or gh auth login as an account that has it`;
  if (r.permission === null) {
    return fail(
      `GitHub did not say whether ${who} may push to ${r.slug} (gh repo view ${r.slug} failed)`,
      ask,
    );
  }
  if (!PUSH.has(r.permission)) {
    return fail(`${who} cannot push to ${r.slug} (permission ${r.permission})`, ask);
  }
  return {
    id: "repo.push",
    ok: true,
    severity: "block",
    detail: `${who} has ${r.permission} access to ${r.slug}`,
  };
}

/** `p` as one shell word: as is when it is plain, else single-quoted (a fix's command is pasted). */
const shellArg = (p: string): string =>
  /^[\w./~@:+,=-]+$/.test(p) ? p : `'${p.replaceAll("'", "'\\''")}'`;

/**
 * `repo.worktrees` (#610): the directory volleyd cuts this repository's worktrees under exists and
 * is writable, or its nearest existing ancestor is. Its fix (`mkdir -p`) is safe: `--fix` applies it.
 */
function worktreesCheck(r: RepoFacts): Check {
  const root = r.worktreeRoot;
  if (r.worktreeWritable) {
    return {
      id: "repo.worktrees",
      ok: true,
      severity: "block",
      detail: `${root} is writable`,
    };
  }
  return {
    id: "repo.worktrees",
    ok: false,
    severity: "block",
    detail: `cannot write ${root} (nor create it): volleyd cuts ${r.slug}'s worktrees there`,
    fix: {
      command: `mkdir -p ${shellArg(root)}`,
      steps: [],
      apply: [{ what: `create ${root}`, run: () => mkdirSync(root, { recursive: true }) }],
    },
  };
}
