import { DAEMON_DEFAULTS } from "../config-defaults";
import { opCommand } from "../controls";

const HELP = `Usage: volleyd steer <wave> <task> <text...> [--role <role>] [--wait-ack-ms <ms>]
                     [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Send mailbox steering to the task's current agent (owner only). Each steer carries a per-task
seq and supersedes the previous one. Waits up to --wait-ack-ms (default 30000; 0 = don't wait)
for the agent's steering_acked and reports \`acked\`, \`received\` (mailbox ack only) or
\`delivered\`. With no live agent on the task (between stages, or with --role, none in that
role) the steer is \`queued\` at once and delivered to the task's next agent (of that role) when
it registers.
`;

export const steer = opCommand({
  name: "steer",
  help: HELP,
  options: { role: { type: "string" }, "wait-ack-ms": { type: "string" } },
  build: ([wave, task, ...text], values) => {
    if (wave === undefined || task === undefined || text.length === 0)
      return "expected a wave, a task and the steering text";
    const raw = values["wait-ack-ms"];
    const wait = typeof raw === "string" ? Number(raw) : DAEMON_DEFAULTS.steer_wait_ack_ms;
    if (!Number.isInteger(wait) || wait < 0) return "--wait-ack-ms must be a non-negative integer";
    return {
      op: "steer",
      fields: {
        wave,
        task,
        text: text.join(" "),
        wait_ack_ms: wait,
        ...(typeof values.role === "string" ? { role: values.role } : {}),
      },
      timeoutMs: wait + DAEMON_DEFAULTS.request_timeout_ms,
    };
  },
  print: (res) => {
    const r = res.result as {
      task: string;
      agent_id: string;
      role: string;
      queued_for?: string;
      seq: number;
      supersedes?: string;
      delivery: string;
      acked_by?: string;
      message_id: string;
    };
    const sup = r.supersedes !== undefined ? ` (supersedes ${r.supersedes})` : "";
    if (r.delivery === "queued") {
      const next =
        r.queued_for === undefined || r.queued_for === "next agent" ? "agent" : r.queued_for;
      return `steer #${r.seq} (${r.task}): queued for the next ${next} of the task\nmessage ${r.message_id}${sup}\n`;
    }
    const state =
      r.delivery === "acked"
        ? `acked by ${r.acked_by}`
        : r.delivery === "received"
          ? "received (not acted on yet)"
          : "delivered (no ack yet)";
    return `steer #${r.seq} → ${r.agent_id} (${r.role}): ${state}\nmessage ${r.message_id}${sup}\n`;
  },
});
