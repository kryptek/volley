import type { PolicyRow } from "../autopilot/policy";
import { opCommand } from "../controls";
import type { AutopilotConfig } from "../types";

const HELP = `Usage: volleyd policy [wave] [--json] [--broker-url <url>] [--namespace <ns>]

Print autopilot's effective policy table (the global config, or a wave's): one row per rule,
kind · condition · answer · budget · max · rationale, in the order rules are tried. A decision
no rule answers, one in autopilot.owner_only, or one whose budget is spent is left for the owner.
`;

export const policy = opCommand({
  name: "policy",
  help: HELP,
  needsCaller: false,
  build: (pos) =>
    pos.length > 1
      ? "expected at most one wave"
      : { op: "policy", fields: pos[0] !== undefined ? { wave: pos[0] } : {} },
  print: (res) => {
    const r = res.result as { rules: PolicyRow[]; config: AutopilotConfig };
    return formatPolicy(r.rules, r.config);
  },
});

/** `autopilot: on|off`, then each rule on its line (its id and rationale under it). */
export function formatPolicy(rows: PolicyRow[], cfg: AutopilotConfig): string {
  const lines = [`autopilot: ${cfg.enabled ? "on" : "off"}`];
  for (const r of rows) {
    const budget = r.budget !== null ? `${r.budget} · max ${r.max}` : "no budget";
    lines.push(`  ${r.kind} · ${r.condition} · ${r.answer} · ${budget}`);
    lines.push(`    ${r.policy}: ${r.rationale}`);
  }
  return `${lines.join("\n")}\n`;
}
