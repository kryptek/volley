/**
 * The Desk's setup wizard, ported from the prototype `SetupWizard` (React Bits
 * Stepper in its own wide modal: "Set up Volley" with Clawd, an X button,
 * Escape and a scrim click close it). It is `volley setup` (O3) seen from a
 * browser, not a second flow: the same five steps (Broker → Security →
 * Accounts → Services → Phone), each planned by volleyd (`setup_plan`: what
 * it found, what it would change) and shown before anything changes. A step
 * changes nothing until the person presses Apply, and Apply applies exactly
 * the plan on screen (`setup_apply { step, plan_id }`: volleyd refuses a plan
 * that changed since, and the wizard shows the new one). The plan is read
 * again afterwards, since each step's plan depends on the ones before it.
 *
 * Security asks the LAN question above its changes, in setup's words,
 * starting from the choice volleyd planned for; another answer asks for the
 * plan again with `lan`, so the diff shown is the diff applied (and a broker
 * with nothing to change can still be opened to the LAN). A change only a
 * terminal can make (`terminal`) shows why and the command, and is never part
 * of Apply, and a step whose changes are all a terminal's has no Apply at all.
 * What volleyd cannot check (the macOS keychain) is a neutral note, neither a
 * check that passed nor a warning. Accounts can issue the one-time admin token, shown once (it is
 * gone when the step is left). Applying waits up to `SETUP_APPLY_TIMEOUT_MS`
 * and still takes a late answer (its token included); a broker restart shows
 * "reconnecting" until the plan answers again. Phone ends on a QR code of a
 * one-time steer sign-in link (`signin_link`, label "Desk on phone", as
 * setup's phone step makes it), never on a page a phone could not reach.
 * `repair` ("Run setup again") is `volley setup --repair`.
 *
 * A volleyd that does not run setup answers `unknown op`: the wizard says to
 * run `volley setup` in a terminal and still offers the phone link. Every
 * error says what to do next; nothing dead-ends.
 */
