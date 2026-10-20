// The Terminal tab's popout: a floating, draggable window with the agent's live screen,
// several at once, Escape closes the topmost, focus trapped and returned, a remembered font size
// and a full-screen sheet on a phone.
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { focusables } from "../src/a11y/keys";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";
import { demoMessages } from "../src/store/fixtures";
import type { DeskMessage, WaveStatePayload } from "../src/store/types";
import { POPOUT_CHROME_PX, popoutWidth } from "../src/windows/agent/TerminalPopout";
import {
  TERMINAL_FONT_KEY,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
} from "../src/windows/agent/useTerminalPopouts";
import { NOW, fakeClient } from "./helpers/desk-msgs";

const FIXUP = "status-chip-t1-fixup-1";
const IMPL = "status-chip-t2-implementer-1";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", autoArrange: false }));
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 900 });
});
afterEach(() => vi.useRealTimers());

const renderDemo = () =>
  render(
    <DeskStoreProvider demo>
      <App />
    </DeskStoreProvider>,
  );

/** The agent window whose id line or title names `id`. */
function agentWindow(id: string): HTMLElement {
  const win = [...document.querySelectorAll<HTMLElement>("section")].find(
    (s) => s.querySelector(".a-id")?.textContent === id,
  );
  if (!win) throw new Error(`no window for ${id}`);
  return win;
}

/** Opens `id`'s Terminal tab and clicks its ⤢ (focused first, as a real click would). */
function popOut(id: string): HTMLElement {
  const win = within(agentWindow(id));
  fireEvent.click(win.getByRole("tab", { name: "Terminal" }));
  const btn = win.getByRole("button", { name: "Open terminal in a window" });
  btn.focus();
  fireEvent.click(btn);
  return btn;
}

const dialogFor = (id: string) => screen.getByRole("dialog", { name: new RegExp(id) });
const pressEscape = () => act(() => void fireEvent.keyDown(window, { key: "Escape" }));

