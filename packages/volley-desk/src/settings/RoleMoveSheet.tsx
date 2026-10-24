/**
 * Move a role here… on a machine card (SPEC §4.6.24): moving the broker, the supervisor or the
 * Desk to this machine, in the phases `planning → plan → confirm → moving → done | failed`.
 *
 * Opening plans at once (`role_plan`, which changes nothing) and shows three lists: **This
 * will** (each step with the machine it runs on), **You run on <machine>** (the commands only a
 * terminal there can run, to copy, and **Check again**, which plans afresh) and **Blocked** (each
 * with its fix), then the warnings and the **After the move** notes. Confirming stays off while
 * anything blocks, except the fleet not being idle: a supervisor or broker move then offers
 * **Move when the fleet is idle…** (D2: `drain`, nothing new starts and the move waits for the
 * last agent). A broker move carries **Also move the supervisor**, checked by default (D1): once
 * the broker is done, the sheet plans the supervisor's move and runs it when nothing blocks it.
 *
 * **Move now** sends `role_move` with the plan's `plan_id`; volleyd refuses a plan that moved on
 * (`plan changed`), and the sheet plans again. While it moves, the step lines come from the
 * move's retained record (`roleMoves`), the newest one for this role and machine the Desk had not
 * seen before sending until the answer names the move. A supervisor move is answered as it
 * starts and hands over (`handing over to <machine>…`) until the supervisor's pill is live again
 * on the new machine. A Desk move's answer seals the sign-in link for the new address (D4): every
 * device signs in again there, so the sheet shows the link and its QR. Done names the rollback
 * (D5: `volley role rollback <move_id>`, kept 7 days) and offers **Undo this move**; failed names
 * the step and whether every step was rolled back. Escape closes only in plan, done and failed.
 */
import { useEffect, useRef, useState } from "react";
import {
  type MachineRole,
  type RoleBlocker,
  type RoleMoveAnswer,
  type RoleOps,
  type RolePlan,
  isQuietWait,
} from "../store/roleOps";
import type { RoleMovePayload, RoleMoveStep, RolesPayload } from "../store/types";
import { CopyCommand } from "./MachineRows";
import { MachineSheet } from "./MachineSheet";
import { CopyText, Qr } from "./onboardingParts";

