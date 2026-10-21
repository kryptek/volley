import { opCommand } from "../controls";

const HELP = `Usage: volleyd resolve <decision-id> <answer...> [--wave <wave>] [--rationale <text>]
                       [--where <where>] [--by <agent-id>] [--json] [--broker-url <url>]
                       [--namespace <ns>]

Answer an open decision (owner only). The answer is journaled with who and why, the retained
decision is cleared, the task resumes, and the answer is written to the task's
.volley/decisions.md for its next stage. Its needs-you inbox item is answered too, where
--where says (default cli; desk·<device>, <machine>·terminal). Resolving twice is a no-op that
says where the first answer was given.
`;

export const resolve = opCommand({
  name: "resolve",
  help: HELP,
  options: { wave: { type: "string" }, rationale: { type: "string" }, where: { type: "string" } },
  build: ([id, ...answer], values) =>
    id === undefined || answer.length === 0
      ? "expected a decision id and an answer"
      : {
          op: "resolve",
          fields: {
            decision_id: id,
            answer: answer.join(" "),
            ...(typeof values.wave === "string" ? { wave: values.wave } : {}),
            ...(typeof values.rationale === "string" ? { rationale: values.rationale } : {}),
            ...(typeof values.where === "string" ? { where: values.where } : {}),
          },
        },
  print: (res) => {
    const r = res.result as {
      wave: string;
      decision_id: string;
      already_resolved: boolean;
      already_answered?: string;
      resolved?: { answer: string; by: string };
      brief?: string;
    };
    if (r.already_resolved)
      return `${r.decision_id} was ${r.already_answered ?? "already resolved"} by ${r.resolved?.by}: ${r.resolved?.answer}\n`;
    return `resolved ${r.decision_id} (${r.wave}): ${r.resolved?.answer}\n${r.brief !== undefined ? `brief: ${r.brief}\n` : ""}`;
  },
});