import { Alert02Icon, Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../a11y/keys";
import Stepper, { Step } from "../rb/Stepper/Stepper";
import {
  type AuthOps,
  PHONE_LABEL,
  SETUP_STEPS,
  type SetupStepName,
  type SetupStepPlan,
  signinLink,
} from "../store/control";
import { Clawd } from "../windows/wave/Clawd";
import { CopyText, Qr } from "./onboardingParts";
import { DetectStep, PlanStep, useSetupPlan } from "./setupPlanParts";

export { LAN_QUESTION } from "./setupPlanParts";

const ACCENT = "#6ee7f9";

/** The wizard's steps: setup's own, with the prototype's titles and subtitles. */
const STEPS: readonly { step: SetupStepName; title: string; description: string }[] = [
  { step: "detect", title: "Broker", description: "Found" },
  { step: "security", title: "Security", description: "Accounts on" },
  { step: "accounts", title: "Accounts", description: "Created" },
  { step: "services", title: "Services", description: "Installed" },
  { step: "phone", title: "Phone", description: "Open the desk" },
];

/** How long a sign-in link lives (setup's phone step: 10 minutes). */
const LINK_TTL_S = 600;

export interface SetupWizardProps {
  /** The admin channel (`createAuthOps`). */
  ops: AuthOps;
  /** This Desk's URL without a fragment: what a phone link opens. */
  deskUrl: string;
  /** "Run setup again": `volley setup --repair` (no new admin token, no phone link). */
  repair?: boolean;
  onClose: () => void;
}

export function SetupWizard({ ops, deskUrl, repair = false, onClose }: SetupWizardProps) {
  const {
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
  } = useSetupPlan(ops, repair);
  const [current, setCurrent] = useState(1);

  const go = (n: number) => {
    setApplying({ state: "idle" });
    setCurrent(n);
  };

  const steps = load.state === "ready" ? load.plan.steps : [];
  const at = STEPS[current - 1] as (typeof STEPS)[number];
  const stepPlan = steps.find((s) => s.step === at.step);
  /** A step left behind with changes only a terminal can make is not done: it asks for attention. */
  const needsTerminal = (n: number) =>
    steps
      .find((s) => s.step === STEPS[n - 1]?.step)
      ?.changes.some((c) => c.terminal !== undefined) === true;
  // In setup's own order: a step volleyd plans that this wizard does not show (network) still
  // blocks the later ones.
  const blockedBefore = steps.find(
    (s) => s.blocked !== undefined && SETUP_STEPS.indexOf(s.step) < SETUP_STEPS.indexOf(at.step),
  );

  if (load.state === "loading") {
    return (
      <Shell onClose={onClose}>
        <div className="waiting">
          <span className="spinner" aria-hidden /> Asking volleyd what setup would do…
        </div>
      </Shell>
    );
  }
  if (load.state === "failed") {
    return (
      <Shell onClose={onClose}>
        <p className="s-error" role="alert">
          {load.error}. Check that volleyd is running (`volleyd status`), then try again.
        </p>
        <div className="wiz-actions">
          <button
            type="button"
            className="btn btn--blue"
            onClick={() => {
              setLoad({ state: "loading" });
              void plan(lan);
            }}
          >
            Try again
          </button>
        </div>
      </Shell>
    );
  }
  if (load.state === "unsupported") {
    return (
      <Shell onClose={onClose}>
        <h3>Run setup in a terminal</h3>
        <p>
          This volleyd cannot run setup from the Desk yet. Run it in a terminal on the supervisor's
          machine: it shows each step and asks before changing anything.
        </p>
        <CopyText text={repair ? "volley setup --repair" : "volley setup"} />
        <PhoneStep ops={ops} deskUrl={deskUrl} plan={undefined} repair={repair} onDone={onClose} />
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose}>
      {reconnecting && (
        <output className="s-note wiz-reconnecting">
          <span className="spinner" aria-hidden /> The broker is restarting; reconnecting…
        </output>
      )}
      <Stepper
        theme="dark"
        accentColor={ACCENT}
        indicator="numbers"
        transition="slide"
        linear
        frame={false}
        width="100%"
        step={current}
        disableStepIndicators
        showFooter={false}
        renderStepIndicator={({ step: n, currentStep }) => (
          <StepBadge
            n={n}
            title={STEPS[n - 1]?.title ?? ""}
            status={
              n === currentStep
                ? "active"
                : n > currentStep
                  ? "upcoming"
                  : needsTerminal(n)
                    ? "attention"
                    : "complete"
            }
          />
        )}
      >
        {STEPS.map((s) => (
          <Step key={s.step} title={s.title} description={s.description}>
            {s.step === at.step &&
              (s.step === "phone" ? (
                <PhoneStep
                  ops={ops}
                  deskUrl={deskUrl}
                  plan={stepPlan}
                  repair={repair}
                  onBack={() => go(current - 1)}
                  onSecurity={() => go(2)}
                  onDone={onClose}
                />
              ) : blockedBefore !== undefined ? (
                <p className="s-error" role="alert">
                  {blockedBefore.title} is blocked, so this step cannot run yet. Go back and fix it
                  first.
                </p>
              ) : stepPlan === undefined ? (
                <p className="dim">volleyd did not plan this step.</p>
              ) : s.step === "detect" ? (
                <DetectStep plan={stepPlan} all={load.plan} onRecheck={() => void plan(lan)} />
              ) : (
                <PlanStep
                  plan={stepPlan}
                  applying={applying}
                  tokenShown={tokenShown}
                  lan={lan ?? stepPlan.lan?.planned ?? null}
                  replanning={replanning}
                  onLan={(on) => void pickLan(on)}
                  onApply={() => void apply(stepPlan)}
                  onRecheck={() => {
                    setApplying({ state: "idle" });
                    void plan(lan);
                  }}
                />
              ))}
          </Step>
        ))}
      </Stepper>
      {at.step !== "phone" && (
        <div className="wiz-actions">
          {current > 1 && (
            <button type="button" className="btn" onClick={() => go(current - 1)}>
              Back
            </button>
          )}
          <button
            type="button"
            className="btn btn--blue"
            disabled={applying.state === "busy" || stepPlan?.blocked !== undefined}
            onClick={() => go(current + 1)}
          >
            Continue
          </button>
        </div>
      )}
    </Shell>
  );
}

type BadgeStatus = "complete" | "attention" | "active" | "upcoming";

/** The Stepper's own badge, plus `attention`: a step passed with a terminal's work still to do. */
function StepBadge({ n, title, status }: { n: number; title: string; status: BadgeStatus }) {
  return (
    <span
      className="stepper__badge"
      data-status={status}
      role="img"
      aria-label={`Step ${n}: ${title}${status === "attention" ? ", needs a terminal" : ""}`}
      aria-current={status === "active" ? "step" : undefined}
    >
      {status === "complete" ? (
        <span className="stepper__check">
          <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2.4} />
        </span>
      ) : status === "attention" ? (
        <span className="stepper__glyph">
          <HugeiconsIcon icon={Alert02Icon} size={14} strokeWidth={2} />
        </span>
      ) : (
        n
      )}
    </span>
  );
}