/** How a role is named in a sentence. */
export const ROLE_NAME: Record<MachineRole, string> = {
  broker: "the broker",
  supervisor: "the supervisor",
  desk: "the Desk",
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What a completed move replaced is kept this long (SPEC §4.6.24: no tunable). */
const KEPT_DAYS = 7;

const MARK: Record<RoleMoveStep["status"], [string, string]> = {
  ok: ["✓", "done"],
  running: ["…", "running"],
  failed: ["✗", "failed"],
  pending: ["○", "waiting"],
  skipped: ["–", "skipped"],
};

interface Target {
  role: MachineRole;
  to: string;
}

type Phase =
  | { k: "planning"; notice?: string; auto?: boolean }
  | { k: "plan"; plan: RolePlan | null; error?: string }
  | { k: "confirm"; plan: RolePlan; drain: boolean }
  | {
      k: "moving";
      from: string;
      /** Known once volleyd names the move (its answer, or a rollback's). */
      moveId?: string;
      /** The moves the Desk knew before sending: none of them is this one. */
      before: ReadonlySet<string>;
      handingOver?: boolean;
      /** Waiting for a quiet fleet (`drain`). */
      waiting?: boolean;
      unanswered?: boolean;
      undo?: boolean;
      steps: RolePlan["steps"];
    }
  | {
      k: "done";
      from: string;
      moveId: string;
      link?: string;
      error?: string;
      /** Undo this move was sent and volleyd has not answered yet. */
      undoing?: boolean;
    }
  | {
      k: "failed";
      from: string;
      moveId?: string;
      error: string;
      step?: string;
      line?: string;
      rolledBack?: boolean;
      logPath?: string;
    };

export interface RoleMoveSheetProps {
  role: MachineRole;
  /** The machine the role moves to: the card's. */
  to: string;
  /** volleyd's roles record: where the supervisor runs (the broker move's box). */
  roles: RolesPayload | undefined;
  ops: RoleOps;
  /** The moves' retained records (`state.roleMoves`). */
  moves: Record<string, RoleMovePayload>;
  /** Whether the supervisor's pill is live: a supervisor move hands over until it is again. */
  hubUp: boolean;
  onClose: () => void;
  /** A move finished: what to tell the section. */
  onMoved?: ((notice: string) => void) | undefined;
}

export function RoleMoveSheet(p: RoleMoveSheetProps) {
  const [target, setTarget] = useState<Target>({ role: p.role, to: p.to });
  const [phase, setPhase] = useState<Phase>({ k: "planning" });
  /** D1: on a broker move, the supervisor follows once the broker is done. */
  const [chain, setChain] = useState(
    p.role === "broker" && p.roles !== undefined && p.roles.supervisor.machine !== p.to,
  );
  const [sawDown, setSawDown] = useState(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const movesNow = useRef(p.moves);
  movesNow.current = p.moves;
  const name = ROLE_NAME[target.role];

  const plan = async (t: Target, opts: { notice?: string; auto?: boolean } = {}) => {
    setPhase({ k: "planning", ...opts });
    const a = await p.ops.plan(t);
    if (!live.current) return;
    if (!a.ok) return setPhase({ k: "plan", plan: null, error: a.error });
    const clear = a.plan.blocked.length === 0;
    if (opts.auto && clear) return void send(t, a.plan, false);
    setPhase({ k: "plan", plan: a.plan, ...(opts.notice ? { error: opts.notice } : {}) });
  };

  // Opening the sheet is the intent: the plan starts at once (once, under StrictMode too).
  const started = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the sheet opens
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void plan(target);
  }, []);

  /** Each send (and Undo) takes the next number: an answer to an earlier one is stale. */
  const sent = useRef(0);

  /**
   * volleyd's answer to the move (or its late one). When the record finished the move first,
   * the answer still adds what only it carries: a Desk move's link, whether a failure was undone.
   */
  const settle = (t: Target, shown: RolePlan, a: RoleMoveAnswer, mine: number) => {
    if (!live.current || mine !== sent.current) return;
    setPhase((ph) => {
      if (ph.k === "done") {
        return a.ok && a.moveId === ph.moveId && a.link ? { ...ph, link: a.link } : ph;
      }
      if (ph.k === "failed") {
        if (a.ok || a.moveId === undefined || a.moveId !== ph.moveId) return ph;
        const title = shown.steps.find((s) => s.id === a.step)?.title;
        return {
          ...ph,
          ...(ph.step === undefined && (title ?? a.step) !== undefined
            ? { step: (title ?? a.step) as string }
            : {}),
          ...(a.rolledBack !== undefined ? { rolledBack: a.rolledBack } : {}),
        };
      }
      if (ph.k !== "moving") return ph;
      if (ph.moveId !== undefined && a.moveId !== undefined && a.moveId !== ph.moveId) return ph;
      if (a.ok) {
        if (a.status === "done") {
          return {
            k: "done",
            from: ph.from,
            moveId: a.moveId,
            ...(a.link ? { link: a.link } : {}),
          };
        }
        return {
          ...ph,
          moveId: a.moveId,
          unanswered: false,
          waiting: a.status === "planning",
          handingOver: a.handingOver === true,
        };
      }
      if (a.unanswered) return { ...ph, unanswered: true };
      if (a.moveId !== undefined) {
        const rec = movesNow.current[a.moveId];
        const title =
          rec?.steps.find((s) => s.id === a.step)?.title ??
          shown.steps.find((s) => s.id === a.step)?.title ??
          a.step;
        const line = rec?.steps.find((s) => s.id === a.step)?.line;
        return {
          k: "failed",
          from: ph.from,
          moveId: a.moveId,
          error: a.error,
          ...(title !== undefined ? { step: title } : {}),
          ...(line !== undefined ? { line } : {}),
          ...(a.rolledBack !== undefined ? { rolledBack: a.rolledBack } : {}),
          ...(rec?.log_path ? { logPath: rec.log_path } : {}),
        };
      }
      return { k: "plan", plan: shown, error: a.error };
    });
    if (!a.ok && a.planChanged) {
      void plan(t, {
        notice:
          "The fleet changed since this plan was shown, so nothing moved. Here is the new plan: check it, then move again",
      });
    }
  };

  const send = async (t: Target, shown: RolePlan, drain: boolean) => {
    const mine = ++sent.current;
    setPhase({
      k: "moving",
      from: shown.from,
      before: new Set(Object.keys(movesNow.current)),
      waiting: drain,
      steps: shown.steps,
    });
    const a = await p.ops.move(
      { role: t.role, to: t.to, planId: shown.planId, ...(drain ? { drain: true } : {}) },
      { onLate: (late) => settle(t, shown, late, mine) },
    );
    settle(t, shown, a, mine);
  };

  const undo = async (moveId: string, from: string) => {
    if (phase.k !== "done" || phase.undoing) return;
    const back: Target = { role: target.role, to: from };
    ++sent.current;
    const { error: _, ...shown } = phase;
    setPhase({ ...shown, undoing: true });
    const a = await p.ops.rollback(moveId);
    if (!live.current) return;
    if (!a.ok) {
      setPhase((ph) => (ph.k === "done" ? { ...ph, undoing: false, error: a.error } : ph));
      return;
    }
    setChain(false);
    setSawDown(false);
    setTarget(back);
    setPhase({
      k: "moving",
      from: target.to,
      moveId: a.moveId,
      before: new Set(),
      undo: true,
      handingOver: a.handingOver === true,
      steps: [],
    });
  };

  // The move's record: the one volleyd named, else the newest new one for this role and machine.
  const moving = phase.k === "moving" ? phase : null;
  const rec = moving
    ? moving.moveId !== undefined
      ? p.moves[moving.moveId]
      : Object.values(p.moves)
          .filter((m) => !moving.before.has(m.move_id) && m.role === target.role)
          .filter((m) => m.to === target.to)
          .sort((a, b) => b.since.localeCompare(a.since))[0]
    : undefined;

  // A finished record ends the move, whether or not its answer has come. Whether a failed move
  // was undone only its answer says (`rolled_back`); `rolled_back` on a record marks a finished
  // move a later rollback undid, never this one while it runs.
  useEffect(() => {
    if (!rec || (rec.status !== "done" && rec.status !== "failed")) return;
    setPhase((ph) => {
      if (ph.k !== "moving") return ph;
      if (rec.status === "done") return { k: "done", from: ph.from, moveId: rec.move_id };
      const failed = rec.steps.find((s) => s.status === "failed");
      return {
        k: "failed",
        from: ph.from,
        moveId: rec.move_id,
        error: rec.error ?? "the move failed",
        ...(failed ? { step: failed.title } : {}),
        ...(failed?.line !== undefined ? { line: failed.line } : {}),
        ...(rec.log_path ? { logPath: rec.log_path } : {}),
      };
    });
  }, [rec]);

  // A supervisor hand-over: the old supervisor goes away, the new one comes up.
  useEffect(() => {
    if (moving?.handingOver && !p.hubUp) setSawDown(true);
  }, [moving?.handingOver, p.hubUp]);
  const handing = moving?.handingOver === true && !(sawDown && p.hubUp);

  // Done: tell the section once per move, then the queued supervisor move (D1).
  const told = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per finished move
  useEffect(() => {
    if (phase.k !== "done" || told.current === phase.moveId) return;
    told.current = phase.moveId;
    p.onMoved?.(`${cap(name)} runs on ${target.to} now.`);
    if (chain && target.role === "broker") {
      setChain(false);
      const next: Target = { role: "supervisor", to: target.to };
      setTarget(next);
      void plan(next, { auto: true });
    }
  }, [phase]);

  const closable =
    phase.k === "plan" || (phase.k === "done" && !phase.undoing) || phase.k === "failed";
  const label =
    phase.k === "moving" && phase.undo
      ? `Move ${name} back to ${target.to}`
      : `Move ${name} to ${target.to}`;

  return (
    <MachineSheet label={label} onClose={p.onClose} closable={closable}>
      {phase.k === "planning" && (
        <p className="dim">
          <span className="spinner" aria-hidden="true" /> Planning the move of {name} to {target.to}
          …
        </p>
      )}
      {phase.k === "plan" && (
        <PlanView
          plan={phase.plan}
          error={phase.error}
          name={name}
          chainable={
            target.role === "broker" &&
            p.roles !== undefined &&
            p.roles.supervisor.machine !== target.to
          }
          chain={chain}
          onChain={setChain}
          to={target.to}
          onCheckAgain={() => void plan(target)}
          onConfirm={(pl, drain) => setPhase({ k: "confirm", plan: pl, drain })}
        />
      )}
      {phase.k === "confirm" && (
        <div className="m-confirm">
          <p className="s-hint">
            Move {name} from {phase.plan.from} to {target.to} now?{" "}
            {phase.drain &&
              "It waits for the fleet to be idle: nothing new starts meanwhile, and the move begins when the last agent ends. "}
            {chain && target.role === "broker" && "The supervisor follows it once it is there."}
          </p>
          <div className="ny-actions">
            <button
              type="button"
              className="btn btn--hot"
              onClick={() => void send(target, phase.plan, phase.drain)}
            >
              Move now
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setPhase({ k: "plan", plan: phase.plan })}
            >
              Back
            </button>
          </div>
        </div>
      )}
      {phase.k === "moving" && (
        <>
          <p className="dim">
            <span className="spinner" aria-hidden="true" />{" "}
            {phase.undo
              ? `Moving ${name} back to ${target.to}…`
              : handing
                ? `handing over to ${target.to}…`
                : phase.waiting
                  ? "Waiting for the fleet to be idle: nothing new starts meanwhile…"
                  : rec
                    ? `Moving ${name} to ${target.to}…`
                    : "Starting the move…"}
          </p>
          {rec && <StepLines steps={rec.steps} />}
          {phase.unanswered && (
            <p className="s-hint">
              volleyd has not answered yet, so {name} is still moving: its steps show here as they
              run.
            </p>
          )}
        </>
      )}
      {phase.k === "done" && (
        <>
          <p className="m-ready m-ready--ok">
            {cap(name)} runs on {target.to}.
          </p>
          {rec && <StepLines steps={rec.steps} />}
          {phase.link && (
            <div className="rm-signin">
              <p className="s-hint">
                Sign in again at the new address on every device: the Desk's old address stops
                working once its service there is unloaded.
              </p>
              <CopyText text={phase.link} />
              <Qr text={phase.link} label="QR code of the sign-in link" />
            </div>
          )}
          <p className="s-hint">
            To undo it within {KEPT_DAYS} days (what it replaced is kept until then):
          </p>
          <CopyCommand text={`volley role rollback ${phase.moveId}`} ready />
          {phase.error && (
            <p className="s-error" role="alert">
              {phase.error}
            </p>
          )}
          <div className="ny-actions">
            <button
              type="button"
              className="btn"
              disabled={phase.undoing === true}
              onClick={() => void undo(phase.moveId, phase.from)}
            >
              {phase.undoing ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Undoing…
                </>
              ) : (
                "Undo this move"
              )}
            </button>
            <button type="button" className="btn btn--hot" onClick={p.onClose}>
              Done
            </button>
          </div>
        </>
      )}
      {phase.k === "failed" && (
        <>
          <div className="s-error" role="alert">
            <p>
              The move failed{phase.step ? ` at ${phase.step}` : ""}: {phase.line ?? phase.error}
            </p>
          </div>
          <p className="s-hint">
            {phase.rolledBack === false
              ? `Its steps were not undone${phase.logPath ? `: the log is ${phase.logPath}` : ""}.`
              : phase.rolledBack
                ? `Every step done so far was rolled back: ${name} stays on ${phase.from}.`
                : `volleyd has not said yet whether its steps were undone${phase.logPath ? `: the log is ${phase.logPath}` : ""}.`}
          </p>
          <div className="ny-actions">
            <button type="button" className="btn" onClick={() => void plan(target)}>
              Plan again
            </button>
          </div>
        </>
      )}
    </MachineSheet>
  );
}

