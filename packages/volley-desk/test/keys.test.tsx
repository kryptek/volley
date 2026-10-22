import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { PAN_STEP, ZOOM_STEP, focusables } from "../src/a11y/keys";
import { MIN_SCALE } from "../src/canvas/useViewport";
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
    // Below MIN_SCALE (a fit of the whole demo) zooming out stays put, so zoom in past it first.
    while (view(container).s < MIN_SCALE * ZOOM_STEP) fireEvent.keyDown(stage(), { key: "+" });
    const v2 = view(container);
    fireEvent.keyDown(stage(), { key: "-" });
    expect(view(container).s).toBeCloseTo(v2.s / ZOOM_STEP, 4);
    fireEvent.keyDown(document.body, { key: "=" });
    expect(view(container).s).toBeGreaterThan(v0.s);
  });

  it("f arranges & fits, except while typing", () => {
    vi.useFakeTimers();
    const { container } = renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /^Message / })[0] as HTMLElement);
    const search = (document.querySelector(".steer textarea, .steer input") ?? null) as HTMLElement;
    expect(search).not.toBeNull();
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
  it("Escape closes the top dialog first: wave settings, then the steering panel", () => {
    renderApp();
    const chat = screen.getAllByRole("button", { name: /^Message / })[0] as HTMLElement;
    fireEvent.click(chat);
    expect(document.querySelector(".steer")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings for ci-speed" }));
    const dialog = screen.getByRole("dialog", { name: "Wave settings" });
    // The focus trap puts focus in the modal, so that is where a real Escape lands.
    expect(dialog.contains(document.activeElement)).toBe(true);

    // In a browser React flushes the modal's close before the event reaches the
    // window listener, which would then close the next dialog down too; so the
    // modal must claim its Escape before the event leaves React's root.
    let claimed: boolean | undefined;
    const spy = (e: KeyboardEvent) => {
      claimed = e.defaultPrevented;
    };
    document.addEventListener("keydown", spy);
    const notCancelled = fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "Escape",
    });
    document.removeEventListener("keydown", spy);
    expect(claimed).toBe(true);
    expect(notCancelled).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Wave settings" })).toBeNull();
    expect(document.querySelector(".steer")).not.toBeNull();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(document.querySelector(".steer")).toBeNull();
  });

  it("Escape closes the Settings window before the steering panel, wherever focus is", () => {
    renderApp();
    fireEvent.click(screen.getAllByRole("button", { name: /^Message / })[0] as HTMLElement);
    fireEvent.click(dock().getByRole("button", { name: "Settings" }));
    const settings = screen.getByRole("dialog", { name: "Settings" });
    expect(settings.contains(document.activeElement)).toBe(true);
    const notCancelled = fireEvent.keyDown(document.activeElement as HTMLElement, {
      key: "Escape",
    });
    expect(notCancelled).toBe(false);
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(document.querySelector(".steer")).not.toBeNull();
    // Focus outside the window (on the page) still closes it first.
    fireEvent.click(dock().getByRole("button", { name: "Settings" }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(document.querySelector(".steer")).not.toBeNull();
  });

  it("f, + and - leave the canvas alone while a wave's settings are open", () => {
    vi.useFakeTimers();
    const { container } = renderApp();
    fireEvent.click(screen.getByRole("button", { name: "Settings for ci-speed" }));
    const dialog = screen.getByRole("dialog", { name: "Wave settings" });
    const v0 = view(container);
    const btn = within(dialog).getByRole("button", { name: "Global settings…" });
    btn.focus();
    for (const key of ["f", "+", "=", "-"]) {
      fireEvent.keyDown(btn, { key });
      fireEvent.keyDown(dialog, { key });
    }
    expect(view(container)).toEqual(v0);
    expect(container.querySelector(".world--anim")).toBeNull();
  });

  it("traps focus in a wave's settings", () => {
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
