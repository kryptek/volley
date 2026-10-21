import type { IssueData } from "../issue";
import type { FixerRemediation } from "../types";
import { flakeTitle } from "./remediation";

/**
 * A flake fixer's `ISSUE.md` (SPEC §4.6.16): a synthetic task has no GitHub issue, so its agents
 * read the root-cause brief instead. Pure.
 */
export function renderFlakeBrief(r: FixerRemediation, o: { task: string }): string {
  const runs = r.run_urls.length > 0 ? r.run_urls.map((u) => `- ${u}`).join("\n") : "none recorded";
  const file = r.test_file !== null ? `\`${r.test_file}\`` : "unknown (find it from the test name)";
  return `# ${flakeTitle(r.test)}

Synthetic task \`${o.task}\`, added by volleyd: no GitHub issue backs it. This file is the issue.

## The flake

- Test: \`${r.test}\`
- File: ${file}
- Blocked tasks (their PRs wait for this fix, then update from the release branch): ${r.for.join(", ")}

Failing runs:

${runs}

The failing test is not in the blocked PRs' changes: it fails on its own. Fix the cause, not the symptom.

## Rules

1. **Reproduce it locally first.** Run the test alone and in the full suite, and under load (several runs in parallel, a busy machine). Note how often it fails.
2. **Find the root cause.** Look for shared state between tests, timing assumptions, fixed or reused ports, the clock (real time, timezones, timers), temp dirs, and retained broker state left by an earlier test.
3. **Fix it test-first.** Make the failure deterministic in a test (or show the reproduction), then fix the cause so it passes every time.
4. **Never re-run CI as a fix.** Never \`skip\` the test, never \`.only\`, no retry wrappers, no quarantine. If the only fix is one of those, publish \`blocked\` with the reason: the owner decides.
`;
}

/** The IssueData a fixer's spawn uses in place of `gh issue view` (issue 0). */
export function flakeIssue(r: FixerRemediation, task: string): IssueData {
  return {
    number: 0,
    title: flakeTitle(r.test),
    url: r.run_urls[0] ?? "",
    body: renderFlakeBrief(r, { task }),
  };
}
