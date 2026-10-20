import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState, reduceAll, sessionCount, workingCount } from "../src/store/reducer";
import type { DeskMessage } from "../src/store/types";
import { TopBar } from "../src/topbar/TopBar";

const NOW = Date.parse("2026-10-19T12:00:00Z");

function agent(id: string, parent: string | null, reg: Record<string, unknown>): DeskMessage[] {
  const env = (channel: string, type: string, payload: object) => ({
    schema_version: "0.1",
    agent_id: id,
    parent_id: parent,
    wall_time: new Date(NOW).toISOString(),
    channel,
    type,
    payload,
  });
  return [
    {
      topic: `volley/_system/registry/${id}`,
      envelope: env("_system/registry", "registered", {
        capabilities: [],
        started_at: new Date(NOW).toISOString(),
        ...reg,
      }),
      receivedAt: NOW,
    },
    {
      topic: `volley/default/${id}/status`,
      envelope: env("status", "working", {}),
      receivedAt: NOW,
    },
  ];
}

const state = () =>
  reduceAll(initialState(), [
    ...agent("coordinator-8fb2", "coordinator-ab12", { title: "#155 spec review" }),
    ...agent("coordinator-t7j0", null, { model_source: "harness-hook" }),
    ...agent("coordinator-q2w3", null, { model_source: "harness-hook" }),
  ]);

describe("sessions are not agents working", () => {
  it("workingCount leaves sessions out; sessionCount counts them", () => {
    const s = state();
    expect(workingCount(s)).toBe(1);
    expect(sessionCount(s)).toBe(2);
  });

  it("the top bar says `1 agent working · 2 sessions`", () => {
    const { container } = render(
      <TopBar
        state={state()}
        connection="connected"
        demo={false}
        needsYou={0}
        onNeedsYou={() => {}}
        coordsOpen={false}
        onToggleCoords={() => {}}
        notify={{ enabled: false, sound: false, on: [] } as never}
        setNotify={() => {}}
        now={NOW}
      />,
    );
    const mid = container.querySelector(".topbar-mid") as HTMLElement;
    expect(mid).toHaveTextContent("1 agent working");
    expect(mid).toHaveTextContent("2 sessions");
    expect(mid).not.toHaveTextContent("3 agents working");
  });
});
