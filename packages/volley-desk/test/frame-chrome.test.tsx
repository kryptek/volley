import { act, fireEvent, render, screen } from "@testing-library/react";
import { lazy } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  type AttnStyle,
  type Chrome,
  Frame,
  type FrameProps,
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

  it("tints the spotlight and glow with the accent", () => {
    expect(hexA("#6ee7f9", 0.22)).toBe("rgba(110,231,249,0.22)");
    expect(hexToHsl("#ff0000")).toBe("0 100 50");
    expect(hexToHsl("#6ee7f9")).toBe("188 92 70");
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
