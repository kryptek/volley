import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCENE_ALT, SCENE_IDS, type SceneId, StepArt } from "../src/getting-started/art";
import {
  ART_MAP_URL,
  __resetArtMapForTests,
  loadArtMap,
} from "../src/getting-started/art/assetMap";

const ART_DIR = path.resolve(__dirname, "../src/getting-started/art");

/** `fetch` answering `art.json` with `body` (or `status`); anything else is a test bug. */
function fakeFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (url: string) => {
    if (url !== ART_MAP_URL) throw new Error(`unexpected fetch ${url}`);
    return new Response(status === 200 ? JSON.stringify(body) : "not found", { status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** `matchMedia` reporting `reduce` for the reduced-motion query. */
function fakeMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query === "(prefers-reduced-motion: reduce)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  __resetArtMapForTests();
  fakeFetch({ version: 1, scenes: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROPS: Record<SceneId, { otters: number; parts: string[] }> = {
  welcome: { otters: 3, parts: ['[data-part="ball"]'] },
  "this-computer": { otters: 1, parts: ['[data-prop="wrench"]', '[data-hat="hard"]'] },
  machines: { otters: 1, parts: ['[data-prop="plug"]'] },
  repos: { otters: 1, parts: ['[data-prop="box"]'] },
  people: { otters: 2, parts: ['[data-hat="crown"]', '[data-prop="badge"]'] },
  access: {
    otters: 1,
    parts: ['[data-hat="headset"]', '[data-prop="globe"]', '[data-prop="phone"]'],
  },
  done: {
    otters: 3,
    parts: ['[data-hat="party"]', '[data-prop="flag"]', '[data-part="confetti"]'],
  },
};

describe("StepArt scenes", () => {
  it("names the seven wizard steps", () => {
    expect(SCENE_IDS).toEqual([
      "welcome",
      "this-computer",
      "machines",
      "repos",
      "people",
      "access",
      "done",
    ]);
    expect(SCENE_ALT.welcome).toBe("Three otters tossing a volleyball between them");
  });

  it.each(SCENE_IDS)("%s: an inline svg named by its alt text, with its otters and props", (id) => {
    const { container } = render(<StepArt scene={id} />);
    const svg = container.querySelector(`svg[role="img"][data-scene="${id}"]`);
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("aria-label")).toBe(SCENE_ALT[id]);
    expect(svg?.querySelector("title")?.textContent).toBe(SCENE_ALT[id]);
    expect(svg?.querySelectorAll('[data-part="otter"]')).toHaveLength(PROPS[id].otters);
    for (const sel of PROPS[id].parts) {
      // The drawn hat or prop itself, not an attribute on the otter's group.
      const part = svg?.querySelector(`${sel}:not([data-part="otter"])`);
      expect(part, sel).not.toBeNull();
      expect(part?.children.length, sel).toBeGreaterThan(0);
    }
  });

  it("only the Welcome scene blinks", () => {
    for (const id of SCENE_IDS) {
      const { container, unmount } = render(<StepArt scene={id} />);
      const blinks = container.querySelectorAll(".gs-blink").length;
      if (id === "welcome") expect(blinks, id).toBeGreaterThan(0);
      else expect(blinks, id).toBe(0);
      unmount();
    }
  });

  it("the repos box is labelled repo", () => {
    const { container } = render(<StepArt scene="repos" />);
    const texts = [...container.querySelectorAll("text")].map((t) => t.textContent);
    expect(texts).toContain("repo");
  });

  it("no two scenes render the same markup", () => {
    const html = SCENE_IDS.map((id) => {
      const { container, unmount } = render(<StepArt scene={id} />);
      const out = container.innerHTML;
      unmount();
      return out;
    });
    expect(new Set(html).size).toBe(SCENE_IDS.length);
  });

  it("size fixes the width in px; without it the art fills its container", () => {
    const { container, rerender } = render(<StepArt scene="machines" size={96} className="x" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("96");
    expect(svg?.getAttribute("height")).toBe("96");
    // Inline, so it beats `.gs-art { width: 100% }` in a browser.
    expect(svg?.style.width).toBe("96px");
    expect(svg?.style.height).toBe("96px");
    expect(svg?.classList.contains("gs-art")).toBe(true);
    expect(svg?.classList.contains("x")).toBe(true);
    rerender(<StepArt scene="machines" />);
    expect(container.querySelector("svg")?.hasAttribute("width")).toBe(false);
    expect(container.querySelector("svg")?.style.width).toBe("");
  });
});

describe("the Welcome toss and reduced motion", () => {
  it("full motion: the ball travels an offset-path", () => {
    fakeMotion(false);
    const { container } = render(<StepArt scene="welcome" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-motion")).toBe("full");
    const ball = svg?.querySelector<SVGGElement>('[data-part="ball"]');
    expect(ball?.getAttribute("style") ?? "").toMatch(/offset-path:\s*path\(/);
    expect(svg?.querySelectorAll(".gs-blink").length).toBeGreaterThanOrEqual(3);
    expect(svg?.querySelectorAll(".gs-bob").length).toBeGreaterThanOrEqual(3);
  });

  it("reduced motion: a static frame, the ball fixed mid-air", () => {
    fakeMotion(true);
    const { container } = render(<StepArt scene="welcome" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("data-motion")).toBe("reduced");
    const ball = svg?.querySelector('[data-part="ball"]');
    expect(ball?.getAttribute("transform")).toMatch(/^translate\(\d+(\.\d+)? \d+(\.\d+)?\)$/);
    expect(ball?.getAttribute("style") ?? "").not.toMatch(/offset-path/);
  });

  it("the stylesheet stops every animation under reduced motion", () => {
    const css = readFileSync(
      path.resolve(__dirname, "../src/styles/getting-started-art.css"),
      "utf8",
    );
    for (const k of ["gs-bob", "gs-blink", "gs-toss"]) expect(css).toContain(`@keyframes ${k}`);
    const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(block).toMatch(/\.gs-bob[\s\S]*\.gs-blink[\s\S]*\.gs-toss[\s\S]*animation:\s*none/);
  });
});

describe("the asset map", () => {
  it("a mapped scene renders its raster, the others their svg", async () => {
    const fetch = fakeFetch({ version: 1, scenes: { repos: "repos.webp" } });
    const { container } = render(
      <>
        <StepArt scene="repos" size={200} />
        <StepArt scene="welcome" />
      </>,
    );
    await waitFor(() => expect(container.querySelector("img")).not.toBeNull());
    const img = container.querySelector("img");
    expect(img?.getAttribute("src")).toBe("/getting-started/repos.webp");
    expect(img?.getAttribute("alt")).toBe(SCENE_ALT.repos);
    expect(img?.getAttribute("width")).toBe("200");
    expect(img?.style.width).toBe("200px");
    expect(img?.style.height).toBe("200px");
    expect(img?.classList.contains("gs-art")).toBe(true);
    expect(container.querySelector('svg[data-scene="repos"]')).toBeNull();
    expect(container.querySelector('svg[data-scene="welcome"]')).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches once per page load", async () => {
    const fetch = fakeFetch({ version: 1, scenes: { done: "done.png" } });
    const a = render(<StepArt scene="done" />);
    await waitFor(() => expect(a.container.querySelector("img")).not.toBeNull());
    a.unmount();
    // The map has arrived: a later mount paints the raster at once, no vector frame first.
    const b = render(<StepArt scene="done" />);
    expect(b.container.querySelector("img")).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a 404", () => fakeFetch(null, 404)],
    [
      "a network error",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => {
            throw new TypeError("offline");
          }),
        ),
    ],
    [
      "malformed JSON",
      () =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response("{nope", { status: 200 })),
        ),
    ],
  ])("%s: every scene renders its svg", async (_, arrange) => {
    arrange();
    const { container } = render(
      <div>
        {SCENE_IDS.map((id) => (
          <StepArt key={id} scene={id} />
        ))}
      </div>,
    );
    // The failed load has settled to the empty map, so the svgs are final, not merely early.
    await expect(loadArtMap()).resolves.toEqual({});
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    expect(container.querySelectorAll("svg[data-scene]")).toHaveLength(SCENE_IDS.length);
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("the art module's boundaries", () => {
  it("imports nothing from clawd/, windows/ or settings/", () => {
    for (const f of readdirSync(ART_DIR)) {
      const src = readFileSync(path.join(ART_DIR, f), "utf8");
      expect(src, f).not.toMatch(/from\s+["'][^"']*\/(clawd|windows|settings)\//);
    }
  });
});
