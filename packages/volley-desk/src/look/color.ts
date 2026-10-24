/**
 * Colour arithmetic for the theme registry (`themes.ts`): parse a CSS colour,
 * WCAG 2.x contrast, and the `color-mix(in oklab, …)` the stylesheets use for
 * the derived accent tokens, so a test can check a theme's contrast without a
 * browser.
 */

/** `[r, g, b, a]`: channels 0–255, alpha 0–1. */
export type Rgba = [number, number, number, number];

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` and `rgba()`; throws on anything else. */
export function parseColor(s: string): Rgba {
  const c = s.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(c);
  if (hex?.[1]) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((x) => x + x).join("");
    const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  const fn = /^rgba?\(\s*([^)]*)\)$/.exec(c);
  if (fn?.[1] !== undefined) {
    const parts = fn[1]
      .split(/\s*[,/]\s*|\s+/)
      .filter(Boolean)
      .map(Number);
    if ((parts.length === 3 || parts.length === 4) && parts.every(Number.isFinite)) {
      const [r, g, b, a = 1] = parts as [number, number, number, number?];
      return [r, g, b, a];
    }
  }
  throw new Error(`not a colour: ${s}`);
}

const toLinear = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (x: number) =>
  255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055);

/** WCAG 2.x relative luminance (alpha ignored). */
export function luminance(s: string): number {
  const [r, g, b] = parseColor(s);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 2.x contrast ratio, 1–21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

/** `#rrggbb`, or `#rrggbbaa` when not opaque. */
export function toHex([r, g, b, a]: Rgba): string {
  const h = (v: number) => clamp(v).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a * 255) : ""}`;
}

type Lab = [number, number, number];

function toOklab([r, g, b]: Rgba): Lab {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, A, B]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** `color-mix(in oklab, a pa*100%, b)` for opaque colours, as `#rrggbb`. */
export function oklabMix(a: string, b: string, pa: number): string {
  const x = toOklab(parseColor(a));
  const y = toOklab(parseColor(b));
  const mixed = x.map((v, i) => v * pa + (y[i] as number) * (1 - pa)) as Lab;
  return toHex([...fromOklab(mixed), 1]);
}
