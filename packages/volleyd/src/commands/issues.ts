import type { IssueRowState } from "../autopilot/issues";
import { opCommand } from "../controls";

const HELP = `Usage: volleyd issues <wave> [--verify [--pr <n>]] [--by <agent-id>] [--json]
                      [--broker-url <url>] [--namespace <ns>]

Each task's issue, one line per task: merged-to-release (its PR merged into the release branch:
volleyd labeled the issue and commented once), closed, open, cancelled, or deferred (not done
when the release reached main). A PR into the release branch closes nothing; once the release
branch merges into main volleyd closes every done task's issue the release PR left open.

--verify (owner only) runs that check now, for a release merged by hand: against --pr <n>, or
the release branch's merged PR gh finds. Done tasks' issues still open are closed (comment:
closed by the release PR), the merged-to-release label comes off, and a cancelled or deferred
task's issue stays open with one comment saying why.
`;

interface IssuesResult {
  wave: string;
  release_branch: string;
  release_pr: number | null;
  issues: { line: string; state: IssueRowState }[];
}

export const issues = opCommand({
  name: "issues",
  help: HELP,
  options: { verify: { type: "boolean" }, pr: { type: "string" } },
  build: (pos, values) => {
    if (pos.length !== 1) return "expected one wave";
    if (values.pr !== undefined && values.verify !== true) return "--pr goes with --verify";
    const pr = typeof values.pr === "string" ? Number(values.pr) : undefined;
    if (pr !== undefined && (!Number.isInteger(pr) || pr < 1))
      return "--pr takes a pull request number";
    return {
      op: "issues",
      fields: {
        wave: pos[0],
        ...(values.verify === true ? { verify: true } : {}),
        ...(pr !== undefined ? { pr } : {}),
      },
    };
  },
  print: (res) => {
    const r = res.result as IssuesResult;
    const head = `${r.wave} (${r.release_branch}): ${r.release_pr !== null ? `released in PR #${r.release_pr}` : "not released yet"}`;
    const lines = r.issues.length === 0 ? ["no task has an issue"] : r.issues.map((i) => i.line);
    return `${[head, ...lines].join("\n")}\n`;
  },
});
