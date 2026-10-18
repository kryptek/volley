import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { PAN_STEP, ZOOM_STEP, focusables } from "../src/a11y/keys";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", autoArrange: false }));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
});
afterEach(() => vi.useRealTimers());

const renderApp = () =>
  render(
    <DeskStoreProvider demo>
      <App />
    </DeskStoreProvider>,
  );

function view(container: HTMLElement) {
  const t = (container.querySelector(".world") as HTMLElement).style.transform;
  const m = t.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/);
  if (!m) throw new Error(`unexpected transform ${t}`);
  return { x: Number(m[1]), y: Number(m[2]), s: Number(m[3]) };
}
const stage = () => screen.getByRole("region", { name: /^Desk canvas/ });
const dock = () => within(screen.getByRole("toolbar", { name: "Dock" }));

describe("keyboard: canvas", () => {
  it("the stage is focusable and arrow keys pan it while it has focus", () => {
    const { container } = renderApp();
    const s = stage();
    expect(s).toHaveAttribute("tabindex", "0");
    s.focus();
    const v0 = view(container);
    fireEvent.keyDown(s, { key: "ArrowRight" });
    expect(view(container)).toEqual({ ...v0, x: v0.x - PAN_STEP });
    fireEvent.keyDown(s, { key: "ArrowDown" });
    fireEvent.keyDown(s, { key: "ArrowLeft" });
    fireEvent.keyDown(s, { key: "ArrowLeft" });
    fireEvent.keyDown(s, { key: "ArrowUp" });
    fireEvent.keyDown(s, { key: "ArrowUp" });
    expect(view(container)).toEqual({ ...v0, x: v0.x + PAN_STEP, y: v0.y + PAN_STEP });
    // Arrow keys elsewhere (a button inside a window) leave the canvas alone.
    const before = view(container);
    const btn = container.querySelector(".world .win button") as HTMLElement;
    btn.focus();
    fireEvent.keyDown(btn, { key: "ArrowRight" });
    expect(view(container)).toEqual(before);
  });

  it("+ and - zoom around the centre of the screen", () => {
    const { container } = renderApp();
    stage().focus();
    const v0 = view(container);
    fireEvent.keyDown(stage(), { key: "+" });
    expect(view(container).s).toBeCloseTo(Math.min(1.6, v0.s * ZOOM_STEP), 4);
    // The point at the centre stays at the centre.
    const v1 = view(container);
    expect((720 - v1.x) / v1.s).toBeCloseTo((720 - v0.x) / v0.s, 1);
    fireEvent.keyDown(stage(), { key: "-" });
    expect(view(container).s).toBeCloseTo(v0.s, 4);
    fireEvent.keyDown(document.body, { key: "=" });
    expect(view(container).s).toBeGreaterThan(v0.s);
  });

  it("f arranges & fits, except while typing", () => {
    vi.useFakeTimers();
    const { container } = renderApp();
    fireEvent.click(dock().getByRole("button", { name: "Appearance" }));
    const search = screen.getByRole("searchbox", { name: "Search backgrounds" });
    search.focus();
    fireEvent.keyDown(search, { key: "f" });
    expect(container.querySelector(".world--anim")).toBeNull();
    stage().focus();
    fireEvent.keyDown(stage(), { key: "f" });
    expect(container.querySelector(".world--anim")).not.toBeNull();
    act(() => {
      vi.runOnlyPendingTimers();
    });
    // Modified keys belong to the browser (⌘F is find).
    fireEvent.keyDown(stage(), { key: "f", metaKey: true });
    expect(container.querySelector(".world--anim")).toBeNull();
  });
});

describe("keyboard: dialogs", () => {
  it("Escape closes the top dialog first: settings, then the steering panel, then Appearance", () => {
    renderApp();
    fireEvent.click(dock().getByRole("button", { name: "Appearance" }));
    const chat = screen.getAllByRole("button", { name: /^Message / })[0] as HTMLElement;
    fireEvent.click(chat);
    expect(document.querySelector(".steer")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings for ci-speed" }));
    expect(screen.getByRole("dialog", { name: "Wave settings" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Wave settings" })).toBeNull();
    expect(document.querySelector(".steer")).not.toBeNull();
    expect(screen.getByRole("complementary", { name: "Appearance" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(document.querySelector(".steer")).toBeNull();
    expect(screen.getByRole("complementary", { name: "Appearance" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Appearance" })).toBeNull();
  });

  it("traps focus in the settings modal", () => {
    renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings for ci-speed" }));
    const dialog = screen.getByRole("dialog", { name: "Wave settings" });
    const items = focusables(dialog);
    expect(items.length).toBeGreaterThan(2);
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    // From the dialog itself (where focus lands on open), Shift+Tab wraps to the last control.
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    // Tab in the middle is left to the browser.
    const mid = items[1] as HTMLElement;
    mid.focus();
    fireEvent.keyDown(mid, { key: "Tab" });
    expect(mid).toHaveFocus();
  });
});
