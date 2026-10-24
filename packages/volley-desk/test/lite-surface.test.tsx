import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LITE_SURFACE_QUERY, useLiteSurface } from "../src/a11y/surface";

const SRC = join(__dirname, "../src");
const LITE = join(SRC, "styles/lite.css");

const realMatchMedia = window.matchMedia;
afterEach(() => {
  window.matchMedia = realMatchMedia;
});

/** A `matchMedia` whose lite query matches while `state.on`; `fire()` sends it a `change`. */
function liteMedia(on: boolean) {
  const state = { on, listeners: new Set<() => void>() };
  window.matchMedia = ((query: string) => ({
    get matches() {
      return state.on && query === LITE_SURFACE_QUERY;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, f: () => void) => {
      state.listeners.add(f);
    },
    removeEventListener: (_: string, f: () => void) => {
      state.listeners.delete(f);
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      state.on = next;
      for (const f of state.listeners) f();
    },
  };
}

describe("useLiteSurface", () => {
  it("is the touch-screen or reduced-transparency query", () => {
    expect(LITE_SURFACE_QUERY).toBe(
      "(hover: none) and (pointer: coarse), (prefers-reduced-transparency: reduce)",
    );
  });

  it("is false under the setup's matchMedia", () => {
    const { result } = renderHook(() => useLiteSurface());
    expect(result.current).toBe(false);
  });

  it("is true when the query matches and follows a change", () => {
    const media = liteMedia(true);
    const { result } = renderHook(() => useLiteSurface());
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
    act(() => media.set(true));
    expect(result.current).toBe(true);
  });
});

/** The CSS with comments removed. */
const read = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level `{ … }` blocks: `[prelude, body]`. */
function blocks(css: string): [string, string][] {
  const out: [string, string][] = [];
  let depth = 0;
  let start = 0;
  let open = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        out.push([css.slice(start, open).trim(), css.slice(open + 1, i)]);
        start = i + 1;
      }
    }
  }
  return out;
}

/** Every plain rule (at any depth) as `[selectors, declarations]`. */
function rules(css: string): [string[], string][] {
  return [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => [
    (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter(Boolean),
    m[2] ?? "",
  ]);
}

const decls = (body: string, prop: string) =>
  [...body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, "g"))].map((m) =>
    (m[1] ?? "").trim(),
  );

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(p);
    return e.name.endsWith(".css") && p !== LITE ? [p] : [];
  });
}

