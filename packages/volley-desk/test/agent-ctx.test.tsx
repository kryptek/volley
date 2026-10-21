import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { REDUCED_MOTION_QUERY } from "../src/a11y/motion";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { DeskMessage, UsagePayload } from "../src/store/types";
import { AgentWindow, CTX_PULSE_PCT, contextMeter } from "../src/windows/agent/AgentWindow";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const FIXUP = "status-chip-t1-fixup-1";
const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

const usage = (cw: UsagePayload["context_window"]): UsagePayload => ({
  account: "work",
  model: "claude-opus-5-5",
  context_window: cw,
  rate_limits: {},
  captured_at: new Date(NOW).toISOString(),
});

const usageMsg = (id: string, p: UsagePayload | null): DeskMessage => ({
  topic: `volley/demo/${id}/usage`,
  envelope:
    p === null
      ? null
      : {
          schema_version: "0.1",
          agent_id: id,
          channel: "usage",
          type: "usage",
          wall_time: p.captured_at,
          payload: p,
        },
  receivedAt: NOW,
  retained: true,
});

/** An agent the demo gives no usage sample. */
const BARE = "leaderboard-t1-implementer-1";

function renderWith(...extra: DeskMessage[]) {
  return renderAgent(FIXUP, ...extra);
}

function renderAgent(id: string, ...extra: DeskMessage[]) {
  const state = reduceAll(initialState(), [...demoMessages(NOW), ...extra]);
  const agent = state.agents[id];
  if (!agent) throw new Error("no agent");
  return render(
    <AgentWindow
      agent={agent}
      wave={state.waves[agent.wave]}
      accent="#c4b5fd"
      frame={frame}
      now={NOW}
      usage={state.usage?.[id] ?? null}
    />,
  );
}

describe("agent window context meter", () => {
  it("a usage record renders `ctx 72% · 143K/200K` with the warn class", () => {
    const { container } = renderWith(
      usageMsg(FIXUP, usage({ used_percentage: 72, used: 143_000, size: 200_000 })),
    );
    const ctx = container.querySelector(".agent-foot .ctx") as HTMLElement;
    expect(ctx).toHaveTextContent("ctx 72% · 143K/200K");
    expect(ctx).toHaveClass("ctx--warn");
    expect(ctx.querySelector(".ctx-bar > span")).toHaveStyle({ width: "72%" });
  });

  it("no usage record → no meter", () => {
    const { container } = renderAgent(BARE);
    expect(container.querySelector(".ctx")).toBeNull();
  });

  it("a cleared usage topic removes the meter", () => {
    const { container } = renderWith(
      usageMsg(FIXUP, usage({ used_percentage: 72, used: 143_000, size: 200_000 })),
      usageMsg(FIXUP, null),
    );
    expect(container.querySelector(".ctx")).toBeNull();
  });

  it("usage traffic stays out of the agent's feed", () => {
    const state = reduceAll(initialState(), demoMessages(NOW));
    const before = state.agents[FIXUP]?.feed.length;
    const after = reduceAll(state, [
      usageMsg(FIXUP, usage({ used_percentage: 5, used: 50_000, size: 1_000_000 })),
    ]);
    expect(after.agents[FIXUP]?.feed.length).toBe(before);
    expect(after.usage?.[FIXUP]?.context_window.used).toBe(50_000);
  });
});

describe("contextMeter", () => {
  it("tones: hot ≥ 85, warn ≥ 65, ok below", () => {
    expect(contextMeter(usage({ used_percentage: 85, used: 170_000, size: 200_000 }))?.tone).toBe(
      "hot",
    );
    expect(contextMeter(usage({ used_percentage: 65, used: 130_000, size: 200_000 }))?.tone).toBe(
      "warn",
    );
    expect(contextMeter(usage({ used_percentage: 64, used: 128_000, size: 200_000 }))?.tone).toBe(
      "ok",
    );
  });

  it("formats millions and falls back to used/size when the percentage is missing", () => {
    expect(contextMeter(usage({ used_percentage: 4, used: 38_427, size: 1_000_000 }))?.text).toBe(
      "ctx 4% · 38K/1M",
    );
    expect(
      contextMeter(usage({ used_percentage: null, used: 750_000, size: 1_500_000 }))?.text,
    ).toBe("ctx 50% · 750K/1.5M");
  });

  it("nothing known yet → no meter", () => {
    expect(contextMeter(usage({ used_percentage: null, used: null, size: 200_000 }))).toBeNull();
    expect(contextMeter(null)).toBeNull();
  });
});