/** The prototype's `Modal` (wide): its own dialog over the Desk, closed by X, Escape or the scrim. */
function Shell({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  useFocusTrap(dialog);
  // Focus moves into the dialog so Escape works at once; it goes back on close.
  useEffect(() => {
    const opener = document.activeElement;
    dialog.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialog}
        className="modal modal--wide win-depth"
        // biome-ignore lint/a11y/useSemanticElements: the prototype's modal markup and CSS (scrim + div)
        role="dialog"
        aria-modal="true"
        aria-label="Set up Volley"
        tabIndex={-1}
        style={{ "--acc": ACCENT } as CSSProperties}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Claimed, so the Desk's window-level Escape doesn't close the next dialog down too.
          e.preventDefault();
          onClose();
        }}
      >
        <div className="modal-head">
          <Clawd /> <span className="t-name">Set up Volley</span>
          <button
            type="button"
            className="icon-btn"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label="Close setup"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} />
          </button>
        </div>
        <div className="wiz-stepper">{children}</div>
        <span className="win-edge" aria-hidden="true" />
      </div>
    </div>
  );
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

type Link =
  | { state: "idle" }
  | { state: "confirm" }
  | { state: "busy" }
  | { state: "ready"; link: string; expiresAt: string | null }
  | { state: "failed"; error: string };

