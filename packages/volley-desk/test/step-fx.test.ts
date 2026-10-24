// The current-step effects' CSS contract (#366): every effect is keyed off `data-fx`, the
// keyframes animate only compositor-friendly properties (Pulse and Ember may add box-shadow,
// the two measured exceptions), nothing blurs, reduced motion stills every animation and
// Classic turns the depth off. jsdom applies no stylesheet, so this reads the file itself.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STEP_FX } from "../src/look/options";

const css = readFileSync(path.resolve(__dirname, "../src/styles/stepfx.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The body of the block opened at `open` (the index of its `{`), braces balanced. */
function blockAt(open: number): string {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("unbalanced braces in stepfx.css");
}

function keyframes(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
    out.set(m[1] as string, blockAt((m.index ?? 0) + m[0].length - 1));
  }
  return out;
}

/** The properties declared inside a keyframes body. */
const declared = (body: string) =>
  [...body.matchAll(/([-\w]+)\s*:/g)].map((m) => m[1] as string).filter((p) => !/^\d/.test(p));

const ANIMATABLE = [
  "transform",
  "opacity",
  "background-position",
  "mask-position",
  "-webkit-mask-position",
  "--ang",
];

describe("stepfx.css", () => {
  it("styles each of the nine effects under its data-fx", () => {
    expect(STEP_FX).toHaveLength(9);
    for (const id of STEP_FX) expect(css, id).toContain(`[data-fx="${id}"]`);
  });

  it("registers the conic angle Aurora animates", () => {
    expect(css).toMatch(/@property\s+--ang\s*\{/);
  });

  it("animates only transform, opacity, background/mask position and --ang (box-shadow in pulse and ember)", () => {
    const frames = keyframes();
    expect([...frames.keys()]).toEqual(
      expect.arrayContaining(["barglint", "glint", "pulse", "spin", "scan", "ember", "wave"]),
    );
    for (const [name, body] of frames) {
      const allowed =
        name === "pulse" || name === "ember" ? [...ANIMATABLE, "box-shadow"] : ANIMATABLE;
      for (const prop of declared(body))
        expect(allowed, `@keyframes ${name}: ${prop}`).toContain(prop);
    }
  });

  it("uses no backdrop-filter and no filter", () => {
    expect(css).not.toContain("backdrop-filter");
    expect(css).not.toMatch(/(^|[^-\w])filter\s*:/);
  });

  it("stills the current step and the bar's glint under reduced motion", () => {
    const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = blockAt(css.indexOf("{", at));
    for (const sel of [".fx-cur", ".fx-cur::before", ".fx-cur::after", ".bar > span::after"]) {
      expect(body, sel).toContain(sel);
    }
    expect(body).toMatch(/animation:\s*none/);
    // As specific as the effects' own `[data-fx="…"] .fx-cur` rules (and after them), or the
    // still frame loses to every effect but Glint's.
    for (const sel of [
      "[data-fx] .fx-cur",
      "[data-fx] .fx-cur::before",
      "[data-fx] .fx-cur::after",
    ]) {
      expect(body, sel).toContain(sel);
    }
  });

  it("on a touch screen Pulse and Ember drop their box-shadow keyframes (measured over budget)", () => {
    const at = css.indexOf("@media (hover: none) and (pointer: coarse)");
    expect(at).toBeGreaterThanOrEqual(0);
    const open = css.indexOf("{", at);
    const body = blockAt(open);
    for (const fx of ["pulse", "ember"]) {
      const sel = `[data-fx="${fx}"] .fx-cur {`;
      expect(body, sel).toContain(sel);
      expect(blockAt(css.indexOf("{", css.indexOf(sel, open)))).toMatch(/animation:\s*none/);
    }
    // Pulse keeps a ring, on a pseudo-element that animates opacity only.
    expect(body).toContain('[data-fx="pulse"] .fx-cur::before');
    // Before the still frames, so reduced motion still wins.
    expect(at).toBeLessThan(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  });

  it("Classic turns the depth off: no shadows, no check mark", () => {
    const rule = (sel: string) => {
      const at = css.indexOf(sel);
      expect(at, sel).toBeGreaterThanOrEqual(0);
      return blockAt(css.indexOf("{", at));
    };
    expect(rule('[data-fx="classic"] :is(.fx-future, .fx-done, .fx-cur)')).toMatch(
      /box-shadow:\s*none/,
    );
    expect(rule('[data-fx="classic"] .fx-done::before')).toMatch(/content:\s*none/);
  });
});
