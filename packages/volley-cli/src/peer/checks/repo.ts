import type { Check, Facts } from "../doctor";
import { binOf } from "./tools";

/**
 * The wave repo's clone on this machine: there (a git clone at `--repo`), pointing at the wave
 * repo (`origin`, normalised), and fetchable without a prompt. A wrong origin is explained,
 * never changed; a missing clone is cloned only with `--clone` and a known origin URL.
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

export function repoChecks(f: Facts): Check[] {
  const r = f.repo;
  if (r.path === null) {
    return [
      {
        id: "repo.clone",
        ok: false,
        severity: "block",
        detail: "no wave repo: pass --repo <path> (this machine's clone of the wave repository)",
      },
    ];
  }
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
    checks.push({
      id: "repo.origin",
      ok: false,
      severity: "block",
      detail: `origin is ${r.origin}, but the wave repo is ${r.expected}`.slice(0, 200),
      fix: {
        command: `check ${r.path} is the clone you meant; to repoint it yourself: git -C ${r.path} remote set-url origin <url>`,
      },
    });
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
