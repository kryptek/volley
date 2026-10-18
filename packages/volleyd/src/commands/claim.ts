import { opCommand } from "../controls";

const HELP = `Usage: volleyd claim <wave> [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Take ownership of a wave. Succeeds when the current owner's status is reaped/done/failed, or it
has been silent (registry, status, heartbeats) for the configured claim_after_s.
Otherwise refused, naming the owner. The claim is journaled. Needs an identity: --by, else
VOLLEY_AGENT_ID, else the session registered for this directory.
`;

export const claim = opCommand({
  name: "claim",
  help: HELP,
  takesOwnership: true,
  build: ([wave, ...rest]) =>
    wave === undefined || rest.length > 0
      ? "expected exactly one wave"
      : { op: "claim", fields: { wave } },
  print: (res) => {
    const r = res.result as { wave: string; owner: string; previous: string | null; why: string };
    return r.previous === r.owner
      ? `${r.owner} already owns wave ${r.wave}\n`
      : `claimed wave ${r.wave} for ${r.owner} (was ${r.previous ?? "unowned"}): ${r.why}\n`;
  },
});