describe("contextMeter pulse", () => {
  const at = (pct: number) =>
    contextMeter(usage({ used_percentage: pct, used: pct * 2000, size: 200_000 }));

  it("pulses slowly from 70% and fast once red (85%)", () => {
    expect(CTX_PULSE_PCT).toBe(70);
    expect(at(69)).toMatchObject({ tone: "warn", pulse: "none" });
    expect(at(70)).toMatchObject({ tone: "warn", pulse: "slow" });
    expect(at(84)).toMatchObject({ tone: "warn", pulse: "slow" });
    expect(at(85)).toMatchObject({ tone: "hot", pulse: "fast" });
    expect(at(100)).toMatchObject({ tone: "hot", pulse: "fast" });
    expect(at(10)).toMatchObject({ tone: "ok", pulse: "none" });
  });
});

describe("agent window context meter pulse", () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  const meterAt = (pct: number) => {
    const { container } = renderWith(
      usageMsg(FIXUP, usage({ used_percentage: pct, used: pct * 2000, size: 200_000 })),
    );
    return container.querySelector(".agent-foot .ctx") as HTMLElement;
  };

  it("69%: amber, no pulse", () => {
    const ctx = meterAt(69);
    expect(ctx).toHaveClass("ctx--warn");
    expect(ctx).not.toHaveClass("ctx--pulse-slow");
    expect(ctx).not.toHaveClass("ctx--pulse-fast");
  });

  it("70%: amber, slow pulse", () => {
    const ctx = meterAt(70);
    expect(ctx).toHaveClass("ctx--warn", "ctx--pulse-slow");
    expect(ctx).not.toHaveClass("ctx--pulse-fast");
  });

  it("85%: red, fast pulse; text and bar width unchanged", () => {
    const ctx = meterAt(85);
    expect(ctx).toHaveClass("ctx--hot", "ctx--pulse-fast");
    expect(ctx).not.toHaveClass("ctx--pulse-slow");
    expect(ctx).toHaveTextContent("ctx 85% · 170K/200K");
    expect(ctx.querySelector(".ctx-bar > span")).toHaveStyle({ width: "85%" });
  });

  it("under reduced motion: the colour changes, nothing pulses", () => {
    window.matchMedia = ((query: string) => ({
      matches: query === REDUCED_MOTION_QUERY,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    const ctx = meterAt(85);
    expect(ctx).toHaveClass("ctx--hot");
    expect(ctx.className).not.toMatch(/ctx--pulse-/);
  });
});

const STYLES = join(__dirname, "../src/styles");
const css = (f: string) => readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every declaration of the rules whose selector list includes exactly `selector`. */
function decls(sheet: string, selector: string): string {
  const out: string[] = [];
  for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = (m[1] ?? "").split(",").map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2] ?? "");
  }
  return out.join(";").replace(/\s+/g, " ");
}

/** The `@media (prefers-reduced-motion: reduce)` blocks of a sheet, each up to its closing brace. */
function reducedMotion(sheet: string): string {
  const out: string[] = [];
  let at = sheet.indexOf("@media (prefers-reduced-motion: reduce)");
  while (at >= 0) {
    let depth = 0;
    let end = sheet.indexOf("{", at);
    for (; end < sheet.length; end++) {
      if (sheet[end] === "{") depth++;
      if (sheet[end] === "}" && --depth === 0) break;
    }
    out.push(sheet.slice(at, end + 1));
    at = sheet.indexOf("@media (prefers-reduced-motion: reduce)", end);
  }
  return out.join("\n");
}

const seconds = (d: string, prop: string) => {
  const m = new RegExp(`${prop}:[^;]*?([0-9.]+)s`).exec(d);
  return m ? Number(m[1]) : Number.NaN;
};

describe("context meter pulse: the stylesheet", () => {
  const SLOW = ".ctx--pulse-slow .ctx-bar > span";
  const FAST = ".ctx--pulse-fast .ctx-bar > span";
  const agent = css("agent.css");

  it("pulses the bar with ctx-pulse, faster when hot", () => {
    expect(agent).toMatch(/@keyframes ctx-pulse\s*\{/);
    const slow = decls(agent, SLOW);
    expect(slow).toMatch(/animation: ctx-pulse /);
    const fast = decls(agent, FAST);
    expect(fast).toMatch(/animation: ctx-pulse /);
    expect(seconds(fast, "animation")).toBeLessThan(seconds(slow, "animation"));
  });

  it("stops both under prefers-reduced-motion, in agent.css and responsive.css", () => {
    for (const f of ["agent.css", "responsive.css"]) {
      const block = reducedMotion(css(f));
      expect(decls(block, SLOW), f).toMatch(/animation: none/);
      expect(decls(block, FAST), f).toMatch(/animation: none/);
    }
  });
});
