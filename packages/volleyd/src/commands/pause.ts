import { opCommand } from "../controls";

const HELP = `Usage: volleyd pause <wave> [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Stop admitting new tasks in the wave; agents already running carry on. Owner only (--by, else
VOLLEY_AGENT_ID, else the session registered for this directory). Undo with \`volleyd resume\`.
`;

export const pause = opCommand({
  name: "pause",
  help: HELP,
  build: ([wave, ...rest]) =>
    wave === undefined || rest.length > 0
      ? "expected exactly one wave"
      : { op: "pause", fields: { wave } },
  print: (res) => {
    const r = res.result as { wave: string; changed: boolean };
    return r.changed ? `paused wave ${r.wave}\n` : `wave ${r.wave} was already paused\n`;
  },
});
