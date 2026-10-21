import { type Digest, renderDigestMd } from "../autopilot/digest";
import { opCommand } from "../controls";

const HELP = `Usage: volleyd digest <wave> [--json] [--broker-url <url>] [--namespace <ns>]

Print a wave's morning digest as last published: what shipped, what autopilot handled on its
own (decisions answered, flakes fixed, conflicts resolved, retries, merges) and what is waiting
for you. It is published when the wave completes, its release_go opens, it is stopped, or it
first needs you (an escalation). --json prints the retained payload.
`;

export const digest = opCommand({
  name: "digest",
  help: HELP,
  needsCaller: false,
  build: (pos) =>
    pos.length !== 1 ? "expected one wave" : { op: "digest", fields: { wave: pos[0] } },
  print: (res) => renderDigestMd(res.result as Digest),
});
