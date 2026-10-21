import { opCommand } from "../controls";

const HELP = `Usage: volleyd merge <wave> <task> [--by <agent-id>] [--json]
                     [--broker-url <url>] [--namespace <ns>]

Merge one gated task's PR now, owner only: volleyd squash-merges exactly the gated head
(gh pr merge --squash --match-head-commit, behind its fence) and journals merged_by_supervisor;
the task is done and its dependents are admitted. Works under merge: manual too, where nothing
else merges, and on a paused or stopped wave (an explicit request; the queue itself does not run
there). The task must be at merge_ready; while another task holds the same release branch's
merge-queue turn (while it is brought up to date, its CI runs and it merges) it is refused, naming
that task (one merge in flight per release branch).
`;

export const merge = opCommand({
  name: "merge",
  help: HELP,
  build: (pos) => {
    if (pos.length !== 2) return "expected a wave and a task";
    return { op: "merge", fields: { wave: pos[0], task: pos[1] } };
  },
  print: (res) => {
    const r = res.result as { wave: string; task: string; merge_sha: string | null };
    return `${r.wave}/${r.task}: merged${r.merge_sha !== null ? ` as ${r.merge_sha}` : ""}; the task is done\n`;
  },
});
