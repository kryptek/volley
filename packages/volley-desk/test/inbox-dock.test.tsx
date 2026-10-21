import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { type DeskDockProps, dockItems } from "../src/look/DeskDock";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";
import { demoAutopilot, demoInbox } from "../src/store/fixtures";
import { NOW, fakeClient } from "./helpers/desk-msgs";

const props = (over: Partial<DeskDockProps> = {}): DeskDockProps => ({
  coordsOpen: true,
  onToggleCoords: () => {},
  needsYou: 0,
  inboxOpen: false,
  onToggleInbox: () => {},
  inboxNeedsYou: 0,
  machinesOpen: false,
  onToggleMachines: () => {},
  machinesDown: 0,
  tethers: true,
  onToggleTethers: () => {},
  onArrange: () => {},
  onZoom: () => {},
  settingsOpen: false,
  onToggleSettings: () => {},
  ...over,
});

describe("the dock's Needs you tile", () => {
  it("sits after the coordinators tile, badged with what needs a person", () => {
    const onToggleInbox = vi.fn();
    const items = dockItems(props({ inboxNeedsYou: 3, inboxOpen: true, onToggleInbox }));
    const tile = items[1];
    expect(tile).toMatchObject({ label: "Needs you", badge: 3, active: true });
    (tile as { onClick: () => void }).onClick();
    expect(onToggleInbox).toHaveBeenCalledTimes(1);
  });

  it("has no badge when nothing needs a person", () => {
    expect(dockItems(props())[1]).not.toHaveProperty("badge");
  });
});

describe("the Desk with inbox items", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", autoArrange: false }));
    vi.useFakeTimers({ now: NOW, toFake: ["setTimeout", "setInterval", "Date"] });
  });
  afterEach(() => vi.useRealTimers());

  const renderLive = () => {
    const f = fakeClient();
    const r = render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
        <App />
      </DeskStoreProvider>,
    );
    act(() => {
      f.up();
      for (const m of [...demoAutopilot(NOW), ...demoInbox(NOW)]) f.emit(m);
      vi.advanceTimersByTime(100);
    });
    return r;
  };
  const dock = () => within(screen.getByRole("toolbar", { name: "Dock" }));

  it("badges the tile, counts the items in the pill, and the tile toggles the window", () => {
    const { container } = renderLive();
    // The picker, the handoff and the owner-only release item; the decision is the coordinator's.
    expect(dock().getByRole("button", { name: "Needs you" })).toHaveTextContent("3");
    const pill = container.querySelector(".topbar .ny-pill")?.textContent ?? "";
    expect(Number(pill.match(/(\d+) needs? you/)?.[1])).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole("region", { name: "Needs you" })).toBeInTheDocument();
    fireEvent.click(dock().getByRole("button", { name: "Needs you" }));
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    fireEvent.click(dock().getByRole("button", { name: "Needs you" }));
    expect(screen.getByRole("region", { name: "Needs you" })).toBeInTheDocument();
  });

  it("tethers each row with a source window on the canvas", () => {
    const { container } = renderLive();
    const ids = [...container.querySelectorAll(".world svg.tethers g.tether[data-agent]")].map(
      (e) => e.getAttribute("data-agent"),
    );
    expect(ids).toEqual(
      expect.arrayContaining(["inbox:d-autopilot-d-rv7", "inbox:r-autopilot-publish"]),
    );
  });
});
