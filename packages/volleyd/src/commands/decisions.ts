import { opCommand } from "../controls";
import type { DecisionPayload } from "../decisions";

const HELP = `Usage: volleyd decisions [wave] [--all] [--json] [--broker-url <url>] [--namespace <ns>]

List open decisions (every wave, or one). --all includes resolved ones. Answer one with
\`volleyd resolve <decision-id> <answer>\`.
`;

export const decisions = opCommand({
  name: "decisions",
  help: HELP,
  needsCaller: false,
  options: { all: { type: "boolean" } },
  build: (pos, values) =>
    pos.length > 1
      ? "expected at most one wave"
      : {
          op: "decisions",
          fields: { ...(pos[0] !== undefined ? { wave: pos[0] } : {}), all: values.all === true },
        },
  print: (res) => {
    const list = (res.result as { decisions: DecisionPayload[] }).decisions;
    return list.length === 0 ? "no open decisions\n" : list.map(formatDecision).join("");
  },
});

/** One decision as a short block: header, question, options and evidence pointers. */
export function formatDecision(d: DecisionPayload): string {
  const where = d.task !== null ? `${d.wave}/${d.task}` : d.wave;
  const lines = [`${d.decision_id}  ${where}  ${d.kind}  opened ${d.opened_at}`, `  ${d.question}`];
  if (d.options !== undefined) lines.push(`  options: ${d.options.join(" | ")}`);
  const ptrs = Object.entries(d.pointers).map(([k, v]) => `${k}: ${v}`);
  if (ptrs.length > 0) lines.push(`  evidence: ${ptrs.join("  ")}`);
  if (d.resolved !== undefined) lines.push(`  resolved by ${d.resolved.by}: ${d.resolved.answer}`);
  return `${lines.join("\n")}\n`;
}
