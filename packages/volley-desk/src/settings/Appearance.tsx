/**
 * Settings › Appearance (formerly the dock's Appearance aside): a search field
 * over every background (the current one always stays listed), the dim
 * slider, the window style, the Needs-you effect and the tethers. Every
 * control writes the look (`useLook`), which persists per browser. Without
 * WebGL (`webgl={false}`) the WebGL backgrounds and the liquid chrome are not
 * offered, with a note, and `look` is the degraded look the Desk renders. On
 * the lite surface (`lite`, a touch screen) the liquid chrome is not offered
 * either, with a note under the window style.
 */
import { useState } from "react";
import { BG_NO_WEBGL_NOTE, SURFACE_LITE_NOTE, needsWebGL } from "../look/Background";
import { BACKGROUNDS, REACT_BITS_BACKGROUNDS } from "../look/backgrounds";
import { ATTN_LABEL, CHROME_LABEL } from "../look/options";
import { DIM_MAX, type Look } from "../look/useLook";
import { Group, Row, Seg, Toggle, clearOnEscape } from "./primitives";
import "../styles/look.css";

export function Appearance({
  look,
  setLook,
  webgl = true,
  lite = false,
}: {
  look: Look;
  setLook: (change: Partial<Look>) => void;
  /** Whether this browser has WebGL (`useWebGL`). */
  webgl?: boolean;
  /** Whether the Desk draws the lite surface (`useLiteSurface`). */
  lite?: boolean;
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
  const chromes = webgl && !lite ? CHROME_LABEL : CHROME_LABEL.filter(([k]) => k !== "liquid");
  const current = BACKGROUNDS.find((b) => b.key === look.bg);
  return (
    <>
      <Group
        title="Background"
        foot={`${REACT_BITS_BACKGROUNDS.length} backgrounds from React Bits. Each loads only when you pick it.`}
      >
        <div className="s-pad">
          <div className="bg-current" aria-live="polite">
            Now: <b>{current?.name ?? look.bg}</b>
          </div>
          <input
            className="bg-search recessed"
            type="search"
            placeholder="Search backgrounds…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => clearOnEscape(e, q, setQ)}
            aria-label="Search backgrounds"
          />
          {!webgl && <p className="s-hint">{BG_NO_WEBGL_NOTE}</p>}
          <fieldset className="bg-grid bg-grid--3" aria-label="Backgrounds">
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
        </div>
        <Row label="Dim background">
          <div className="s-slider">
            <input
              type="range"
              min={0}
              max={DIM_MAX}
              step={0.05}
              value={look.dim}
              onChange={(e) => setLook({ dim: Number(e.target.value) })}
              aria-label="Dim background"
            />
            <span className="mono s-val">{Math.round(look.dim * 100)}%</span>
          </div>
        </Row>
      </Group>
      <Group title="Windows">
        <Row label="Window style">
          <Seg
            label="Window style"
            options={chromes}
            value={look.chrome}
            onPick={(chrome) => setLook({ chrome })}
          />
        </Row>
        {lite && (
          <div className="s-pad">
            <p className="s-hint">{SURFACE_LITE_NOTE}</p>
          </div>
        )}
        <Row label="“Needs you” effect">
          <Seg
            label="Needs you effect"
            options={ATTN_LABEL}
            value={look.attn}
            onPick={(attn) => setLook({ attn })}
          />
        </Row>
        <Row label="Tethers" hint="Lines from each agent window to its wave">
          <Toggle label="Tethers" on={look.tethers} onChange={(tethers) => setLook({ tethers })} />
        </Row>
      </Group>
    </>
  );
}
