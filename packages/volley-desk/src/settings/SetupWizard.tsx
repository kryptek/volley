/**
 * The Desk's setup wizard, ported from the prototype `SetupWizard` (React Bits
 * Stepper). It is `volley setup` (O3) seen from a browser, not a second flow:
 * the same five steps (Broker → Security → Accounts → Services → Phone), each
 * planned by volleyd (`setup_plan`: what it found, what it would change) and
 * shown before anything changes. A step changes nothing until the person
 * presses Apply (`setup_apply { step }`); the plan is read again afterwards,
 * since each step's plan depends on the ones before it. Security asks the LAN
 * question first, in setup's words, recommending yes. Accounts can issue the
 * one-time admin token, which the wizard shows once (it is gone when the step
 * is left). Phone ends on a QR code of a one-time steer sign-in link
 * (`signin_link`, label "Desk on phone", as setup's phone step makes it).
 *
 * A volleyd that does not run setup answers `unknown op`: the wizard says to
 * run `volley setup` in a terminal and still offers the phone link. Every
 * error says what to do next; nothing dead-ends.
 */
import { Alert02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { plural } from "../lib/plural";
import Stepper, { Step } from "../rb/Stepper/Stepper";
import {
  type AuthOps,
  PHONE_LABEL,
  type SetupApplied,
  type SetupPlan,
  type SetupStepName,
  type SetupStepPlan,
  isUnknownOp,
  parseSetupApplied,
  parseSetupPlan,
  signinLink,
} from "../store/control";
import { CopyText, Once, Qr } from "./onboardingParts";
import { Seg } from "./primitives";

const ACCENT = "#6ee7f9";

/** The wizard's steps: setup's own, with the titles the terminal prints. */
const STEPS: readonly { step: SetupStepName; title: string; description: string }[] = [
  { step: "detect", title: "Broker", description: "Find it" },
  { step: "security", title: "Security", description: "Accounts on" },
  { step: "accounts", title: "Accounts", description: "Identities" },
  { step: "services", title: "Services", description: "Supervisor, Desk" },
  { step: "phone", title: "Phone", description: "Open the Desk" },
];

/** `volley setup`'s LAN question (O3 `LAN_QUESTION`), split into the question and its caveat. */
export const LAN_QUESTION =
  "Let your phone and other devices on this network reach the broker's WebSocket listener (port 9001), so the Desk works from your phone?";
const LAN_CAVEAT =
  "Every device still has to sign in, but the traffic is not encrypted until TLS is set up, so say yes only on a network you trust (home, not a café).";

/** How long a sign-in link lives (setup's phone step: 10 minutes). */
const LINK_TTL_S = 600;

const icon = (i: typeof Tick02Icon) => <HugeiconsIcon icon={i} size={12} strokeWidth={1.8} />;

type Load =
  | { state: "loading" }
  | { state: "ready"; plan: SetupPlan }
  | { state: "unsupported" }
  | { state: "failed"; error: string };

type Applying =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "done"; report: SetupApplied }
  | { state: "failed"; error: string };

export interface SetupWizardProps {
  /** The admin channel (`createAuthOps`). */
  ops: AuthOps;
  /** This Desk's URL without a fragment: what a phone link opens. */
  deskUrl: string;
  onClose: () => void;
}

