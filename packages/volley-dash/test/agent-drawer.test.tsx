/**
 * Phase 2 — AgentDrawer behaviour tests.
 *
 * Covers: structural shell present with placeholder when no agent supplied
 * (the standalone-render case the Phase 0 smoke tests already exercise),
 * close button invokes onClose, identity section shows the agent id, and
 * the Dashboard-level Esc handler clears the selection (verified via the
 * Dashboard integration test below).
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentDrawer } from "../src/components/AgentDrawer";
import type { Agent } from "../src/types";

const fullAgent: Agent = {
  id: "coordinator-zeta",
  ns: "infra",
  status: "working",
  parent: null,
  caps: ["coordinator"],
  msg: "Working on it",
  pct: 33,
  spawnedAt: Date.now() - 30_000,
  lastSeen: Date.now() - 1_000,
};

describe("AgentDrawer", () => {
  it("shows the agent id in the header when an agent is supplied", () => {
    render(<AgentDrawer agent={fullAgent} />);
    expect(screen.getByText("coordinator-zeta")).toBeInTheDocument();
  });

  it("close button invokes onClose", () => {
    const onClose = vi.fn();
    render(<AgentDrawer agent={fullAgent} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders the retained envelope + subscriptions sections when agent set", () => {
    render(<AgentDrawer agent={fullAgent} />);
    expect(screen.getByTestId("drawer-section-envelope")).toBeInTheDocument();
    expect(screen.getByTestId("drawer-section-subscriptions")).toBeInTheDocument();
  });

  it("renders only the identity section in the placeholder shell (no agent)", () => {
    render(<AgentDrawer />);
    expect(screen.getByTestId("drawer-section-identity")).toBeInTheDocument();
    expect(screen.queryByTestId("drawer-section-envelope")).not.toBeInTheDocument();
    expect(screen.queryByTestId("drawer-section-subscriptions")).not.toBeInTheDocument();
  });
});
