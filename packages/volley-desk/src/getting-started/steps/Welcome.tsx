/** Getting started › Welcome: what the next five steps set up, and a way out for now. */
import type { StepProps } from "../steps";

const SET_UP: readonly [string, string][] = [
  ["This computer", "Check what runs here and fix what is missing"],
  ["Your machines", "Pair the other computers agents can run on"],
  ["Repos", "Sign in to GitHub and pick your projects"],
  ["People", "Give the people who steer their own sign-in"],
  ["Access", "Reach the Desk from your phone and away from home"],
];

export function Welcome({ onSkip }: StepProps) {
  return (
    <>
      <div className="gs-card">
        <h3 className="gs-card-title" id="gs-set-up">
          You'll set up
        </h3>
        <ol className="gs-set-up" aria-labelledby="gs-set-up">
          {SET_UP.map(([title, what], i) => (
            <li key={title}>
              <span className="gs-badge" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <b>{title}</b> <span className="dim">{what}</span>
              </span>
            </li>
          ))}
        </ol>
      </div>
      {onSkip && (
        <button type="button" className="gs-link" onClick={onSkip}>
          Skip for now
        </button>
      )}
    </>
  );
}
