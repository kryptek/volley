/**
 * Settings › Repositories' **Add repository…** (SPEC §4.6.21 `repo_add`): the shared form
 * (`AddRepoForm`: the slug, the machines, an existing clone to adopt per paired machine, checked
 * with `repo_probe`) in a sheet. Once volleyd has added it, each machine's progress follows its
 * readiness verdict (`cloning…`, `ready`, `blocked: <why>`) until every one is ready or blocked,
 * when **Done** closes; a blocked chip's **Why** opens its whole reason.
 */
import { useState } from "react";
import type { PeerOps } from "../store/peerOps";
import type { ReadinessPayload } from "../store/types";
import { AddRepoForm } from "./AddRepoForm";
import { MachineSheet } from "./MachineSheet";
import { RepoChipReason } from "./RepoChipReason";
import { bySlug, stateText } from "./repos";

export interface AddRepoSheetProps {
  ops: PeerOps;
  /** Every machine, the supervisor's own first (`allMachines`). */
  machines: readonly string[];
  /** The supervisor's own machine: no existing-clone choice there. */
  localName: string | null | undefined;
  /** volleyd's verdicts, by machine: the progress of each machine's clone. */
  readiness: Record<string, ReadinessPayload>;
  onClose: () => void;
}

type Phase = { k: "form" } | { k: "added"; slug: string; machines: string[] };

/** A machine's progress has settled: ready, or blocked with its reason. */
const SETTLED: ReadonlySet<string> = new Set(["ready", "blocked"]);

export function AddRepoSheet({ ops, machines, localName, readiness, onClose }: AddRepoSheetProps) {
  const [phase, setPhase] = useState<Phase>({ k: "form" });

  if (phase.k === "added") {
    const states = phase.machines.map((m) => {
      const v = bySlug(readiness[m]?.repos, phase.slug);
      return {
        m,
        state: v?.state,
        reasons: v?.reasons ?? [],
        text: stateText(v ?? { reasons: [] }, "starting…"),
      };
    });
    const settled = states.every((x) => x.state !== undefined && SETTLED.has(x.state));
    return (
      <MachineSheet label="Add repository" onClose={onClose}>
        <p>
          Added <b className="mono">{phase.slug}</b>. Each machine clones it and trusts it for
          Claude Code:
        </p>
        <ul className="repo-chips" aria-label={`Progress for ${phase.slug}`}>
          {states.map(({ m, state, reasons, text }) => (
            <li
              key={m}
              className={`repo-chip repo-chip--${state ?? "none"}`}
              aria-label={`${m}: ${text}`}
              title={reasons.join("\n") || undefined}
            >
              <b>{m}</b>
              <span className="ell">{text}</span>
              {(state === undefined || state === "cloning") && (
                <span className="spinner" aria-hidden="true" />
              )}
              {state === "blocked" && <RepoChipReason reasons={reasons} />}
            </li>
          ))}
        </ul>
        {states.some((x) => x.state === "blocked") && (
          <p className="s-hint">
            A blocked machine is tried again when it is back, or after Repair on its row.
          </p>
        )}
        <div className="ny-actions">
          <button type="button" className="btn btn--hot" disabled={!settled} onClick={onClose}>
            Done
          </button>
        </div>
      </MachineSheet>
    );
  }

  return (
    <MachineSheet label="Add repository" onClose={onClose}>
      <AddRepoForm
        ops={ops}
        machines={machines}
        localName={localName}
        onCancel={onClose}
        onAdded={(r, picked) =>
          setPhase({
            k: "added",
            slug: r.slug,
            machines: r.machines.length > 0 ? r.machines : picked,
          })
        }
      />
    </MachineSheet>
  );
}
