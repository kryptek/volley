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
    addEventListener: (_: string, f: () => void) => state.listeners.add(f),
    removeEventListener: (_: string, f: () => void) => state.listeners.delete(f),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
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
    expect(top.filter(([p]) => !p.startsWith("@media") && !p.startsWith("@keyframes"))).toEqual(
      [],
    );
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
