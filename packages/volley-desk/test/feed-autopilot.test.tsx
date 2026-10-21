import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { autopilotLine } from "../src/store/autopilot";
import { initialState, reduceAll, routeTopic } from "../src/store/reducer";
import type { DeskMessage, Envelope, WaveStatePayload } from "../src/store/types";
import { Feed } from "../src/windows/agent/Feed";

const T0 = Date.parse("2026-10-20T12:00:00Z");
const IMPL = "w1-t3-implementer-1";

function event(type: string, data: Record<string, unknown>, seq: number, task?: string): Envelope {
  return {
    schema_version: "0.1",
    agent_id: "volleyd",
    channel: "_waves/events",
    type,
    wall_time: new Date(T0 + seq * 1000).toISOString(),
    payload: { wave: "w1", seq, at: new Date(T0 + seq * 1000).toISOString(), task, data },
  };
}

const AUTO = event(
  "decision_auto_resolved",
  {
    decision_id: "w1-t3-hooks_auth_failed-1",
    kind: "hooks_auth_failed",
    policy: "hooks_auth_failed/relaunch",
    answer: "relaunch",
    rationale: "a bad launch is cheaper to retry than to read",
    evidence: { screen_hash: "abc123", attempts: 1 },
    budget: { key: "relaunch_max:T3/implementer", used: 1, max: 1 },
  },
  41,
  "T3",
);
const ESCALATED = event(
  "decision_escalated",
  { decision_id: "w1-plan-1", kind: "plan_change", why: "owner_only" },
  42,
);

const state: WaveStatePayload = {
  wave: "w1",
  version: 1,
  owner: "lead",
  repo: "example-org/example-repo",
  release_branch: "release/w1",
  status: "running",
  tasks: [{ id: "T3", issue: 3, stage: "implement", agents: { implementer: IMPL } }],
  open_decisions: [],
  gates: [],
  updated_at: new Date(T0).toISOString(),
};

const m = (topic: string, envelope: Envelope, receivedAt = T0): DeskMessage => ({
  topic,
  envelope,
  receivedAt,
});

function stored() {
  return reduceAll(initialState(), [
    m(`volley/default/${IMPL}/status`, {
      schema_version: "0.1",
      agent_id: IMPL,
      channel: "status",
      type: "working",
      payload: {},
    }),
    m("volley/_waves/w1/state", {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_waves/state",
      type: "wave_state",
      payload: state,
    }),
    m("volley/_waves/w1/events", AUTO),
    m("volley/_waves/w1/events", ESCALATED),
    // Any other journal event is not the Desk's news (only autopilot's are kept).
    m("volley/_waves/w1/events", event("stage_entered", { stage: "implement" }, 43, "T3")),
  ]);
}

describe("autopilot lines", () => {
  it("say what autopilot answered, under which policy and why, or why it could not", () => {
    expect(autopilotLine(AUTO)).toBe(
      "Autopilot · relaunch (hooks_auth_failed/relaunch): a bad launch is cheaper to retry than to read",
    );
    expect(autopilotLine(ESCALATED)).toBe("Autopilot could not resolve (owner_only)");
    expect(autopilotLine(event("stage_entered", {}, 1))).toBeNull();
  });
});

describe("the store's autopilot feed", () => {
  it("routes a wave's events topic", () => {
    expect(routeTopic("volley/_waves/w1/events")).toEqual({ kind: "waveEvent", wave: "w1" });
  });

  it("keeps the two autopilot events per wave, and on the agent of the event's task", () => {
    const s = stored();
    expect(s.waveFeed?.w1?.map((e) => e.envelope.type)).toEqual([
      "decision_auto_resolved",
      "decision_escalated",
    ]);
    // The wave-level escalation has no task: it is the wave's only.
    expect(s.agents[IMPL]?.feed.map((e) => e.envelope.type)).toEqual([
      "working",
      "decision_auto_resolved",
    ]);
  });

  it("ignores events from anyone but volleyd", () => {
    const forged = { ...AUTO, agent_id: "someone" };
    const s = reduceAll(initialState(), [m("volley/_waves/w1/events", forged)]);
    expect(s.waveFeed?.w1 ?? []).toEqual([]);
  });

  it("keeps the wave's autopilot feed across a reconnect's resync", async () => {
    const { resync } = await import("../src/store/reducer");
    expect(resync(stored()).waveFeed?.w1).toHaveLength(2);
  });
});

describe("Feed rows for autopilot events", () => {
  it("render the autopilot line, with the evidence JSON behind the row's disclosure", () => {
    const s = stored();
    render(<Feed feed={s.waveFeed?.w1 ?? []} />);
    const row = screen.getByText(/^Autopilot · relaunch/).closest(".env-row") as HTMLElement;
    expect(row).toHaveTextContent("decision_auto_resolved");
    expect(screen.getByText("Autopilot could not resolve (owner_only)")).toBeInTheDocument();
    expect(screen.queryByText(/screen_hash/)).toBeNull();
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText(/"screen_hash": "abc123"/)).toBeInTheDocument();
  });
});