describe("terminal popout", () => {
  it("(a) the Terminal tab's ⤢ opens a dialog named for the agent, with task and role chips", () => {
    renderDemo();
    popOut(FIXUP);
    const dialog = dialogFor(FIXUP);
    expect(dialog).toHaveAttribute("aria-modal", "false");
    const bar = dialog.querySelector(".popout-bar") as HTMLElement;
    expect(bar).toHaveTextContent(FIXUP);
    expect(within(bar).getByText("T1")).toHaveClass("chip");
    expect(within(bar).getByText("fixup")).toHaveClass("chip--role");
    expect(dialog).toHaveTextContent("⏺ Update(src/chip-mapper.ts)");
  });

  it("(b) the labelled close button closes it and focus returns to the ⤢", () => {
    renderDemo();
    const btn = popOut(FIXUP);
    expect(dialogFor(FIXUP)).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Close terminal window" }));
    expect(screen.queryByRole("dialog", { name: new RegExp(FIXUP) })).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("(c) several open at once; Escape closes the most recently opened first", () => {
    renderDemo();
    popOut(FIXUP);
    popOut(IMPL);
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    pressEscape();
    expect(screen.queryByRole("dialog", { name: new RegExp(IMPL) })).toBeNull();
    expect(dialogFor(FIXUP)).toBeInTheDocument();
    pressEscape();
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
  });

  it("a pointer-down raises a window: Escape then closes it first", () => {
    renderDemo();
    popOut(FIXUP);
    popOut(IMPL);
    fireEvent.pointerDown(dialogFor(FIXUP));
    expect(Number(dialogFor(FIXUP).style.zIndex)).toBeGreaterThan(
      Number(dialogFor(IMPL).style.zIndex),
    );
    pressEscape();
    expect(screen.queryByRole("dialog", { name: new RegExp(FIXUP) })).toBeNull();
    expect(dialogFor(IMPL)).toBeInTheDocument();
  });

  it("(d) Tab from the last focusable wraps to the first", () => {
    renderDemo();
    popOut(FIXUP);
    const dialog = dialogFor(FIXUP);
    const items = focusables(dialog);
    expect(items.length).toBeGreaterThan(1);
    items[items.length - 1]?.focus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Tab" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("(g) the body is a no-wrap .term--popout in the terminal font", () => {
    renderDemo();
    popOut(FIXUP);
    expect(dialogFor(FIXUP).querySelector(".term")).toHaveClass("term--popout");
    const css = readFileSync(path.resolve(__dirname, "../src/styles/popout.css"), "utf8");
    const at = css.indexOf(".term--popout {");
    expect(at).toBeGreaterThanOrEqual(0);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(/white-space: pre;/);
    expect(rule).toMatch(/word-break: normal;/);
    expect(rule).toMatch(/var\(--f-term\)/);
  });

  it("(h) −/+ change the text size, remembered in localStorage, within 9–20 px", () => {
    const { unmount } = renderDemo();
    popOut(FIXUP);
    const body = () => dialogFor(FIXUP).querySelector(".term") as HTMLElement;
    expect(body().style.fontSize).toBe("12px");
    fireEvent.click(screen.getByRole("button", { name: "Larger terminal text" }));
    expect(body().style.fontSize).toBe("13px");
    expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBe("13");
    unmount();

    renderDemo();
    popOut(FIXUP);
    expect(body().style.fontSize).toBe("13px");
    for (let i = 0; i < 20; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Larger terminal text" }));
    }
    expect(body().style.fontSize).toBe(`${TERMINAL_FONT_MAX}px`);
    for (let i = 0; i < 20; i++) {
      fireEvent.click(screen.getByRole("button", { name: "Smaller terminal text" }));
    }
    expect(body().style.fontSize).toBe(`${TERMINAL_FONT_MIN}px`);
    expect(localStorage.getItem(TERMINAL_FONT_KEY)).toBe(String(TERMINAL_FONT_MIN));
  });

  it("a stored size out of range or garbage falls back into bounds", () => {
    localStorage.setItem(TERMINAL_FONT_KEY, "99");
    const { unmount } = renderDemo();
    popOut(FIXUP);
    expect((dialogFor(FIXUP).querySelector(".term") as HTMLElement).style.fontSize).toBe("20px");
    unmount();
    localStorage.setItem(TERMINAL_FONT_KEY, "nope");
    renderDemo();
    popOut(FIXUP);
    expect((dialogFor(FIXUP).querySelector(".term") as HTMLElement).style.fontSize).toBe("12px");
  });

  it("is draggable by its title bar on a desktop", () => {
    renderDemo();
    popOut(FIXUP);
    const dialog = dialogFor(FIXUP);
    const handle = dialog.querySelector("[data-drag-handle]") as HTMLElement;
    expect(handle).not.toBeNull();
    const left = Number.parseFloat(dialog.style.left);
    const top = Number.parseFloat(dialog.style.top);
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1, button: 0 });
    fireEvent.pointerMove(handle, { clientX: 160, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 160, clientY: 140, pointerId: 1 });
    expect(Number.parseFloat(dialog.style.left)).toBe(left + 60);
    expect(Number.parseFloat(dialog.style.top)).toBe(top + 40);
  });

  it("(i) at phone width it is a full-screen sheet with no drag handle", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    renderDemo();
    popOut(FIXUP);
    const dialog = dialogFor(FIXUP);
    expect(dialog).toHaveClass("popout--sheet");
    expect(dialog.querySelector("[data-drag-handle]")).toBeNull();
    expect(screen.getByRole("button", { name: "Close terminal window" })).toBeInTheDocument();
  });

  it("follows the viewport across the phone breakpoint after it opened", () => {
    renderDemo();
    popOut(FIXUP);
    const dialog = dialogFor(FIXUP);
    const resize = (w: number) =>
      act(() => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: w });
        window.dispatchEvent(new Event("resize"));
      });
    resize(390);
    expect(dialog).toHaveClass("popout--sheet");
    resize(1440);
    expect(dialog).not.toHaveClass("popout--sheet");
    expect(dialog.querySelector("[data-drag-handle]")).not.toBeNull();
  });

  it("Escape closes a modal opened over a popout before the popout", () => {
    renderDemo();
    popOut(FIXUP);
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Dock" })).getByRole("button", {
        name: "Settings",
      }),
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    pressEscape();
    expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();
    expect(dialogFor(FIXUP)).toBeInTheDocument();
    pressEscape();
    expect(screen.queryByRole("dialog", { name: new RegExp(FIXUP) })).toBeNull();
  });

  it("canvas keys (f, +, -) do nothing while focus is inside a popout", () => {
    renderDemo();
    popOut(FIXUP);
    const dialog = dialogFor(FIXUP);
    for (const key of ["f", "+", "-"]) {
      // fireEvent returns false when a handler called preventDefault (the canvas acted).
      expect(fireEvent.keyDown(dialog, { key })).toBe(true);
    }
  });
});

