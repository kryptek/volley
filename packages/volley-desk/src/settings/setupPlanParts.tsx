/**
 * The setup wizard's shared pieces (`SetupWizard.tsx`, and Getting started › This computer):
 * `useSetupPlan` holds volleyd's plan (`setup_plan`), the LAN answer, Apply (`setup_apply
 * { step, plan_id }`, re-planned afterwards, a stale plan shown again) and the broker-restart
 * reconnect; `DetectStep`, `PlanStep` and `ChangeItem` draw a step's plan. One implementation,
 * rendered in both places.
 */
import { Alert02Icon, InformationCircleIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { plural } from "../lib/plural";
import {
  type AuthAnswer,
  type AuthOps,
  SETUP_APPLY_TIMEOUT_MS,
  type SetupApplied,
  type SetupPlan,
  type SetupStepPlan,
  isPlanChanged,
  isUnknownOp,
  listenerProbes,
  parseSetupApplied,
  parseSetupPlan,
} from "../store/control";
import { CopyText, Once } from "./onboardingParts";
import { Seg } from "./primitives";

/** `volley setup`'s LAN question (O3 `LAN_QUESTION`), split into the question and its caveat. */
export const LAN_QUESTION =
  "Let your phone and other devices on this network reach the broker's WebSocket listener (port 9001), so the Desk works from your phone?";
const LAN_CAVEAT =
  "Every device still has to sign in, but the traffic is not encrypted until TLS is set up, so say yes only on a network you trust (home, not a café).";

/** While the broker restarts: how often, and how many times, the wizard asks for the plan again. */
const RECONNECT_EVERY_MS = 2000;
const RECONNECT_TRIES = 30;

export const icon = (i: typeof Tick02Icon) => (
  <HugeiconsIcon icon={i} size={12} strokeWidth={1.8} />
);

export type Load =
  | { state: "loading" }
  | { state: "ready"; plan: SetupPlan }
  | { state: "unsupported" }
  | { state: "failed"; error: string };

export type Applying =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "done"; report: SetupApplied }
  /** No answer in time: volleyd may still be applying it (a late answer still lands). */
  | { state: "unanswered"; error: string }
  | { state: "failed"; error: string };

type Fetched = { plan: SetupPlan } | { unsupported: true } | { error: string };
/** What `useSetupPlan` gives a wizard: the plan, the LAN answer and Apply, with their states. */
export interface SetupPlanState {
  load: Load;
  /** Show the spinner again (Try again). */
  setLoad: (l: Load) => void;
  /** Per step: the last apply, while the person is on that step. */
  applying: Applying;
  setApplying: (a: Applying) => void;
  /** Whether the one-time admin token was shown this run (it is never shown again). */
  tokenShown: boolean;
  /** The person's LAN answer; `null` until they pick one (the plan's own choice stands). */
  lan: boolean | null;
  /** The broker restarts after an apply: asking for the plan until it answers. */
  reconnecting: boolean;
  /** A new plan for another LAN answer is on its way. */
  replanning: boolean;
  /** Ask volleyd for the plan again. */
  plan: (lanChoice: boolean | null) => Promise<void>;
  pickLan: (on: boolean) => Promise<void>;
  /** Apply exactly the plan on screen, then plan again. */
  apply: (s: SetupStepPlan) => Promise<void>;
}

