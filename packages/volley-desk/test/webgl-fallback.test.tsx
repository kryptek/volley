import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { Appearance } from "../src/look/Appearance";
import { BG_NO_WEBGL_NOTE, degradeLook, hasWebGL, needsWebGL } from "../src/look/Background";
import { BACKGROUNDS, NO_BACKGROUND } from "../src/look/backgrounds";
import { LOOK0, LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";

/** The two React Bits backgrounds that draw with a 2D canvas or the DOM, not WebGL. */
const NO_GL = ["GridMotion", "ShapeGrid"];

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

const renderApp = () =>
  render(
    <DeskStoreProvider demo>
      <App />
    </DeskStoreProvider>,
  );

describe("WebGL detection", () => {
  it("is false when the canvas gives no WebGL context (test setup: getContext → null)", () => {
    expect(hasWebGL()).toBe(false);
  });

  it("is true when a WebGL context is available, and releases the probe context", () => {
    const loseContext = vi.fn();
    const ctx = { getExtension: () => ({ loseContext }) };
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockImplementation(((kind: string) =>
        kind === "webgl" ? ctx : null) as unknown as HTMLCanvasElement["getContext"]);
    expect(hasWebGL()).toBe(true);
    expect(spy).toHaveBeenCalled();
    expect(loseContext).toHaveBeenCalled();
  });

  it("knows which backgrounds need WebGL", () => {
    for (const b of BACKGROUNDS) {
      expect(needsWebGL(b.key), b.key).toBe(b.C !== null && !NO_GL.includes(b.key));
    }
  });

  it("matches the vendored sources: a background needs WebGL iff its source uses it", () => {
    for (const b of BACKGROUNDS.filter((x) => x.C !== null)) {
      const src = readFileSync(join(__dirname, `../src/rb/${b.key}/${b.key}.tsx`), "utf8");
      const usesGL = /webgl|from ["'](ogl|three|vgpu)["']/i.test(src);
      expect(needsWebGL(b.key), b.key).toBe(usesGL);
    }
  });

  it("degrades the look: WebGL backgrounds → none, liquid → glass", () => {
    const look = { ...LOOK0, bg: "Aurora", chrome: "liquid" as const };
    expect(degradeLook(look, true)).toBe(look);
    expect(degradeLook(look, false)).toEqual({ ...look, bg: NO_BACKGROUND, chrome: "glass" });
    const plain = { ...LOOK0, bg: "GridMotion", chrome: "solid" as const };
    expect(degradeLook(plain, false)).toEqual(plain);
  });
});

describe("App without WebGL", () => {
  it("renders none and glass, hides WebGL backgrounds and liquid in the picker, keeps the saved pick", () => {
    localStorage.setItem(
      LOOK_STORAGE_KEY,
      JSON.stringify({ bg: "Aurora", chrome: "liquid", autoArrange: false }),
    );
    const { container } = renderApp();
    expect(container.querySelector(".bg-layer")).toHaveAttribute("data-bg", NO_BACKGROUND);
    const inners = [...container.querySelectorAll(".world .win-inner")];
    expect(inners.length).toBeGreaterThan(0);
    for (const el of inners) expect(el).toHaveClass("chrome-glass");
    expect(container.querySelector(".world .win-glass")).toBeNull();

    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dock" })).getByRole("button", {
        name: "Appearance",
      }),
    );
    const panel = within(screen.getByRole("complementary", { name: "Appearance" }));
    const grid = within(panel.getByRole("group", { name: "Backgrounds" }));
    expect(grid.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Grid Motion",
      "Shape Grid",
      "None (plain)",
    ]);
    expect(grid.getByRole("button", { name: "None (plain)" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(panel.getByText(BG_NO_WEBGL_NOTE)).toBeInTheDocument();
    const style = within(panel.getByRole("group", { name: "Window style" }));
    expect(style.queryByRole("button", { name: "Liquid glass" })).toBeNull();
    expect(style.getByRole("button", { name: "Frosted glass" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // The saved look is untouched: a browser with WebGL still gets Aurora and liquid glass.
    expect(JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "{}")).toMatchObject({
      bg: "Aurora",
      chrome: "liquid",
    });
    // Picking a 2D background still works.
    fireEvent.click(grid.getByRole("button", { name: "Grid Motion" }));
    expect(container.querySelector(".bg-layer")).toHaveAttribute("data-bg", "GridMotion");
  });

  it("keeps liquid glass when the browser has WebGL", () => {
    localStorage.setItem(
      LOOK_STORAGE_KEY,
      JSON.stringify({ bg: "none", chrome: "liquid", autoArrange: false }),
    );
    // Only the up-front probe sees a WebGL context; everything after it gets the setup's null.
    const ctx = { getExtension: () => ({ loseContext: () => {} }) };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementationOnce(
      (() => ctx) as unknown as HTMLCanvasElement["getContext"],
    );
    const { container } = renderApp();
    const inners = [...container.querySelectorAll(".world .win-inner")];
    expect(inners.length).toBeGreaterThan(0);
    for (const el of inners) expect(el).toHaveClass("chrome-liquid");
    expect(container.querySelector(".world .win-glass")).not.toBeNull();
  });

  it("the Appearance panel lists everything when WebGL is there", () => {
    render(
      <Appearance look={LOOK0} setLook={() => {}} onClose={() => {}} onArrange={() => {}} webgl />,
    );
    const grid = within(screen.getByRole("group", { name: "Backgrounds" }));
    expect(grid.getAllByRole("button")).toHaveLength(BACKGROUNDS.length);
    expect(screen.queryByText(BG_NO_WEBGL_NOTE)).toBeNull();
    expect(screen.getByRole("button", { name: "Liquid glass" })).toBeInTheDocument();
  });
});
