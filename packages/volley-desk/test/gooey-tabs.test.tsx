/**
 * The agent window's Volley feed / Terminal tabs on React Bits Gooey Nav
 * (D10): still a tablist of tabs with one selected, arrow keys (and Home /
 * End) move the selection and the focus, and the selected tab's panel shows.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GooeyTabs } from "../src/look/GooeyTabs";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import { AgentWindow } from "../src/windows/agent/AgentWindow";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

function renderAgent() {
  const state = reduceAll(initialState(), demoMessages(NOW));
  const agent = Object.values(state.agents).find((a) => a.screen !== null && a.feed.length > 0);
  if (!agent) throw new Error("no demo agent with a feed and a screen");
  return render(
    <AgentWindow
      agent={agent}
      wave={state.waves[agent.wave]}
      accent="#c4b5fd"
      frame={frame}
      now={NOW}
    />,
  );
}

const tab = (name: RegExp) => screen.getByRole("tab", { name });
const FEED = /Volley feed/;
const TERM = /Terminal/;

describe("Gooey Nav tabs", () => {
  it("render through Gooey Nav as a tablist with one selected tab", () => {
    const { container } = renderAgent();
    const list = screen.getByRole("tablist");
    expect(list).toHaveClass("gooey-nav", "tabs");
    expect(within(list).getAllByRole("tab")).toHaveLength(2);
    expect(tab(FEED)).toHaveAttribute("aria-selected", "true");
    expect(tab(TERM)).toHaveAttribute("aria-selected", "false");
    // Roving focus: only the selected tab is in the Tab order.
    expect(tab(FEED)).toHaveAttribute("tabindex", "0");
    expect(tab(TERM)).toHaveAttribute("tabindex", "-1");
    // The decorative active-label copy is hidden from assistive tech.
    expect(container.querySelector(".gooey-nav__list--active")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("the selected tab controls a labelled tabpanel showing its view", () => {
    renderAgent();
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", tab(FEED).id);
    expect(tab(FEED)).toHaveAttribute("aria-controls", panel.id);
    expect(panel.querySelector(".feed")).not.toBeNull();
  });

  it("arrow keys move the selection and the focus; the panel follows", () => {
    renderAgent();
    tab(FEED).focus();
    fireEvent.keyDown(tab(FEED), { key: "ArrowRight" });
    expect(tab(TERM)).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tab(TERM));
    expect(screen.getByRole("tabpanel").querySelector(".term")).not.toBeNull();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", tab(TERM).id);
    // Wraps around at either end.
    fireEvent.keyDown(tab(TERM), { key: "ArrowRight" });
    expect(tab(FEED)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab(FEED), { key: "ArrowLeft" });
    expect(tab(TERM)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab(TERM), { key: "Home" });
    expect(tab(FEED)).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tab(FEED), { key: "End" });
    expect(tab(TERM)).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tab(TERM));
  });

  it("the active tab's ink is the theme's on-pill ink", () => {
    const { container } = renderAgent();
    const nav = container.querySelector(".gooey-tabs") as HTMLElement;
    expect(nav.style.getPropertyValue("--gn-active-ink")).toBe("var(--on-hi)");
  });

  it("a click selects a tab", () => {
    renderAgent();
    fireEvent.click(tab(TERM));
    expect(tab(TERM)).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel").querySelector(".term")).not.toBeNull();
  });

  it("other keys are left alone (the Desk's own keys still work)", () => {
    const onChange = vi.fn();
    render(
      <GooeyTabs
        label="Views"
        tabs={[
          { key: "a", label: "A" },
          { key: "b", label: "B" },
        ]}
        value="a"
        onChange={onChange}
        accent="#6ee7f9"
      />,
    );
    const a = screen.getByRole("tab", { name: "A" });
    const ev = fireEvent.keyDown(a, { key: "f" });
    expect(ev).toBe(true); // not prevented
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(a, { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
  });
});
