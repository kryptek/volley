/**
 * Repair… on a machine card (SPEC §4.6.14 `peer_doctor`): opening runs the
 * machine's doctor as a dry run (`fix: false`) and shows its plan, split by
 * the Desk's fix table (`machineFixes.ts`) into what Repair does itself
 * ("This will: …", the safe fixes) and what someone runs on the machine
 * ("You run on <machine>: …", the doctor's own command, to copy). **Apply**
 * sends `fix: true`, then shows the checks the answer carries. A refusal or an
 * ssh failure shows volleyd's reason.
 *
 * A machine with repositories (SPEC §4.6.21) gets one row per repository: a
 * clone it lacks has a **Clone <owner/name>** switch, on by default (its
 * owner added it there), which Apply sends as `repos_add` with `clone: true`
 * (an adopted clone as `<owner/name>=<path>`); what its toolchain lacks is the
 * person's to install. A successful run also makes volleyd retry the
 * repository runs blocked there. An older peer without repositories keeps
 * the one **Also clone the wave repo** switch, off by default.
 */
import { useEffect, useRef, useState } from "react";
import type { DoctorCheck, PeerOps } from "../store/peerOps";
import { CheckRows, CopyCommand } from "./MachineRows";
import { MachineSheet } from "./MachineSheet";
import { fixFor } from "./machineFixes";
import { Toggle } from "./primitives";
import { type RepoOnMachine, cloneable, sameSlug, stateText } from "./repos";

type Phase =
  | { k: "planning" }
  | { k: "plan"; plan: DoctorCheck[] }
  | { k: "applying"; plan: DoctorCheck[] }
  | { k: "applied"; checks: DoctorCheck[] }
  | { k: "failed"; error: string };

export function RepairSheet({
  machine,
  ops,
  repo,
  repos = [],
  onClose,
}: {
  machine: string;
  ops: PeerOps;
  /** The wave repo's clone on the machine, for the fix lines (an older peer's one repo). */
  repo?: string | undefined;
  /** Each repository on the machine (`reposOnMachine`): one row each. */
  repos?: readonly RepoOnMachine[];
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ k: "planning" });
  const [clone, setClone] = useState(false);
  /** The repositories Apply clones: every one without a clone, until switched off. */
  const [cloning, setCloning] = useState<ReadonlySet<string>>(
    () => new Set(repos.filter(cloneable).map((r) => r.slug)),
  );
  const perRepo = repos.length > 0;
  const ctx = { machine, repo, repos };
  const toClone = repos.filter((r) => cloning.has(r.slug));

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
    const a = await ops.doctor(
      machine,
      perRepo
        ? toClone.length > 0
          ? {
              fix: true,
              clone: true,
              reposAdd: toClone.map((r) =>
                r.managed === false && r.path ? `${r.slug}=${r.path}` : r.slug,
              ),
            }
          : { fix: true, clone: false }
        : { fix: true, clone },
    );
    setPhase(a.ok ? { k: "applied", checks: a.checks } : { k: "failed", error: a.error });
  };

  const items = phase.k === "plan" || phase.k === "applying" ? phase.plan : [];
  /** Whether the clone a `needsClone` fix makes is switched on: its repository's, else the wave repo's. */
  const cloneOn = (c: DoctorCheck) =>
    !perRepo
      ? clone
      : c.repo !== undefined
        ? toClone.some((r) => sameSlug(r.slug, c.repo ?? ""))
        : toClone.length > 0;
  const runs = (c: DoctorCheck) => {
    const f = fixFor(c.id, ctx, c.repo);
    return f.safe && (f.needsClone !== true || cloneOn(c));
  };
  const key = (c: DoctorCheck) => `${c.id}:${c.repo ?? ""}`;
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
                  <li key={key(c)}>{fixFor(c.id, ctx, c.repo).text}</li>
                ))}
              </ul>
            </>
          )}
          {yours.length > 0 && (
            <>
              <h4 className="m-sheet-sub">You run on {machine}:</h4>
              <ul className="m-plan" aria-label={`You run on ${machine}`}>
                {yours.map((c) => {
                  const f = fixFor(c.id, ctx, c.repo);
                  const command = c.fix ?? f.command;
                  return (
                    <li key={key(c)}>
                      <span className="dim">{c.detail}</span>
                      {command ? <CopyCommand text={command} ready /> : <span>{f.text}</span>}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {perRepo ? (
            <RepoRows
              machine={machine}
              repos={repos}
              cloning={cloning}
              onClone={(slug, on) =>
                setCloning((s) => {
                  const next = new Set(s);
                  if (on) next.add(slug);
                  else next.delete(slug);
                  return next;
                })
              }
            />
          ) : (
            <div className="m-switch">
              <Toggle on={clone} onChange={setClone} label="Also clone the wave repo" />
              <span>Also clone the wave repo</span>
            </div>
          )}
          <div className="ny-actions">
            <button
              type="button"
              className="btn btn--hot"
              disabled={phase.k === "applying" || (will.length === 0 && toClone.length === 0)}
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

/** One row per repository on the machine: where it stands, its clone switch, its missing tools. */
function RepoRows({
  machine,
  repos,
  cloning,
  onClone,
}: {
  machine: string;
  repos: readonly RepoOnMachine[];
  cloning: ReadonlySet<string>;
  onClone: (slug: string, on: boolean) => void;
}) {
  return (
    <>
      <h4 className="m-sheet-sub">Repositories:</h4>
      <ul className="m-plan repo-rows" aria-label={`Repositories on ${machine}`}>
        {repos.map((r) => (
          <li key={r.slug} aria-label={r.slug} className="repo-row">
            <div className="repo-row-head">
              <b className="mono">{r.slug}</b>
              <span className={`repo-state repo-state--${r.state ?? "none"}`}>
                {stateText(r, "no verdict yet")}
              </span>
            </div>
            {cloneable(r) && (
              <div className="m-switch">
                <Toggle
                  on={cloning.has(r.slug)}
                  onChange={(on) => onClone(r.slug, on)}
                  label={`Clone ${r.slug}`}
                />
                <span>
                  Clone {r.slug}
                  {r.path && <span className="dim mono"> to {r.path}</span>}
                </span>
              </div>
            )}
            {r.missing.map((t) => (
              <span key={`missing-${t}`} className="s-hint">
                install {t} on {machine} (needed by {r.slug})
              </span>
            ))}
            {r.outdated.map((t) => (
              <span key={`outdated-${t}`} className="s-hint">
                update {t} on {machine} (needed by {r.slug})
              </span>
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}
