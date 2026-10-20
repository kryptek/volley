/**
 * Remove… on a machine card (SPEC §4.6.14 `peer_remove`): the agents running
 * there, what removing does, and two ways: **Drain, then remove**
 * (`drain: true`: nothing new starts there and volleyd removes it once they
 * finish) or **Remove now** (`now: true`, after a confirm: each agent is told
 * to cancel). With nothing running it removes at once.
 */
import { useState } from "react";
import { plural } from "../lib/plural";
import type { PeerOps } from "../store/peerOps";
import { MachineSheet } from "./MachineSheet";

type Phase = "choose" | "confirm-now" | "busy";

export function RemoveMachineSheet({
  machine,
  agents,
  ops,
  onClose,
  onDone,
}: {
  machine: string;
  /** The live agents on the machine. */
  agents: readonly string[];
  ops: PeerOps;
  onClose: () => void;
  /** Called with what happened once volleyd accepts; the sheet's owner closes it. */
  onDone: (notice: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>("choose");
  const [error, setError] = useState<string | null>(null);
  const n = agents.length;

  const remove = async (mode?: "drain" | "now") => {
    setPhase("busy");
    setError(null);
    const r = await (mode ? ops.remove(machine, mode) : ops.remove(machine));
    if (!r.ok) {
      setPhase("choose");
      setError(r.error ?? "volleyd refused");
      return;
    }
    const left = plural(r.agents ?? n, "agent");
    onDone(
      r.removing === "drain"
        ? `${machine} is draining: it is removed once its ${left} finish.`
        : r.removing === "now"
          ? `${machine} is being removed: its ${left} are being stopped.`
          : `${machine} removed: its account was revoked.`,
    );
  };

  const busy = phase === "busy";
  return (
    <MachineSheet label={`Remove ${machine}`} onClose={onClose}>
      {n === 0 ? (
        <p className="dim">Nothing is running on {machine}, so it is removed at once.</p>
      ) : (
        <>
          <h4 className="m-sheet-sub">Running on {machine}:</h4>
          <ul className="m-plan mono" aria-label={`Running on ${machine}`}>
            {agents.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </>
      )}
      <h4 className="m-sheet-sub">This will:</h4>
      <ul className="m-plan" aria-label="This will">
        {n > 0 && <li>stop placing and starting new agents on {machine}</li>}
        {n > 0 && (
          <li>
            wait for its {plural(n, "running agent")} to finish (Remove now stops them instead)
          </li>
        )}
        <li>
          revoke {machine}'s broker account, take it out of volleyd's hosts and clear its record
        </li>
        <li>stop its tunnel at its next check; pairing it again takes a new code</li>
      </ul>
      {error && (
        <p className="s-error" role="alert">
          {error}
        </p>
      )}
      {phase === "confirm-now" ? (
        <div className="m-confirm">
          <p className="s-hint">
            Stop {plural(n, "agent")} on {machine} now? Each is told to cancel; one still running
            after the stop grace is retired, and its task asks whether to respawn elsewhere.
          </p>
          <div className="ny-actions">
            <button type="button" className="btn btn--danger" onClick={() => void remove("now")}>
              Stop them and remove
            </button>
            <button type="button" className="btn" onClick={() => setPhase("choose")}>
              Back
            </button>
          </div>
        </div>
      ) : n === 0 ? (
        <div className="ny-actions">
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? "Removing…" : `Remove ${machine}`}
          </button>
        </div>
      ) : (
        <div className="ny-actions">
          <button
            type="button"
            className="btn btn--hot"
            disabled={busy}
            onClick={() => void remove("drain")}
          >
            Drain, then remove
          </button>
          <button
            type="button"
            className="btn btn--danger"
            disabled={busy}
            onClick={() => setPhase("confirm-now")}
          >
            Remove now
          </button>
        </div>
      )}
    </MachineSheet>
  );
}
