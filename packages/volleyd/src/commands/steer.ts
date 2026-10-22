import { DAEMON_DEFAULTS } from "../config-defaults";
import { opCommand } from "../controls";

const HELP = `Usage: volleyd steer <wave> <task> <text...> [--role <role>] [--wait-ack-ms <ms>]
                     [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Send mailbox steering to the task's live agent, whatever its role (owner only; --role one of
implementer, spec_reviewer, quality_reviewer, fixup, rebase, release; task _release for the
release train's stage agent; when two reviewers run together, the newest spawned is steered
unless --role names one). Each steer carries a per-task seq and supersedes the previous one.
Waits up to --wait-ack-ms (default 30000; 0 = don't wait) for the agent's steering_acked and
reports \`delivered (acked by <agent>)\`, \`delivered (received, not acted on yet)\` (mailbox
ack only), \`delivered · woke the agent\` (an idle agent whose hooks did not ack within
mailbox_wake_after_ms was typed the wake line) or \`delivered (no ack yet)\`. With no live agent
on the task (between stages, or with --role, none in that role) the steer is
\`queued (no live agent)\` at once and delivered to the task's next agent (of that role) when it
registers, or to one already up at its next hook signal.
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
      woke?: boolean;
      message_id: string;
    };
    const sup = r.supersedes !== undefined ? ` (supersedes ${r.supersedes})` : "";
    if (r.delivery === "queued") {
      const next =
        r.queued_for === undefined || r.queued_for === "next agent" ? "agent" : r.queued_for;
      return `steer #${r.seq} (${r.task}): queued (no live agent) for the next ${next} of the task\nmessage ${r.message_id}${sup}\n`;
    }
    const state =
      r.delivery === "acked"
        ? `delivered (acked by ${r.acked_by})`
        : r.woke === true
          ? "delivered · woke the agent"
          : r.delivery === "received"
            ? "delivered (received, not acted on yet)"
            : "delivered (no ack yet)";
    return `steer #${r.seq} → ${r.agent_id} (${r.role}): ${state}\nmessage ${r.message_id}${sup}\n`;
  },
});
