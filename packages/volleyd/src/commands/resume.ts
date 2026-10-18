import { opCommand } from "../controls";

const HELP = `Usage: volleyd resume <wave> | --all [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Resume admissions in a paused or stopped wave (owner only). --all releases the kill switch set by
\`volleyd stop --all\` so \`run\` is accepted again; stopped waves stay stopped until resumed one by one.
`;

export const resume = opCommand({
  name: "resume",
  help: HELP,
  options: { all: { type: "boolean" } },
  build: (pos, values) => {
    if (values.all === true)
      return pos.length > 0 ? "--all takes no wave" : { op: "resume", fields: { all: true } };
    return pos.length !== 1
      ? "expected exactly one wave (or --all)"
      : { op: "resume", fields: { wave: pos[0] } };
  },
  print: (res) => {
    const r = res.result as { wave?: string; changed?: boolean; kill_switch?: boolean };
    if (r.wave === undefined) return "kill switch released: volleyd accepts new runs\n";
    return r.changed ? `resumed wave ${r.wave}\n` : `wave ${r.wave} was already running\n`;
  },
});
