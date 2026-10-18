import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Envelope, FeedEntry } from "../src/store/types";
import { Feed } from "../src/windows/agent/Feed";

const AGENT = "ci-speed-t3b-implementer-1";
const T0 = Date.parse("2026-10-18T12:00:00Z");

function entry(channel: string, type: string, payload: unknown, atS: number): FeedEntry {
  const envelope: Envelope = {
    schema_version: "0.1",
    agent_id: channel === "mailbox" ? "coordinator-desk2" : AGENT,
    wall_time: new Date(T0 + atS * 1000).toISOString(),
    channel,
    type,
    payload,
  };
  return { topic: `volley/demo/${AGENT}/${channel}`, envelope, receivedAt: T0 + atS * 1000 };
}

const working = entry("status", "working", { msg: "implementing shard split" }, 0);
const steer = entry("mailbox", "steering", { text: "keep the matrix to 4 shards" }, 30);
const narr = entry("progress", "narration", { msg: "Matrix written", progress: 38 }, 60);

describe("Feed", () => {
  it("renders envelopes in time order, newest last", () => {
    // Arrival order differs from envelope time order (retained replay).
    render(<Feed feed={[narr, working, steer]} />);
    const rows = screen.getAllByRole("button", { name: /status|mailbox|progress/ });
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("implementing shard split"),
      expect.stringContaining("keep the matrix to 4 shards"),
      expect.stringContaining("Matrix written"),
    ]);
  });

  it("clicking a row shows the exact envelope JSON, clicking again hides it", () => {
    const { container } = render(<Feed feed={[working, steer, narr]} />);
    fireEvent.click(screen.getByRole("button", { name: /Matrix written/ }));
    const pre = container.querySelector("pre.env-json");
    expect(pre?.textContent).toBe(JSON.stringify(narr.envelope, null, 2));
    fireEvent.click(screen.getByRole("button", { name: /Matrix written/ }));
    expect(container.querySelector("pre.env-json")).toBeNull();
  });

  it("marks rows with their channel class", () => {
    render(<Feed feed={[working, steer, narr]} />);
    const row = (name: RegExp) => screen.getByRole("button", { name }).closest(".env");
    expect(row(/keep the matrix/)).toHaveClass("ch-mailbox");
    expect(row(/implementing shard/)).toHaveClass("ch-status");
    expect(row(/Matrix written/)).toHaveClass("ch-progress");
  });

  it("labels registry entries by the registry channel", () => {
    const reg: FeedEntry = {
      topic: `volley/_system/registry/${AGENT}`,
      envelope: {
        schema_version: "0.1",
        agent_id: AGENT,
        channel: "_system/registry",
        type: "registered",
        payload: { capabilities: ["implements-issue"], started_at: "2026-10-18T12:00:00Z" },
      },
      receivedAt: T0 - 1000,
    };
    render(<Feed feed={[reg]} />);
    expect(screen.getByRole("button", { name: /registered/ }).closest(".env")).toHaveClass(
      "ch-registry",
    );
  });

  it("shows a placeholder with no envelopes", () => {
    render(<Feed feed={[]} />);
    expect(screen.getByText("no envelopes yet")).toBeInTheDocument();
  });
});
