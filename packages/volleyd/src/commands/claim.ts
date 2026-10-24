import { opCommand } from "../controls";

const HELP = `Usage: volleyd claim <wave> [--by <agent-id>] [--json] [--broker-url <url>] [--namespace <ns>]

Take ownership of a wave. Succeeds when the current owner is offline: its session is gone (its
retained status is reaped/done/failed: the will fired or it shut down). A coordinator-name owner
is claimable once its bound session has been offline past autopilot.reconnect_grace_s (while it
reads "reconnecting" it may come back). A quiet connected owner is never claimable. Otherwise
refused, naming the owner and when a claim will be allowed. The claim is journaled. Needs an
identity: --by, else VOLLEY_AGENT_ID, else the session registered for this directory, else
VOLLEY_COORDINATOR.
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
