import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EffectiveCoordinator } from "../src/attention";
import { Frame } from "../src/canvas/Frame";
import type { DecisionPayload } from "../src/store/types";
import {
  AttentionLine,
  COPY_RESET_MS,
  MachineDown,
  NeedsYou,
  firstLines,
} from "../src/windows/wave/NeedsYou";

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

function stubClipboard() {
  const writeText = vi.fn<(s: string) => Promise<void>>(() => Promise.resolve());
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

const waiting: EffectiveCoordinator = {
  id: "coord-1",
  state: "awaiting_input",
  question:
    "Ties on the scorecard: shared or dense ranking?\nShared keeps parity with v1.\nDense is simpler.",
  sessionUrl: "https://claude.ai/code/session-example-1",
  workspace: "workspace:14",
};

describe("firstLines", () => {
  it("keeps the first two non-empty lines", () => {
    expect(firstLines("a\n\nb\nc")).toBe("a\nb");
    expect(firstLines("  one  ")).toBe("one");
  });
});

describe("NeedsYou (coordinator awaiting input)", () => {
  it("shows the question's first lines and an Open in Claude link to the session", () => {
    render(<NeedsYou wave="status-chip" coordinator={waiting} openDecisions={0} now={NOW} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveClass("needs-you");
    expect(banner).toHaveTextContent("Needs you: the coordinator is waiting for your answer");
    const q = banner.querySelector(".ny-q");
    expect(q?.textContent).toContain("Ties on the scorecard: shared or dense ranking?");
    expect(q?.textContent).toContain("Shared keeps parity with v1.");
    expect(q?.textContent).not.toContain("Dense is simpler.");
    const link = screen.getByRole("link", { name: /Open in Claude/ });
    expect(link).toHaveAttribute("href", "https://claude.ai/code/session-example-1");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("copies the cmux command for the coordinator's workspace", async () => {
    const writeText = stubClipboard();
    render(<NeedsYou wave="status-chip" coordinator={waiting} openDecisions={0} now={NOW} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Terminal: workspace:14/ }));
    });
    expect(writeText).toHaveBeenCalledWith("cmux select-workspace --workspace workspace:14");
    expect(screen.getByRole("button", { name: /Terminal: workspace:14/ })).toHaveTextContent(
      "Copied",
    );
  });

  it("leaves out the link and the terminal button when the hooks did not report them", () => {
    render(
      <NeedsYou
        wave="status-chip"
        coordinator={{ id: "coord-1", state: "awaiting_input" }}
        openDecisions={0}
        now={NOW}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button", { name: /Terminal/ })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("waiting for your answer");
  });
});

describe("NeedsYou (no coordinator)", () => {
  const gone: EffectiveCoordinator = { id: "coord-3", state: "gone", lastSeen: NOW - 34 * 60_000 };

  it("says how long the wave has had no coordinator and offers the claim command to copy", async () => {
    const writeText = stubClipboard();
    render(<NeedsYou wave="leaderboard" coordinator={gone} openDecisions={1} now={NOW} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Needs you: no coordinator for 34 min");
    expect(banner).toHaveTextContent("coord-3");
    expect(banner).toHaveTextContent("1 decision is parked");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /volleyd claim leaderboard/ }));
    });
    expect(writeText).toHaveBeenCalledWith("volleyd claim leaderboard");
  });

  it("falls back to showing the command when the clipboard is unavailable", async () => {
    render(<NeedsYou wave="leaderboard" coordinator={gone} openDecisions={0} now={NOW} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /volleyd claim leaderboard/ }));
    });
    expect(screen.getByText("Copy failed: select the command")).toBeInTheDocument();
  });

  it("clears Copied / Copy failed after a moment", async () => {
    vi.useFakeTimers();
    try {
      stubClipboard();
      render(<NeedsYou wave="leaderboard" coordinator={gone} openDecisions={0} now={NOW} />);
      const button = screen.getByRole("button", { name: /volleyd claim leaderboard/ });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(button).toHaveTextContent("Copied");
      act(() => {
        vi.advanceTimersByTime(COPY_RESET_MS);
      });
      expect(button).not.toHaveTextContent("Copied");

      Reflect.deleteProperty(navigator, "clipboard");
      await act(async () => {
        fireEvent.click(button);
      });
      expect(screen.getByText("Copy failed: select the command")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(COPY_RESET_MS);
      });
      expect(screen.queryByText("Copy failed: select the command")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("NeedsYou (working coordinator)", () => {
  it("renders nothing", () => {
    const { container } = render(
      <NeedsYou
        wave="ci-speed"
        coordinator={{ id: "coord-2", state: "working" }}
        openDecisions={0}
        now={NOW}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AttentionLine", () => {
  it("labels the tier the way the prototype does", () => {
    const { rerender } = render(<AttentionLine attn={{ tier: "you", reason: "Blocked" }} />);
    expect(screen.getByText("Needs you · Blocked")).toHaveClass("attn-line", "attn-you");
    rerender(<AttentionLine attn={{ tier: "coordinator", reason: "Merge-ready gate" }} />);
    expect(screen.getByText("Coordinator handling · Merge-ready gate")).toHaveClass(
      "attn-coordinator",
    );
    rerender(<AttentionLine attn={{ tier: "none" }} />);
    expect(screen.queryByText(/·/)).toBeNull();
  });
});

describe("Frame attention wrapper", () => {
  const base = {
    id: "w",
    title: "w",
    accent: "#fff",
    pos: { x: 0, y: 0 },
    width: 100,
    z: 1,
    scale: 1,
    chrome: "glass" as const,
    onMove: () => {},
    onFocus: () => {},
  };

  it("pulses a window at tier you by default, rings tier coordinator, leaves the rest alone", () => {
    const { container, rerender } = render(
      <Frame {...base} attn="you">
        body
      </Frame>,
    );
    expect(container.querySelector(".win")).toHaveClass("win--attn-you");
    expect(container.querySelector(".win > .win-attn.win-attn-pulse > .win-inner")).not.toBeNull();
    rerender(
      <Frame {...base} attn="coordinator">
        body
      </Frame>,
    );
    expect(container.querySelector(".win")).toHaveClass("win--attn-coordinator");
    expect(container.querySelector(".win-attn")).toBeNull();
    rerender(<Frame {...base}>body</Frame>);
    expect(container.querySelector(".win")?.className).toBe("win");
  });

  it("uses a custom wrapper (D7's electric/star) instead of the pulse", () => {
    const { container } = render(
      <Frame {...base} attn="you" wrapAttention={(f) => <div className="custom">{f}</div>}>
        body
      </Frame>,
    );
    expect(container.querySelector(".custom > .win-inner")).not.toBeNull();
    expect(container.querySelector(".win-attn-pulse")).toBeNull();
  });
});

describe("MachineDown (a machine_down decision)", () => {
  const down: DecisionPayload = {
    decision_id: "w1-machine_down-box-b-1",
    wave: "w1",
    task: null,
    kind: "machine_down",
    question: "box-b has been down for 5 min. Re-place its 2 queued tasks on box-a?",
    options: ["wait", "re-place queued tasks", "cancel"],
    opened_at: "2026-10-18T11:55:00.000Z",
    host: "box-b",
    down_since: "2026-10-18T11:50:00.000Z",
    tasks: ["T3", "T4"],
  };

  it("pre-selects re-place queued tasks and names the tasks", () => {
    render(<MachineDown decision={down} onAnswer={vi.fn()} />);
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Needs you: box-b is down");
    expect(banner).toHaveTextContent(down.question);
    expect(screen.getByText("T3")).toBeInTheDocument();
    expect(screen.getByText("T4")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "re-place queued tasks" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "wait" })).not.toBeChecked();
  });

  it("an unknown machine state falls back to is down", () => {
    render(
      <MachineDown decision={{ ...down, machine: "rebooting" } as never} onAnswer={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Needs you: box-b is down");
  });

  it("Answer sends the chosen option", async () => {
    const onAnswer = vi.fn(async () => ({ ok: true }));
    render(<MachineDown decision={down} onAnswer={onAnswer} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    });
    expect(onAnswer).toHaveBeenCalledWith("re-place queued tasks");
    fireEvent.click(screen.getByRole("radio", { name: "wait" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    });
    expect(onAnswer).toHaveBeenLastCalledWith("wait");
  });

  it("a draining machine says so; a refused answer shows why; read-only offers no Answer", async () => {
    const onAnswer = vi.fn(async () => ({ ok: false, error: "box-a is not eligible now" }));
    const { unmount } = render(
      <MachineDown
        decision={{ ...down, machine: "draining", options: ["wait", "re-place queued tasks"] }}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Needs you: box-b is draining");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("box-a is not eligible now");
    unmount();
    render(<MachineDown decision={down} />);
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
  });
});
