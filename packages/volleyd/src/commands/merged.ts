import { opCommand } from "../controls";

const HELP = `Usage: volleyd merged <wave> <task> --sha <sha> [--by <agent-id>] [--json]
                      [--broker-url <url>] [--namespace <ns>]

Record that a gated task's PR landed outside GitHub's merge button (a local squash + push, which
closes the PR with no merge). Owner only. volleyd checks it first, read-only: <sha> is on the
release branch and carries the gated head (as an ancestor, as equivalent patches, or as the PR's
whole diff squashed into one commit); then it journals merged_by_operator, the task is done and
its dependents are admitted. Anything else is refused.
`;

const SHA = /^[0-9a-f]{7,40}$/;

export const merged = opCommand({
  name: "merged",
  help: HELP,
  options: { sha: { type: "string" } },
  build: (pos, values) => {
    if (pos.length !== 2) return "expected a wave and a task";
    if (typeof values.sha !== "string" || !SHA.test(values.sha))
      return "--sha <sha> is required (7 to 40 lowercase hex digits)";
    return { op: "merged", fields: { wave: pos[0], task: pos[1], sha: values.sha } };
  },
  print: (res) => {
    const r = res.result as { wave: string; task: string; sha: string; how: string };
    return `${r.wave}/${r.task}: merged at ${r.sha} (${r.how}); the task is done\n`;
  },
});
