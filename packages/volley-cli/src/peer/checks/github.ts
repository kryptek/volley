import type { AuthGh, Check, Facts } from "../doctor";

/**
 * GitHub: this machine's own `gh` is signed in (`gh auth status`'s exit code: a state, never its
 * text) and its user may push to the wave repo (`viewerPermission` WRITE, MAINTAIN or ADMIN).
 */

const PUSH = new Set(["WRITE", "MAINTAIN", "ADMIN"]);

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

export function ghState(f: Facts): AuthGh {
  const g = f.github;
  if (!g.present) return "missing";
  if (!g.signedIn) return "unauthenticated";
  if (g.slug !== null && (g.permission === null || !PUSH.has(g.permission))) return "no_write";
  return "ok";
}

export function githubChecks(f: Facts): Check[] {
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
          g.slug !== null
            ? `signed in as ${who}, with ${g.permission} access to ${g.slug}`
            : `signed in as ${who} (no GitHub wave repo to check push access against)`,
        ),
      ];
  }
}
