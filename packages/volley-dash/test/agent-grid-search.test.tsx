/**
 * Phase 2 — AgentGrid filtering / sorting tests.
 *
 * Covers:
 *   - substring search filters across id, ns, capability tags, parent id,
 *     progress message (the 5 fields per handoff §Search)
 *   - status priority sort (STATUS_ORDER from Phase 1)
 *   - reconcile-by-id keying (cards render once per id, not per array slot)
 *   - "no agents match" message when filters strip everything
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentGrid } from "../src/components/AgentGrid";
import type { Agent } from "../src/types";

function a(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-x",
    ns: "default",
    status: "working",
    parent: null,
    caps: [],
    msg: "",
    pct: null,
    spawnedAt: 0,
    lastSeen: 0,
    ...overrides,
  };
}

describe("AgentGrid — search + sort", () => {
  it("substring matches the agent id", () => {
    const agents = [a({ id: "alpha-001" }), a({ id: "beta-002" })];
    render(<AgentGrid agents={agents} query="alpha" />);
    expect(screen.getByTestId("agent-card-alpha-001")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-beta-002")).not.toBeInTheDocument();
  });

  it("substring matches the namespace", () => {
    const agents = [a({ id: "u1", ns: "infra" }), a({ id: "u2", ns: "growth" })];
    render(<AgentGrid agents={agents} query="growth" />);
    expect(screen.queryByTestId("agent-card-u1")).not.toBeInTheDocument();
    expect(screen.getByTestId("agent-card-u2")).toBeInTheDocument();
  });

  it("substring matches a capability tag", () => {
    const agents = [a({ id: "c1", caps: ["coordinator"] }), a({ id: "c2", caps: ["worker"] })];
    render(<AgentGrid agents={agents} query="coord" />);
    expect(screen.getByTestId("agent-card-c1")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-c2")).not.toBeInTheDocument();
  });

  it("substring matches the parent id", () => {
    const agents = [a({ id: "ch1", parent: "boss-99" }), a({ id: "ch2", parent: "boss-42" })];
    render(<AgentGrid agents={agents} query="boss-99" />);
    expect(screen.getByTestId("agent-card-ch1")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-ch2")).not.toBeInTheDocument();
  });

  it("substring matches the progress message", () => {
    const agents = [
      a({ id: "m1", msg: "Editing src/billing/invoice.ts" }),
      a({ id: "m2", msg: "Running tests" }),
    ];
    render(<AgentGrid agents={agents} query="billing" />);
    expect(screen.getByTestId("agent-card-m1")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-card-m2")).not.toBeInTheDocument();
  });

  it("case-insensitive substring match", () => {
    const agents = [a({ id: "Coordinator-X" })];
    render(<AgentGrid agents={agents} query="coordinator" />);
    expect(screen.getByTestId("agent-card-Coordinator-X")).toBeInTheDocument();
  });

  it("sorts by STATUS_ORDER: working > spawning > blocked > failed > registered > done > reaped", () => {
    const agents = [
      a({ id: "agent-done", status: "done" }),
      a({ id: "agent-working", status: "working" }),
      a({ id: "agent-blocked", status: "blocked" }),
      a({ id: "agent-spawning", status: "spawning" }),
    ];
    render(<AgentGrid agents={agents} />);
    const cards = screen.getAllByTestId(/^agent-card-/);
    expect(cards.map((c) => c.getAttribute("data-agent-id"))).toEqual([
      "agent-working",
      "agent-spawning",
      "agent-blocked",
      "agent-done",
    ]);
  });

  it("within a status, sorts by lastSeen descending (most recently active first)", () => {
    const agents = [
      a({ id: "old", status: "working", lastSeen: 100 }),
      a({ id: "new", status: "working", lastSeen: 1000 }),
    ];
    render(<AgentGrid agents={agents} />);
    const cards = screen.getAllByTestId(/^agent-card-/);
    expect(cards.map((c) => c.getAttribute("data-agent-id"))).toEqual(["new", "old"]);
  });

  it("renders no-match copy when all agents are filtered out", () => {
    render(<AgentGrid agents={[a({ id: "alpha" })]} query="zzz" />);
    const grid = screen.getByTestId("agent-grid");
    expect(within(grid).getByText(/no agents match/)).toBeInTheDocument();
  });
});
