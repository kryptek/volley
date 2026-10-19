import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { DeskMessage, UsagePayload } from "../src/store/types";
import { AgentWindow, contextMeter } from "../src/windows/agent/AgentWindow";

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
