/**
 * The Appearance panel, ported from the prototype `App.tsx` aside: a search
 * field over every background (the current one always stays listed), the dim
 * slider, the window style, auto-arrange with "Arrange & fit now", the
 * Needs-you effect and the narration effect. Every control writes the look
 * (`useLook`), which persists per browser.
 */
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { AttnStyle, Chrome } from "../canvas/Frame";
import { BACKGROUNDS, REACT_BITS_BACKGROUNDS } from "./backgrounds";
import { DIM_MAX, type Look, type NarrationFx } from "./useLook";
import "../styles/look.css";

export const CHROME_LABEL: readonly (readonly [Chrome, string])[] = [
  ["glass", "Frosted glass"],
  ["liquid", "Liquid glass"],
  ["spotlight", "Spotlight"],
  ["glow", "Border glow"],
  ["solid", "Solid"],
];
export const ATTN_LABEL: readonly (readonly [AttnStyle, string])[] = [
  ["electric", "Electric border"],
  ["star", "Star border"],
  ["pulse", "Pulse"],
];
export const NARR_LABEL: readonly (readonly [NarrationFx, string])[] = [
  ["decrypt", "Decrypt"],
  ["shiny", "Shiny"],
  ["plain", "Plain"],
];

function Segments<K extends string>({
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

export function Appearance({
  look,
  setLook,
  onClose,
  onArrange,
}: {
  look: Look;
  setLook: (change: Partial<Look>) => void;
  onClose: () => void;
  onArrange: () => void;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const shown = BACKGROUNDS.filter(
    (b) =>
      !needle ||
      b.name.toLowerCase().includes(needle) ||
      b.key.toLowerCase().includes(needle) ||
      b.key === look.bg,
  );
  const current = BACKGROUNDS.find((b) => b.key === look.bg);
  return (
    <aside className="look" aria-label="Appearance">
      <div className="look-head">
        <span>Appearance</span>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close appearance">
          <HugeiconsIcon icon={Cancel01Icon} size={15} />
        </button>
      </div>
      <div className="lbl">
        Background <span className="dim">· {REACT_BITS_BACKGROUNDS.length} from React Bits</span>
      </div>
      <div className="bg-current" aria-live="polite">
        Now: <b>{current?.name ?? look.bg}</b>
      </div>
      <input
        className="bg-search"
        type="search"
        placeholder="Search backgrounds…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search backgrounds"
      />
      <fieldset className="bg-grid" aria-label="Backgrounds">
        {shown.map((b) => (
          <button
            key={b.key}
            type="button"
            className={`bg-opt${look.bg === b.key ? " on" : ""}`}
            aria-pressed={look.bg === b.key}
            onClick={() => setLook({ bg: b.key })}
          >
            {b.name}
          </button>
        ))}
        {shown.length === 1 && shown[0]?.key === look.bg && needle && (
          <span className="bg-none">No other background matches “{q.trim()}”.</span>
        )}
      </fieldset>
      <label className="lbl" htmlFor="look-dim">
        Dim background <span className="mono">{Math.round(look.dim * 100)}%</span>
      </label>
      <input
        id="look-dim"
        type="range"
        min={0}
        max={DIM_MAX}
        step={0.05}
        value={look.dim}
        onChange={(e) => setLook({ dim: Number(e.target.value) })}
      />
      <div className="lbl">Window style</div>
      <Segments
        label="Window style"
        options={CHROME_LABEL}
        value={look.chrome}
        onPick={(chrome) => setLook({ chrome })}
      />
      <div className="lbl">Layout</div>
      <label className="check">
        <input
          type="checkbox"
          checked={look.autoArrange}
          onChange={(e) => setLook({ autoArrange: e.target.checked })}
        />{" "}
        Auto-arrange and fit when windows open, close, hide or show
      </label>
      <button type="button" className="btn" onClick={onArrange}>
        Arrange &amp; fit now
      </button>
      <div className="lbl">“Needs you” effect</div>
      <Segments
        label="Needs you effect"
        options={ATTN_LABEL}
        value={look.attn}
        onPick={(attn) => setLook({ attn })}
      />
      <div className="lbl">Narration effect</div>
      <Segments
        label="Narration effect"
        options={NARR_LABEL}
        value={look.narr}
        onPick={(narr) => setLook({ narr })}
      />
      <p className="look-note">
        Drag empty space to pan. Pinch or ⌘/Ctrl + scroll to zoom. Drag a title bar to move a
        window; with auto-arrange on, the next new window re-arranges everything.
      </p>
    </aside>
  );
}
