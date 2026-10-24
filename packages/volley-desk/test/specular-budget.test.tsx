import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LITE_SURFACE_QUERY } from "../src/a11y/surface";
import { GL_BUTTON_BUDGET, createGlBudget, glBudgetLive } from "../src/look/glBudget";
import SpecularButton from "../src/rb/SpecularButton/SpecularButton";

const realMatchMedia = window.matchMedia;
afterEach(() => {
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
});

/** A `matchMedia` whose lite query matches while `state.on`; `set()` flips it and notifies. */
function liteMedia() {
  const state = { on: false, listeners: new Set<() => void>() };
  window.matchMedia = ((query: string) => ({
    get matches() {
      return state.on && query === LITE_SURFACE_QUERY;
    },
    media: query,
    addEventListener: (_: string, f: () => void) => state.listeners.add(f),
    removeEventListener: (_: string, f: () => void) => state.listeners.delete(f),
    addListener: () => {},
    removeListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return (on: boolean) =>
    act(() => {
      state.on = on;
      for (const f of state.listeners) f();
    });
}

/** A WebGL2 context good enough for the button's setup: every call returns an object. */
function fakeGL() {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_, prop) {
      if (prop === "getExtension") return () => ({ loseContext: () => {} });
      if (prop === "getShaderParameter" || prop === "getProgramParameter") return () => true;
      return () => ({});
    },
  });
}

/** Counts WebGL `getContext` calls and hands out fake contexts. */
function countWebGL() {
  const calls: HTMLCanvasElement[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (!/webgl/.test(kind)) return null;
    calls.push(this);
    return fakeGL();
  } as unknown as HTMLCanvasElement["getContext"]);
  return calls;
}

function Buttons({ n }: { n: number }) {
  return (
    <div>
      {Array.from({ length: n }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of copies
        <SpecularButton key={i} size="sm">
          option {i}
        </SpecularButton>
      ))}
    </div>
  );
}

function Keyed({ keys }: { keys: string[] }) {
  return (
    <div>
      {keys.map((k) => (
        <SpecularButton key={k} size="sm">
          {k}
        </SpecularButton>
      ))}
    </div>
  );
}

const flat = (c: HTMLElement) => c.querySelectorAll(".specular-button--flat");
const lit = (c: HTMLElement) =>
  [...c.querySelectorAll(".specular-button")].filter(
    (b) => !b.classList.contains("specular-button--flat"),
  );

describe("the budget (look/glBudget.ts)", () => {
  it("grants up to its limit, refuses past it, and grants again once one is released", () => {
    const b = createGlBudget(2);
    const seen: number[] = [];
    b.subscribe(() => seen.push(b.live()));
    expect(b.acquire("a")).toBe(true);
    expect(b.acquire("a")).toBe(true);
    expect(b.acquire("b")).toBe(true);
    expect(b.acquire("c")).toBe(false);
    expect(b.live()).toBe(2);
    b.release("a");
    expect(seen.at(-1)).toBe(1);
    expect(b.acquire("c")).toBe(true);
    b.release("nobody");
    expect(b.live()).toBe(2);
  });

  it("is six live contexts per page", () => {
    expect(GL_BUTTON_BUDGET).toBe(6);
  });
});

describe("SpecularButton under the context budget", () => {
  it("12 buttons open at most GL_BUTTON_BUDGET contexts; the rest are flat, with no canvas", () => {
    const calls = countWebGL();
    const { container } = render(<Buttons n={12} />);
    expect(calls.length).toBeLessThanOrEqual(GL_BUTTON_BUDGET);
    expect(lit(container)).toHaveLength(GL_BUTTON_BUDGET);
    expect(flat(container)).toHaveLength(12 - GL_BUTTON_BUDGET);
    for (const b of flat(container)) expect(b.querySelector("canvas")).toBeNull();
    expect(glBudgetLive()).toBe(GL_BUTTON_BUDGET);
  });

  it("unmounting a lit button lets the next flat one upgrade", () => {
    countWebGL();
    const keys = (from: number) => Array.from({ length: 8 - from }, (_, i) => String(from + i));
    const { container, rerender } = render(<Keyed keys={keys(0)} />);
    const byLabel = (k: string) =>
      [...container.querySelectorAll(".specular-button")].find((b) => b.textContent === k);
    expect(byLabel("6")).toHaveClass("specular-button--flat");
    rerender(<Keyed keys={keys(1)} />);
    expect(byLabel("6")).not.toHaveClass("specular-button--flat");
    expect(byLabel("6")?.querySelector("canvas")).not.toBeNull();
    expect(byLabel("7")).toHaveClass("specular-button--flat");
    expect(glBudgetLive()).toBe(GL_BUTTON_BUDGET);
  });

  it("releases every slot on unmount", () => {
    countWebGL();
    const { unmount } = render(<Buttons n={12} />);
    unmount();
    expect(glBudgetLive()).toBe(0);
  });

  it("a lost context flips the button flat; a restored one brings it back", () => {
    countWebGL();
    const { container } = render(<Buttons n={1} />);
    const button = container.querySelector(".specular-button") as HTMLElement;
    const canvas = button.querySelector("canvas") as HTMLCanvasElement;
    expect(button).not.toHaveClass("specular-button--flat");
    const lost = new Event("webglcontextlost", { cancelable: true });
    act(() => {
      canvas.dispatchEvent(lost);
    });
    expect(lost.defaultPrevented).toBe(true);
    expect(button).toHaveClass("specular-button--flat");
    act(() => {
      fireEvent(canvas, new Event("webglcontextrestored"));
    });
    expect(button).not.toHaveClass("specular-button--flat");
  });

  it("a button flat for want of a context lights up once a later slot gets one", () => {
    const lite = liteMedia();
    const { container } = render(<Buttons n={1} />);
    const button = container.querySelector(".specular-button") as HTMLElement;
    expect(button).toHaveClass("specular-button--flat");
    countWebGL();
    lite(true);
    lite(false);
    expect(button.querySelector("canvas")).not.toBeNull();
    expect(button).not.toHaveClass("specular-button--flat");
  });

  it("is flat when the canvas gives no WebGL context (test setup: getContext → null)", () => {
    const { container } = render(<Buttons n={2} />);
    expect(flat(container)).toHaveLength(2);
  });
});

describe("the flat variant (SpecularButton.css)", () => {
  const css = readFileSync(
    join(__dirname, "../src/rb/SpecularButton/SpecularButton.css"),
    "utf8",
  ).replace(/\s+/g, " ");
  it("draws a static tinted rim and hides the light canvas", () => {
    const at = css.indexOf(".specular-button--flat {");
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toContain("inset 0 0 0 1px color-mix(in srgb, var(--sb-tint) 28%, transparent)");
    expect(css).toMatch(/\.specular-button--flat \.specular-button__light \{ display: none;/);
  });
});
