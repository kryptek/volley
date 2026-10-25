/**
 * Getting started, the Desk's first-launch wizard: `volley setup` seen from a browser. Its own
 * dialog over the Desk, a step rail on the left (one row of badges on a phone) and the stage on
 * the right: the step's eyebrow, heading and lede beside its otter raft scene (`StepArt`), the
 * step's body from the registry (`steps.ts`), and Back / Continue. The rail jumps to any step
 * already reached. X and Escape pause it at the current step; Skip for now stops it reopening;
 * Open the Desk on the last step finishes it. What the steps do lives in `steps/`.
 */
import "../styles/getting-started.css";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../a11y/keys";
import { StepArt } from "./art";
import type { SceneId } from "./art/ids";
import type { Summary } from "./state";
import { STEPS, type WizardContext } from "./steps";

/** The steps between Welcome and Done are numbered "Step n of 6" (Done is the sixth). */
const NUMBERED = STEPS.length - 1;

export interface GettingStartedProps {
  ctx: WizardContext;
  /** The step it opens at (the one stored when it was last closed). */
  initial: SceneId;
  summary: Summary;
  /** The person moved to `step`. */
  onStep?(step: SceneId): void;
  setSummary(patch: Partial<Summary>): void;
  /** X or Escape: pause at `step`. */
  onClose(step: SceneId): void;
  onSkip(): void;
  /** Open the Desk on the last step. */
  onFinish(): void;
}

const indexOf = (id: SceneId) =>
  Math.max(
    0,
    STEPS.findIndex((s) => s.id === id),
  );

export function GettingStarted(p: GettingStartedProps) {
  const [cur, setCur] = useState(() => indexOf(p.initial));
  /** The furthest step reached: the rail jumps to any step up to it. */
  const [reached, setReached] = useState(cur);
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

  const step = STEPS[cur] ?? STEPS[0];
  if (!step) return null;
  const go = (i: number) => {
    const next = STEPS[i];
    if (!next) return;
    setCur(i);
    setReached((r) => Math.max(r, i));
    p.onStep?.(next.id);
  };
  const close = () => p.onClose(step.id);
  const last = cur === STEPS.length - 1;
  const { Body } = step;

  return (
    <div className="modal-scrim gs-scrim">
      <div
        ref={dialog}
        className="gs win-depth"
        // biome-ignore lint/a11y/useSemanticElements: the Desk's modal markup (scrim + div), as SetupWizard
        role="dialog"
        aria-modal="true"
        aria-label="Getting started"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Claimed, so the Desk's window-level Escape doesn't close the next dialog down too.
          e.preventDefault();
          close();
        }}
      >
        <aside className="gs-side">
          <p className="gs-brand">Getting started</p>
          <nav className="gs-rail" aria-label="Setup steps">
            <ol>
              {STEPS.map((s, i) => {
                const now = i === cur;
                const done = i < reached && !now;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={`gs-rail-step${now ? " gs-rail-step--now" : ""}`}
                      aria-current={now ? "step" : undefined}
                      disabled={i > reached}
                      onClick={() => go(i)}
                    >
                      <span
                        className={`gs-badge${now ? " gs-badge--now" : ""}${done ? " gs-badge--done" : ""}`}
                        aria-hidden="true"
                      >
                        {done ? (
                          <HugeiconsIcon icon={Tick02Icon} size={13} strokeWidth={2.2} />
                        ) : (
                          i + 1
                        )}
                      </span>
                      <span className="gs-rail-text">
                        <span className="gs-rail-title">{s.title}</span>
                        <span className="gs-rail-sub">{s.subtitle}</span>
                        {done && <span className="sr-only"> (done)</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="gs-side-foot">
            <button type="button" className="gs-link" onClick={p.onSkip}>
              Skip for now
            </button>
          </div>
        </aside>

        <section className="gs-stage">
          <button
            type="button"
            className="icon-btn gs-close"
            onClick={close}
            aria-label="Close Getting started"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={15} strokeWidth={1.8} />
          </button>
          <div className="gs-hero">
            <div className="gs-copy">
              <p className="gs-eyebrow">
                {cur === 0 ? "Getting started" : `Step ${cur} of ${NUMBERED}`}
              </p>
              <h2 className="gs-heading">{step.heading}</h2>
              <p className="gs-lede">{step.lede}</p>
            </div>
            <StepArt scene={step.id} className="gs-hero-art" />
          </div>
          <div className="gs-body">
            <Body
              ctx={p.ctx}
              summary={p.summary}
              setSummary={p.setSummary}
              onContinue={() => go(cur + 1)}
              {...(cur === 0 ? { onSkip: p.onSkip } : {})}
            />
          </div>
          <footer className="gs-foot">
            <p className="gs-note">
              Each step shows what it will change before you apply it. Run again any time from
              Settings › Getting started.
            </p>
            <div className="gs-actions">
              {cur > 0 && (
                <button type="button" className="btn" onClick={() => go(cur - 1)}>
                  Back
                </button>
              )}
              <button
                type="button"
                className="btn btn--blue"
                onClick={last ? p.onFinish : () => go(cur + 1)}
              >
                {cur === 0 ? "Let's go" : last ? "Open the Desk" : "Continue"}
              </button>
            </div>
          </footer>
        </section>
        <span className="win-edge" aria-hidden="true" />
      </div>
    </div>
  );
}
