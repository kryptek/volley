import { opCommand } from "../controls";

const HELP = `Usage: volleyd release <decision-id> [--wave <wave>] [--by <agent-id>] [--json]
                       [--broker-url <url>] [--namespace <ns>]

Lift a decision's hold by hand (owner only): it is open in its normal tier again, and autopilot's
rule for its kind runs again. volleyd releases a hold itself when its blocker lands.
`;

export const release = opCommand({
  name: "release",
  help: HELP,
  options: { wave: { type: "string" } },
  build: ([id, ...rest], values) =>
    id === undefined || rest.length > 0
      ? "expected one decision id"
      : {
          op: "release",
          fields: {
            decision_id: id,
            ...(typeof values.wave === "string" ? { wave: values.wave } : {}),
          },
        },
  print: (res) => {
    const r = res.result as { wave: string; decision_id: string; released: boolean };
    return r.released
      ? `released ${r.decision_id} (${r.wave})\n`
      : `${r.decision_id} (${r.wave}) was not held\n`;
  },
});
