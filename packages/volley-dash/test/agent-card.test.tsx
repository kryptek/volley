/**
 * Phase 2 — AgentCard variant tests.
 *
 * Asserts that each of the seven lifecycle statuses renders with the right
 * status-dot shape/state, badge label text, and edge color signal. The
 * dot's per-status data-attribute drives the CSS treatment in `globals.css`
 * (blocked is a rotated square, working/failed have glow, reaped is dimmed,
 * etc.) — keep that attribute stable so the design tokens stay in charge
 * of the visual treatment.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentCard } from "../src/components/AgentCard";
import { STATUS_META } from "../src/lib/lifecycle-meta";
import type { Agent, AgentStatus } from "../src/types";

function makeAgent(status: AgentStatus, overrides: Partial<Agent> = {}): Agent {
  return {
    // Use a neutral id so substring matches on the status label only hit the
    // badge, not the agent id.
    id: "agent-x",
    ns: "default",
    status,
    parent: null,
    caps: ["test"],
    msg: "stub progress message",
    pct: 50,
    spawnedAt: Date.now() - 60_000,
    lastSeen: Date.now() - 1_000,
    ...overrides,
  };
}

describe("AgentCard — 7 status variants", () => {
  const statuses: AgentStatus[] = [
    "spawning",
    "registered",
    "working",
    "done",
    "blocked",
    "failed",
    "reaped",
  ];

  for (const s of statuses) {
    it(`renders ${s} with dot[data-status="${s}"] and the badge label`, () => {
      const agent = makeAgent(s);
      render(<AgentCard agent={agent} />);
      const dot = screen.getByTestId("status-dot");
      expect(dot).toHaveAttribute("data-status", s);
      // Badge text — exact match on the label
      expect(
        screen.getByText(STATUS_META[s].label, { selector: ".vd-status-label" }),
      ).toBeInTheDocument();
      // Card root carries the status data attribute for the status-edge color.
      expect(screen.getByTestId(`agent-card-${agent.id}`)).toHaveAttribute("data-status", s);
    });
  }

  it("renders parent id when present", () => {
    render(<AgentCard agent={makeAgent("working", { parent: "parent-xyz" })} />);
    expect(screen.getByText("parent-xyz")).toBeInTheDocument();
  });

  it("omits parent block when null", () => {
    render(<AgentCard agent={makeAgent("working", { parent: null })} />);
    expect(screen.queryByText(/parent-/)).not.toBeInTheDocument();
  });

  it("renders the progress percentage label for working with pct", () => {
    render(<AgentCard agent={makeAgent("working", { pct: 67 })} />);
    expect(screen.getByText("67%")).toBeInTheDocument();
  });

  it("renders 'running' when working with null pct", () => {
    render(<AgentCard agent={makeAgent("working", { pct: null })} />);
    expect(screen.getByText("running")).toBeInTheDocument();
  });
});
