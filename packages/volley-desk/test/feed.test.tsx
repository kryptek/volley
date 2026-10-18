import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState, reduceAll } from "../src/store/reducer";
import type { DeskMessage, Envelope, FeedEntry } from "../src/store/types";
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

/** jsdom has no layout: give `el` a fixed scroll geometry and a writable `scrollTop`. */
function layout(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  let top = el.scrollTop;
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
  });
}

/** The user scrolls `el` to `to`. */
function scrollTo(el: HTMLElement, to: number) {
  el.scrollTop = to;
  fireEvent.scroll(el);
}

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

  describe("auto-scroll", () => {
    function setup() {
      const r = render(<Feed feed={[working, steer]} />);
      const el = r.container.querySelector(".feed") as HTMLElement;
      layout(el, 1000, 200);
      return { ...r, el };
    }

    it("follows new envelopes while the reader is at the bottom", () => {
      const { el, rerender } = setup();
      scrollTo(el, 800);
      layout(el, 1300, 200);
      rerender(<Feed feed={[working, steer, narr]} />);
      expect(el.scrollTop).toBe(1100);
    });

    it("stops following once the reader scrolls up, and resumes at the bottom", () => {
      const { el, rerender } = setup();
      scrollTo(el, 300);
      layout(el, 1300, 200);
      rerender(<Feed feed={[working, steer, narr]} />);
      expect(el.scrollTop).toBe(300);
      scrollTo(el, 1100);
      layout(el, 1600, 200);
      rerender(
        <Feed feed={[working, steer, narr, entry("progress", "narration", { msg: "x" }, 90)]} />,
      );
      expect(el.scrollTop).toBe(1400);
    });
  });

  it("keeps rows mounted when the ring drops its oldest entry", () => {
    const more = entry("progress", "narration", { msg: "Shards balanced" }, 120);
    const { rerender } = render(<Feed feed={[working, steer, narr]} />);
    const before = screen.getByRole("button", { name: /Matrix written/ }).closest(".env");
    // FEED_LIMIT reached: the oldest entry is sliced off as a new one arrives.
    rerender(<Feed feed={[steer, narr, more]} />);
    expect(screen.getByRole("button", { name: /Matrix written/ }).closest(".env")).toBe(before);
  });

  it("shows the empty hint for an agent with no signal", () => {
    render(<Feed feed={[]} noSignal />);
    expect(screen.getByText(/no envelopes yet/)).toHaveTextContent(/no signal/);
  });
});

describe("Feed control traffic", () => {
  // volleyd's control channel: a mailbox `query` with `payload.op`, answered by an `ack` that
  // echoes `acked_type: "query"` and the op. Neither is a conversation with the agent.
  const query = entry("mailbox", "query", { op: "status", text: "volleyd status" }, 10);
  const reply = entry(
    "mailbox",
    "ack",
    { acked_type: "query", op: "status", ok: true, text: "2 waves" },
    11,
  );
  const plainQuery = entry("mailbox", "query", { text: "what are you on?" }, 20);
  const ack = entry("mailbox", "ack", { acked_type: "steering" }, 31);

  it("hides control queries and their replies; steering, acks and plain queries still show", () => {
    render(<Feed feed={[working, query, reply, steer, ack, plainQuery, narr]} />);
    expect(screen.queryByRole("button", { name: /volleyd status/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /2 waves/ })).toBeNull();
    expect(screen.getByRole("button", { name: /keep the matrix to 4 shards/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /what are you on\?/ })).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(5);
  });

  it("the store never rings control traffic into an agent's feed", () => {
    const m = (e: FeedEntry): DeskMessage => ({ ...e });
    const s = reduceAll(initialState(), [m(working), m(query), m(reply), m(steer)]);
    expect(s.agents[AGENT]?.feed.map((f) => f.envelope.type)).toEqual(["working", "steering"]);
  });
});
