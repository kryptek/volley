import { dirname, resolve } from "node:path";
import type { AuthClaude, Check, Facts } from "../doctor";

/**
 * Claude Code on this machine: its default profile is signed in (`claude auth status`: a state
 * and the plan's label, never a credential), and it trusts the wave repo's folder (T4's rule over
 * the box's own `~/.claude.json`: the folder or a parent has an accepted trust dialog).
 */

/** A plan label (`max`, `pro`, `team`): short, plain words only, never anything token-shaped. */
const PLAN_RE = /^[a-z][a-z0-9 _-]{0,31}$/i;

/** `claude auth status`'s answer as a state and a plan label; nothing else is kept. */
export function parseClaudeStatus(
  code: number,
  stdout: string,
): { state: AuthClaude; plan: string | null } {
  let j: unknown = null;
  const text = stdout.trim();
  const at = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (at >= 0 && end > at) {
    try {
      j = JSON.parse(text.slice(at, end + 1));
    } catch {}
  }
  const loggedIn = (j as { loggedIn?: unknown } | null)?.loggedIn;
  if (loggedIn === true) {
    const plan = (j as { subscriptionType?: unknown }).subscriptionType;
    return {
      state: "signed_in",
      plan: typeof plan === "string" && PLAN_RE.test(plan) ? plan.toLowerCase() : null,
    };
  }
  if (loggedIn === false || (code !== 0 && /not (logged|signed) in/i.test(text))) {
    return { state: "not_signed_in", plan: null };
  }
  return { state: "unknown", plan: null };
}

/**
 * True when `repo` or one of its parent directories has an accepted trust dialog: T4's rule
 * (volleyd's trust.ts `isRepoTrusted`, which this package cannot import).
 */
export function isRepoTrusted(claudeJson: unknown, repo: string): boolean {
  const projects = (claudeJson as { projects?: unknown } | null)?.projects;
  if (typeof projects !== "object" || projects === null) return false;
  const table = projects as Record<string, unknown>;
  for (let dir = resolve(repo); ; dir = dirname(dir)) {
    const entry = Object.hasOwn(table, dir) ? table[dir] : undefined;
    if (
      typeof entry === "object" &&
      entry !== null &&
      (entry as Record<string, unknown>).hasTrustDialogAccepted === true
    ) {
      return true;
    }
    if (dirname(dir) === dir) return false;
  }
}

export function claudeChecks(f: Facts): Check[] {
  const c = f.claude;
  const signin: Check =
    c.state === "signed_in"
      ? {
          id: "claude.signin",
          ok: true,
          severity: "warn",
          detail: `Claude Code is signed in${c.plan !== null ? ` (${c.plan})` : ""}`,
        }
      : {
          id: "claude.signin",
          ok: false,
          severity: "warn",
          detail:
            c.state === "missing"
              ? "Claude Code is not installed"
              : c.state === "not_signed_in"
                ? "Claude Code is not signed in on this machine"
                : "could not tell whether Claude Code is signed in (claude auth status)",
          ...(c.state !== "missing"
            ? {
                fix: {
                  command: "sign in on this machine: run claude and /login",
                },
              }
            : {}),
        };
  const repo = f.repo.path;
  const trust: Check =
    c.trust === "ok"
      ? { id: "claude.trust", ok: true, severity: "warn", detail: `Claude Code trusts ${repo}` }
      : {
          id: "claude.trust",
          ok: false,
          severity: "warn",
          detail:
            repo === null
              ? "no wave repo to check Claude Code's folder trust for"
              : c.trust === "missing"
                ? `Claude Code does not trust ${repo} yet`
                : `could not read ~/.claude.json to check trust of ${repo}`,
          ...(repo !== null
            ? {
                fix: {
                  command: `run claude in ${repo} once and accept the trust dialog (or answer trust to the first repo_untrusted decision)`,
                },
              }
            : {}),
        };
  return [signin, trust];
}
