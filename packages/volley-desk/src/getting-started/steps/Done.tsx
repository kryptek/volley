/** Getting started › You're good to go!: what the steps set up, from the stored summary. */
import type { Summary } from "../state";
import type { StepProps } from "../steps";

const CONNECTED_BY: Record<NonNullable<Summary["connectedBy"]>, string> = {
  code: "Pairing code",
  key: "SSH key",
  password: "Password",
};
const NETWORK: Record<NonNullable<Summary["network"]>, string> = {
  tailscale: "Tailscale",
  manual: "Your own address",
  none: "Home network only",
};

const list = (xs: readonly string[]) => (xs.length > 0 ? xs.join(", ") : null);

/** The summary's rows; `null` is a value no step has learnt yet. */
export function summaryRows(s: Summary): [string, string | null][] {
  return [
    ["Computers", list(s.machines) ?? s.machine ?? null],
    ["Connected by", s.connectedBy ? CONNECTED_BY[s.connectedBy] : null],
    ["Repos", list(s.repos)],
    ["People", list(s.people.map((p) => `${p.name} (${p.role})`))],
    ["Away from home", s.network ? NETWORK[s.network] : null],
  ];
}

export function Done({ summary }: StepProps) {
  return (
    <div className="gs-card">
      <dl className="gs-summary" aria-label="Summary">
        {summaryRows(summary).map(([label, value]) => (
          <div key={label} className="gs-summary-row">
            <dt>{label}</dt>
            <dd>{value ?? "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
