import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { UsagePayload } from "../src/store/types";
import { AgentWindow, type AgentWindowProps } from "../src/windows/agent/AgentWindow";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const FIXUP = "status-chip-t1-fixup-1";
const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

const usage: UsagePayload = {
  account: "work",
  model: "claude-opus-5-5",
  context_window: { used_percentage: 10, used: 20_000, size: 200_000 },
  rate_limits: {},
  captured_at: new Date(NOW).toISOString(),
};

const accounts = [
  { id: "work", label: "Work", fivePct: 91 },
  { id: "personal", label: "Personal", fivePct: 12 },
  { id: "fresh", label: "Fresh", fivePct: null },
];

function renderPicker(props: Partial<AgentWindowProps> = {}) {
  const state = reduceAll(initialState(), demoMessages(NOW));
  const agent = state.agents[FIXUP];
  if (!agent) throw new Error("no agent");
  return render(
    <AgentWindow
      agent={agent}
      wave={state.waves[agent.wave]}
      accent="#c4b5fd"
      frame={frame}
      now={NOW}
      usage={usage}
      accounts={accounts}
      {...props}
    />,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("agent window account picker", () => {
  it("lists the accounts with their 5-hour usage, the agent's own selected", () => {
    renderPicker({ onMoveAccount: vi.fn() });
    const pick = screen.getByRole("combobox", { name: "Claude account for T1" });
    expect(pick).toHaveValue("work");
    const names = [...pick.querySelectorAll("option")].map((o) => o.textContent);
    expect(names).toEqual(["Work · 91%", "Personal · 12%", "Fresh · no usage yet"]);
  });

  it("choosing another account asks for confirmation then calls agent_move_account", async () => {
    const move = vi.fn(async () => ({ ok: true }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPicker({ onMoveAccount: move });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Claude account for T1" }), {
        target: { value: "personal" },
      });
    });
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/Personal.*resume note/));
    expect(move).toHaveBeenCalledWith("personal");
  });

  it("declining the confirmation moves nothing and keeps the current account", async () => {
    const move = vi.fn(async () => ({ ok: true }));
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPicker({ onMoveAccount: move });
    const pick = screen.getByRole("combobox", { name: "Claude account for T1" });
    await act(async () => {
      fireEvent.change(pick, { target: { value: "personal" } });
    });
    expect(move).not.toHaveBeenCalled();
    expect(pick).toHaveValue("work");
  });

  it("a refused move says why", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPicker({
      onMoveAccount: async () => ({ ok: false, error: "ACCOUNT_MOVE_STOP_TIMEOUT" }),
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "Claude account for T1" }), {
        target: { value: "personal" },
      });
    });
    expect(screen.getByRole("alert")).toHaveTextContent("ACCOUNT_MOVE_STOP_TIMEOUT");
  });

  it("read-only without a way to move: the picker is disabled", () => {
    renderPicker();
    expect(screen.getByRole("combobox", { name: "Claude account for T1" })).toBeDisabled();
  });

  it("no accounts known → no picker", () => {
    renderPicker({ accounts: [] });
    expect(screen.queryByRole("combobox", { name: /Claude account/ })).toBeNull();
  });
});
