import type { CiState, InfraReason } from "../artifacts";
import type { GithubStatus } from "./github-status";

/**
 * Self-healing CI (SPEC §4.6.16): what a red head is, before anyone is asked. Pure.
 *
 *   - `own_change`: a failing test's file is among the PR's changed files, or the failing tests
 *     cannot be mapped to files and the release branch's latest CI is not red (a CI fixup);
 *   - `flake`: no failing test's file is in the PR, and the test fails on the release branch too
 *     or the head is not infra-shaped (a `fix_flake` remediation: a dedicated fixer, never a re-run);
 *   - `infra_incident`: the run is infra-shaped, or GitHub's status page reports an Actions / API
 *     incident (a hold, re-checked; never a fixer and never a re-run).
 *
 * The order: an infra shape first, then own-change evidence (it wins over a status-page incident),
 * then the status page, then flake.
 */

export type Classification = "own_change" | "flake" | "infra_incident";

/** The release branch's latest CI (the latest run per workflow), with its failing tests. */
export interface ReleaseCi {
  state: CiState | "unknown";
  failing_tests: string[];
}

export interface ClassifyInput {
  failing_tests: string[];
  /** The PR's changed files; null when they could not be read. */
  pr_files: string[] | null;
  release: ReleaseCi;
  infra: InfraReason | null;
  status_page: GithubStatus;
}

export interface ClassifyEvidence {
  failing_tests: string[];
  test_files: string[];
  pr_files: string[] | null;
  release_ci: ReleaseCi;
  status_page: GithubStatus;
}

export interface ClassifyResult {
  classification: Classification;
  evidence: ClassifyEvidence;
  /** A flake: the test its fixer is for (one also red on the release branch first), and all of them. */
  flake?: { test: string; test_file: string | null; tests: string[] };
  /** An infra incident: what it is, as the hold's why_waiting reads it. */
  incident?: string;
}

const TEST_FILE = /^(\S+\.[cm]?[jt]sx?)(?:\s|$)/;

/**
 * The file a failing test id names: vitest's `<file> > <suite> > <name>` (or a bare `<file>`)
 * → `<file>`; bun's `(fail) <name>` ids carry no file → null.
 */
export function testFile(id: string): string | null {
  const first = id.split(" > ")[0]?.trim() ?? "";
  return TEST_FILE.exec(first)?.[1] ?? null;
}

const INFRA_LINE: Record<InfraReason, string> = {
  startup: "a run never started",
  steps: "runner, checkout or network step failed",
  cancelled: "a run was cancelled and nothing replaced it",
};

/** Whether `file` (a path in the test log, often relative to a package) is one of the PR's files. */
const touches = (prFiles: string[], file: string): boolean =>
  prFiles.some((f) => f === file || f.endsWith(`/${file}`));

export function classify(i: ClassifyInput): ClassifyResult {
  const files = i.failing_tests.map(testFile);
  const evidence: ClassifyEvidence = {
    failing_tests: i.failing_tests,
    test_files: [...new Set(files.filter((f): f is string => f !== null))],
    pr_files: i.pr_files,
    release_ci: i.release,
    status_page: i.status_page,
  };
  if (i.infra !== null)
    return { classification: "infra_incident", evidence, incident: INFRA_LINE[i.infra] };
  const incident = (): ClassifyResult | null => {
    const down = i.status_page.components.filter((c) => c.status !== "operational");
    if (!i.status_page.incident || down.length === 0) return null;
    const what = down.map((c) => `GitHub ${c.name} ${c.status}`).join(", ");
    return { classification: "infra_incident", evidence, incident: what };
  };
  const own: ClassifyResult = { classification: "own_change", evidence };
  if (i.pr_files === null) return incident() ?? own;
  const prFiles = i.pr_files;
  if (files.some((f) => f !== null && touches(prFiles, f))) return own;
  const held = incident();
  if (held !== null) return held;
  const releaseRed = i.release.state === "red";
  const onRelease = (t: string) => i.release.failing_tests.includes(t);
  // Unmapped ids (bun's) are the PR's unless the release branch is red (or red on them too).
  const unmapped = i.failing_tests.filter((t, n) => files[n] === null && !onRelease(t));
  if (i.failing_tests.length === 0 ? !releaseRed : unmapped.length > 0 && !releaseRed) return own;
  const tests = i.failing_tests.length > 0 ? i.failing_tests : i.release.failing_tests;
  const test = tests.find(onRelease) ?? tests[0] ?? "unknown";
  return {
    classification: "flake",
    evidence,
    flake: { test, test_file: testFile(test), tests },
  };
}
