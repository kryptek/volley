/**
 * Getting started › Access: how the cluster is reached away from home. Two decisions, kept apart
 * as the cluster design keeps them:
 *
 * - **The private network**: Tailscale (recommended), the owner's own VPN into the network a
 *   machine is on (`manual`, with this computer's address on it), or this network only (`none`).
 *   It is `volley setup`'s Network step seen from the browser (SPEC §4.6.10 Setup ops): the radio
 *   writes nothing, it asks `setup_plan { network, network_address? }` for that choice's plan and
 *   shows what the step found and would change (a change only a terminal can make, the Linux
 *   install that needs sudo, with its command); Apply sends `setup_apply { step: "network",
 *   plan_id, network, network_address? }` and shows the report, where a `Sign in to Tailscale:
 *   <url>` line is a link and a QR so a phone can sign the machine in.
 * - **The coordinator**: the shared `CoordinatorCard` (Settings › Machines has the same one), whose
 *   pick writes `coordinator.machine` through the config transport. Nothing here starts a process:
 *   volleyd runs the role.
 *
 * The summary follows both: `network` once applied (or already recorded), `coordinatorMachine`
 * from the config and every pick.
 */
import "../../styles/machines.css";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CoordinatorCard } from "../../settings/CoordinatorCard";
import { CopyText, Qr } from "../../settings/onboardingParts";
import {
  type Applying,
  ChangeItem,
  type Load,
  icon,
  requestOrFail,
} from "../../settings/setupPlanParts";
import {
  type AuthAnswer,
  SETUP_APPLY_TIMEOUT_MS,
  type SetupStepPlan,
  isPlanChanged,
  isUnknownOp,
  parseSetupApplied,
  parseSetupPlan,
} from "../../store/control";
import type { StepProps } from "../steps";
import {
  NETWORK_WHAT,
  type NetworkChoice,
  networkLabel,
  tailscaleSignIn,
  vpnMachine,
} from "./accessWords";

const CHOICES: readonly NetworkChoice[] = ["tailscale", "manual", "none"];
export const ACCESS_QUESTION = "How do you plan on reaching your cluster?";
const APP_STORE = "https://apps.apple.com/app/tailscale/id1470499037";
const PLAY_STORE = "https://play.google.com/store/apps/details?id=com.tailscale.ipn";

/** What the step asks volleyd to plan for: the choice, and the VPN address with `manual`. */
interface Want {
  network: NetworkChoice | null;
  address: string;
}

const planFields = (w: Want): Record<string, unknown> => ({
  ...(w.network !== null ? { network: w.network } : {}),
  ...(w.network === "manual" && w.address !== "" ? { network_address: w.address } : {}),
});