export function SetupWizard({ ops, deskUrl, onClose }: SetupWizardProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [current, setCurrent] = useState(1);
  /** Per step: the last apply, while the person is on that step. */
  const [applying, setApplying] = useState<Applying>({ state: "idle" });
  /** Whether the one-time admin token was shown this run (it is never shown again). */
  const [tokenShown, setTokenShown] = useState(false);
  const [lan, setLan] = useState(true);

  const plan = useCallback(async () => {
    const r = await ops.request("setup_plan");
    if (isUnknownOp(r)) return setLoad({ state: "unsupported" });
    const parsed = r.ok ? parseSetupPlan(r.result) : null;
    if (parsed === null) {
      return setLoad({ state: "failed", error: r.error ?? "volleyd's plan could not be read" });
    }
    setLoad({ state: "ready", plan: parsed });
  }, [ops]);

  useEffect(() => {
    void plan();
  }, [plan]);

  const go = (n: number) => {
    setApplying({ state: "idle" });
    setCurrent(n);
  };

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
              void plan();
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
        <CopyText text="volley setup" />
        <PhoneStep ops={ops} deskUrl={deskUrl} plan={undefined} onDone={onClose} />
      </Shell>
    );
  }

  const steps = load.plan.steps;
  const at = STEPS[current - 1] as (typeof STEPS)[number];
  const stepPlan = steps.find((s) => s.step === at.step);
  const blockedBefore = steps.find(
    (s) => s.blocked !== undefined && STEPS.findIndex((x) => x.step === s.step) < current - 1,
  );
  const apply = async (s: SetupStepPlan) => {
    setApplying({ state: "busy" });
    const r = await ops.request("setup_apply", {
      step: s.step,
      ...(s.step === "security" ? { lan } : {}),
    });
    if (!r.ok) {
      setApplying({
        state: "failed",
        error: r.unanswered
          ? `${r.error}: volleyd may still be applying it. Wait a moment, then check again.`
          : (r.error ?? "volleyd refused the step"),
      });
      return;
    }
    const report = parseSetupApplied(r);
    if (report.token !== undefined) setTokenShown(true);
    setApplying({ state: "done", report });
    // Each step's plan depends on the ones before it.
    void plan();
  };

  return (
    <Shell onClose={onClose}>
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
      >
        {STEPS.map((s) => (
          <Step key={s.step} title={s.title} description={s.description}>
            {s.step === at.step &&
              (s.step === "phone" ? (
                <PhoneStep
                  ops={ops}
                  deskUrl={deskUrl}
                  plan={stepPlan}
                  onBack={() => go(current - 1)}
                  onDone={onClose}
                />
              ) : blockedBefore !== undefined ? (
                <p className="s-error" role="alert">
                  {blockedBefore.title} is blocked, so this step cannot run yet. Go back and fix it
                  first.
                </p>
              ) : stepPlan === undefined ? (
                <p className="dim">volleyd did not plan this step.</p>
              ) : (
                <PlanStep
                  plan={stepPlan}
                  applying={applying}
                  tokenShown={tokenShown}
                  lan={lan}
                  onLan={setLan}
                  onApply={() => void apply(stepPlan)}
                  onRecheck={() => void plan()}
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

function Shell({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled region inside the Settings dialog
    <div className="wiz-stepper" role="group" aria-label="Set up Volley">
      <div className="wiz-head">
        <h3>Set up Volley</h3>
        <button type="button" className="btn btn--sm" onClick={onClose} aria-label="Close setup">
          Close
        </button>
      </div>
      {children}
    </div>
  );
}

function PlanStep({
  plan,
  applying,
  tokenShown,
  lan,
  onLan,
  onApply,
  onRecheck,
}: {
  plan: SetupStepPlan;
  applying: Applying;
  tokenShown: boolean;
  lan: boolean;
  onLan: (on: boolean) => void;
  onApply: () => void;
  onRecheck: () => void;
}) {
  const n = plan.changes.length;
  const report = applying.state === "done" ? applying.report : null;
  return (
    <>
      <h3>{plan.title}</h3>
      {plan.found.length > 0 && (
        <ul className="checks">
          {plan.found.map((f) => (
            <li key={f}>
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
      ) : n === 0 ? (
        <p className="ok-line">{icon(Tick02Icon)} Already done: nothing to change.</p>
      ) : (
        <>
          <p>What this step will change (nothing changes until you apply it):</p>
          <ul className="checks">
            {plan.changes.map((c) => (
              <li key={c.summary}>
                {icon(Alert02Icon)}
                <span>
                  {c.summary}
                  {c.detail !== undefined && (
                    <details>
                      <summary>Details</summary>
                      <pre className="mono wiz-detail">{c.detail}</pre>
                    </details>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {plan.step === "security" && (
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
            </div>
          )}
          {applying.state === "failed" && (
            <p className="s-error" role="alert">
              {applying.error}
            </p>
          )}
          <div className="wiz-actions wiz-actions--inline">
            <button
              type="button"
              className="btn btn--hot"
              disabled={applying.state === "busy"}
              onClick={onApply}
            >
              {applying.state === "busy"
                ? "Applying…"
                : n === 1
                  ? "Apply this change"
                  : `Apply ${plural(n, "change")}`}
            </button>
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

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

type Link =
  | { state: "idle" }
  | { state: "busy" }
  | { state: "ready"; link: string; expiresAt: string | null }
  | { state: "failed"; error: string };

/** The last step: a one-time steer sign-in link for a phone, as a QR code. */
function PhoneStep({
  ops,
  deskUrl,
  plan,
  onBack,
  onDone,
}: {
  ops: AuthOps;
  deskUrl: string;
  plan: SetupStepPlan | undefined;
  onBack?: () => void;
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
  return (
    <>
      <h3>Open the Desk on your phone</h3>
      {plan?.found.map((f) => (
        <p key={f} className="dim">
          {f}
        </p>
      ))}
      {plan?.skipped !== undefined && <p className="dim">Skipped: {plan.skipped}</p>}
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
          {loopback && (
            <p className="s-error" role="alert">
              This Desk is open at {host}, which a phone cannot reach. Open the Desk at this
              machine's network address (the one `volley setup` printed, port 5199) and make the
              link there.
            </p>
          )}
          {link.state === "failed" && (
            <p className="s-error" role="alert">
              {link.error}. Try again, or run `volley auth signin-link --role steer --label "
              {PHONE_LABEL}"` in a terminal.
            </p>
          )}
          <div className="wiz-actions wiz-actions--inline">
            <button
              type="button"
              className="btn btn--hot"
              disabled={link.state === "busy" || loopback}
              onClick={() => void make()}
            >
              {link.state === "busy" ? "Making the link…" : "Make the phone link"}
            </button>
          </div>
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
