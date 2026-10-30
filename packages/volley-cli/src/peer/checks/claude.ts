import { dirname, resolve } from "node:path";
import type { AuthClaude, Check, Facts } from "../doctor";

/**
 * Claude Code on this machine: its default profile is signed in (`claude auth status`: a state
 * and the plan's label, never a credential), and it trusts the wave repo's folder (T4's rule over
 * the box's own `~/.claude.json`: the folder or a parent has an accepted trust dialog).
 */

/** A plan label (`max`, `pro`, `team`): short, plain words only, never anything token-shaped. */
const PLAN_RE = /^[a-z][a-z0-9 _-]{0,31}$/i;

export interface LoginIdentity {
  email?: string;
  org?: string;
}

/**
 * The default profile's login identity in `~/.claude.json`: exactly `oauthAccount.emailAddress`
 * and `oauthAccount.organizationName`, nothing else of the file. Identity, never a credential.
 */
// Kept byte-identical with volleyd's copy (src/claude/identity.ts): volley-cli cannot import it.
// The schemas' `format: email` (ajv-formats' full mode), so no address kept here fails them.
const EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/** `{ email?, org? }` from a parsed `.claude.json`; a field that is not well-formed is left out. */
export function loginIdentity(json: Record<string, unknown> | null): LoginIdentity {
  const oauth = json?.oauthAccount;
  if (typeof oauth !== "object" || oauth === null || Array.isArray(oauth)) return {};
  const { emailAddress: e, organizationName: o } = oauth as Record<string, unknown>;
  const email = typeof e === "string" && e.length <= 254 && EMAIL.test(e) ? e.toLowerCase() : null;
  const org = typeof o === "string" && o !== "" && o.length <= 128 ? o : null;
  return { ...(email !== null ? { email } : {}), ...(org !== null ? { org } : {}) };
}
// End of the copy shared with volleyd.

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
  // One line per configured repository, naming its clone; else the legacy clone's one line.
  const trust: Check[] =
    f.repos.length > 0
      ? f.repos.map((r) => ({
          ...trustCheck(
            r.trusted === true ? "ok" : r.trusted === false ? "missing" : "unknown",
            r.path,
          ),
          repo: r.slug,
        }))
      : [trustCheck(f.claude.trust, f.repo.path)];
  return [signin, ...trust];
}

/** `claude.trust` for the clone at `repo` (null: no clone to check). */
function trustCheck(state: Facts["claude"]["trust"], repo: string | null): Check {
  return state === "ok" && repo !== null
    ? { id: "claude.trust", ok: true, severity: "warn", detail: `Claude Code trusts ${repo}` }
    : {
        id: "claude.trust",
        ok: false,
        severity: "warn",
        detail:
          repo === null
            ? "no wave repo to check Claude Code's folder trust for"
            : state === "missing"
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
}
