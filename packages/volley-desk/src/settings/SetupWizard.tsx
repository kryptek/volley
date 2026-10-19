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
 * of Apply. Accounts can issue the one-time admin token, shown once (it is
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
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useFocusTrap } from "../a11y/keys";
import { plural } from "../lib/plural";
import Stepper, { Step } from "../rb/Stepper/Stepper";
import {
  type AuthAnswer,
  type AuthOps,
  PHONE_LABEL,
  SETUP_APPLY_TIMEOUT_MS,
  type SetupApplied,
  type SetupPlan,
  type SetupStepName,
  type SetupStepPlan,
  isPlanChanged,
  isUnknownOp,
  listenerProbes,
  parseSetupApplied,
  parseSetupPlan,
  signinLink,
} from "../store/control";
import { Clawd } from "../windows/wave/Clawd";
import { CopyText, Once, Qr } from "./onboardingParts";
import { Seg } from "./primitives";

const ACCENT = "#6ee7f9";

/** The wizard's steps: setup's own, with the prototype's titles and subtitles. */
const STEPS: readonly { step: SetupStepName; title: string; description: string }[] = [
  { step: "detect", title: "Broker", description: "Found" },
  { step: "security", title: "Security", description: "Accounts on" },
  { step: "accounts", title: "Accounts", description: "Created" },
  { step: "services", title: "Services", description: "Installed" },
  { step: "phone", title: "Phone", description: "Open the desk" },
];

/** `volley setup`'s LAN question (O3 `LAN_QUESTION`), split into the question and its caveat. */
export const LAN_QUESTION =
  "Let your phone and other devices on this network reach the broker's WebSocket listener (port 9001), so the Desk works from your phone?";
const LAN_CAVEAT =
  "Every device still has to sign in, but the traffic is not encrypted until TLS is set up, so say yes only on a network you trust (home, not a café).";

/** How long a sign-in link lives (setup's phone step: 10 minutes). */
const LINK_TTL_S = 600;
/** While the broker restarts: how often, and how many times, the wizard asks for the plan again. */
const RECONNECT_EVERY_MS = 2000;
const RECONNECT_TRIES = 30;

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
  /** No answer in time: volleyd may still be applying it (a late answer still lands). */
  | { state: "unanswered"; error: string }
  | { state: "failed"; error: string };

export interface SetupWizardProps {
  /** The admin channel (`createAuthOps`). */
  ops: AuthOps;
  /** This Desk's URL without a fragment: what a phone link opens. */
  deskUrl: string;
  /** "Run setup again": `volley setup --repair` (no new admin token, no phone link). */
  repair?: boolean;
  onClose: () => void;
}

type Fetched = { plan: SetupPlan } | { unsupported: true } | { error: string };

export function SetupWizard({ ops, deskUrl, repair = false, onClose }: SetupWizardProps) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [current, setCurrent] = useState(1);
  /** Per step: the last apply, while the person is on that step. */
  const [applying, setApplying] = useState<Applying>({ state: "idle" });
  /** Whether the one-time admin token was shown this run (it is never shown again). */
  const [tokenShown, setTokenShown] = useState(false);
  /** The person's LAN answer; `null` until they pick one (the plan's own choice stands). */
  const [lan, setLan] = useState<boolean | null>(null);
  /** The broker restarts after an apply: asking for the plan until it answers. */
  const [reconnecting, setReconnecting] = useState(false);
  /** A new plan for another LAN answer is on its way. */
  const [replanning, setReplanning] = useState(false);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const fetchPlan = useCallback(
    async (lanChoice: boolean | null): Promise<Fetched> => {
      const r = await ops.request("setup_plan", {
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

  const go = (n: number) => {
    setApplying({ state: "idle" });
    setCurrent(n);
  };

  const steps = load.state === "ready" ? load.plan.steps : [];
  const at = STEPS[current - 1] as (typeof STEPS)[number];
  const stepPlan = steps.find((s) => s.step === at.step);
  const blockedBefore = steps.find(
    (s) => s.blocked !== undefined && STEPS.findIndex((x) => x.step === s.step) < current - 1,
  );

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
    const r = await ops.request(
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

const describeProbe = (p: "refused" | "accepted" | "unreachable") =>
  p === "refused" ? "refuses anonymous" : p === "accepted" ? "open to anonymous" : "not listening";

/** Step 1, as the prototype draws it: Broker / Listening / Agents on it now, and the promise. */
function DetectStep({
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

function ChangeItem({ c }: { c: SetupStepPlan["changes"][number] }) {
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

function PlanStep({
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
      {plan.found.length > 0 && (
        <ul className="checks">
          {plan.found.map((f) => (
            <li key={f}>
              {icon(Tick02Icon)} <span>{f}</span>
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
            <button
              type="button"
              className="btn btn--hot"
              disabled={applying.state === "busy" || replanning || n === 0}
              onClick={onApply}
            >
              {applying.state === "busy"
                ? "Applying…"
                : n === 1
                  ? "Apply this change"
                  : n === 0
                    ? "Apply"
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
  const label = another ? "Make another link" : "Make the phone link";
  return (
    <>
      <h3>Open the Desk on your phone</h3>
      {plan?.found.map((f) => (
        <p key={f} className="dim">
          {f}
        </p>
      ))}
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