describe("popoutWidth", () => {
  it("adds the whole chrome around the text: borders, margin, padding and a scrollbar gutter", () => {
    // popout border 2 + .term--popout margin 16 + .recessed border 2 + .term padding 20 + gutter 16.
    expect(POPOUT_CHROME_PX).toBe(56);
    expect(popoutWidth(120)).toBe("min(calc(100vw - 32px), calc(120ch + 56px))");
  });

  it("reserves the scrollbar gutter on the popout's terminal", () => {
    const css = readFileSync(path.resolve(__dirname, "../src/styles/popout.css"), "utf8");
    const at = css.indexOf(".term--popout {");
    expect(css.slice(at, css.indexOf("}", at))).toMatch(/scrollbar-gutter: stable;/);
  });
});

describe("terminal popout is live", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  const screenMsg = (lines: string[], at: number): DeskMessage => ({
    topic: `volley/demo/${FIXUP}/screen`,
    envelope: {
      schema_version: "0.1",
      agent_id: "volleyd",
      channel: "screen",
      type: "screen_tail",
      wall_time: new Date(at).toISOString(),
      payload: {
        lines,
        captured_at: new Date(at).toISOString(),
        workspace: "workspace:1",
        hash: lines.join("|"),
        source: "cmux",
      },
    },
    receivedAt: at,
    retained: true,
  });

  function mount() {
    const f = fakeClient();
    render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
        <App />
      </DeskStoreProvider>,
    );
    const step = (fn: () => void, ms = 1000) =>
      act(() => {
        fn();
        vi.advanceTimersByTime(ms);
      });
    step(() => {
      f.up();
      for (const m of demoMessages(NOW)) f.emit({ ...m, receivedAt: NOW });
      f.emit(screenMsg(["$ old line"], NOW));
    }, 2000);
    return { f, step };
  }

  it("(e) a new retained screen message updates the open window in place", () => {
    const { f, step } = mount();
    popOut(FIXUP);
    expect(dialogFor(FIXUP)).toHaveTextContent("$ old line");
    step(() => f.emit(screenMsg(["$ new line"], NOW + 1000)));
    expect(dialogFor(FIXUP)).toHaveTextContent("$ new line");
    expect(dialogFor(FIXUP)).not.toHaveTextContent("$ old line");
  });

  it("(f) shows `stale` while the task's screen_stale is set", () => {
    const { f, step } = mount();
    popOut(FIXUP);
    expect(within(dialogFor(FIXUP)).queryByText("stale")).toBeNull();
    const wave = demoMessages(NOW).find((m) => m.topic === "volley/_waves/status-chip/state");
    const e = wave?.envelope;
    if (!wave || !e) throw new Error("no wave state");
    const ws = e.payload as WaveStatePayload;
    const tasks = ws.tasks.map((t) => (t.id === "T1" ? { ...t, screen_stale: true } : t));
    step(() =>
      f.emit({
        ...wave,
        envelope: { ...e, payload: { ...ws, version: ws.version + 1, tasks } },
        receivedAt: NOW + 1000,
      }),
    );
    expect(within(dialogFor(FIXUP)).getByText("stale")).toBeInTheDocument();
  });
});
