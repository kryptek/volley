import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  type AttnStyle,
  type Chrome,
  Frame,
  type FrameProps,
  hexA,
  hexToHsl,
} from "../src/canvas/Frame";
import { BG_FALLBACK, Background } from "../src/look/Background";
import type { BackgroundDef } from "../src/look/backgrounds";

const base: Omit<FrameProps, "children"> = {
  id: "w",
  title: "wave-1",
  accent: "#6ee7f9",
  pos: { x: 0, y: 0 },
  width: 460,
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};
const win = () => screen.getByRole("region", { name: "wave-1" });

describe("Frame chromes", () => {
  const cases: [Chrome, string | null][] = [
    ["glass", null],
    ["liquid", ".win-inner > .win-glass .glass-surface"],
    ["spotlight", ".spotlight-card.win-wrap > .win-inner"],
    ["glow", ".border-glow-card.win-wrap .win-inner"],
    ["solid", null],
  ];
  it.each(cases)("%s renders its wrapper", (chrome, wrapper) => {
    render(
      <Frame {...base} chrome={chrome}>
        body
      </Frame>,
    );
    const el = win();
    expect(el.querySelector(".win-inner")).toHaveClass(`chrome-${chrome}`);
    expect(el).toHaveTextContent("body");
    if (wrapper) expect(el.querySelector(wrapper)).not.toBeNull();
    else expect(el.firstElementChild).toHaveClass("win-inner");
    // Only the liquid chrome lays glass under the content.
    expect(el.querySelector(".win-glass") !== null).toBe(chrome === "liquid");
  });

  it("tints the spotlight and glow with the accent", () => {
    expect(hexA("#6ee7f9", 0.22)).toBe("rgba(110,231,249,0.22)");
    expect(hexToHsl("#ff0000")).toBe("0 100 50");
    expect(hexToHsl("#6ee7f9")).toBe("188 92 70");
  });
});

describe("Frame Needs-you effects", () => {
  const cases: [AttnStyle, string][] = [
    ["pulse", ".win-attn.win-attn-pulse"],
    ["electric", ".electric-border.win-attn"],
    ["star", ".star-border.win-attn.win-attn-star"],
  ];
  it.each(cases)("attn='you' + %s renders its wrapper", (attnStyle, wrapper) => {
    render(
      <Frame {...base} attn="you" attnStyle={attnStyle}>
        body
      </Frame>,
    );
    const outer = win().firstElementChild;
    expect(outer?.matches(wrapper)).toBe(true);
    expect(outer?.querySelector(".win-inner")).not.toBeNull();
    // No effect may wrap the window in an interactive element: it holds buttons.
    expect(outer?.tagName).toBe("DIV");
    for (const [other, sel] of cases) {
      if (other !== attnStyle) expect(win().querySelector(sel)).toBeNull();
    }
  });

  it("defaults to the pulse", () => {
    render(
      <Frame {...base} attn="you">
        body
      </Frame>,
    );
    expect(win().firstElementChild).toHaveClass("win-attn-pulse");
  });

  it("wraps the chrome wrapper, and only at tier you", () => {
    const { rerender } = render(
      <Frame {...base} chrome="spotlight" attn="you" attnStyle="star">
        body
      </Frame>,
    );
    expect(win().querySelector(".star-border .spotlight-card .win-inner")).not.toBeNull();
    rerender(
      <Frame {...base} chrome="spotlight" attn="coordinator" attnStyle="star">
        body
      </Frame>,
    );
    expect(win().querySelector(".win-attn")).toBeNull();
    expect(win().firstElementChild).toHaveClass("spotlight-card");
  });
});

describe("Background", () => {
  function Boom(): never {
    throw new Error("no WebGL");
  }
  const Calm = () => <div data-testid="calm">calm</div>;
  const registry: BackgroundDef[] = [
    { key: "Boom", name: "Boom", C: Boom as unknown as BackgroundDef["C"] },
    { key: "Calm", name: "Calm", C: Calm as unknown as BackgroundDef["C"] },
    { key: "none", name: "None (plain)", C: null },
  ];

  it("shows the fallback message when the background throws, and recovers on a new pick", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container, rerender } = render(
      <Background which="Boom" dim={0.2} backgrounds={registry} />,
    );
    expect(container.querySelector(".bg-fallback")).toHaveTextContent(BG_FALLBACK);
    rerender(<Background which="Calm" dim={0.2} backgrounds={registry} />);
    expect(screen.getByTestId("calm")).toBeInTheDocument();
    expect(container.querySelector(".bg-fallback")).toBeNull();
    spy.mockRestore();
  });

  it("sets the dim overlay's opacity and renders nothing but the plain ground for None", () => {
    const { container } = render(<Background which="none" dim={0.55} backgrounds={registry} />);
    expect((container.querySelector(".bg-dim") as HTMLElement).style.opacity).toBe("0.55");
    expect(container.querySelector(".bg-plain")).not.toBeNull();
  });
});
