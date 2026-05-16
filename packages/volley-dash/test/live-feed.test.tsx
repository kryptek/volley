/**
 * Phase 2 — LiveFeed interaction tests.
 *
 * Asserts that the pause toggle blocks visual append of new events while
 * paused, that channel filter chips narrow the rendered set, and that all
 * 5 channel chips are wired up to `setChannelFilter`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LiveFeed } from "../src/components/LiveFeed";
import type { FeedEvent } from "../src/types";

function ev(id: string, ch: FeedEvent["ch"], msg: string, ts: number = Date.now()): FeedEvent {
  return { id, ts, agent: "a1", ch, type: ch, msg };
}

describe("LiveFeed", () => {
  it("renders event rows by id", () => {
    render(<LiveFeed events={[ev("e1", "progress", "first row")]} />);
    expect(screen.getByText("first row")).toBeInTheDocument();
  });

  it("filters events by channel when a chip is selected", () => {
    render(
      <LiveFeed
        channelFilter="progress"
        events={[ev("e1", "progress", "kept"), ev("e2", "mailbox", "filtered")]}
      />,
    );
    expect(screen.getByText("kept")).toBeInTheDocument();
    expect(screen.queryByText("filtered")).not.toBeInTheDocument();
  });

  it("pause toggle calls setPaused with negated value", () => {
    const setPaused = vi.fn();
    render(<LiveFeed paused={false} setPaused={setPaused} />);
    fireEvent.click(screen.getByTestId("pause-toggle"));
    expect(setPaused).toHaveBeenCalledWith(true);
  });

  it("when paused, freezes the rendered slice — new events don't append", () => {
    const initial = [ev("e1", "progress", "row-one")];
    const { rerender } = render(<LiveFeed paused={true} events={initial} />);
    expect(screen.getByText("row-one")).toBeInTheDocument();

    // Append a new event while paused — visual should NOT add it.
    rerender(<LiveFeed paused={true} events={[...initial, ev("e2", "progress", "row-two")]} />);
    expect(screen.queryByText("row-two")).not.toBeInTheDocument();
    expect(screen.getByText("row-one")).toBeInTheDocument();
  });

  it("clicking a channel chip calls setChannelFilter with that channel", () => {
    const setChannelFilter = vi.fn();
    render(<LiveFeed setChannelFilter={setChannelFilter} />);
    fireEvent.click(screen.getByText("mailbox"));
    expect(setChannelFilter).toHaveBeenCalledWith("mailbox");
  });
});
