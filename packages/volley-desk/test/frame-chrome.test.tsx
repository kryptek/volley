import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { lazy } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REDUCED_MOTION_QUERY } from "../src/a11y/motion";
import { LITE_SURFACE_QUERY } from "../src/a11y/surface";
import {
  type AttnStyle,
  type Chrome,
  Frame,
  type FrameProps,
  TILT_MAX_DEG,
  hexA,
  hexToHsl,
} from "../src/canvas/Frame";
import { BG_FALLBACK, BG_LOAD_FAILED, Background } from "../src/look/Background";
import {
  type BackgroundDef,
  addStylesheet,
  failedChunk,
  isChunkLoadError,
  lazyBackground,
} from "../src/look/backgrounds";
import { CHROMES } from "../src/look/options";
import { resolveTokens } from "./helpers/tokens";

const base: Omit<FrameProps, "children"> = {
  id: "w",
  title: "wave-1",
  accent: "#6ee7f9",
  pos: { x: 0, y: 0 },
  width: 460,
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};
const win = () => screen.getByRole("region", { name: "wave-1" });

describe("Frame chromes", () => {
  const cases: [Chrome, string | null][] = [
    ["glass", null],
    ["liquid", ".win-inner > .win-glass .glass-surface"],
    ["spotlight", ".spotlight-card.win-wrap > .win-inner"],
    ["glow", ".border-glow-card.win-wrap .win-inner"],
    ["solid", null],
  ];
  it.each(cases)("%s renders its wrapper", (chrome, wrapper) => {
    render(
      <Frame {...base} chrome={chrome}>
        body
      </Frame>,
    );
    const el = win();
    expect(el.querySelector(".win-inner")).toHaveClass(`chrome-${chrome}`);
    expect(el).toHaveTextContent("body");
    if (wrapper) expect(el.querySelector(wrapper)).not.toBeNull();
    else expect(el.firstElementChild).toHaveClass("win-inner");
    // Only the liquid chrome lays glass under the content.
    expect(el.querySelector(".win-glass") !== null).toBe(chrome === "liquid");
  });

  describe("on the lite surface (touch screen)", () => {
    const realMatchMedia = window.matchMedia;
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });
    const lite = () => {
      window.matchMedia = (q: string) =>
        ({ ...realMatchMedia(q), matches: q === LITE_SURFACE_QUERY }) as MediaQueryList;
    };

    it("liquid renders as the CSS glass, with no GlassSurface", () => {
      lite();
      render(
        <Frame {...base} chrome="liquid">
          body
        </Frame>,
      );
      const el = win();
      expect(el.querySelector(".win-inner")).toHaveClass("chrome-glass");
      expect(el.querySelector(".win-inner")).not.toHaveClass("chrome-liquid");
      expect(el.querySelector(".win-glass")).toBeNull();
      expect(el.querySelector(".glass-surface")).toBeNull();
    });

    it.each(cases.filter(([c]) => c !== "liquid"))("%s renders as before", (chrome, wrapper) => {
      lite();
      render(
        <Frame {...base} chrome={chrome}>
          body
        </Frame>,
      );
      const el = win();
      expect(el.querySelector(".win-inner")).toHaveClass(`chrome-${chrome}`);
      if (wrapper) expect(el.querySelector(wrapper)).not.toBeNull();
      else expect(el.firstElementChild).toHaveClass("win-inner");
    });
  });

  it("tints the spotlight and glow with the accent", () => {
    expect(hexA("#6ee7f9", 0.22)).toBe("rgba(110,231,249,0.22)");
    expect(hexToHsl("#ff0000")).toBe("0 100 50");
    expect(hexToHsl("#6ee7f9")).toBe("188 92 70");
  });
});

