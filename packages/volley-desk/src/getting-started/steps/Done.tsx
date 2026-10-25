/**
 * Getting started › You're good to go!: what the steps set up, from the stored summary, and how to
 * add a computer to the cluster: the two lines to paste on it, the installer as a peer and then
 * `volley peer join <code> --to <this machine>`. **Make a pairing code** asks `peer_invite` (SPEC
 * §4.6.14: one use, `peer_code_ttl_s`, 10 minutes by default) and fills the code in; the `--to` address starts at the Desk's own
 * host and is editable, as in Settings › Machines; **Copy both lines** copies them together.
 */
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useId, useMemo, useState } from "react";
import { createPeerOps, joinCommand, pairingSupported } from "../../store/peerOps";
import type { Summary } from "../state";
import type { StepProps } from "../steps";
import { coordinatorSummary, networkSummary } from "./accessWords";
import { wordOfRole } from "./roleWords";

const CONNECTED_BY: Record<NonNullable<Summary["connectedBy"]>, string> = {
  code: "Pairing code",
  key: "SSH key",
  password: "Password",
};

/** The installer, run as a peer on the computer being added (README Quickstart, `--peer`). */
export const PEER_INSTALL =
  "curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh -s -- --peer";
/** How many minutes a code made now lives: counted from its expiry, as `peer_code_ttl_s` is a tunable. */
const minutesLeft = (expiresAt: string) =>
  Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));

const list = (xs: readonly string[]) => (xs.length > 0 ? xs.join(", ") : null);

/** The summary's rows; `null` is a value no step has learnt yet. */
export function summaryRows(s: Summary): [string, string | null][] {
  const computers = [...new Set([...(s.machine !== undefined ? [s.machine] : []), ...s.machines])];
  return [
    ["Computers", list(computers)],
    ["Connected by", s.connectedBy ? CONNECTED_BY[s.connectedBy] : null],
    ["Repos", list(s.repos)],
    ["People", list(s.people.map((p) => `${p.name} (${wordOfRole(p.role) ?? p.role})`))],
    ["Away from home", networkSummary(s)],
    ["Coordinator", coordinatorSummary(s)],
  ];
}

export function Done({ ctx, summary }: StepProps) {
  return (
    <>
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
      <JoinCard ctx={ctx} />
    </>
  );
}

type Code =
  | { k: "none" }
  | { k: "busy" }
  | { k: "made"; code: string; expiresAt: string; minutes: number }
  | { k: "failed"; error: string };

/** "To add a computer to your Volley cluster": the two lines, a fresh code, Copy. */
function JoinCard({ ctx }: { ctx: StepProps["ctx"] }) {
  const id = useId();
  const peerOps = useMemo(() => ctx.peerOps ?? createPeerOps(ctx.ops), [ctx.peerOps, ctx.ops]);
  const [to, setTo] = useState(ctx.sshHost ?? "");
  const [code, setCode] = useState<Code>({ k: "none" });
  const [copied, setCopied] = useState<"Copied" | "Select and copy" | null>(null);
  const join = joinCommand(code.k === "made" ? code.code : "<code>", to);
  const both = `${PEER_INSTALL}\n${join}`;

  const make = async () => {
    setCode({ k: "busy" });
    setCopied(null);
    const r = await peerOps.invite();
    setCode(
      r.ok
        ? { k: "made", code: r.code, expiresAt: r.expiresAt, minutes: minutesLeft(r.expiresAt) }
        : { k: "failed", error: r.error },
    );
  };

  const copy = () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard?.writeText) return setCopied("Select and copy");
    clipboard.writeText(both).then(
      () => setCopied("Copied"),
      () => setCopied("Select and copy"),
    );
  };

  return (
    <section className="gs-card gs-join" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="gs-card-title">
        To add a computer to your Volley cluster
      </h3>
      <p className="s-hint">Paste these two lines in a terminal on it, one after the other:</p>
      <pre className="mono gs-join-lines">
        <code>{PEER_INSTALL}</code>
        {"\n"}
        <code>{join}</code>
      </pre>
      <label className="gs-join-to">
        <span className="s-hint">
          This machine's ssh address (user@host), as the other computer reaches it
        </span>
        <input
          className="recessed mono"
          aria-label="This machine's ssh address"
          autoComplete="off"
          spellCheck={false}
          placeholder={`you@${ctx.sshHost || "hub-hostname"}`}
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setCopied(null);
          }}
        />
      </label>
      {code.k === "made" && (
        <p className="s-hint">
          The code works once and lives {code.minutes} {code.minutes === 1 ? "minute" : "minutes"}{" "}
          (until {new Date(code.expiresAt).toLocaleTimeString()}); get a new one here or under
          Settings › Machines.
        </p>
      )}
      {code.k === "failed" && (
        <p className="s-error" role="alert">
          No pairing code: {code.error}
        </p>
      )}
      {pairingSupported() ? (
        <div className="wiz-actions wiz-actions--inline">
          <button
            type="button"
            className="btn"
            disabled={code.k === "busy"}
            onClick={() => void make()}
          >
            {code.k === "busy"
              ? "Making a code…"
              : code.k === "made"
                ? "Make a new pairing code"
                : "Make a pairing code"}
          </button>
          <button
            type="button"
            className="btn btn--blue"
            disabled={code.k !== "made"}
            onClick={copy}
          >
            <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.8} />{" "}
            {copied ?? "Copy both lines"}
          </button>
        </div>
      ) : (
        <p className="s-hint">
          This browser cannot make the key that keeps the pairing code private. On this computer,{" "}
          <code className="mono">volley peer invite</code> makes a code.
        </p>
      )}
    </section>
  );
}
