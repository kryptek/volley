import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClawdSprite } from "../src/clawd/ClawdSprite";
import { BODY_FAILED, C } from "../src/clawd/palette";
import { CLAWD_LABEL, CLAWD_STATES } from "../src/clawd/variants";

describe("ClawdSprite", () => {
  it.each(CLAWD_STATES)("%s: role img named by the state's label", (state) => {
    render(<ClawdSprite agentId="a-1" state={state} />);
    const img = screen.getByRole("img", { name: CLAWD_LABEL[state] });
    expect(img.tagName.toLowerCase()).toBe("svg");
    expect(img).toHaveAttribute("viewBox", "0 0 16 14");
    expect(img.classList.contains("clawd-sprite--glow")).toBe(state === "merge_ready");
    expect(img.querySelector("title")).toHaveTextContent(CLAWD_LABEL[state]);
  });

  it("one path per colour, the body's non-empty", () => {
    const { container } = render(<ClawdSprite agentId="a-1" state="fixup" />);
    const ps = [...container.querySelectorAll("path")];
    const fills = ps.map((p) => p.getAttribute("fill"));
    expect(new Set(fills).size).toBe(ps.length);
    expect(ps.length).toBeLessThanOrEqual(8);
    const body = ps.find((p) => p.getAttribute("fill") === C.body);
    expect(body?.getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
  });

  it("failed draws the darker body", () => {
    const { container } = render(<ClawdSprite agentId="a-1" state="failed" />);
    expect(container.querySelector(`path[fill="${BODY_FAILED}"]`)).not.toBeNull();
  });

  it("24 × 21 by default", () => {
    render(<ClawdSprite agentId="a-1" state="review" />);
    const img = screen.getByRole("img");
    expect(img).toHaveAttribute("width", "24");
    expect(img).toHaveAttribute("height", "21");
  });

  it("keeps its variant on rerender", () => {
    const { container, rerender } = render(<ClawdSprite agentId="a-1" state="implement" />);
    const v = container.querySelector("svg")?.getAttribute("data-variant");
    expect(v).toBeTruthy();
    for (let i = 0; i < 3; i++) {
      rerender(<ClawdSprite agentId="a-1" state="implement" />);
      expect(container.querySelector("svg")?.getAttribute("data-variant")).toBe(v);
    }
  });
});
