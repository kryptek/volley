import {
  type CiModeFacts,
  type CiWhere,
  activeWorkflows,
  ciFactsFrom,
  ghApi,
  ghApiRead,
  protectionChecks,
  protectionReviews,
  resolveCiMode,
  rulesetChecks,
  rulesetReviews,
} from "./ci-mode";
import { formatCiMode } from "./commands/status";
import type { ExecFn } from "./exec";
import type { MachineCheck, MachineRecord } from "./machines";
import type { RepoState, RepoVerdict } from "./readiness";
import { type SlugView, readSlugView } from "./repo-visibility";
import { repoStateLine, sameSlug } from "./repos";
import type { MergeMode } from "./types";

/**
 * `repo_check` (SPEC §4.6.21, #610): is this repository ready to run a wave, on every machine that
 * could run it? Two halves, each reusing the checks that exist. The repository half is read once,
 * on the supervisor, with read-only `gh` (`readRepoFacts`, then `repositoryChecks`): the
 * repository on GitHub, its release branch on origin, the reviews that branch requires and its CI
 * mode. The machine half is each machine's own doctor report, filtered to the lines about the
 * repository and the machine-level ones an agent there needs (`machineBlock`). Wave admission reads
 * the same verdicts placement uses (`admissionRefusals`); it never runs a doctor.
 */

/** One line of a check, the doctor's report shape (`fix`: what to run, on a failing line). */
export interface RepoCheck {
  id: string;
  ok: boolean;
  severity: "block" | "warn";
  detail: string;
  repo?: string;
  fix?: string;
}

/** What GitHub says of a repository and (when asked) its release branch. Never a throw. */
export interface RepoFacts {
  slug: string;
  /** `gh repo view`'s answer, or why it failed, in gh's words; null: not read here (admission). */
  view: SlugView | string | null;
  /**
   * Its workflows and the branch's required checks, as `readCiFacts` reads them (the CI mode's
   * facts at admission); null: unreadable, or the branch is not on origin.
   */
  ci: CiModeFacts | null;
  /** The release branch asked about; null: none (`repo_add`). */
  branch: string | null;
  /** The branch is on origin; null: not asked, or unreadable. */
  branch_exists: boolean | null;
  /** The most approving reviews a rule or the classic protection requires (0: none). */
  required_reviews: number;
  /** False when a rule could require reviews this account cannot read (classic protection). */
  reviews_readable: boolean;
}

/**
 * `gh repo view <slug>` and the repository's `gh api` reads (`readRepoFacts`), in parallel: what
 * `repo_check` and `repo_add` read.
 */
export async function readRepoCheck(
  exec: ExecFn,
  slug: string,
  branch: string | null,
): Promise<RepoFacts> {
  const [view, facts] = await Promise.all([
    readSlugView(exec, slug),
    readRepoFacts(exec, { slug }, slug, branch),
  ]);
  return { ...facts, view };
}

/**
 * The repository's `gh api` reads, in parallel (each bounded by `ci_mode_ms`): its workflows and,
 * for a `branch`, `branches/<b>` (on origin, and its classic protection's checks),
 * `rules/branches/<b>` (rulesets' checks and reviews) and, for a protected branch,
 * `branches/<b>/protection` (its reviews: an admin's read). The first three are `readCiFacts`'
 * reads: admission takes its CI mode from these facts, so a submit reads each once.
 */
export async function readRepoFacts(
  exec: ExecFn,
  where: CiWhere,
  slug: string,
  branch: string | null,
): Promise<RepoFacts> {
  const [workflows, b, rules] = await Promise.all([
    ghApi(exec, where, "actions/workflows?per_page=100").then(activeWorkflows),
    branch !== null ? ghApiRead(exec, where, `branches/${branch}`) : null,
    branch !== null ? ghApi(exec, where, `rules/branches/${branch}`) : [],
  ]);
  let branchExists: boolean | null = null;
  let protection: string[] | undefined = [];
  let classic: number | undefined = 0;
  if (b !== null) {
    branchExists = "value" in b ? true : "missing" in b ? false : null;
    // Not on origin is unreadable to the CI mode too (`readCiFacts`): never `none` from it.
    protection = "value" in b ? protectionChecks(b.value) : undefined;
    const isProtected =
      "value" in b &&
      typeof b.value === "object" &&
      b.value !== null &&
      (b.value as { protected?: unknown }).protected === true;
    if (isProtected) {
      const p = await ghApiRead(exec, where, `branches/${branch}/protection`);
      // A branch only rulesets protect is `protected` too, and its `/protection` is a 404: no
      // classic reviews. Only a failed read (a non-admin's 403) leaves them unknown.
      classic = "value" in p ? protectionReviews(p.value) : "missing" in p ? 0 : undefined;
    }
  }
  const ruleReviews = rulesetReviews(rules);
  return {
    slug,
    view: null,
    ci: ciFactsFrom(workflows, protection, rulesetChecks(rules)),
    branch,
    branch_exists: branchExists,
    required_reviews: Math.max(ruleReviews ?? 0, classic ?? 0),
    reviews_readable: ruleReviews !== undefined && classic !== undefined,
  };
}

