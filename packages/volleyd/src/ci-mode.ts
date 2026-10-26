import { DAEMON_DEFAULTS } from "./config-defaults";
import type { ExecFn } from "./exec";
import type { CiMode, CiOverride } from "./types";

/**
 * What a repository's CI is (SPEC §4.6.8), read once per wave version at admission: its active
 * GitHub Actions workflows and the checks its release branch requires (branch protection and
 * rulesets). `none` is a fact read here, never inferred from a head with no run.
 */
export interface CiModeFacts {
  /** Active workflows (`state == "active"`; a disabled one does not count). */
  workflows: number;
  /** Required status check contexts on the release branch, deduplicated. */
  required_checks: string[];
}

/** `ci_mode_detected` data: the mode for a wave version, and what it was decided from. */
export interface CiModeResult {
  mode: CiMode;
  /** Active workflows as read (null: not read). */
  workflows: number | null;
  required_checks: string[];
  source: "gh" | "wave_file";
  /** The facts could not be read: the mode is `workflows`, and the alarm `ci_mode_unknown`. */
  unknown?: true;
}

/** Where `gh api` reads a repository: in its clone (gh resolves `{owner}/{repo}`), or by name. */
export type CiWhere = { cwd: string } | { slug: string };

/**
 * One read-only `gh api` GET of `repos/<repo>/<path>`: its JSON, or that GitHub answered 404
 * (`missing`: a branch not pushed, a branch with no classic protection), or that it could not be
 * read (`failed`: no permission, a rate limit, a timeout, output that is not JSON).
 */
export async function ghApiRead(
  exec: ExecFn,
  where: CiWhere,
  path: string,
): Promise<{ value: unknown } | { missing: true } | { failed: true }> {
  const repo = "slug" in where ? where.slug : "{owner}/{repo}";
  try {
    const r = await exec(["gh", "api", `repos/${repo}/${path}`], {
      ...("cwd" in where ? { cwd: where.cwd } : {}),
      timeoutMs: DAEMON_DEFAULTS.ci_mode_ms,
    });
    if (r.timedOut) return { failed: true };
    if (r.code !== 0) return /\(HTTP 404\)/.test(r.stderr) ? { missing: true } : { failed: true };
    return { value: JSON.parse(r.stdout) as unknown };
  } catch {
    return { failed: true };
  }
}

/** One read-only `gh api` GET, parsed as JSON; undefined on any failure (a 404 included). */
export async function ghApi(exec: ExecFn, where: CiWhere, path: string): Promise<unknown> {
  const r = await ghApiRead(exec, where, path);
  return "value" in r ? r.value : undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `actions/workflows`: how many are `active` (undefined: not a workflow list). */
export function activeWorkflows(v: unknown): number | undefined {
  if (!isObject(v) || !Array.isArray(v.workflows)) return undefined;
  return v.workflows.filter((w) => isObject(w) && w.state === "active").length;
}

/** `branches/<b>`: the classic protection's required contexts (none when unprotected). */
export function protectionChecks(v: unknown): string[] | undefined {
  if (!isObject(v)) return undefined;
  const checks = isObject(v.protection) ? v.protection.required_status_checks : undefined;
  const contexts = isObject(checks) ? checks.contexts : undefined;
  return Array.isArray(contexts) ? contexts.filter((c) => typeof c === "string") : [];
}

/** `rules/branches/<b>`: every `required_status_checks` rule's contexts. */
export function rulesetChecks(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((rule) => {
    if (!isObject(rule) || rule.type !== "required_status_checks") return [];
    const params = isObject(rule.parameters) ? rule.parameters.required_status_checks : undefined;
    if (!Array.isArray(params)) return [];
    return params.flatMap((c) => (isObject(c) && typeof c.context === "string" ? [c.context] : []));
  });
}

/**
 * `rules/branches/<b>`: the most approving reviews a `pull_request` rule requires (0: none;
 * undefined: not a rule list).
 */
export function rulesetReviews(v: unknown): number | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.reduce<number>((most, rule) => {
    if (!isObject(rule) || rule.type !== "pull_request" || !isObject(rule.parameters)) return most;
    const n = rule.parameters.required_approving_review_count;
    return typeof n === "number" && n > most ? n : most;
  }, 0);
}

/**
 * `branches/<b>/protection` (readable by an admin only): the approving reviews classic
 * protection requires (0: none; undefined: not a protection object).
 */
export function protectionReviews(v: unknown): number | undefined {
  if (!isObject(v)) return undefined;
  const r = v.required_pull_request_reviews;
  if (!isObject(r)) return 0;
  const n = r.required_approving_review_count;
  return typeof n === "number" && n > 0 ? n : 0;
}

/** CI facts from the three reads (null when one is unreadable): `readCiFacts`' arithmetic. */
export function ciFactsFrom(
  workflows: number | undefined,
  protection: string[] | undefined,
  rules: string[] | undefined,
): CiModeFacts | null {
  if (workflows === undefined || protection === undefined || rules === undefined) return null;
  return { workflows, required_checks: [...new Set([...protection, ...rules])] };
}

/**
 * The repository's CI facts: its active workflows and, for a `branch`, the checks that branch
 * requires (null: workflows only, as `repo_add` reads them). Null when any read fails or times
 * out (no permission, a rate limit, a host gh cannot reach): unreadable is never `none`.
 */
export async function readCiFacts(
  exec: ExecFn,
  where: CiWhere,
  branch: string | null,
): Promise<CiModeFacts | null> {
  const [workflows, protection, rules] = await Promise.all([
    ghApi(exec, where, "actions/workflows?per_page=100").then(activeWorkflows),
    branch !== null ? ghApi(exec, where, `branches/${branch}`).then(protectionChecks) : [],
    branch !== null ? ghApi(exec, where, `rules/branches/${branch}`).then(rulesetChecks) : [],
  ]);
  return ciFactsFrom(workflows, protection, rules);
}

/**
 * The wave version's CI mode from its `ci:` override (absent: `auto`) and the facts read.
 * `required` on the release branch makes `ci: none` impossible (the host would refuse the merge):
 * a refusal naming the checks. Unreadable facts under `auto` are `workflows`, flagged unknown.
 */
export function resolveCiMode(
  override: CiOverride | undefined,
  facts: CiModeFacts | null,
  branch: string,
): CiModeResult | { refused: string } {
  const workflows = facts?.workflows ?? null;
  const required_checks = facts?.required_checks ?? [];
  if (override === "required")
    return { mode: "required", workflows, required_checks, source: "wave_file" };
  if (override === "none") {
    if (required_checks.length > 0)
      return {
        refused: `ci: none cannot be honoured: ${branch} requires the checks ${required_checks.join(", ")}, and GitHub refuses a merge without them`,
      };
    return { mode: "none", workflows, required_checks, source: "wave_file" };
  }
  if (facts === null)
    return { mode: "workflows", workflows, required_checks, source: "gh", unknown: true };
  const mode: CiMode =
    required_checks.length > 0 ? "required" : facts.workflows > 0 ? "workflows" : "none";
  return { mode, workflows, required_checks, source: "gh" };
}
