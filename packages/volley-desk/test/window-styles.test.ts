// Owner reports on the window styles: Spotlight wrapped every panel in a second dark card, and
// Border glow grew scrollbars on hover and painted its cone under the panel body (a pinwheel).
// jsdom applies no stylesheet, so this guards the overrides themselves; the browser behaviour
// (same box as the default style, no new overflow, nothing under the body) is checked with
// Playwright across every style.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.resolve(__dirname, "../src/styles/look.css"), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} is styled`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}\n", at));
};

describe("Spotlight is applied to the panel itself", () => {
  it("adds no padding, surface or radius of its own", () => {
    const r = rule(".spotlight-card.win-wrap");
    expect(r).toMatch(/padding: 0;/);
    expect(r).toMatch(/background-color: transparent;/);
    expect(r).toMatch(/border-radius: 14px;/);
  });
});

describe("Border glow draws on the border ring only", () => {
  it("its inner wrapper never scrolls (the hover tilt transforms the window inside it)", () => {
    expect(rule(".border-glow-card.win-wrap > .border-glow-inner")).toMatch(/overflow: visible;/);
  });

  it("paints no interior fill under the body", () => {
    expect(rule(".border-glow-card.win-wrap::after")).toMatch(/display: none;/);
  });

  it("clips the colour mesh to the ring and the outer glow to outside the panel", () => {
    const mesh = rule(".border-glow-card.win-wrap::before");
    expect(mesh).toMatch(/mask-clip: border-box, padding-box, border-box;/);
    expect(mesh).toMatch(/mask-composite: intersect, exclude, add;/);
    const glow = rule(".border-glow-card.win-wrap > .edge-light");
    expect(glow).toMatch(/mask-clip: border-box, content-box, border-box;/);
    expect(glow).toMatch(/mask-composite: intersect, exclude, add;/);
  });
});

// #327: the wave header's autopilot chip ellipsized mid-word (`4 auto · 1 escalat…`).
describe("the autopilot chip never truncates mid-word", () => {
  const desk = readFileSync(path.resolve(__dirname, "../src/styles/desk.css"), "utf8");
  const deskRule = (selector: string) => {
    const at = desk.indexOf(`${selector} {`);
    expect(at, `${selector} is styled`).toBeGreaterThanOrEqual(0);
    return desk.slice(at, desk.indexOf("}\n", at));
  };

  it("lifts the title-bar chip width cap, in a compact window too", () => {
    // The compact selector matches `.win--compact .win-bar .chip` (0,3,0) and comes after it, so it wins.
    const lift = deskRule(".win-bar .chip--autopilot,\n.win--compact .win-bar .chip--autopilot");
    expect(lift).toMatch(/max-width: none;/);
    expect(lift).toMatch(/text-overflow: clip;/);
    expect(desk.indexOf(".win--compact .win-bar .chip {")).toBeLessThan(
      desk.indexOf(".win--compact .win-bar .chip--autopilot {"),
    );
  });

  it("shows the full sentence, and only the tokens in a compact window", () => {
    expect(deskRule(".chip--autopilot .ap-short")).toMatch(/display: none;/);
    expect(deskRule(".win--compact .win-bar .chip--autopilot .ap-short")).toMatch(
      /display: inline;/,
    );
  });

  it("keeps the full sentence readable by a screen reader in a compact window", () => {
    // Visually hidden, not display:none: the tokens are aria-hidden, so the sentence is the chip's only text.
    const hidden = deskRule(".win--compact .win-bar .chip--autopilot .ap-full");
    expect(hidden).not.toMatch(/display: none;/);
    expect(hidden).toMatch(/position: absolute;/);
    expect(hidden).toMatch(/clip: rect\(0 0 0 0\);/);
  });
});
