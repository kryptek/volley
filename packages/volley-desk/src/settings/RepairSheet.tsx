/**
 * Repair… on a machine card (SPEC §4.6.14 `peer_doctor`): opening runs the
 * machine's doctor as a dry run (`fix: false`) and shows its plan, split by
 * the Desk's fix table (`machineFixes.ts`) into what Repair does itself
 * ("This will: …", the safe fixes) and what someone runs on the machine
 * ("You run on <machine>: …", the doctor's own command, to copy). **Also
 * clone the wave repo** is off by default; **Apply** sends `fix: true` with
 * it, then shows the checks the answer carries. A refusal or an ssh failure
 * shows volleyd's reason.
 */
import { useEffect, useRef, useState } from "react";
import type { DoctorCheck, PeerOps } from "../store/peerOps";
import { CheckRows, CopyCommand } from "./MachineRows";
import { MachineSheet } from "./MachineSheet";
import { fixFor } from "./machineFixes";
import { Toggle } from "./primitives";

type Phase =
  | { k: "planning" }
  | { k: "plan"; plan: DoctorCheck[] }
  | { k: "applying"; plan: DoctorCheck[] }
  | { k: "applied"; checks: DoctorCheck[] }
  | { k: "failed"; error: string; plan?: DoctorCheck[] };

export function RepairSheet({
  machine,
  ops,
  repo,
  onClose,
}: {
  machine: string;
  ops: PeerOps;
  /** The wave repo's clone on the machine, for the fix lines. */
  repo?: string | undefined;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ k: "planning" });
  const [clone, setClone] = useState(false);
  const ctx = { machine, repo };

  const plan = async () => {
    setPhase({ k: "planning" });
    const a = await ops.doctor(machine, { fix: false });
    setPhase(a.ok ? { k: "plan", plan: a.plan } : { k: "failed", error: a.error });
  };
  // Opening the sheet is the intent: the dry run starts at once (once, under StrictMode too).
  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the sheet opens
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void plan();
  }, []);

  const apply = async (items: DoctorCheck[]) => {
    setPhase({ k: "applying", plan: items });
    const a = await ops.doctor(machine, { fix: true, clone });
    setPhase(
      a.ok ? { k: "applied", checks: a.checks } : { k: "failed", error: a.error, plan: items },
    );
  };

  const items = phase.k === "plan" || phase.k === "applying" ? phase.plan : [];
  const runs = (c: DoctorCheck) => {
    const f = fixFor(c.id, ctx);
    return f.safe && (f.needsClone !== true || clone);
  };
  const will = items.filter(runs);
  const yours = items.filter((c) => !runs(c));

  return (
    <MachineSheet label={`Repair ${machine}`} onClose={onClose}>
      {phase.k === "planning" && (
        <p className="dim">
          <span className="spinner" aria-hidden="true" /> Running the doctor on {machine}…
        </p>
      )}
      {phase.k === "failed" && (
        <>
          <p className="s-error" role="alert">
            {phase.error}
          </p>
          <div className="ny-actions">
            <button type="button" className="btn" onClick={() => void plan()}>
              Try again
            </button>
          </div>
        </>
      )}
      {(phase.k === "plan" || phase.k === "applying") && (
        <>
          {items.length === 0 && <p className="dim">The doctor found nothing to fix.</p>}
          {will.length > 0 && (
            <>
              <h4 className="m-sheet-sub">This will:</h4>
              <ul className="m-plan" aria-label="This will">
                {will.map((c) => (
                  <li key={c.id}>{fixFor(c.id, ctx).text}</li>
                ))}
              </ul>
            </>
          )}
          {yours.length > 0 && (
            <>
              <h4 className="m-sheet-sub">You run on {machine}:</h4>
              <ul className="m-plan" aria-label={`You run on ${machine}`}>
                {yours.map((c) => {
                  const f = fixFor(c.id, ctx);
                  const command = c.fix ?? f.command;
                  return (
                    <li key={c.id}>
                      <span className="dim">{c.detail}</span>
                      {command ? <CopyCommand text={command} ready /> : <span>{f.text}</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          <div className="m-switch">
            <Toggle on={clone} onChange={setClone} label="Also clone the wave repo" />
            <span>Also clone the wave repo</span>
          </div>
          <div className="ny-actions">
            <button
              type="button"
              className="btn btn--hot"
              disabled={phase.k === "applying" || will.length === 0}
              onClick={() => void apply(items)}
            >
              {phase.k === "applying" ? "Applying…" : "Apply"}
            </button>
          </div>
        </>
      )}
      {phase.k === "applied" && (
        <>
          <p className="dim">Applied. The doctor checked {machine} again:</p>
          <CheckRows checks={phase.checks} ctx={ctx} label="Checks after the fix" />
        </>
      )}
    </MachineSheet>
  );
}
