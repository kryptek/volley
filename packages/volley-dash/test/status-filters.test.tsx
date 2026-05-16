/**
 * Phase 2 — StatusFilters interaction test.
 *
 * Clicking a chip calls `setFilter` with that status. Clicking the active
 * chip clears back to `all`. Chips render only for statuses with a non-zero
 * count.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StatusFilters } from "../src/components/StatusFilters";
import type { AgentStatus } from "../src/types";

const zeroCounts: Record<AgentStatus | "all", number> = {
  all: 0,
  working: 0,
  spawning: 0,
  blocked: 0,
  failed: 0,
  registered: 0,
  done: 0,
  reaped: 0,
};

describe("StatusFilters", () => {
  it("clicking a chip dispatches setFilter with that status", () => {
    const setFilter = vi.fn();
    render(
      <StatusFilters
        filter="all"
        setFilter={setFilter}
        counts={{ ...zeroCounts, all: 3, working: 2, blocked: 1 }}
      />,
    );
    fireEvent.click(screen.getByText("working"));
    expect(setFilter).toHaveBeenCalledWith("working");
  });

  it("clicking the active chip clears the filter", () => {
    const setFilter = vi.fn();
    render(
      <StatusFilters
        filter="blocked"
        setFilter={setFilter}
        counts={{ ...zeroCounts, all: 2, blocked: 1 }}
      />,
    );
    fireEvent.click(screen.getByText("blocked"));
    expect(setFilter).toHaveBeenCalledWith("all");
  });

  it("renders only chips for statuses with non-zero counts (plus 'all')", () => {
    render(
      <StatusFilters
        filter="all"
        setFilter={() => {}}
        counts={{ ...zeroCounts, all: 2, working: 2 }}
      />,
    );
    expect(screen.getByText("all")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
    expect(screen.queryByText("blocked")).not.toBeInTheDocument();
    expect(screen.queryByText("done")).not.toBeInTheDocument();
  });
});