/** Whether a fact the refusals need could not be read (journaled as `repo_check_unknown`). */
export const factsUnknown = (f: RepoFacts): boolean =>
  typeof f.view === "string" ||
  (f.ci === null && f.branch_exists !== false) ||
  (f.branch !== null && f.branch_exists === null) ||
  !f.reviews_readable;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * The repository half's lines: `repo.exists`, then for a release branch `branch.release` and
 * `branch.protection`, then `ci.mode` (`volleyd status`'s words).
 */
export function repositoryChecks(f: RepoFacts): RepoCheck[] {
  const out: RepoCheck[] = [];
  if (f.view !== null)
    out.push(
      typeof f.view === "string"
        ? {
            id: "repo.exists",
            ok: false,
            severity: "block",
            detail: f.view,
            fix: `check the name, and that gh on the supervisor is signed in as an account that can see ${f.slug}`,
          }
        : {
            id: "repo.exists",
            ok: true,
            severity: "block",
            detail: `GitHub knows it as ${f.view.slug}`,
          },
    );
  const b = f.branch;
  if (b !== null) {
    out.push(
      f.branch_exists === true
        ? { id: "branch.release", ok: true, severity: "block", detail: `${b} exists on origin` }
        : f.branch_exists === false
          ? {
              id: "branch.release",
              ok: false,
              severity: "block",
              detail: `${b} is not on origin (github.com/${f.slug}): every spawn would fail`,
              fix: `push it: git push origin <base>:refs/heads/${b}`,
            }
          : {
              id: "branch.release",
              ok: false,
              severity: "warn",
              detail: `could not read ${b} on origin (GitHub did not answer)`,
            },
    );
    if (f.branch_exists !== false) out.push(protectionCheck(f, b));
  }
  if (f.ci === null && f.branch_exists === false) {
    out.push({
      id: "ci.mode",
      ok: false,
      severity: "warn",
      detail: `not read: ${b} is not on origin yet`,
    });
  } else if (f.ci === null) {
    out.push({
      id: "ci.mode",
      ok: false,
      severity: "warn",
      detail: "could not read the repository's workflows: a wave proceeds as workflows",
    });
  } else {
    const ci = resolveCiMode(undefined, f.ci, b ?? "the release branch");
    const words =
      "refused" in ci
        ? ci.refused
        : formatCiMode({
            ci_mode: ci.mode,
            ci_required_checks: ci.required_checks,
            ...(ci.workflows !== null ? { ci_workflows: ci.workflows } : {}),
          }).replace(/^ci: /, "");
    out.push({ id: "ci.mode", ok: true, severity: "warn", detail: words });
  }
  return out;
}

/** `branch.protection`: the required checks, and the approving reviews `merge: auto` cannot give. */
function protectionCheck(f: RepoFacts, b: string): RepoCheck {
  const checks =
    f.ci !== null && f.ci.required_checks.length > 0
      ? `requires the checks ${f.ci.required_checks.join(", ")}; `
      : "";
  if (f.required_reviews > 0) {
    return {
      id: "branch.protection",
      ok: false,
      severity: "warn",
      detail: `${b} ${checks}requires ${plural(f.required_reviews, "approving review")}: GitHub will refuse volleyd's merge: auto`,
      fix: "set merge: manual in the wave file, or drop the rule for this branch",
    };
  }
  if (!f.reviews_readable) {
    return {
      id: "branch.protection",
      ok: false,
      severity: "warn",
      detail: `${checks}reviews: unknown (classic protection is admin-only)`,
    };
  }
  return { id: "branch.protection", ok: true, severity: "warn", detail: `${checks}reviews: none` };
}

/** The machine-level checks a repository's block shows beside its own (an agent there needs them). */
const MACHINE_LINES = ["gh.auth", "git.identity", "claude.signin", "claude.trust"];

/** A record carries no fix text: these are the ones a machine block names without a fresh doctor. */
const RECORD_FIXES: Record<string, (slug: string) => string> = {
  "git.identity": () => "volley setup --peer --step signin",
  "gh.auth": () => "gh auth login && gh auth setup-git",
  "claude.signin": () => "claude, then /login",
  "repo.clone": (slug) => `volley repo check ${slug} --fix`,
  "repo.worktrees": (slug) => `volley repo check ${slug} --fix`,
  "repo.fetch": (slug) => `volley repo check ${slug} --fix`,
};

/** The supervisor's own clone is the owner's checkout: `--fix` never touches it (D5). */
const OWN_FIX =
  "volley peer doctor --repo <the clone> --fix, on this machine (volleyd never fixes its own clone)";

/** One machine's answer for a repository (`repo_check`'s `machines.<name>`). */
export interface MachineBlock {
  checks: RepoCheck[];
  /** Ready for a wave on this repository: the machine is ready and so is its clone. */
  ready: boolean;
  /** Its state for the repository (`none`: no record to judge). */
  state: RepoState | "none";
  /** Why not ready (the machine's reasons, then the repository's). */
  reasons: string[];
  /** A doctor run for this answer, or the machine's last record (busy, down, or not asked). */
  from: "doctor" | "record";
  doctor_at: string | null;
  /** Why the block is from the record (`a doctor run is in progress`, the ssh error). */
  note?: string;
}

/**
 * One machine's block: the checks of `checks` (a fresh report's, with fix text, or the record's)
 * about `slug`, and the machine-level lines; ready when `machine.ready` and the clone's verdict is
 * `ready`.
 */
export function machineBlock(
  slug: string,
  record: MachineRecord | undefined,
  checks: (MachineCheck & { fix?: string })[] | undefined,
  machine: { ready: boolean; reasons: string[] },
  verdict: RepoVerdict | undefined,
  from: { from: "doctor" | "record"; note?: string; own?: boolean },
): MachineBlock {
  const all: (MachineCheck & { fix?: string })[] = checks ?? record?.checks ?? [];
  const tagged = all.some((c) => c.repo !== undefined && sameSlug(c.repo, slug));
  const picked = all.filter((c) => {
    if (c.repo !== undefined) return sameSlug(c.repo, slug);
    // An untagged clone check (the supervisor's own doctor, an older peer) is about its one clone.
    if (c.id.startsWith("repo.")) return !tagged;
    return MACHINE_LINES.includes(c.id) || (!c.ok && c.severity === "block");
  });
  const lines: RepoCheck[] = picked.map((c) => {
    const recordFix =
      from.own === true && c.id.startsWith("repo.") ? OWN_FIX : RECORD_FIXES[c.id]?.(slug);
    const fix = c.fix ?? (!c.ok ? recordFix : undefined);
    return {
      id: c.id,
      ok: c.ok,
      severity: c.severity,
      detail: c.detail,
      ...(c.repo !== undefined ? { repo: c.repo } : {}),
      ...(!c.ok && fix !== undefined ? { fix } : {}),
    };
  });
  const state: MachineBlock["state"] = record === undefined ? "none" : (verdict?.state ?? "absent");
  const repoReasons =
    verdict?.reasons ?? (record !== undefined ? [`no clone of ${slug} reported`] : []);
  const reasons = [...machine.reasons, ...(state === "ready" ? [] : repoReasons)];
  return {
    checks: lines,
    ready: machine.ready && state === "ready",
    state,
    reasons,
    from: from.from,
    doctor_at: record?.doctor_at ?? null,
    ...(from.note !== undefined ? { note: from.note } : {}),
  };
}

/** Readiness' needs among the `!` checks: a failing one names why a machine is not ready. */
const NEEDED = ["gh.auth", "git.identity", "claude.signin"];

/** Why a block is not ready, in a word or two: its failing checks' ids, else its first reason. */
function whyNot(b: MachineBlock): string {
  const ids = b.checks
    .filter((c) => !c.ok && (c.severity === "block" || NEEDED.includes(c.id)))
    .map((c) => c.id);
  return ids.length > 0 ? [...new Set(ids)].join(", ") : (b.reasons[0] ?? b.state);
}

/**
 * The closing line: `ready for a wave on: control, box-a.`, or `not ready for a wave on box-a
 * (git.identity); ready on control.`
 */
export function closingLine(machines: Record<string, MachineBlock>): string {
  const names = Object.keys(machines);
  if (names.length === 0)
    return "no machine holds it: volley repo add <owner/name> --machine <name>";
  const ready = names.filter((n) => machines[n]?.ready === true);
  const not = names.filter((n) => machines[n]?.ready !== true);
  if (not.length === 0) return `ready for a wave on: ${ready.join(", ")}.`;
  const why = not.map((n) => `${n} (${whyNot(machines[n] as MachineBlock)})`).join(", ");
  return `not ready for a wave on ${why}${ready.length > 0 ? `; ready on ${ready.join(", ")}` : ""}.`;
}

/** One machine a wave's tasks could run on, as admission judges it from its verdicts. */
export interface Candidate {
  name: string;
  /** A task names it (`host: <name>`): that task runs there or nowhere. */
  pinned: boolean;
  /**
   * The supervisor's own machine: its local tasks spawn into the wave's clone whatever its
   * verdict says (`releaseBranchMissing` checks that clone), so only its git identity refuses.
   */
  local: boolean;
  /** Its readiness (`ready`, `reasons`) and where the repository stands there. */
  ready: boolean;
  reasons: string[];
  repo: RepoVerdict | undefined;
  /** Its record's `git.identity` fails. */
  noIdentity: boolean;
  /**
   * Its verdict is not settled yet (no record heard, its PATH not probed since the supervisor
   * started): it refuses nothing, as a clone being made does not.
   */
  settling?: boolean;
}

/** One `errors[]` entry of a refused submit. */
export interface Refusal {
  path: "repo";
  reason: string;
}

/** A candidate's one line: `box-a: not ready (…)`, else `repoStateLine`'s. */
function candidateLine(c: Candidate): string {
  if (c.local) return `${c.name}: no commit identity (volley setup --peer --step signin)`;
  if (!c.ready) return `${c.name}: not ready (${c.reasons.join("; ") || "no reason given"})`;
  return repoStateLine(c.name, c.repo);
}

/** Whether a candidate can take the wave's tasks now (`pending`: its clone is still being made). */
function standing(c: Candidate): "ready" | "pending" | "no" {
  if (c.noIdentity) return "no";
  if (c.local) return "ready";
  if (c.settling === true) return "pending";
  if (!c.ready) return "no";
  if (c.repo?.state === "ready") return "ready";
  return c.repo?.state === "cloning" ? "pending" : "no";
}

/**
 * Wave admission's refusals (D7) from the repository's facts (null: not read) and its candidates'
 * verdicts, and the lines it shows without refusing (a second candidate not ready, an unreadable
 * fact, a `!` repository line).
 */
export function admissionRefusals(
  w: { slug: string; release_branch: string; merge: MergeMode; spawnsLocally: boolean },
  facts: RepoFacts | null,
  candidates: Candidate[],
): { refusals: Refusal[]; lines: string[] } {
  const refusals: Refusal[] = [];
  const lines: string[] = [];
  const checks = facts !== null ? repositoryChecks(facts) : [];
  const release = checks.find((c) => c.id === "branch.release");
  // A local wave keeps releaseBranchMissing's words (it refused already, had it been missing).
  if (release !== undefined && !release.ok && release.severity === "block" && !w.spawnsLocally) {
    refusals.push({
      path: "repo",
      reason: `branch.release: ${release.detail}; fix: ${release.fix ?? "push it"}`,
    });
  }
  if (facts !== null && facts.required_reviews > 0 && w.merge === "auto") {
    refusals.push({
      path: "repo",
      reason: `merge: auto cannot be honoured: ${w.release_branch} requires ${plural(facts.required_reviews, "approving review")}, and GitHub refuses volleyd's own merge; set merge: manual, or drop the rule for ${w.release_branch}`,
    });
  }
  for (const c of candidates.filter((x) => x.pinned && standing(x) === "no")) {
    refusals.push({
      path: "repo",
      reason: `a task is pinned to ${c.name}, which is not ready for ${w.slug}: ${candidateLine(c)}`,
    });
  }
  const states = candidates.map(standing);
  // Every candidate pinned: each was refused above, by its own line.
  const unpinned = candidates.some((c) => !c.pinned);
  if (unpinned && !states.includes("ready") && !states.includes("pending")) {
    const each = candidates.map(candidateLine).join("; ");
    const named = candidates.find((c) => !c.local)?.name ?? candidates[0]?.name ?? "<name>";
    refusals.push({
      path: "repo",
      reason: `no machine that could run this wave is ready for ${w.slug}: ${each}; fix: volley repo check ${w.slug} --fix, or volley repo add ${w.slug} --machine ${named}`,
    });
  } else {
    for (const [i, c] of candidates.entries()) {
      if (states[i] === "no" && !c.pinned) lines.push(`! ${candidateLine(c)}`);
    }
  }
  for (const c of checks) {
    if (c.ok || (c.id === "branch.release" && c.severity === "block")) continue;
    lines.push(`! ${c.id}: ${c.detail}${c.fix !== undefined ? ` (fix: ${c.fix})` : ""}`);
  }
  return { refusals, lines };
}

/** Whether a record's `git.identity` check fails (readiness' blocker, D3). */
export const lacksIdentity = (r: MachineRecord | undefined): boolean =>
  r?.checks?.some((c) => c.id === "git.identity" && !c.ok) ?? false;
