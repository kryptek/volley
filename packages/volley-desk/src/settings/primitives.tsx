/**
 * The Settings window's building blocks, ported from the prototype
 * `settings.tsx`: `Group` (a titled card of rows with an optional footnote),
 * `Row` (label and hint on the left, the control on the right), `Seg` (a
 * segmented control: a labelled group of pressed / unpressed buttons) and
 * `Toggle` (an iOS-style switch).
 */
import type { ReactNode } from "react";

export function Group({
  title,
  children,
  foot,
}: {
  title?: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <section className="s-group">
      {title && <h3>{title}</h3>}
      <div className="s-card">{children}</div>
      {foot && <p className="s-foot">{foot}</p>}
    </section>
  );
}

export function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /** The control's id, when the label should name it. */
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="s-row">
      <div className="s-row-l">
        {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <div>{label}</div>}
        {hint && <div className="s-hint">{hint}</div>}
      </div>
      <div className="s-row-r">{children}</div>
    </div>
  );
}

export function Seg<K extends string>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly (readonly [K, string])[];
  value: K;
  onPick: (k: K) => void;
}) {
  return (
    <fieldset className="seg seg--wrap" aria-label={label}>
      {options.map(([k, name]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onPick(k)}>
          {name}
        </button>
      ))}
    </fieldset>
  );
}

export function Toggle({
  on,
  onChange,
  label,
  disabled = false,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`switch${on ? " on" : ""}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}