/** volleyd's setup plan, planned once on mount, and Apply (see the module comment). */
export function useSetupPlan(ops: AuthOps, repair = false): SetupPlanState {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [applying, setApplying] = useState<Applying>({ state: "idle" });
  const [tokenShown, setTokenShown] = useState(false);
  const [lan, setLan] = useState<boolean | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [replanning, setReplanning] = useState(false);
  const live = useRef(true);
  // Set again on every mount: StrictMode mounts, unmounts and mounts again.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const fetchPlan = useCallback(
    async (lanChoice: boolean | null): Promise<Fetched> => {
      // Never left spinning: a request that fails outright shows Try again.
      const r = await requestOrFail(ops, "setup_plan", {
        ...(lanChoice !== null ? { lan: lanChoice } : {}),
        ...(repair ? { repair: true } : {}),
      });
      if (isUnknownOp(r)) return { unsupported: true };
      const parsed = r.ok ? parseSetupPlan(r.result) : null;
      return parsed === null
        ? { error: r.error ?? "volleyd's plan could not be read" }
        : { plan: parsed };
    },
    [ops, repair],
  );

  const show = useCallback((f: Fetched) => {
    if (!live.current) return;
    if ("unsupported" in f) setLoad({ state: "unsupported" });
    else if ("error" in f) setLoad({ state: "failed", error: f.error });
    else setLoad({ state: "ready", plan: f.plan });
  }, []);

  const plan = useCallback(
    async (lanChoice: boolean | null) => show(await fetchPlan(lanChoice)),
    [fetchPlan, show],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: planned once on open; a LAN answer re-plans by itself
  useEffect(() => {
    void plan(null);
  }, []);

  /** After a broker restart: ask until the plan answers, then show it. */
  const replanAfterRestart = async (lanChoice: boolean | null) => {
    setReconnecting(true);
    for (let i = 0; i < RECONNECT_TRIES && live.current; i++) {
      const f = await fetchPlan(lanChoice);
      if (!("error" in f)) {
        setReconnecting(false);
        return show(f);
      }
      await new Promise((r) => setTimeout(r, RECONNECT_EVERY_MS));
    }
    if (live.current) setReconnecting(false);
  };

  const pickLan = async (on: boolean) => {
    setLan(on);
    setApplying({ state: "idle" });
    setReplanning(true);
    await plan(on);
    if (live.current) setReplanning(false);
  };

  const finished = (r: AuthAnswer, lanChoice: boolean | null) => {
    if (!live.current) return;
    const report = parseSetupApplied(r);
    if (report.token !== undefined) setTokenShown(true);
    setApplying({ state: "done", report });
    // Each step's plan depends on the ones before it.
    if (report.restarting) void replanAfterRestart(lanChoice);
    else void plan(lanChoice);
  };

  const apply = async (s: SetupStepPlan) => {
    setApplying({ state: "busy" });
    const lanChoice = s.step === "security" && s.lan !== undefined ? (lan ?? s.lan.planned) : lan;
    const r = await requestOrFail(
      ops,
      "setup_apply",
      {
        step: s.step,
        ...(s.plan_id !== undefined ? { plan_id: s.plan_id } : {}),
        ...(s.step === "security" && lanChoice !== null ? { lan: lanChoice } : {}),
        ...(repair ? { repair: true } : {}),
      },
      {
        timeoutMs: SETUP_APPLY_TIMEOUT_MS,
        // The step finished after all: show its report (and its one-time token) now.
        onLate: (late) => {
          if (late.ok) finished(late, lanChoice);
          else if (live.current)
            setApplying({ state: "failed", error: late.error ?? "volleyd refused the step" });
        },
      },
    );
    if (!live.current) return;
    if (r.ok) return finished(r, lanChoice);
    if (isPlanChanged(r)) {
      setApplying({
        state: "failed",
        error:
          "The machine changed since this plan was shown, so nothing was applied. Here is the new plan: check it, then apply again",
      });
      return void plan(lanChoice);
    }
    setApplying(
      r.unanswered
        ? {
            state: "unanswered",
            error: `${r.error}: volleyd may still be applying it (a broker restart also drops this page's connection for a moment). Its report will show here if it arrives; or check again`,
          }
        : { state: "failed", error: r.error ?? "volleyd refused the step" },
    );
  };

  return {
    load,
    setLoad,
    applying,
    setApplying,
    tokenShown,
    lan,
    reconnecting,
    replanning,
    plan,
    pickLan,
    apply,
  };
}

