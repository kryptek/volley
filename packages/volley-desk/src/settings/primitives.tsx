/**
 * The Settings window's building blocks, ported from the prototype
 * `settings.tsx`: `Group` (a titled card of rows with an optional footnote),
 * `Row` (label and hint on the left, the control on the right), `Seg` (a
 * segmented picker on React Bits Gooey Nav, as the agent tabs are since D10:
 * a `radiogroup` of `radio`s with roving focus, the arrow keys (wrapping)
 * and Home/End moving and committing the pick) and `Toggle` (an iOS-style
 * switch), and `clearOnEscape` for the search boxes.
 */
import type { KeyboardEvent, ReactNode } from "react";
import GooeyNav from "../rb/GooeyNav/GooeyNav";

/** The Desk's cyan: the Settings window has no wave accent of its own. */
const SEG_ACCENT = "#6ee7f9";

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
  const index = Math.max(
    0,
    options.findIndex(([k]) => k === value),
  );
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    const n = options.length;
    const moves: Record<string, number> = {
      ArrowRight: (index + 1) % n,
      ArrowDown: (index + 1) % n,
      ArrowLeft: (index - 1 + n) % n,
      ArrowUp: (index - 1 + n) % n,
      Home: 0,
      End: n - 1,
    };
    const next = moves[e.key];
    const option = next === undefined ? undefined : options[next];
    if (next === undefined || !option) return;
    e.preventDefault();
    if (next !== index) onPick(option[0]);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
  };
  return (
    // A div carries the radiogroup: axe allows no such role on Gooey Nav's <nav>, which is `presentation` here.
    <div className="seg-group" role="radiogroup" aria-label={label} onKeyDown={keys}>
      <GooeyNav
        className="gooey-seg"
        role="presentation"
        size="sm"
        color={SEG_ACCENT}
        gl={false}
        items={options.map(([, name]) => ({ label: name }))}
        activeIndex={index}
        onChange={(i: number) => {
          const option = options[i];
          if (option) onPick(option[0]);
        }}
        itemProps={(i: number) => ({
          role: "radio",
          "data-sound": "click",
          "aria-checked": i === index,
          tabIndex: i === index ? 0 : -1,
        })}
      />
    </div>
  );
}

/**
 * Escape in a search box with a query clears the query, and stays there:
 * only Escape in an empty box closes the window.
 */
export function clearOnEscape(e: KeyboardEvent, q: string, setQ: (q: string) => void) {
  if (e.key !== "Escape" || q === "") return;
  e.stopPropagation();
  setQ("");
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
      data-sound="click"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    >
      <i />
    </button>
  );
}
