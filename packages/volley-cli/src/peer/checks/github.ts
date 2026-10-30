import { isSlug } from "volleyd/repos";
import type { AuthGh, Check, Facts } from "../doctor";
import { binOf } from "./tools";

/**
 * GitHub: this machine's own `gh` is signed in (`gh auth status`'s exit code: a state, never its
 * text) and its user may push to the wave repo (`viewerPermission` WRITE, MAINTAIN or ADMIN);
 * and git has a commit identity here (`git.identity`).
 */

export const PUSH = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

/** A GitHub login: letters, digits and dashes, at most 39 (never a token's underscore). */
export const ghUser = (out: string): string | null => {
  const first = (out.split("\n")[0] ?? "").trim();
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(first) ? first : null;
};

/** `WRITE`, `READ`…: upper-case letters only. */
export const ghPermission = (out: string): string | null => {
  const first = (out.split("\n")[0] ?? "").trim();
  return /^[A-Z]{1,16}$/.test(first) ? first : null;
};

/**
 * GitHub's canonical `owner/name` out of `gh repo view <slug> --json nameWithOwner` (D6): a
 * renamed or transferred repository answers with its new name. Null for anything else.
 */
export const canonicalSlug = (out: string): string | null => {
  const first = (out.split("\n")[0] ?? "").trim();
  return isSlug(first) ? first : null;
};

/**
 * D6: a clone whose remote names `remote` while the configured repository is another slug is the
 * same repository only when GitHub reports one `nameWithOwner` for both (it was renamed or
 * transferred). Unknown (no gh, or GitHub did not answer) is never the same.
 */
export const sameRepository = (
  canonical: { configured: string | null; remote: string | null } | null,
): canonical is { configured: string; remote: string } =>
  canonical !== null &&
  canonical.configured !== null &&
  canonical.remote !== null &&
  canonical.configured.toLowerCase() === canonical.remote.toLowerCase();

export function ghState(f: Facts): AuthGh {
  const g = f.github;
  if (!g.present) return "missing";
  if (!g.signedIn) return "unauthenticated";
  if (g.slug !== null && (g.permission === null || !PUSH.has(g.permission))) return "no_write";
  return "ok";
}

/**
 * git can commit here (the home's identity: global or system): without one an agent's first
 * commit dies unless its clone sets its own (`repo.identity`). A warn, like gh.auth.
 */
function gitIdentityCheck(f: Facts): Check {
  const id = f.github.gitIdentity;
  // Every repository's clone (the legacy --repo one too) commits under its own identity (#631):
  // only a new clone would not.
  const each = [...f.repos.map((r) => r.identity), ...(f.repo.isGit ? [f.repo.identity] : [])];
  const clones = each.length > 0 && each.every((i) => i !== null);
  return {
    id: "git.identity",
    ok: id !== null,
    severity: "warn",
    detail:
      id !== null
        ? `git commits as ${id}`
        : clones
          ? "no global commit identity (user.name/user.email); every repository's clone sets its own, a new clone would not"
          : 'git has no commit identity (user.name/user.email): an agent\'s first commit here fails with "Author identity unknown"',
    // Without git, tool.git's fix stands.
    ...(id === null && binOf(f.tools.git) !== null
      ? { fix: { command: "volley setup --peer --step signin" } }
      : {}),
  };
}

export function githubChecks(f: Facts): Check[] {
  return [...ghChecks(f), gitIdentityCheck(f)];
}

export function ghChecks(f: Facts): Check[] {
  const g = f.github;
  const who = g.user ?? "the signed-in GitHub user";
  const check = (ok: boolean, detail: string, fix?: string): Check => ({
    id: "gh.auth",
    ok,
    severity: "warn",
    detail,
    ...(fix !== undefined ? { fix: { command: fix } } : {}),
  });
  switch (ghState(f)) {
    case "missing":
      return [
        check(
          false,
          "gh is not installed: agents here cannot open pull requests",
          "install gh: https://cli.github.com, then gh auth login && gh auth setup-git",
        ),
      ];
    case "unauthenticated":
      return [check(false, "gh is not signed in", "gh auth login && gh auth setup-git")];
    case "no_write":
      return [
        check(
          false,
          `${who} cannot push to ${g.slug} (permission ${g.permission ?? "none"})`,
          `ask for write access to ${g.slug} for ${who}, or gh auth login as an account that has it`,
        ),
      ];
    default:
      return [
        check(
          true,
          // Push access is per repository (repo.push): this line names the sign-in only.
          `signed in as ${who}`,
        ),
      ];
  }
}
