import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { loadPins } from "../src/layout/pins";
import { type DeskDockProps, dockItems } from "../src/look/DeskDock";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";

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

describe("the dock's Machines tile", () => {
  it("sits after Needs you, badged with the machines that are down", () => {
    const onToggleMachines = vi.fn();
    const tile = dockItems(props({ machinesDown: 2, machinesOpen: true, onToggleMachines }))[2];
    expect(tile).toMatchObject({ label: "Machines", badge: 2, active: true });
    (tile as { onClick: () => void }).onClick();
    expect(onToggleMachines).toHaveBeenCalledTimes(1);
  });

  it("has no badge when every machine is up", () => {
    expect(dockItems(props())[2]).not.toHaveProperty("badge");
  });
});

describe("the Machines window on the demo Desk", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", autoArrange: false }));
  });
  const renderApp = () =>
    render(
      <DeskStoreProvider demo>
        <App />
      </DeskStoreProvider>,
    );
  const dock = () => within(screen.getByRole("toolbar", { name: "Dock" }));
  const win = () => screen.queryByRole("region", { name: "Machines" });

  it("is closed until the tile opens it; the tile closes it again", () => {
    renderApp();
    // box-b is down in the demo
    expect(dock().getByRole("button", { name: "Machines" })).toHaveTextContent("1");
    expect(win()).toBeNull();
    fireEvent.click(dock().getByRole("button", { name: "Machines" }));
    expect(win()).toBeInTheDocument();
    expect(
      within(win() as HTMLElement).getAllByRole("button", { name: /open in Settings › Machines$/ }),
    ).toHaveLength(3);
    fireEvent.click(dock().getByRole("button", { name: "Machines" }));
    expect(win()).toBeNull();
  });

  it("a row click opens Settings › Machines at that machine's card", () => {
    // jsdom has no scrollIntoView.
    const spy = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: spy, configurable: true });
    try {
      const { container } = renderApp();
      fireEvent.click(dock().getByRole("button", { name: "Machines" }));
      fireEvent.click(screen.getByRole("button", { name: "box-a: open in Settings › Machines" }));
      expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
      const card = container.querySelector('article.machine[aria-label="box-a"]');
      expect(card).not.toBeNull();
      expect(spy.mock.contexts).toContain(card);
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("pins like the other panels, under panel:machines", () => {
    renderApp();
    fireEvent.click(dock().getByRole("button", { name: "Machines" }));
    fireEvent.click(
      within(win() as HTMLElement).getByRole("button", { name: "Not pinned · pin in place" }),
    );
    expect(loadPins().desktop["panel:machines"]).toMatchObject({ mode: "place" });
  });
});
