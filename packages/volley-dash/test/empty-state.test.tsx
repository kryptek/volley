/**
 * Phase 2 — EmptyState content tests.
 *
 * The empty state is shown inside the Dashboard `<main>` when `state.agents`
 * is empty. The Phase 0 smoke tests assert the structural testids; here we
 * pin the visible copy + the ASCII wordmark + that the broker URL is
 * surfaced (since the production Dashboard threads it through from context).
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "../src/components/EmptyState";

describe("EmptyState", () => {
  it("renders the registry tag-line copy verbatim from the handoff", () => {
    render(<EmptyState />);
    expect(
      screen.getByText(/no agents registered · waiting for retained entries/),
    ).toBeInTheDocument();
  });

  it("includes the box-drawing wordmark text", () => {
    render(<EmptyState />);
    const ascii = screen.getByTestId("ascii-wordmark");
    expect(ascii.textContent).toContain("┌─ volley ─");
  });

  it("surfaces the broker URL prop in the hint card", () => {
    render(<EmptyState brokerUrl="mqtt://example.test:1883" />);
    expect(screen.getByTestId("empty-hint-card").textContent).toContain("mqtt://example.test:1883");
  });

  it("includes the dispatch + mosquitto_pub example commands", () => {
    render(<EmptyState />);
    const hint = screen.getByTestId("empty-hint-card");
    expect(hint.textContent).toContain("npx volley dispatch");
    expect(hint.textContent).toContain("mosquitto_pub");
  });
});
