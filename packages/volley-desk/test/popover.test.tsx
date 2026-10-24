import { fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Popover, type PopoverProps } from "../src/look/Popover";

type Extra = Partial<Omit<PopoverProps, "anchor" | "children">>;

function Harness(props: Extra) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <div data-testid="parent">
      <button type="button" ref={ref}>
        anchor
      </button>
      <Popover anchor={ref} open role="tooltip" id="t" {...props}>
        <p>card body</p>
      </Popover>
    </div>
  );
}

describe("Popover", () => {
  it("renders into document.body, not into the anchor's parent", () => {
    render(<Harness />);
    const card = screen.getByRole("tooltip");
    expect(card).toHaveTextContent("card body");
    expect(card.parentElement).toBe(document.body);
    expect(screen.getByTestId("parent")).not.toContainElement(card);
    expect(card).toHaveClass("host-pop");
    expect(card).toHaveAttribute("data-side", "below");
  });

  it("renders nothing when closed", () => {
    render(<Harness open={false} />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByText("card body")).toBeNull();
  });

  it("role, id and aria-label pass through", () => {
    render(<Harness role="dialog" id="d" aria-label="Why here" />);
    const card = screen.getByRole("dialog", { name: "Why here" });
    expect(card.id).toBe("d");
  });

  it("Escape fires onClose", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a pointerdown outside closes a dialog; inside it or on the anchor it does not", () => {
    const onClose = vi.fn();
    render(<Harness role="dialog" aria-label="x" dismiss="outside" onClose={onClose} />);
    fireEvent.pointerDown(screen.getByText("card body"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "anchor" }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a tooltip (dismiss none) ignores a pointerdown outside", () => {
    const onClose = vi.fn();
    render(<Harness dismiss="none" onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("pointer enter and leave on the card reach the caller", () => {
    const onPointerEnter = vi.fn();
    const onPointerLeave = vi.fn();
    render(<Harness onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave} />);
    const card = screen.getByRole("tooltip");
    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
    expect(onPointerLeave).toHaveBeenCalledTimes(1);
  });
});