/** `ops.request`, with a request that fails outright answered as a refusal. */
export async function requestOrFail(
  ops: AuthOps,
  ...args: Parameters<AuthOps["request"]>
): Promise<AuthAnswer> {
  try {
    return await ops.request(...args);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const describeProbe = (p: "refused" | "accepted" | "unreachable") =>
  p === "refused" ? "refuses anonymous" : p === "accepted" ? "open to anonymous" : "not listening";

/** Step 1, as the prototype draws it: Broker / Listening / Agents on it now, and the promise. */
export function DetectStep({
  plan,
  all,
  onRecheck,
}: {
  plan: SetupStepPlan;
  all: SetupPlan;
  onRecheck: () => void;
}) {
  const broker = plan.found.find((f) => /^mosquitto /.test(f));
  const agents = plan.found
    .map((f) => /^(\d+) agents? running on the broker$/.exec(f))
    .find(Boolean);
  const listeners = listenerProbes(all);
  const shown = (f: string) =>
    f === broker || /^Listener \d+: /.test(f) || /^\d+ agents? running on the broker$/.test(f);
  const rest = plan.found.filter((f) => !shown(f));
  return (
    <>
      <h3>{plan.blocked === undefined ? "Found your broker" : "Your broker"}</h3>
      <div className="kv">
        <span>Broker</span>
        <b>{broker !== undefined ? broker.replace(/ \(from [^)]*\)$/, "") : "—"}</b>
        <span>Listening</span>
        <b className="mono">
          {listeners.length > 0
            ? listeners.map((l) => `:${l.port} ${describeProbe(l.anonymous)}`).join(" · ")
            : "—"}
        </b>
        <span>Agents on it now</span>
        <b>{agents ? `${agents[1]} live` : "—"}</b>
      </div>
      {rest.length > 0 && (
        <ul className="checks">
          {rest.map((f) => (
            <li key={f} className="dim">
              {icon(Tick02Icon)} <span>{f}</span>
            </li>
          ))}
        </ul>
      )}
      {plan.blocked !== undefined ? (
        <>
          <p className="s-error" role="alert">
            Blocked: {plan.blocked}
          </p>
          <div className="wiz-actions wiz-actions--inline">
            <button type="button" className="btn" onClick={onRecheck}>
              Check again
            </button>
          </div>
        </>
      ) : (
        <p className="dim">
          Nothing changes until you confirm a step. Every file I edit gets a backup next to it.
        </p>
      )}
    </>
  );
}

export function ChangeItem({ c }: { c: SetupStepPlan["changes"][number] }) {
  return (
    <li>
      {icon(Alert02Icon)}
      <span>
        {c.summary}
        {c.terminal !== undefined && (
          <span className="wiz-terminal">
            <span className="dim">
              Only a terminal can make this change: {c.terminal.reason}. Run it on the supervisor's
              machine:
            </span>
            <CopyText text={c.terminal.command} />
          </span>
        )}
        {c.detail !== undefined && (
          <details>
            <summary>Details</summary>
            <pre className="mono wiz-detail">{c.detail}</pre>
          </details>
        )}
      </span>
    </li>
  );
}

export function PlanStep({
  plan,
  applying,
  tokenShown,
  lan,
  replanning,
  onLan,
  onApply,
  onRecheck,
}: {
  plan: SetupStepPlan;
  applying: Applying;
  tokenShown: boolean;
  /** The LAN answer this plan is for; `null` when the step has no LAN choice. */
  lan: boolean | null;
  replanning: boolean;
  onLan: (on: boolean) => void;
  onApply: () => void;
  onRecheck: () => void;
}) {
  const applicable = plan.changes.filter((c) => c.terminal === undefined);
  const n = applicable.length;
  const report = applying.state === "done" ? applying.report : null;
  return (
    <>
      <h3>{plan.title}</h3>
      {plan.found.length + (plan.notes?.length ?? 0) > 0 && (
        <ul className="checks">
          {plan.found.map((f) => (
            <li key={f} data-kind="found">
              {icon(Tick02Icon)} <span>{f}</span>
            </li>
          ))}
          {/* What volleyd cannot check (the step's `notes`): neither a tick nor a warning. */}
          {plan.notes?.map((f) => (
            <li key={f} className="dim" data-kind="note">
              {icon(InformationCircleIcon)} <span>{f}</span>
            </li>
          ))}
        </ul>
      )}
      {plan.blocked === undefined && plan.lan !== undefined && lan !== null && report === null && (
        // Asked before the changes: they are planned for this answer.
        <div className="wiz-lan">
          <p>{LAN_QUESTION}</p>
          <p className="dim">{LAN_CAVEAT}</p>
          <Seg
            label={LAN_QUESTION}
            options={[
              ["yes", "Yes, on this network (recommended)"],
              ["no", "No, this machine only"],
            ]}
            value={lan ? "yes" : "no"}
            onPick={(k) => onLan(k === "yes")}
          />
          {replanning && <p className="dim">Planning for that answer…</p>}
        </div>
      )}
      {plan.blocked !== undefined ? (
        <>
          <p className="s-error" role="alert">
            Blocked: {plan.blocked}
          </p>
          <div className="wiz-actions wiz-actions--inline">
            <button type="button" className="btn" onClick={onRecheck}>
              Check again
            </button>
          </div>
        </>
      ) : plan.skipped !== undefined ? (
        <p className="dim">Skipped: {plan.skipped}</p>
      ) : report !== null ? (
        <>
          <p className="ok-line">
            {icon(Tick02Icon)} Applied.{" "}
            {report.problems.length === 0 ? "Checked afterwards: all good." : ""}
          </p>
          {report.lines.length > 0 && (
            <ul className="checks">
              {report.lines.map((l) => (
                <li key={l}>
                  {icon(Tick02Icon)} <span>{l}</span>
                </li>
              ))}
            </ul>
          )}
          {report.problems.length > 0 && (
            <div className="s-error" role="alert">
              After the changes, setup found:
              <ul>
                {report.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
              Fix these, then check again (or run `volley setup` in a terminal for the details).
            </div>
          )}
          {report.terminal.length > 0 && (
            <div className="s-note">
              Left for a terminal on the supervisor's machine:
              <ul className="checks">
                {report.terminal.map((t) => (
                  <ChangeItem key={t.summary} c={{ summary: t.summary, terminal: t }} />
                ))}
              </ul>
            </div>
          )}
          {report.token !== undefined && (
            <Once label="One-time admin token (shown once)" secret={report.token} qr={false}>
              <p className="dim">
                Signs one browser in as admin, once, within 10 minutes: open the Desk there with{" "}
                <span className="mono">#signin=&lt;token&gt;</span> or paste it in Settings › Setup
                &amp; Security.
              </p>
            </Once>
          )}
        </>
      ) : plan.changes.length === 0 ? (
        <p className="ok-line">{icon(Tick02Icon)} Already done: nothing to change.</p>
      ) : (
        <>
          <p>What this step will change (nothing changes until you apply it):</p>
          <ul className="checks">
            {plan.changes.map((c) => (
              <ChangeItem key={c.summary} c={c} />
            ))}
          </ul>
          {n === 0 && (
            <p className="dim">
              Every change here needs a terminal; run the command above, then check again.
            </p>
          )}
          {applying.state === "failed" && (
            <p className="s-error" role="alert">
              {applying.error}
            </p>
          )}
          {applying.state === "unanswered" && (
            <p className="s-error" role="alert">
              {applying.error}
            </p>
          )}
          <div className="wiz-actions wiz-actions--inline">
            {(applying.state === "unanswered" || n === 0) && (
              <button type="button" className="btn" onClick={onRecheck}>
                Check again
              </button>
            )}
            {/* Nothing here the Desk can apply: no Apply to press. */}
            {n > 0 && (
              <button
                type="button"
                className="btn btn--hot"
                disabled={applying.state === "busy" || replanning}
                onClick={onApply}
              >
                {applying.state === "busy"
                  ? "Applying…"
                  : n === 1
                    ? "Apply this change"
                    : `Apply ${plural(n, "change")}`}
              </button>
            )}
          </div>
        </>
      )}
      {plan.step === "accounts" && tokenShown && report?.token === undefined && (
        <p className="dim">
          The admin token was shown once; `volley auth token` in a terminal issues another.
        </p>
      )}
    </>
  );
}
