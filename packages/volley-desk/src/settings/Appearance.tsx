/**
 * Settings › Appearance (formerly the dock's Appearance aside): the theme
 * (`look/themes.ts`, a card per palette with its swatches), the current
 * pipeline step's effect (a card per effect with a live preview), a search field
 * over every background (the current one always stays listed), the dim
 * slider, the window style, the Needs-you effect, the tethers and the agent
 * icons (Clawd characters or the classic spinner). Every
 * control writes the look (`useLook`), which persists per browser. Without
 * WebGL (`webgl={false}`) the WebGL backgrounds and the liquid chrome are not
 * offered, with a note, and `look` is the degraded look the Desk renders. On
 * the lite surface (`lite`, a touch screen) the liquid chrome is not offered
 * either, with a note under the window style.
 */
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BG_NO_WEBGL_NOTE, SURFACE_LITE_NOTE, needsWebGL } from "../look/Background";
import { BACKGROUNDS, REACT_BITS_BACKGROUNDS } from "../look/backgrounds";
import {
  ATTN_LABEL,
  CHROME_LABEL,
  ICON_LABEL,
  STEP_FX_LABEL,
  type StepFx,
  THEME_LABEL,
} from "../look/options";
import { LIGHT_THEME_IDS, type ThemeTokens, themeById } from "../look/themes";
import { DIM_MAX, type Look } from "../look/useLook";
import { Group, Row, Seg, Toggle, clearOnEscape } from "./primitives";
import "../styles/look.css";
import STEP_FX_CSS from "../styles/stepfx.css?inline";

/**
 * The preview step's box (the pipeline step's) inside its shadow root; `--acc` is the theme
 * accent there, for Classic.
 */
const PREVIEW_CSS = `:host { display: block; --acc: var(--t-acc); }
.fx-cur { display: block; text-align: center; font-size: 11px; padding: 4px 0; border-radius: 6px; border: 1px solid transparent; }`;

/**
 * One effect's live preview, the mockup's `.demo`: `<span data-fx><span class="fx-cur">`.
 * It renders in a shadow root with its own copy of stepfx.css, because every rule there is
 * `[data-fx=…] .fx-cur` and <html> carries the chosen effect: in the page, each card would
 * also wear the chosen one. The previews run only while this page is mounted; reduced motion
 * stills them (stepfx.css).
 */
function FxPreview({ fx }: { fx: StepFx }) {
  const host = useRef<HTMLSpanElement>(null);
  const [root, setRoot] = useState<ShadowRoot | null>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (el) setRoot(el.shadowRoot ?? el.attachShadow({ mode: "open" }));
  }, []);
  return (
    <span ref={host} className="fx-demo" aria-hidden="true">
      {root &&
        createPortal(
          <>
            <style>{`${STEP_FX_CSS}\n${PREVIEW_CSS}`}</style>
            <span data-fx={fx}>
              <span className="fx-cur">fixup</span>
            </span>
          </>,
          root,
        )}
    </span>
  );
}

/** The five colours a theme card shows. */
const SWATCHES = [
  "bg",
  "win1",
  "acc",
  "ok",
  "link",
] as const satisfies readonly (keyof ThemeTokens)[];

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
      <Group title="Theme">
        <div className="s-pad">
          <fieldset className="theme-grid" aria-label="Theme">
            {THEME_LABEL.map(([id, name]) => {
              const { v } = themeById(id);
              return (
                <button
                  key={id}
                  type="button"
                  className={`theme-opt${look.theme === id ? " on" : ""}`}
                  aria-pressed={look.theme === id}
                  onClick={() => setLook({ theme: id })}
                >
                  <span className="theme-swatch" aria-hidden="true">
                    {SWATCHES.map((k) => (
                      <i key={k} style={{ background: v[k] }} />
                    ))}
                  </span>
                  <span className="theme-name">
                    {name}
                    {LIGHT_THEME_IDS.includes(id) && <span className="theme-tone"> · light</span>}
                  </span>
                </button>
              );
            })}
          </fieldset>
        </div>
      </Group>
      <Group title="Current step">
        <div className="s-pad">
          <fieldset className="fx-grid" aria-label="Current step">
            {STEP_FX_LABEL.map(([id, name, desc]) => (
              <button
                key={id}
                type="button"
                className="fx-opt"
                aria-label={name}
                aria-describedby={`fx-desc-${id}`}
                aria-pressed={look.fx === id}
                onClick={() => setLook({ fx: id })}
              >
                <FxPreview fx={id} />
                <span className="fx-name">{name}</span>
                <span className="fx-desc" id={`fx-desc-${id}`}>
                  {desc}
                </span>
              </button>
            ))}
          </fieldset>
        </div>
      </Group>
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
        <Row label="Agent icons" hint="What sits at the top left of each agent window">
          <Seg
            label="Agent icons"
            options={ICON_LABEL}
            value={look.icons}
            onPick={(icons) => setLook({ icons })}
          />
        </Row>
      </Group>
    </>
  );
}