/** The live step lines: ✓ done, … running, ✗ failed, ○ waiting, – skipped. */
function StepLines({ steps }: { steps: readonly RoleMoveStep[] }) {
  return (
    <ul className="m-plan rm-steps" aria-label="Steps">
      {steps.map((s) => {
        const [mark, word] = MARK[s.status];
        return (
          <li key={s.id} className={`rm-step rm-step--${s.status}`}>
            <span className="rm-mark" aria-hidden="true">
              {mark}
            </span>
            <span className="sr-only">{word}: </span>
            {s.title}
            <span className="dim"> · {s.where}</span>
            {s.line && <span className="rm-line mono">{s.line}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** The plan: This will, You run on, Blocked, the warnings and the After the move notes. */
function PlanView({
  plan,
  error,
  name,
  to,
  chainable,
  chain,
  onChain,
  onCheckAgain,
  onConfirm,
}: {
  plan: RolePlan | null;
  error: string | undefined;
  name: string;
  to: string;
  chainable: boolean;
  chain: boolean;
  onChain: (on: boolean) => void;
  onCheckAgain: () => void;
  onConfirm: (plan: RolePlan, drain: boolean) => void;
}) {
  const hard: RoleBlocker[] = plan?.blocked.filter((b) => !isQuietWait(b)) ?? [];
  const waits = (plan?.blocked.length ?? 0) - hard.length;
  const places = [...new Set(plan?.terminal.map((t) => t.where) ?? [])];
  return (
    <>
      {error && (
        <p className="s-error" role="alert">
          {error}
        </p>
      )}
      {plan && (
        <>
          <h4 className="m-sheet-sub">This will:</h4>
          <ul className="m-plan" aria-label="This will">
            {plan.steps.map((s) => (
              <li key={s.id}>
                {s.title}
                <span className="dim"> · {s.where}</span>
              </li>
            ))}
          </ul>
          {places.map((where) => (
            <div key={where}>
              <h4 className="m-sheet-sub">You run on {where}:</h4>
              <ul className="m-plan" aria-label={`You run on ${where}`}>
                {plan.terminal
                  .filter((t) => t.where === where)
                  .map((t, i) => (
                    <li key={`${i}:${t.command}`}>
                      <span className="s-hint">{t.reason}</span>
                      <CopyCommand text={t.command} ready />
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          {plan.blocked.length > 0 && (
            <>
              <h4 className="m-sheet-sub">Blocked:</h4>
              <ul className="m-plan rm-blocked" aria-label="Blocked">
                {plan.blocked.map((b, i) => (
                  <li key={`${i}:${b.why}`}>
                    {b.why}
                    {b.fix && <span className="s-hint rm-fix">{b.fix}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plan.warnings.length > 0 && (
            <ul className="m-plan rm-warnings" aria-label="Warnings">
              {plan.warnings.map((w, i) => (
                <li key={`${i}:${w}`}>{w}</li>
              ))}
            </ul>
          )}
          {plan.after.length > 0 && (
            <>
              <h4 className="m-sheet-sub">After the move:</h4>
              <ul className="m-plan" aria-label="After the move">
                {plan.after.map((a, i) => (
                  <li key={`${i}:${a}`}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {chainable && (
            <label className="rm-chain">
              <input type="checkbox" checked={chain} onChange={(e) => onChain(e.target.checked)} />{" "}
              Also move the supervisor to {to}, once {name} is there
            </label>
          )}
        </>
      )}
      <div className="ny-actions">
        {plan && (
          <button
            type="button"
            className="btn btn--hot"
            disabled={hard.length > 0}
            onClick={() => onConfirm(plan, hard.length === 0 && waits > 0)}
          >
            {hard.length === 0 && waits > 0 ? "Move when the fleet is idle…" : "Move…"}
          </button>
        )}
        <button type="button" className="btn" onClick={onCheckAgain}>
          Check again
        </button>
      </div>
    </>
  );
}
