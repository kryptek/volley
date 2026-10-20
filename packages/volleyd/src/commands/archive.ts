import { opCommand } from "../controls";

const HELP = `Usage: volleyd archive <wave> [--yes] [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Retire an ended (stopped or complete) wave (owner only; anyone for a wave with no owner): its open
decisions are closed as \`archived\`, its retained state and decision topics are cleared, and it
leaves \`volleyd status\` and the Desk (\`volleyd status --all\` still shows it). Its journal,
evidence and worktrees stay on disk; \`volleyd cleanup\` still works on it. A running, paused or
awaiting-decision wave is refused (stop it first); an archived wave id cannot be run again.
Without --yes, prints what would be closed and changes nothing.
`;

export const archive = opCommand({
  name: "archive",
  help: HELP,
  options: { yes: { type: "boolean" } },
  build: (pos, values) =>
    pos.length !== 1
      ? "expected exactly one wave"
      : { op: "archive", fields: { wave: pos[0], dry_run: values.yes !== true } },
  print: (res) => {
    const r = res.result as { wave: string; would_close?: string[]; closed?: string[] };
    if (r.would_close !== undefined) {
      const ids = r.would_close.length > 0 ? `: ${r.would_close.join(", ")}` : "";
      return `would archive ${r.wave}: close ${r.would_close.length} open decision(s)${ids}\n(pass --yes to archive it)\n`;
    }
    return `archived ${r.wave} (closed ${(r.closed ?? []).length} decision(s))\n`;
  },
});
