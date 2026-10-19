/**
 * Gooey Nav and WebGL (D10): a browser keeps about 16 live WebGL contexts per
 * page (8 on Android) and drops the oldest past that, so the agent windows'
 * tabs must not open one each. `GooeyTabs` draws the goo as a CSS clip-path
 * (`gl={false}`); a vendored Gooey Nav that does draw with WebGL falls back to
 * the same clip-path pill when its context is lost, and releases the context
 * on unmount.
 */
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import GooeyNav from "../src/rb/GooeyNav/GooeyNav";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import { AgentWindow } from "../src/windows/agent/AgentWindow";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

afterEach(() => vi.restoreAllMocks());

/** A WebGL2 context that accepts every call; `loseContext` is observable. */
function fakeGL(loseContext: () => void) {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_, prop) {
      if (prop === "getExtension") {
        return (name: string) => (name === "WEBGL_lose_context" ? { loseContext } : null);
      }
      return () => ({});
    },
  });
}

/** Counts WebGL `getContext` calls and hands out fake contexts. */
function countWebGL() {
  const loseContext = vi.fn();
  const calls: string[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (!/webgl/.test(kind)) return null;
    calls.push(this.className);
    return fakeGL(loseContext);
  } as unknown as HTMLCanvasElement["getContext"]);
  return { calls, loseContext };
}

describe("Gooey Nav without a WebGL context per window", () => {
  it("20 agent windows open no WebGL context for their tabs, and each still shows its pill", () => {
    const { calls } = countWebGL();
    const state = reduceAll(initialState(), demoMessages(NOW));
    const agents = Object.values(state.agents);
    const { container } = render(
      <div>
        {Array.from({ length: 20 }, (_, i) => {
          const agent = agents[i % agents.length];
          if (!agent) throw new Error("no demo agents");
          return (
            <AgentWindow
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of 20 copies
              key={i}
              agent={agent}
              wave={state.waves[agent.wave]}
              accent="#c4b5fd"
              frame={frame}
              now={NOW}
            />
          );
        })}
      </div>,
    );
    const navs = container.querySelectorAll(".gooey-tabs");
    expect(navs).toHaveLength(20);
    expect(calls.filter((c) => c.includes("gooey-nav__canvas"))).toHaveLength(0);
    for (const nav of navs) {
      const pill = nav.querySelector<HTMLElement>(".gooey-nav__fallback");
      expect(pill?.style.display).toBe("block");
      expect(pill?.style.clipPath).toMatch(/^path\(/);
      expect(nav.querySelector<HTMLElement>(".gooey-nav__canvas")?.style.display).toBe("none");
    }
  });

  it("a WebGL Gooey Nav whose context is lost falls back to the clip-path pill", () => {
    const { calls } = countWebGL();
    const { container } = render(<GooeyNav items={[{ label: "One" }, { label: "Two" }]} />);
    expect(calls).toHaveLength(1);
    const canvas = container.querySelector<HTMLCanvasElement>(".gooey-nav__canvas");
    const pill = container.querySelector<HTMLElement>(".gooey-nav__fallback");
    expect(canvas?.style.display).toBe("block");
    expect(pill?.style.display).toBe("none");
    act(() => {
      canvas?.dispatchEvent(new Event("webglcontextlost"));
    });
    expect(canvas?.style.display).toBe("none");
    expect(pill?.style.display).toBe("block");
    expect(pill?.style.clipPath).toMatch(/^path\(/);
  });

  it("releases its WebGL context once unmounted", async () => {
    const { loseContext } = countWebGL();
    const { unmount } = render(<GooeyNav items={[{ label: "One" }, { label: "Two" }]} />);
    expect(loseContext).not.toHaveBeenCalled();
    unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(loseContext).toHaveBeenCalledTimes(1);
  });
});
