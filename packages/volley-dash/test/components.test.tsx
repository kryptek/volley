/**
 * Phase 0 RED smoke tests.
 *
 * These tests assert the visual structure that Phase 2 will build out.
 * The stubs from Phase 0 mount with the right top-level testid but do
 * NOT yet render the children (TopBar inside Dashboard, status badge in
 * AgentCard, channel filter buttons in LiveFeed, etc.) — so the assertions
 * past "the root testid exists" intentionally fail. That's the RED signal
 * for Phase 2 to drive against.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import pkg from "../package.json";
import { AgentCard } from "../src/components/AgentCard";
import { AgentDrawer } from "../src/components/AgentDrawer";
import { AgentGrid } from "../src/components/AgentGrid";
import { Dashboard } from "../src/components/Dashboard";
import { EmptyState } from "../src/components/EmptyState";
import { LiveFeed } from "../src/components/LiveFeed";
import { TopBar } from "../src/components/TopBar";
import type { Agent } from "../src/types";

const sampleAgent: Agent = {
  id: "coordinator-clu1",
  ns: "default",
  status: "working",
  parent: null,
  caps: ["coordinator", "dispatch-issues"],
  msg: "Dispatching 7 issues across worker pool",
  pct: 67,
  spawnedAt: Date.now() - 942_000,
  lastSeen: Date.now() - 1_000,
};

describe("Phase 0 component scaffolding", () => {
  describe("Dashboard", () => {
    it("mounts with the dashboard testid", () => {
      render(<Dashboard />);
      expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    });

    it("renders the TopBar, AgentGrid, LiveFeed inside the shell", () => {
      // Phase 2 fills these in; RED for now.
      render(<Dashboard />);
      expect(screen.getByTestId("top-bar")).toBeInTheDocument();
      expect(screen.getByTestId("agent-grid")).toBeInTheDocument();
      expect(screen.getByTestId("live-feed")).toBeInTheDocument();
    });
  });

  describe("TopBar", () => {
    it("mounts with the top-bar testid", () => {
      render(<TopBar />);
      expect(screen.getByTestId("top-bar")).toBeInTheDocument();
    });

    it("renders the brand mark + namespace tabs + search input", () => {
      // Phase 2 fills these in; RED for now.
      render(<TopBar />);
      expect(screen.getByTestId("brand-mark")).toBeInTheDocument();
      expect(screen.getByTestId("namespace-tabs")).toBeInTheDocument();
      expect(screen.getByTestId("search-input")).toBeInTheDocument();
    });

    it("shows the package version next to the wordmark", () => {
      render(<TopBar />);
      expect(screen.getByText(`v${pkg.version}`)).toBeInTheDocument();
    });
  });

  describe("AgentCard", () => {
    it("mounts with a testid keyed by agent id", () => {
      render(<AgentCard agent={sampleAgent} />);
      expect(screen.getByTestId("agent-card-coordinator-clu1")).toBeInTheDocument();
    });

    it("renders the status dot, agent id, and status badge", () => {
      // Phase 2 fills these in; RED for now.
      render(<AgentCard agent={sampleAgent} />);
      expect(screen.getByTestId("status-dot")).toBeInTheDocument();
      expect(screen.getByText("coordinator-clu1")).toBeInTheDocument();
      expect(screen.getByText(/working/i)).toBeInTheDocument();
    });
  });

  describe("AgentGrid", () => {
    it("mounts with the agent-grid testid", () => {
      render(<AgentGrid />);
      expect(screen.getByTestId("agent-grid")).toBeInTheDocument();
    });

    it("renders the section header with AGENTS label", () => {
      // Phase 2 fills this in; RED for now.
      render(<AgentGrid />);
      expect(screen.getByText(/AGENTS/)).toBeInTheDocument();
    });
  });

  describe("LiveFeed", () => {
    it("mounts with the live-feed testid", () => {
      render(<LiveFeed />);
      expect(screen.getByTestId("live-feed")).toBeInTheDocument();
    });

    it("renders the LIVE FEED header, channel filter chips, pause toggle", () => {
      // Phase 2 fills these in; RED for now.
      render(<LiveFeed />);
      expect(screen.getByText(/LIVE FEED/)).toBeInTheDocument();
      expect(screen.getByTestId("channel-filter-chips")).toBeInTheDocument();
      expect(screen.getByTestId("pause-toggle")).toBeInTheDocument();
    });
  });

  describe("AgentDrawer", () => {
    it("mounts with the agent-drawer testid", () => {
      render(<AgentDrawer />);
      expect(screen.getByTestId("agent-drawer")).toBeInTheDocument();
    });

    it("renders the close button + identity section", () => {
      // Phase 2 fills these in; RED for now.
      render(<AgentDrawer />);
      expect(screen.getByTestId("drawer-close")).toBeInTheDocument();
      expect(screen.getByTestId("drawer-section-identity")).toBeInTheDocument();
    });
  });

  describe("EmptyState", () => {
    it("mounts with the empty-state testid", () => {
      render(<EmptyState />);
      expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    });

    it("renders the ASCII wordmark and the hint card", () => {
      // Phase 2 fills these in; RED for now.
      render(<EmptyState />);
      expect(screen.getByTestId("ascii-wordmark")).toBeInTheDocument();
      expect(screen.getByTestId("empty-hint-card")).toBeInTheDocument();
    });
  });
});