describe("Frame depth (D10)", () => {
  const css = ["desk.css", "look.css"]
    .map((f) => readFileSync(join(__dirname, "../src/styles", f), "utf8"))
    .join("\n")
    .replace(/\s+/g, " ");
  const setWidth = (w: number) =>
    Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
  const realMatchMedia = window.matchMedia;
  const reduceMotion = () => {
    window.matchMedia = (q: string) =>
      ({ ...realMatchMedia(q), matches: q === REDUCED_MOTION_QUERY }) as MediaQueryList;
  };
  afterEach(() => {
    setWidth(1024);
    window.matchMedia = realMatchMedia;
  });
  const inner = () => win().querySelector(".win-inner") as HTMLElement;
  const section = () => win() as HTMLElement;
  /** A pointer move over the window at (fx, fy) of its box (jsdom has no layout: a 400 × 300 box). */
  const hover = (fx: number, fy: number) => {
    vi.spyOn(section(), "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    } as DOMRect);
    fireEvent.pointerMove(section(), { clientX: 400 * fx, clientY: 300 * fy });
  };

  it.each(CHROMES)("%s is a raised, lit object and keeps the accent bar", (chrome) => {
    render(
      <Frame {...base} chrome={chrome}>
        body
      </Frame>,
    );
    expect(inner()).toHaveClass("win-depth", `chrome-${chrome}`);
    // The lit top edge, dark bottom edge and inner highlight ring sit over every chrome's content.
    const edge = inner().querySelector(":scope > .win-edge");
    expect(edge).not.toBeNull();
    expect(edge).toHaveAttribute("aria-hidden", "true");
    expect(inner().querySelector(".win-bar > .win-acc")).not.toBeNull();
  });

  it("the depth recipe matches the sign-in card: layered shadows, lit edges, gradient body, glass", () => {
    const rule = (sel: string) => {
      const at = css.indexOf(`${sel} {`);
      expect(at, `${sel} rule`).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf("}", at));
    };
    const depth = rule(".win-depth");
    // Contact shadow + ambient + a wide soft drop.
    expect(depth).toMatch(/box-shadow: var\(--win-shadow\)/);
    const shadow = css.slice(
      css.indexOf("--win-shadow:"),
      css.indexOf(";", css.indexOf("--win-shadow:")),
    );
    expect(shadow).toMatch(/0 2px 4px rgba\(0, 0, 0, 0\.35\)/);
    expect(shadow).toMatch(/0 12px 24px -6px/);
    expect(shadow).toMatch(/0 40px 80px -20px/);
    expect(depth).toMatch(/background-image: var\(--win-body\)/);
    const edge = resolveTokens(rule(".win-edge"));
    expect(edge).toMatch(/inset 0 1px 0 rgba\(255, 255, 255, 0\.18\)/);
    expect(edge).toMatch(/inset 0 -1px 0 rgba\(0, 0, 0, 0\.5\)/);
    expect(edge).toMatch(/inset 0 0 0 1px/);
    expect(edge).toMatch(/pointer-events: none/);
    for (const chrome of CHROMES)
      expect(rule(`.win-inner.chrome-${chrome}`)).toMatch(/--win-body:/);
    // Liquid's glass is GlassSurface's own backdrop filter: a second one on the frame would hide it.
    for (const glass of ["glass", "spotlight"]) {
      expect(rule(`.win-inner.chrome-${glass}`)).toMatch(
        /backdrop-filter: blur\(\d+px\) saturate\(/,
      );
    }
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[^@]*\.win\[data-tilt\] \.win-depth/,
    );
  });

  it(`tilts toward the pointer by at most ${TILT_MAX_DEG}° and settles when it leaves`, () => {
    render(
      <Frame {...base} chrome="glass">
        body
      </Frame>,
    );
    hover(1, 0);
    expect(section()).toHaveAttribute("data-tilt");
    const rx = Number.parseFloat(section().style.getPropertyValue("--rx"));
    const ry = Number.parseFloat(section().style.getPropertyValue("--ry"));
    expect(rx).toBeCloseTo(TILT_MAX_DEG);
    expect(ry).toBeCloseTo(TILT_MAX_DEG);
    expect(TILT_MAX_DEG).toBeLessThanOrEqual(3);
    fireEvent.pointerLeave(section());
    expect(section()).not.toHaveAttribute("data-tilt");
    expect(section().style.getPropertyValue("--rx")).toBe("");
  });

  it("never tilts under reduced motion", () => {
    reduceMotion();
    render(
      <Frame {...base} chrome="glass">
        body
      </Frame>,
    );
    hover(1, 1);
    expect(section().style.getPropertyValue("--rx")).toBe("");
    expect(section().style.getPropertyValue("--ry")).toBe("");
    expect(section()).not.toHaveAttribute("data-tilt");
  });

  it("never tilts at phone width (390 px)", () => {
    setWidth(390);
    render(
      <Frame {...base} chrome="glass">
        body
      </Frame>,
    );
    hover(1, 1);
    expect(section().style.getPropertyValue("--rx")).toBe("");
    expect(section()).not.toHaveAttribute("data-tilt");
  });

  it("never tilts a window being dragged", () => {
    render(
      <Frame {...base} chrome="glass">
        body
      </Frame>,
    );
    hover(1, 1);
    expect(section()).toHaveAttribute("data-tilt");
    const bar = section().querySelector(".win-bar") as HTMLElement;
    fireEvent.pointerDown(bar, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(section()).not.toHaveAttribute("data-tilt");
    hover(0, 0);
    expect(section().style.getPropertyValue("--rx")).toBe("");
    fireEvent.pointerUp(bar, { pointerId: 1 });
  });

  it("reads the window's box once per hover, not on every pointer move", () => {
    render(
      <Frame {...base} chrome="glass">
        body
      </Frame>,
    );
    const box = vi.spyOn(section(), "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
    } as DOMRect);
    fireEvent.pointerEnter(section());
    for (let i = 0; i < 10; i++) {
      fireEvent.pointerMove(section(), { clientX: 40 * i, clientY: 30 * i });
    }
    expect(section()).toHaveAttribute("data-tilt");
    expect(box).toHaveBeenCalledTimes(1);
    // After a drag the window has moved: the next move measures again.
    const bar = section().querySelector(".win-bar") as HTMLElement;
    fireEvent.pointerDown(bar, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(bar, { pointerId: 1 });
    fireEvent.pointerMove(section(), { clientX: 200, clientY: 150 });
    expect(box).toHaveBeenCalledTimes(2);
  });

  it("tells the Desk when its title bar is dragged (tethers sway only then)", () => {
    const onDrag = vi.fn();
    render(
      <Frame {...base} chrome="glass" onDrag={onDrag}>
        body
      </Frame>,
    );
    const bar = section().querySelector(".win-bar") as HTMLElement;
    fireEvent.pointerDown(bar, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onDrag).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(bar, { pointerId: 1 });
    expect(onDrag).toHaveBeenLastCalledWith(false);
    expect(onDrag).toHaveBeenCalledTimes(2);
  });
});

describe("Frame Needs-you effects", () => {
  const cases: [AttnStyle, string][] = [
    ["pulse", ".win-attn.win-attn-pulse"],
    ["electric", ".electric-border.win-attn"],
    ["star", ".star-border.win-attn.win-attn-star"],
  ];
  it.each(cases)("attn='you' + %s renders its wrapper", (attnStyle, wrapper) => {
    render(
      <Frame {...base} attn="you" attnStyle={attnStyle}>
        body
      </Frame>,
    );
    const outer = win().firstElementChild;
    expect(outer?.matches(wrapper)).toBe(true);
    expect(outer?.querySelector(".win-inner")).not.toBeNull();
    // No effect may wrap the window in an interactive element: it holds buttons.
    expect(outer?.tagName).toBe("DIV");
    for (const [other, sel] of cases) {
      if (other !== attnStyle) expect(win().querySelector(sel)).toBeNull();
    }
  });

  it("defaults to the pulse", () => {
    render(
      <Frame {...base} attn="you">
        body
      </Frame>,
    );
    expect(win().firstElementChild).toHaveClass("win-attn-pulse");
  });

  it("wraps the chrome wrapper, and only at tier you", () => {
    const { rerender } = render(
      <Frame {...base} chrome="spotlight" attn="you" attnStyle="star">
        body
      </Frame>,
    );
    expect(win().querySelector(".star-border .spotlight-card .win-inner")).not.toBeNull();
    rerender(
      <Frame {...base} chrome="spotlight" attn="coordinator" attnStyle="star">
        body
      </Frame>,
    );
    expect(win().querySelector(".win-attn")).toBeNull();
    expect(win().firstElementChild).toHaveClass("spotlight-card");
  });
});

describe("Background", () => {
  function Boom(): never {
    throw new Error("no WebGL");
  }
  const Calm = () => <div data-testid="calm">calm</div>;
  const registry: BackgroundDef[] = [
    { key: "Boom", name: "Boom", C: Boom as unknown as BackgroundDef["C"] },
    { key: "Calm", name: "Calm", C: Calm as unknown as BackgroundDef["C"] },
    { key: "none", name: "None (plain)", C: null },
  ];

  it("shows the fallback message when the background throws, and recovers on a new pick", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container, rerender } = render(
      <Background which="Boom" dim={0.2} backgrounds={registry} />,
    );
    expect(container.querySelector(".bg-fallback")).toHaveTextContent(BG_FALLBACK);
    rerender(<Background which="Calm" dim={0.2} backgrounds={registry} />);
    expect(screen.getByTestId("calm")).toBeInTheDocument();
    expect(container.querySelector(".bg-fallback")).toBeNull();
    spy.mockRestore();
  });

  it("sets the dim overlay's opacity and renders nothing but the plain ground for None", () => {
    const { container } = render(<Background which="none" dim={0.55} backgrounds={registry} />);
    expect((container.querySelector(".bg-dim") as HTMLElement).style.opacity).toBe("0.55");
    expect(container.querySelector(".bg-plain")).not.toBeNull();
  });

  describe("a background chunk that fails to load", () => {
    const chunkError = () =>
      new TypeError("Failed to fetch dynamically imported module: /assets/Boom.js");
    const settle = () => act(async () => {});

    it("says it couldn't load and offers Retry, not the no-WebGL message", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const Missing = lazy(() => Promise.reject(chunkError()));
      const reg: BackgroundDef[] = [
        { key: "Missing", name: "Missing", C: Missing as BackgroundDef["C"] },
      ];
      const { container } = render(<Background which="Missing" dim={0.2} backgrounds={reg} />);
      await settle();
      expect(screen.getByRole("alert")).toHaveTextContent(BG_LOAD_FAILED);
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(container).not.toHaveTextContent(BG_FALLBACK);
      // The notice sits outside the aria-hidden background layer, so it can be read and clicked.
      expect(screen.getByRole("alert").closest("[aria-hidden]")).toBeNull();
      spy.mockRestore();
    });

    const Calm = () => <div data-testid="calm">calm</div>;
    /** A loader that fails once with `err`, then works; and a fetch that serves the retry. */
    const flaky = (err: Error) => {
      const load = vi
        .fn<() => Promise<{ default: unknown }>>()
        .mockRejectedValueOnce(err)
        .mockResolvedValue({ default: Calm });
      const fetch = {
        importUrl: vi.fn(async (_url: string) => ({ default: Calm as unknown })),
        addStylesheet: vi.fn(async (_url: string) => {}),
      };
      return { load, fetch, C: lazyBackground(load, fetch) };
    };

    it("Retry fetches the failed chunk again under a fresh URL and renders the background", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { load, fetch, C } = flaky(chunkError());
      render(
        <Background which="Flaky" dim={0.2} backgrounds={[{ key: "Flaky", name: "Flaky", C }]} />,
      );
      await settle();
      expect(screen.getByRole("alert")).toHaveTextContent(BG_LOAD_FAILED);
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await settle();
      // The browser keeps the failed import, so the same URL would fail again without a fetch.
      expect(fetch.importUrl).toHaveBeenCalledTimes(1);
      expect(fetch.importUrl.mock.calls[0]?.[0]).toMatch(/^\/assets\/Boom\.js\?retry=\d+$/);
      expect(load).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("calm")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).toBeNull();
      spy.mockRestore();
    });

    it("a stylesheet that failed is added again, then the loader runs", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { load, fetch, C } = flaky(new Error("Unable to preload CSS for /assets/Boom.css"));
      render(
        <Background which="Flaky" dim={0.2} backgrounds={[{ key: "Flaky", name: "Flaky", C }]} />,
      );
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await settle();
      expect(fetch.addStylesheet.mock.calls[0]?.[0]).toMatch(/^\/assets\/Boom\.css\?retry=\d+$/);
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("calm")).toBeInTheDocument();
      spy.mockRestore();
    });

    it("an error naming no chunk (Safari) retries with the loader", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { load, fetch, C } = flaky(new TypeError("Importing a module script failed."));
      render(
        <Background which="Flaky" dim={0.2} backgrounds={[{ key: "Flaky", name: "Flaky", C }]} />,
      );
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await settle();
      expect(fetch.importUrl).not.toHaveBeenCalled();
      expect(load).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("calm")).toBeInTheDocument();
      spy.mockRestore();
    });

    it("fetches again after picking another background and coming back", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { fetch, C } = flaky(chunkError());
      const reg: BackgroundDef[] = [
        { key: "Flaky", name: "Flaky", C },
        { key: "none", name: "None (plain)", C: null },
      ];
      const { rerender } = render(<Background which="Flaky" dim={0.2} backgrounds={reg} />);
      await settle();
      expect(screen.getByRole("alert")).toBeInTheDocument();
      rerender(<Background which="none" dim={0.2} backgrounds={reg} />);
      expect(screen.queryByRole("alert")).toBeNull();
      rerender(<Background which="Flaky" dim={0.2} backgrounds={reg} />);
      await settle();
      expect(fetch.importUrl).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("calm")).toBeInTheDocument();
      spy.mockRestore();
    });

    it("does not retry on its own: one failed load is one import", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const load = vi.fn<() => Promise<{ default: unknown }>>().mockRejectedValue(chunkError());
      const reg: BackgroundDef[] = [{ key: "Gone", name: "Gone", C: lazyBackground(load) }];
      render(<Background which="Gone" dim={0.2} backgrounds={reg} />);
      await settle();
      await settle();
      expect(load).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alert")).toBeInTheDocument();
      spy.mockRestore();
    });

    it("a render error keeps the no-WebGL message and offers no Retry", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      render(<Background which="Boom" dim={0.2} backgrounds={registry} />);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      spy.mockRestore();
    });
  });

  it("names the chunk a load error names", () => {
    expect(
      failedChunk(
        new TypeError("Failed to fetch dynamically imported module: http://x/assets/a-1.js"),
      ),
    ).toBe("http://x/assets/a-1.js");
    expect(
      failedChunk(new TypeError("error loading dynamically imported module: /assets/a.js?retry=5")),
    ).toBe("/assets/a.js");
    expect(failedChunk(new Error("Unable to preload CSS for /assets/a.css"))).toBe("/assets/a.css");
    expect(failedChunk(new TypeError("Importing a module script failed."))).toBeNull();
    expect(failedChunk("nope")).toBeNull();
  });

  it("adds a stylesheet and settles on its load or error", async () => {
    const ok = addStylesheet("/assets/ok.css");
    const okLink = document.head.querySelector('link[href="/assets/ok.css"]') as HTMLLinkElement;
    okLink.dispatchEvent(new Event("load"));
    await expect(ok).resolves.toBeUndefined();
    const bad = addStylesheet("/assets/bad.css");
    (document.head.querySelector('link[href="/assets/bad.css"]') as HTMLLinkElement).dispatchEvent(
      new Event("error"),
    );
    expect(await bad.catch((e: Error) => e.message)).toBe(
      "Unable to preload CSS for /assets/bad.css",
    );
    expect(document.head.querySelector('link[href="/assets/bad.css"]')).toBeNull();
    okLink.remove();
  });

  it("tells a chunk-load failure apart from a render failure", () => {
    for (const m of [
      "Failed to fetch dynamically imported module: https://x/assets/a.js",
      "error loading dynamically imported module: https://x/assets/a.js",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/a.css",
    ]) {
      expect(isChunkLoadError(new TypeError(m))).toBe(true);
    }
    const named = new Error("Loading chunk 7 failed.");
    named.name = "ChunkLoadError";
    expect(isChunkLoadError(named)).toBe(true);
    expect(isChunkLoadError(new Error("WebGL context could not be created"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch")).toBe(false);
  });
});