/** The last step: a one-time steer sign-in link for a phone, as a QR code. */
function PhoneStep({
  ops,
  deskUrl,
  plan,
  repair,
  onBack,
  onSecurity,
  onDone,
}: {
  ops: AuthOps;
  deskUrl: string;
  plan: SetupStepPlan | undefined;
  repair: boolean;
  onBack?: () => void;
  /** Back to the Security step (its LAN question). */
  onSecurity?: () => void;
  onDone: () => void;
}) {
  const [link, setLink] = useState<Link>({ state: "idle" });
  let host = "";
  try {
    host = new URL(deskUrl).hostname;
  } catch {
    // An unparsable URL: volleyd refuses it with a reason.
  }
  const loopback = LOOPBACK.test(host);
  /** A phone could not reach the broker from here (LAN access off): a link would be wasted. */
  const unreachable = plan?.skipped !== undefined;
  /** setup found a pending link or a signed-in phone: another link is a deliberate choice. */
  const another = plan !== undefined && !repair && !unreachable && plan.changes.length === 0;
  const make = async () => {
    setLink({ state: "busy" });
    const r = await ops.request("signin_link", {
      role: "steer",
      label: PHONE_LABEL,
      desk_url: deskUrl,
    });
    const base = (r.result as { link_base?: unknown } | undefined)?.link_base;
    const token = r.secret?.token;
    if (!r.ok || typeof base !== "string" || typeof token !== "string") {
      setLink({ state: "failed", error: r.error ?? "volleyd's answer carried no link" });
      return;
    }
    const expires = (r.result as { expires_at?: unknown }).expires_at;
    setLink({
      state: "ready",
      link: signinLink(base, token),
      expiresAt: typeof expires === "string" ? expires : null,
    });
  };
  const label = another
    ? "Make another link"
    : repair
      ? "Make a phone link"
      : "Make the phone link";
  return (
    <>
      <h3>Open the Desk on your phone</h3>
      {repair ? (
        // setup's own line says the step is skipped under --repair: true of the terminal's run,
        // not beside a button that makes the link.
        <p className="dim">
          Run setup again checks and fixes; it makes no phone link by itself. If your phone needs
          one, make it here.
        </p>
      ) : (
        plan?.found.map((f) => (
          <p key={f} className="dim">
            {f}
          </p>
        ))
      )}
      {link.state === "ready" ? (
        <div className="pair-grid">
          <Qr text={link.link} label="QR code of the phone sign-in link" />
          <div>
            <p>
              Scan to open the Desk signed in as <b>{PHONE_LABEL}</b> (can steer). The link works
              once and expires in {LINK_TTL_S / 60} minutes; only its hash is stored.
            </p>
            <CopyText text={link.link} label="Copy link" />
          </div>
        </div>
      ) : (
        <>
          <p>
            A one-time link signs your phone in as <b>{PHONE_LABEL}</b> (can steer) without typing a
            password. It works once and expires in {LINK_TTL_S / 60} minutes.
          </p>
          {unreachable ? (
            <div className="s-error" role="alert">
              <p>A phone cannot sign in yet: {plan?.skipped}</p>
              <p>
                Go back to Security and answer Yes to the LAN question, apply it, then make the link
                here.
              </p>
              {onSecurity && (
                <button type="button" className="btn" onClick={onSecurity}>
                  Back to Security
                </button>
              )}
            </div>
          ) : (
            loopback && (
              <p className="s-error" role="alert">
                This Desk is open at {host}, which a phone cannot reach. Open the Desk at this
                machine's network address (the one `volley setup` printed, port 5199) and make the
                link there.
              </p>
            )
          )}
          {link.state === "failed" && (
            <p className="s-error" role="alert">
              {link.error}. Try again, or run `volley auth signin-link --role steer --label "
              {PHONE_LABEL}"` in a terminal.
            </p>
          )}
          {link.state === "confirm" ? (
            <div className="s-note">
              <p>
                Your phone already has a link waiting or is signed in. Another link is another
                single-use sign-in; the earlier one keeps working until it is used or expires.
              </p>
              <div className="wiz-actions wiz-actions--inline">
                <button type="button" className="btn btn--hot" onClick={() => void make()}>
                  Make another link
                </button>
                <button type="button" className="btn" onClick={() => setLink({ state: "idle" })}>
                  Keep the one I have
                </button>
              </div>
            </div>
          ) : (
            <div className="wiz-actions wiz-actions--inline">
              <button
                type="button"
                className="btn btn--hot"
                disabled={link.state === "busy" || loopback || unreachable}
                onClick={() => (another ? setLink({ state: "confirm" }) : void make())}
              >
                {link.state === "busy" ? "Making the link…" : label}
              </button>
            </div>
          )}
        </>
      )}
      <div className="wiz-actions">
        {onBack && (
          <button type="button" className="btn" onClick={onBack}>
            Back
          </button>
        )}
        <button type="button" className="btn btn--blue" onClick={onDone}>
          Done
        </button>
      </div>
    </>
  );
}
