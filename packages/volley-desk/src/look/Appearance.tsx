/**
 * The Appearance panel, ported from the prototype `App.tsx` aside: a search
 * field over every background (the current one always stays listed), the dim
 * slider, the window style, auto-arrange with "Arrange & fit now", the
 * Needs-you effect and the narration effect. Every control writes the look
 * (`useLook`), which persists per browser. Without WebGL (`webgl={false}`)
 * the WebGL backgrounds and the liquid chrome are not offered, with a note,
 * and `look` is the degraded look the Desk renders.
 */
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { BG_NO_WEBGL_NOTE, needsWebGL } from "./Background";
import { BACKGROUNDS, REACT_BITS_BACKGROUNDS } from "./backgrounds";
import { ATTN_LABEL, CHROME_LABEL, NARR_LABEL } from "./options";
import { DIM_MAX, FINISHED_GRACE_MAX_MIN, type Look, isGraceMin } from "./useLook";
import "../styles/look.css";

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

/**
 * The finished-agent grace in minutes. Typing edits a draft, committed on blur
 * or Enter, so backspacing `10` towards `45` never applies (and saves) `1` on
 * the way; an empty or invalid draft is dropped for the saved value.
 */
function GraceInput({ value, onCommit }: { value: number; onCommit: (min: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    if (draft.trim() !== "" && isGraceMin(v) && v !== value) onCommit(v);
    setDraft(null);
  };
  return (
    <input
      id="look-finished-grace"
      className="look-num recessed mono"
      type="number"
      min={0}
      max={FINISHED_GRACE_MAX_MIN}
      step={1}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

export function Appearance({
  look,
  setLook,
  onClose,
  onArrange,
  webgl = true,
}: {
  look: Look;
  setLook: (change: Partial<Look>) => void;
  onClose: () => void;
  onArrange: () => void;
  /** Whether this browser has WebGL (`useWebGL`). */
  webgl?: boolean;
}) {
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const offered = webgl ? BACKGROUNDS : BACKGROUNDS.filter((b) => !needsWebGL(b.key));
  const shown = offered.filter(
    (b) =>
      !needle ||
      b.name.toLowerCase().includes(needle) ||
      b.key.toLowerCase().includes(needle) ||
      b.key === look.bg,
  );
  const chromes = webgl ? CHROME_LABEL : CHROME_LABEL.filter(([k]) => k !== "liquid");
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
        className="bg-search recessed"
        type="search"
        placeholder="Search backgrounds…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search backgrounds"
      />
      {!webgl && <p className="look-note">{BG_NO_WEBGL_NOTE}</p>}
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
        options={chromes}
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
      <label className="check" htmlFor="look-finished-grace">
        Hide finished agents after{" "}
        <GraceInput
          value={look.finishedGraceMin}
          onCommit={(finishedGraceMin) => setLook({ finishedGraceMin })}
        />{" "}
        min
      </label>
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
