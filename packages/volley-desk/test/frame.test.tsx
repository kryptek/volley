import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BORN_MS, COMPACT_PX, Frame, type FrameProps, useFocusOrder } from "../src/canvas/Frame";

const base: Omit<FrameProps, "children"> = {
  id: "w",
  title: "wave-1",
  accent: "#6ee7f9",
  pos: { x: 10, y: 20 },
  width: 460,
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};

const section = (title: string) => screen.getByRole("region", { name: title });
const titleBar = (title: string) => section(title).querySelector(".win-bar") as HTMLElement;

afterEach(() => {
  vi.useRealTimers();
});

describe("Frame", () => {
  it("renders at its world position and width with the accent variable", () => {
    render(<Frame {...base}>body</Frame>);
    const el = section("wave-1");
    expect(el.style.left).toBe("10px");
    expect(el.style.top).toBe("20px");
    expect(el.style.width).toBe("460px");
    expect(el.style.getPropertyValue("--acc")).toBe("#6ee7f9");
    expect(el.querySelector(".win-inner")).toHaveClass("chrome-glass");
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("drags by the title bar, dividing the pointer delta by the zoom scale", () => {
    const onMove = vi.fn();
    render(
      <Frame {...base} scale={0.5} onMove={onMove}>
        body
      </Frame>,
    );
    const bar = titleBar("wave-1");
    fireEvent.pointerDown(bar, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(bar, { clientX: 110, clientY: 95 });
    fireEvent.pointerMove(bar, { clientX: 130, clientY: 95 });
    fireEvent.pointerUp(bar);
    fireEvent.pointerMove(bar, { clientX: 300, clientY: 300 });
    expect(onMove.mock.calls).toEqual([
      [20, -10],
      [40, 0],
    ]);
  });

  it("moves the window in a parent that applies onMove", () => {
    function Movable() {
      const [pos, setPos] = useState({ x: 0, y: 0 });
      return (
        <Frame
          {...base}
          pos={pos}
          scale={2}
          onMove={(dx, dy) => setPos((p) => ({ x: p.x + dx, y: p.y + dy }))}
        >
          body
        </Frame>
      );
    }
    render(<Movable />);
    const bar = titleBar("wave-1");
    fireEvent.pointerDown(bar, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(bar, { clientX: 50, clientY: 30 });
    expect(section("wave-1").style.left).toBe("25px");
    expect(section("wave-1").style.top).toBe("15px");
  });

  it("does not start a drag from a title-bar button", () => {
    const onMove = vi.fn();
    render(
      <Frame {...base} onMove={onMove} actions={<button type="button">gear</button>}>
        body
      </Frame>,
    );
    const btn = screen.getByRole("button", { name: "gear" });
    fireEvent.pointerDown(btn, { clientX: 0, clientY: 0 });
    fireEvent.pointerMove(titleBar("wave-1"), { clientX: 50, clientY: 30 });
    expect(onMove).not.toHaveBeenCalled();
  });

  it("pointer-down anywhere focuses: the window's z rises above the others", () => {
    function Two() {
      const { z, focus } = useFocusOrder();
      return (
        <>
          <Frame {...base} id="a" title="A" z={z("a")} onFocus={() => focus("a")}>
            a
          </Frame>
          <Frame {...base} id="b" title="B" z={z("b")} onFocus={() => focus("b")}>
            <p>b body</p>
          </Frame>
        </>
      );
    }
    render(<Two />);
    const zOf = (t: string) => Number(section(t).style.zIndex);
    expect(zOf("A")).toBe(zOf("B"));
    fireEvent.pointerDown(screen.getByText("b body"));
    expect(zOf("B")).toBeGreaterThan(zOf("A"));
    fireEvent.pointerDown(titleBar("A"), { clientX: 0, clientY: 0 });
    expect(zOf("A")).toBeGreaterThan(zOf("B"));
  });

  it("keeps the born class for 4 s", () => {
    vi.useFakeTimers();
    render(
      <Frame {...base} born>
        body
      </Frame>,
    );
    expect(BORN_MS).toBe(4000);
    expect(section("wave-1")).toHaveClass("win--born");
    act(() => vi.advanceTimersByTime(3999));
    expect(section("wave-1")).toHaveClass("win--born");
    act(() => vi.advanceTimersByTime(1));
    expect(section("wave-1")).not.toHaveClass("win--born");
  });

  it("has no born class unless born", () => {
    render(<Frame {...base}>body</Frame>);
    expect(section("wave-1")).not.toHaveClass("win--born");
  });

  it("reports its size through onSize", () => {
    const onSize = vi.fn();
    render(
      <Frame {...base} onSize={onSize}>
        body
      </Frame>,
    );
    expect(onSize).toHaveBeenCalledWith(expect.any(Number), expect.any(Number));
  });

  it("supports the solid chrome, a footer and an attention wrapper slot", () => {
    render(
      <Frame
        {...base}
        chrome="solid"
        attn="you"
        footer={<span>foot</span>}
        wrapAttention={(node) => <div data-testid="attn">{node}</div>}
      >
        body
      </Frame>,
    );
    const el = section("wave-1");
    expect(el).toHaveClass("win--attn-you");
    expect(el.querySelector(".win-inner")).toHaveClass("chrome-solid");
    expect(screen.getByTestId("attn")).toContainElement(screen.getByText("body"));
    expect(screen.getByText("foot").closest("footer")).toHaveClass("win-foot");
  });

  it("a subtitle is a full-width second row of the bar, after the actions", () => {
    render(
      <Frame {...base} actions={<button type="button">act</button>} subtitle={<span>sub</span>}>
        body
      </Frame>,
    );
    const bar = titleBar("wave-1");
    const sub = bar.querySelector(":scope > .win-sub");
    expect(sub).toHaveTextContent("sub");
    expect(bar.lastElementChild).toBe(sub);
    expect(sub?.previousElementSibling).toHaveClass("win-actions");
  });

  it("has no subtitle row without a subtitle", () => {
    render(<Frame {...base}>body</Frame>);
    expect(titleBar("wave-1").querySelector(".win-sub")).toBeNull();
  });

  it("is compact when its effective width is under COMPACT_PX", () => {
    expect(COMPACT_PX).toBe(420);
    const { unmount } = render(
      <Frame {...base} maxWidth={380}>
        body
      </Frame>,
    );
    expect(section("wave-1")).toHaveClass("win--compact");
    unmount();
    render(<Frame {...base}>body</Frame>);
    expect(section("wave-1")).not.toHaveClass("win--compact");
  });

  it("drags by the subtitle row too", () => {
    const onDrag = vi.fn();
    const onMove = vi.fn();
    render(
      <Frame {...base} onDrag={onDrag} onMove={onMove} subtitle={<span>sub</span>}>
        body
      </Frame>,
    );
    const sub = titleBar("wave-1").querySelector(".win-sub") as HTMLElement;
    fireEvent.pointerDown(sub, { clientX: 100, clientY: 100 });
    expect(onDrag).toHaveBeenCalledWith(true);
    fireEvent.pointerMove(sub, { clientX: 120, clientY: 100 });
    expect(onMove).toHaveBeenCalledWith(20, 0);
  });
});
