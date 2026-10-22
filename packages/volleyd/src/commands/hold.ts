import { opCommand } from "../controls";
import { type Held, parseHeldOn } from "../decisions";

const HELP = `Usage: volleyd hold <decision-id> --on <task|#pr|issue#n> [--note <text>] [--wave <wave>]
                    [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Hold an open decision (owner only): it stays open, waiting on a task of its wave (T4), a PR
(#194 or pr#194) or an issue (issue#7), and is never escalated. volleyd releases it when the
blocker lands (the task done or cancelled, the PR merged or closed, the issue closed), and it is
asked again in its normal tier. A second hold replaces the first; \`volleyd release\` lifts one.
`;

export const hold = opCommand({
  name: "hold",
  help: HELP,
  options: { on: { type: "string" }, note: { type: "string" }, wave: { type: "string" } },
  build: ([id, ...rest], values) => {
    if (id === undefined || rest.length > 0) return "expected one decision id";
    if (typeof values.on !== "string") return "hold needs --on <task|#pr|issue#n>";
    const on = parseHeldOn(values.on);
    if (on === null) return `--on '${values.on}' is not a task, #<pr> or issue#<n>`;
    return {
      op: "hold",
      fields: {
        decision_id: id,
        on,
        ...(typeof values.note === "string" ? { note: values.note } : {}),
        ...(typeof values.wave === "string" ? { wave: values.wave } : {}),
      },
    };
  },
  print: (res) => {
    const r = res.result as { wave: string; decision_id: string; held: Held; label: string };
    return `held ${r.decision_id} (${r.wave}) on ${r.label}${r.held.note !== undefined ? `: ${r.held.note}` : ""}\n`;
  },
});