/** The custom properties a desk.css block declares. */
function props(selector: string): Map<string, string> {
  const css = read(join(SRC, "styles/desk.css"));
  const at = css.indexOf(`${selector} {`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("\n}", at));
  return new Map(
    [...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
  );
}
const ROOT = props(":root");
const THEMED = new Map([...ROOT, ...props('html[data-theme]:not([data-theme="volley"])')]);

/**
 * The alphas of a fill: each `rgba(…, a)` and each `color-mix(in srgb, var(--x) N%, transparent)`
 * (alpha N/100), after resolving `var(--…)` against `defs`.
 */
function fillAlphas(value: string, defs: Map<string, string>): number[] {
  let v = value;
  for (let i = 0; i < 5; i++) {
    v = v.replace(/var\((--[\w-]+)\)(?!\s*\d)/g, (m, p: string, at: number, all: string) =>
      /color-mix\(in srgb,\s*$/.test(all.slice(0, at)) ? m : (defs.get(p) ?? m),
    );
  }
  return [
    ...[...v.matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g)].map((m) => Number(m[1])),
    ...[...v.matchAll(/color-mix\(in srgb,\s*var\(--[\w-]+\)\s+([\d.]+)%,\s*transparent\)/g)].map(
      (m) => Number(m[1]) / 100,
    ),
  ];
}

describe("lite.css", () => {
  const css = read(LITE);
  const top = blocks(css);
  const media = top.filter(([prelude]) => prelude.startsWith("@media"));
  const lite = media[0]?.[1] ?? "";
  const liteRules = rules(lite);

  it("is one @media block on the lite query", () => {
    expect(media).toHaveLength(1);
    expect(media[0]?.[0].replace(/\s+/g, " ")).toBe(`@media ${LITE_SURFACE_QUERY}`);
    // Keyframes may sit beside it; no other rule does.
    expect(top.filter(([p]) => !p.startsWith("@media") && !p.startsWith("@keyframes"))).toEqual([]);
  });

  it("sets every backdrop filter it names to none", () => {
    const values = liteRules.flatMap(([, body]) => [
      ...decls(body, "backdrop-filter"),
      ...decls(body, "-webkit-backdrop-filter"),
    ]);
    expect(values.length).toBeGreaterThan(0);
    expect(new Set(values)).toEqual(new Set(["none"]));
  });

  it("names every selector that declares a backdrop filter anywhere in the Desk's CSS", () => {
    const named = new Set(liteRules.flatMap(([sels]) => sels));
    const missing: string[] = [];
    for (const file of cssFiles(SRC)) {
      for (const [sels, body] of rules(read(file))) {
        if (!/(^|[;\s])(-webkit-)?backdrop-filter\s*:/.test(body)) continue;
        for (const s of sels) if (!named.has(s)) missing.push(`${relative(SRC, file)}: ${s}`);
      }
    }
    expect(missing).toEqual([]);
    // GlassSurface.css is vendored and never edited: its two glass modes are overridden here.
    expect(named.has(".glass-surface--svg")).toBe(true);
    expect(named.has(".glass-surface--fallback")).toBe(true);
  });

  it("fills the dock opaque-ish under the rule that draws it (look.css `.dock-wrap .dock`)", () => {
    // `.dock-wrap .dock` (0,2,0) sets the dock's translucent gradient; a bare `.dock` would lose to it.
    const drawn = rules(read(join(SRC, "styles/look.css"))).some(
      ([sels, body]) => sels.includes(".dock-wrap .dock") && decls(body, "background").length > 0,
    );
    expect(drawn).toBe(true);
    const fill = liteRules.find(([sels]) => sels.includes(".dock-wrap .dock"))?.[1] ?? "";
    const value = decls(fill, "background")[0] ?? "";
    expect(value).not.toBe("");
    // Volley's fill (desk.css :root) and every other theme's (the themed block).
    for (const props of [ROOT, THEMED]) {
      const alphas = fillAlphas(value, props);
      expect(alphas.length).toBeGreaterThan(0);
      for (const a of alphas) expect(a).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("keeps every surface's fill opaque-ish under every theme (≥ 0.94)", () => {
    const fills = liteRules.flatMap(([, body]) => [
      ...decls(body, "background-color"),
      ...decls(body, "background"),
    ]);
    expect(fills.length).toBeGreaterThanOrEqual(6);
    for (const props of [ROOT, THEMED]) {
      for (const value of fills) {
        const alphas = fillAlphas(value, props);
        expect(alphas.length, value).toBeGreaterThan(0);
        for (const a of alphas) expect(a, value).toBeGreaterThanOrEqual(0.94);
      }
    }
  });

  it("pulses Needs-you with opacity, never box-shadow", () => {
    const rule = (sel: string) => liteRules.find(([sels]) => sels.includes(sel))?.[1] ?? "";
    expect(decls(rule(".win-attn-pulse"), "animation")).toEqual(["none"]);
    const anim = decls(rule(".win-attn-pulse::after"), "animation")[0] ?? "";
    const name = anim.split(/\s+/)[0] ?? "";
    expect(name).not.toBe("");
    const frames = top.find(([p]) => p === `@keyframes ${name}`)?.[1] ?? "";
    expect(frames).toMatch(/opacity\s*:/);
    expect(frames).not.toMatch(/box-shadow/);
    expect(lite).not.toMatch(/box-shadow/);
  });
});

describe("lite.css and the Specular buttons (#417)", () => {
  it("hides every Specular button's light canvas: the buttons are flat", () => {
    const lite = rules(read(LITE));
    const rule = lite.find(([sels]) => sels.includes(".specular-button .specular-button__light"));
    expect(rule && decls(rule[1], "display")).toEqual(["none"]);
  });
});