export function Access({ ctx, summary, setSummary }: StepProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [want, setWant] = useState<Want>({ network: null, address: "" });
  const [applying, setApplying] = useState<Applying>({ state: "idle" });
  const configured = ctx.state.config?.coordinator?.machine;
  /** The coordinator's machine as picked here, until volleyd's config says so too. */
  const [coordinator, setCoordinator] = useState<string | null | undefined>(configured);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const plan = useCallback(
    async (w: Want) => {
      const r = await requestOrFail(ctx.ops, "setup_plan", planFields(w));
      if (!live.current) return;
      const parsed = r.ok ? parseSetupPlan(r.result) : null;
      if (isUnknownOp(r)) setLoad({ state: "unsupported" });
      else if (parsed === null)
        setLoad({ state: "failed", error: r.error ?? "volleyd's plan could not be read" });
      else setLoad({ state: "ready", plan: parsed });
    },
    [ctx.ops],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: planned once on open; a choice re-plans by itself
  useEffect(() => {
    void plan({ network: null, address: "" });
  }, []);

  useEffect(() => {
    if (configured !== undefined) {
      setCoordinator(configured);
      setSummary({ coordinatorMachine: configured });
    }
  }, [configured, setSummary]);

  const step =
    load.state === "ready" ? load.plan.steps.find((s) => s.step === "network") : undefined;
  const chosen: NetworkChoice = want.network ?? step?.network?.planned ?? "tailscale";
  const recorded =
    step?.network?.current === chosen && step.changes.length === 0 && step.blocked === undefined;

  useEffect(() => {
    if (recorded) setSummary({ network: chosen });
  }, [recorded, chosen, setSummary]);

  const pick = (w: Want) => {
    setWant(w);
    setApplying({ state: "idle" });
    void plan(w);
  };

  const finished = (r: AuthAnswer, w: Want, kind: NetworkChoice) => {
    if (!live.current) return;
    setApplying({ state: "done", report: parseSetupApplied(r) });
    setSummary({ network: kind });
    void plan(w);
  };

  const apply = async (s: SetupStepPlan) => {
    const w = { ...want, network: chosen };
    setApplying({ state: "busy" });
    const r = await requestOrFail(
      ctx.ops,
      "setup_apply",
      {
        step: "network",
        ...(s.plan_id !== undefined ? { plan_id: s.plan_id } : {}),
        ...planFields(w),
      },
      {
        timeoutMs: SETUP_APPLY_TIMEOUT_MS,
        onLate: (late) => {
          if (late.ok) finished(late, w, chosen);
          else if (live.current)
            setApplying({ state: "failed", error: late.error ?? "volleyd refused the step" });
        },
      },
    );
    if (!live.current) return;
    if (r.ok) return finished(r, w, chosen);
    if (isPlanChanged(r)) {
      setApplying({
        state: "failed",
        error:
          "The machine changed since this plan was shown, so nothing was applied. Here is the new plan: check it, then apply again",
      });
      return void plan(w);
    }
    setApplying(
      r.unanswered
        ? {
            state: "unanswered",
            error: `${r.error}: volleyd may still be applying it. Its report will show here if it arrives`,
          }
        : { state: "failed", error: r.error ?? "volleyd refused the step" },
    );
  };

  const vpnTo = vpnMachine({
    ...(summary.machine !== undefined ? { machine: summary.machine } : {}),
    ...(coordinator !== undefined ? { coordinatorMachine: coordinator } : {}),
  });

  return (
    <>
      <NetworkCard
        load={load}
        step={step}
        chosen={chosen}
        want={want}
        vpnTo={vpnTo}
        applying={applying}
        onPick={pick}
        onApply={(s) => void apply(s)}
        onRetry={() => {
          setLoad({ state: "loading" });
          void plan(want);
        }}
      />
      <section className="gs-card gs-coord" aria-labelledby="gs-coord-title">
        <h3 id="gs-coord-title" className="gs-card-title">
          Keep a Claude coordinator session running on…
        </h3>
        <p className="s-hint">
          Volley keeps a Claude Code Remote Control session alive on a machine that stays on. Open
          it from the Claude app anywhere and drive everything from the chat. A laptop sleeps and
          travels, so it is refused unless you allow it. Change it later in Settings › Machines.
        </p>
        <CoordinatorCard
          coordinatorRole={ctx.state.coordinatorRole}
          machines={ctx.state.machines ?? {}}
          hosts={Object.keys(ctx.state.config?.hosts ?? {})}
          localName={ctx.state.config?.fleet?.local_name}
          coordinator={ctx.state.config?.coordinator}
          transport={ctx.config ?? null}
          ops={ctx.ops}
          onMachine={(machine) => {
            setCoordinator(machine);
            setSummary({ coordinatorMachine: machine });
          }}
        />
      </section>
    </>
  );
}

/** The private network: the three choices, the Network step's plan for the chosen one, Apply. */
function NetworkCard({
  load,
  step,
  chosen,
  want,
  vpnTo,
  applying,
  onPick,
  onApply,
  onRetry,
}: {
  load: Load;
  step: SetupStepPlan | undefined;
  chosen: NetworkChoice;
  want: Want;
  vpnTo: string;
  applying: Applying;
  onPick: (w: Want) => void;
  onApply: (s: SetupStepPlan) => void;
  onRetry: () => void;
}) {
  const id = useId();
  const [address, setAddress] = useState(want.address);
  const commitAddress = () => {
    const v = address.trim();
    if (v !== want.address) onPick({ network: "manual", address: v });
  };

  if (load.state === "loading") {
    return (
      <div className="gs-card waiting">
        <span className="spinner" aria-hidden /> Asking volleyd how this computer is reached…
      </div>
    );
  }
  if (load.state === "failed") {
    return (
      <div className="gs-card">
        <p className="s-error" role="alert">
          {load.error}. Check that volleyd is running (`volleyd status`), then try again.
        </p>
        <div className="wiz-actions wiz-actions--inline">
          <button type="button" className="btn btn--blue" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (load.state === "unsupported" || step === undefined) {
    return (
      <div className="gs-card">
        <p>
          This volleyd cannot set up the network from the Desk yet. In a terminal on this computer,
          run <code className="mono">volley setup --network</code> with{" "}
          <code className="mono">tailscale</code>, <code className="mono">manual</code> or{" "}
          <code className="mono">none</code>: it shows the change and asks before making it.
        </p>
      </div>
    );
  }

  const report = applying.state === "done" ? applying.report : null;
  const applicable = step.changes.filter((c) => c.terminal === undefined).length;
  return (
    <section className="gs-card gs-access" aria-label="Private network">
      <div className="gs-connect" role="radiogroup" aria-label={ACCESS_QUESTION}>
        {/* The stage's heading asks the question; the card names the decision. */}
        <h3 className="gs-card-title">The private network</h3>
        {CHOICES.map((kind) => (
          <label key={kind} className={`gs-choice${kind === chosen ? " gs-choice--on" : ""}`}>
            <input
              type="radio"
              name={`${id}-network`}
              checked={kind === chosen}
              aria-describedby={`${id}-${kind}`}
              onChange={() => onPick({ network: kind, address: want.address })}
            />
            <span className="gs-choice-text">
              <b>
                {networkLabel(kind, vpnTo)}
                {kind === "tailscale" && <span className="chip gs-tag">Recommended</span>}
              </b>
              <span id={`${id}-${kind}`} className="dim">
                {NETWORK_WHAT[kind]}
              </span>
            </span>
          </label>
        ))}
      </div>

      {chosen === "tailscale" && (
        <p className="s-hint">
          On your phone, install Tailscale from the{" "}
          <a href={APP_STORE} target="_blank" rel="noreferrer noopener">
            App Store
          </a>{" "}
          or{" "}
          <a href={PLAY_STORE} target="_blank" rel="noreferrer noopener">
            Google Play
          </a>{" "}
          and sign in with the same account.
        </p>
      )}

      {chosen === "manual" && (
        <div className="gs-name">
          <label htmlFor={`${id}-address`}>This computer's address on your VPN</label>
          <input
            id={`${id}-address`}
            className="recessed mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="192.168.1.20"
            value={address}
            aria-invalid={step.blocked !== undefined}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={commitAddress}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              commitAddress();
            }}
          />
          <p className="s-hint">
            The host or IP your phone and laptop reach this computer at once the VPN is up.
          </p>
        </div>
      )}

      <PlanBody
        step={step}
        report={report}
        applying={applying}
        applicable={applicable}
        onApply={() => onApply(step)}
      />
      <p className="s-hint">Change it later in Settings › Setup &amp; Security.</p>
    </section>
  );
}

function PlanBody({
  step,
  report,
  applying,
  applicable,
  onApply,
}: {
  step: SetupStepPlan;
  report: Extract<Applying, { state: "done" }>["report"] | null;
  applying: Applying;
  applicable: number;
  onApply: () => void;
}) {
  return (
    <div className="gs-access-plan">
      {step.found.length > 0 && (
        <ul className="checks" aria-label="What setup found">
          {step.found.map((f) => (
            <li key={f} data-kind="found">
              {icon(Tick02Icon)} <span>{f}</span>
            </li>
          ))}
        </ul>
      )}
      {report !== null && <Report report={report} />}
      {step.blocked !== undefined ? (
        <p className="s-error" role="alert">
          {step.blocked}
        </p>
      ) : step.changes.length === 0 ? (
        report === null && (
          <p className="ok-line">{icon(Tick02Icon)} Already set up: nothing to change.</p>
        )
      ) : (
        <>
          <p>What this will change (nothing changes until you apply it):</p>
          <ul className="checks">
            {step.changes.map((c) => (
              <ChangeItem key={c.summary} c={c} />
            ))}
          </ul>
          {(applying.state === "failed" || applying.state === "unanswered") && (
            <p className="s-error" role="alert">
              {applying.error}
            </p>
          )}
          {applicable > 0 && (
            <div className="wiz-actions wiz-actions--inline">
              <button
                type="button"
                className="btn btn--hot"
                disabled={applying.state === "busy"}
                onClick={onApply}
              >
                {applying.state === "busy" ? "Applying…" : "Apply this change"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The applied step's report; a Tailscale sign-in line is a link and a QR for the phone. */
function Report({ report }: { report: Extract<Applying, { state: "done" }>["report"] }) {
  return (
    <div className="gs-access-report">
      <p className="ok-line">
        {icon(Tick02Icon)} Applied.{" "}
        {report.problems.length === 0 ? "Checked afterwards: all good." : ""}
      </p>
      {report.lines.length > 0 && (
        <ul className="checks">
          {report.lines.map((l) => {
            const url = tailscaleSignIn(l);
            return url === null ? (
              <li key={l}>
                {icon(Tick02Icon)} <span>{l}</span>
              </li>
            ) : (
              <li key={l} className="gs-signin">
                <span>
                  Sign in to Tailscale:{" "}
                  <a href={url} target="_blank" rel="noreferrer noopener">
                    {url}
                  </a>
                </span>
                <span className="gs-signin-qr">
                  <Qr text={url} size={120} label="QR code to sign in to Tailscale" />
                  <span className="s-hint">
                    Scan it with your phone to sign this computer in to your tailnet.
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {report.problems.length > 0 && (
        <div className="s-error" role="alert">
          After the change, setup found:
          <ul>
            {report.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {report.terminal.length > 0 && (
        <div className="s-note">
          Left for a terminal on this computer:
          <ul className="checks">
            {report.terminal.map((t) => (
              <li key={t.summary}>
                <span>
                  {t.summary}: {t.reason}
                  <CopyText text={t.command} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
