import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { plural } from "../src/lib/plural";
import { initialState, reduceAll } from "../src/store/reducer";
import type { DeskMessage } from "../src/store/types";
import { TopBar, type TopBarProps } from "../src/topbar/TopBar";

describe("plural", () => {
  it("counts one thing in the singular and any other number in the plural", () => {
    expect(plural(1, "agent")).toBe("1 agent");
    expect(plural(2, "agent")).toBe("2 agents");
    expect(plural(0, "gate")).toBe("0 gates");
    expect(plural(1, "decision")).toBe("1 decision");
  });

  it("takes an irregular plural", () => {
    expect(plural(3, "person", "people")).toBe("3 people");
    expect(plural(1, "person", "people")).toBe("1 person");
  });
});

describe("TopBar grammar", () => {
  const working = (id: string): DeskMessage => ({
    topic: `volley/default/${id}/status`,
    envelope: {
      schema_version: "0.1",
      agent_id: id,
      channel: "status",
      type: "working",
      wall_time: "2026-10-18T12:00:00.000Z",
      payload: {},
    },
    receivedAt: 1,
  });
  const props = (msgs: DeskMessage[]): TopBarProps => ({
    state: reduceAll(initialState(), msgs),
    connection: "connected",
    demo: true,
    needsYou: 0,
    onNeedsYou: () => {},
    coordsOpen: true,
    onToggleCoords: () => {},
    notify: { enabled: false, sound: false, on: [] },
    setNotify: () => {},
  });

  it("renders `1 agent working`, then `2 agents working`", () => {
    const { container, rerender } = render(createElement(TopBar, props([working("a1")])));
    const mid = () => container.querySelector(".topbar-mid")?.textContent ?? "";
    expect(mid()).toContain("1 agent working");
    expect(mid()).toContain("0 waves");
    rerender(createElement(TopBar, props([working("a1"), working("a2")])));
    expect(mid()).toContain("2 agents working");
    expect(screen.queryByText(/1 agents/)).toBeNull();
  });
});
