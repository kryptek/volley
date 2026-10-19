import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FEED_LIMIT, initialState, reduceAll } from "../src/store/reducer";
import type { AgentView, DeskMessage } from "../src/store/types";
import { AgentWindow } from "../src/windows/agent/AgentWindow";
import { Feed } from "../src/windows/agent/Feed";
import { NOW, S, progress, registry, status } from "./helpers/desk-msgs";

const ID = "impl-1";

function agent(msgs: DeskMessage[]): AgentView {
  const a = reduceAll(initialState(), msgs).agents[ID];
  if (!a) throw new Error("no agent");
  return a;
}

const beats = (n: number, lastAt: number) =>
  Array.from({ length: n }, (_, i) =>
    progress(ID, "heartbeat", lastAt - (n - 1 - i) * 5 * S, { seq: i }),
  );
const narrations = [1, 2, 3].map((i) =>
  progress(ID, "narration", NOW - (40 - i) * S, { msg: `step ${i}`, progress: i * 10 }),
);

describe("heartbeats off the feed", () => {
  it("keeps heartbeats out of the feed ring and counts them", () => {
    const a = agent([...beats(20, NOW - 3 * S), ...narrations]);
    expect(a.feed.map((e) => e.envelope.type)).toEqual(["narration", "narration", "narration"]);
    expect(a.heartbeats).toBe(20);
    expect(a.heartbeat).toBe(NOW - 3 * S);
  });

  it("heartbeats never push narration out of the ring", () => {
    const a = agent([...narrations, ...beats(FEED_LIMIT + 50, NOW - 3 * S)]);
    expect(a.feed.filter((e) => e.envelope.type === "narration")).toHaveLength(3);
  });

  it("20 heartbeats + 3 narrations → 3 rows; the toggle adds one collapsed heartbeat row", () => {
    const a = agent([...beats(20, NOW - 3 * S), ...narrations]);
    const { container } = render(
      <Feed feed={a.feed} heartbeats={{ count: a.heartbeats ?? 0, last: a.heartbeat }} now={NOW} />,
    );
    expect(container.querySelectorAll(".env")).toHaveLength(3);
    const toggle = screen.getByRole("checkbox", { name: "show heartbeats" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    const rows = container.querySelectorAll(".env");
    expect(rows).toHaveLength(4);
    expect(rows[3]).toHaveClass("env--heartbeats");
    expect(rows[3]).toHaveTextContent("heartbeat ×20 · last 3s");
  });

  it("the liveness age in the footer follows the latest heartbeat", () => {
    const frame = {
      pos: { x: 0, y: 0 },
      z: 1,
      scale: 1,
      chrome: "glass" as const,
      onMove: () => {},
      onFocus: () => {},
    };
    const base = [registry(ID, NOW - 60 * S), status(ID, "working", NOW - 60 * S)];
    const { container, rerender } = render(
      <AgentWindow
        agent={agent([...base, ...beats(2, NOW - 40 * S)])}
        wave={undefined}
        accent="#fff"
        frame={frame}
        now={NOW}
      />,
    );
    expect(container.querySelector(".hb")).toHaveTextContent("40s");
    rerender(
      <AgentWindow
        agent={agent([...base, ...beats(3, NOW - 2 * S)])}
        wave={undefined}
        accent="#fff"
        frame={frame}
        now={NOW}
      />,
    );
    expect(container.querySelector(".hb")).toHaveTextContent("2s");
  });
});
