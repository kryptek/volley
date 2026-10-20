import { opCommand } from "../controls";

const HELP = `Usage: volleyd stop <wave> | --all [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Stop a wave (owner only): no more admissions, and every running agent of the wave gets a mailbox
\`cancel\` and an interrupt. --all is the kill switch: every wave stops and the daemon refuses
\`run\` until \`volleyd resume --all\`. Anyone may pull the kill switch.
`;

export const stop = opCommand({
  name: "stop",
  help: HELP,
  options: { all: { type: "boolean" } },
  build: (pos, values) => {
    if (values.all === true)
      return pos.length > 0 ? "--all takes no wave" : { op: "stop", fields: { all: true } };
    return pos.length !== 1
      ? "expected exactly one wave (or --all)"
      : { op: "stop", fields: { wave: pos[0] } };
  },
  print: (res) => {
    const r = res.result as {
      wave?: string;
      changed?: boolean;
      cancelled?: string[];
      stopped?: string[];
    };
    if (r.wave === undefined) {
      const waves = r.stopped ?? [];
      return `kill switch engaged: stopped ${waves.length} wave(s)${waves.length > 0 ? `: ${waves.join(", ")}` : ""}; run is refused until \`volleyd resume --all\`\n`;
    }
    if (r.changed !== true) return `wave ${r.wave} was already stopped\n`;
    const c = r.cancelled ?? [];
    return `stopped wave ${r.wave}; cancel sent to ${c.length} agent(s)${c.length > 0 ? `: ${c.join(", ")}` : ""}\n`;
  },
});
