import { act, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { Envelope, FeedEntry, UsagePayload } from "../src/store/types";
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
  { id: "work", label: "Work", machine: "local", fivePct: 91, weeklyPct: 40 },
  { id: "personal", label: "Personal", machine: "local", fivePct: 12, weeklyPct: 22 },
  { id: "fresh", label: "Fresh", machine: "local", fivePct: null, weeklyPct: null },
  { id: "spare", label: "Spare", machine: "local", fivePct: null, weeklyPct: 20 },
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

/** The tooltip an element's `aria-describedby` names. */
function tipOf(el: HTMLElement): HTMLElement {
  const tip = document.getElementById(el.getAttribute("aria-describedby") ?? "");
  if (tip?.getAttribute("role") !== "tooltip") throw new Error("no tooltip");
  return tip;
}

describe("agent window account picker", () => {
  it("lists the accounts with their 5-hour usage, the agent's own selected", () => {
    renderPicker({ onMoveAccount: vi.fn() });
    const pick = screen.getByRole("combobox", { name: "Claude account for T1" });
    // Row 2 of the title bar, beside the headline; the actions keep only buttons.
    expect(pick.closest(".win-sub")).toBeTruthy();
    expect(pick.closest(".win-actions")).toBeNull();
    expect(pick).toHaveValue("work");
    const names = [...pick.querySelectorAll("option")].map((o) => o.textContent);
    expect(names).toEqual([
      "Work · 91% · this machine",
      "Personal · 12% · this machine",
      "Fresh · no usage yet · this machine",
      "Spare · no 5-hour usage yet · this machine",
    ]);
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

describe("agent window account picker: the agent's machine and why (T8)", () => {
  const peerAccounts = [
    ...accounts,
    {
      id: "primary@peer-a",
      label: "primary@peer-a",
      machine: "peer-a",
      fivePct: 88,
      weeklyPct: 30,
    },
    { id: "work@peer-a", label: "Work", machine: "peer-a", fivePct: 12, weeklyPct: 40 },
  ];
  const peer = { name: "peer-a", local: false, hubUp: true };
  const ev = (type: string, seq: number, data: Record<string, unknown>): FeedEntry => {
    const envelope: Envelope = {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "_waves/events",
      type,
      wall_time: new Date(NOW - 60_000 + seq * 1000).toISOString(),
      payload: { wave: "status-chip", seq, task: "T1", data },
    };
    return { topic: "volley/_waves/status-chip/events", envelope, receivedAt: NOW };
  };
  const chosen = ev("account_chosen", 1, {
    task: "T1",
    role: "fixup",
    account: "work@peer-a",
    source: "balance",
    why: "work@peer-a: most headroom on peer-a (5h 12%, 7d 40%; primary@peer-a 5h 88%)",
  });
  const other = ev("account_chosen", 2, {
    task: "T1",
    role: "implementer",
    account: "primary@peer-a",
    why: "primary@peer-a: the implementer's",
  });

  const peerUsage = { ...usage, account: "work@peer-a" };

  it("a peer agent's picker lists only its machine's accounts, the current one with its figures", () => {
    renderPicker({
      accounts: peerAccounts,
      machine: peer,
      usage: peerUsage,
      onMoveAccount: vi.fn(),
    });
    const pick = screen.getByRole("combobox", { name: "Claude account for T1" });
    expect(pick).toHaveValue("work@peer-a");
    expect([...pick.querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "primary@peer-a · 88% · peer-a",
      "Work · 12% · peer-a",
    ]);
    expect(pick.querySelector("option:checked")).toHaveTextContent("Work · 12% · peer-a");
  });

  it("a local agent's picker lists this machine's accounts only", () => {
    renderPicker({
      accounts: peerAccounts,
      machine: { name: "hub", local: true, hubUp: true },
      onMoveAccount: vi.fn(),
    });
    const pick = screen.getByRole("combobox", { name: "Claude account for T1" });
    expect([...pick.querySelectorAll("option")].map((o) => o.getAttribute("value"))).toEqual([
      "work",
      "personal",
      "fresh",
      "spare",
    ]);
  });

  it("focusing the picker shows why this account, from its task role's account_chosen", async () => {
    const { container } = renderPicker({
      accounts: peerAccounts,
      machine: peer,
      usage: peerUsage,
      accountEvents: [chosen, other],
      onMoveAccount: vi.fn(),
    });
    const pick = screen.getByRole("combobox", { name: "Claude account for T1" });
    act(() => pick.focus());
    const tip = tipOf(pick);
    expect(tip).toHaveTextContent(
      "most headroom on peer-a (5h 12%, 7d 40%; primary@peer-a 5h 88%)",
    );
    expect(tip).not.toHaveTextContent("the implementer's");
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });

  it("after autopilot moved the agent, the tooltip says so", () => {
    const moved = ev("agent_account_moved", 3, {
      agent_id: FIXUP,
      role: "fixup",
      from: "primary@peer-a",
      to: "work@peer-a",
      by: "autopilot",
      decision_id: "d-1",
      why: "primary@peer-a at 91% of its 5-hour window",
    });
    renderPicker({
      accounts: peerAccounts,
      machine: peer,
      usage: peerUsage,
      accountEvents: [chosen, moved],
    });
    expect(
      tipOf(screen.getByRole("combobox", { name: "Claude account for T1" })),
    ).toHaveTextContent(
      "moved off primary@peer-a by autopilot: primary@peer-a at 91% of its 5-hour window",
    );
  });
});
