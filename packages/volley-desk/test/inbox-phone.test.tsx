import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ctxFrom, inboxAttention } from "../src/attention";
import { demoAutopilot, demoInbox } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import { NeedsYouWindow, type NeedsYouWindowProps } from "../src/windows/inbox/NeedsYouWindow";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const STATE = reduceAll(initialState(), [...demoAutopilot(NOW), ...demoInbox(NOW)]);
const ITEMS = Object.values(STATE.inbox ?? {});

const frame: NeedsYouWindowProps["frame"] = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
  maxWidth: 366,
};

function renderPhone() {
  return render(
    <NeedsYouWindow
      items={ITEMS}
      tiers={Object.fromEntries(
        ITEMS.map((i) => [i.id, inboxAttention(i, STATE, ctxFrom(STATE, { now: NOW })).tier]),
      )}
      live={{ "p-coord-a1b2c3-toolu_01AbCdEf": "A long narration line that must stay on one line" }}
      waves={STATE.waves}
      control={vi.fn(async () => ({ ok: true }))}
      device="phone"
      narrow
      frame={frame}
      onClose={() => {}}
      onGoTo={() => {}}
      loadEvidence={async () => null}
    />,
  );
}

/** The `@media (max-width: 699px)` block of inbox.css, whitespace collapsed. */
function phoneCss(): string {
  const css = readFileSync(join(__dirname, "../src/styles/inbox.css"), "utf8").replace(/\s+/g, " ");
  const at = css.indexOf("@media (max-width: 699px)");
  expect(at).toBeGreaterThanOrEqual(0);
  return css.slice(at);
}

const ruleFor = (css: string, selector: string) => {
  const at = css.indexOf(selector);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

describe("the Needs you window at phone width (390 px)", () => {
  it("is the phone layout: stacked full-width cards within the clamped window", () => {
    const { container } = renderPhone();
    expect(container.querySelector(".inbox")).toHaveClass("inbox--phone");
    const win = screen.getByRole("region", { name: "Needs you" });
    expect(Number.parseFloat(win.style.width)).toBeLessThanOrEqual(366);
    const css = phoneCss();
    expect(ruleFor(css, ".inbox-card.spotlight-card")).toContain("flex-wrap: wrap");
    expect(ruleFor(css, ".inbox-options")).toContain("flex-direction: column");
    expect(ruleFor(css, ".inbox-live")).toContain("white-space: nowrap");
  });

  it("every answer, action and tab is a target of at least 48 px", () => {
    const css = phoneCss();
    const rule = ruleFor(css, ".inbox-target,");
    expect(rule).toContain(".inbox-row .icon-btn");
    expect(rule).toContain('.inbox-tabs [role="tab"]');
    expect(rule).toContain("min-height: 48px");
    expect(rule).toContain("min-width: 48px");

    renderPhone();
    const win = screen.getByRole("region", { name: "Needs you" });
    fireEvent.click(within(win).getAllByRole("button", { name: "Other…" })[0] as HTMLElement);
    for (const row of within(win).getAllByRole("listitem", { name: /^Inbox item/ })) {
      // The release train's step indicators are disabled: a status display, not a target.
      for (const b of within(row).getAllByRole("button")) {
        if (b.closest(".inbox-train")) continue;
        expect(
          b.classList.contains("inbox-target") || b.classList.contains("icon-btn"),
          b.getAttribute("aria-label") ?? b.textContent ?? "",
        ).toBe(true);
      }
      for (const t of within(row).queryAllByRole("textbox")) expect(t).toHaveClass("inbox-target");
    }
    expect(within(win).getAllByRole("tab")).toHaveLength(5);
  });
});

describe("a grouped row at phone width (#417)", () => {
  it("is one card whose every button is a 48 px target", () => {
    const decision = ITEMS.find((i) => i.kind === "decision");
    if (!decision) throw new Error("no demo decision");
    const burst = Array.from({ length: 3 }, (_, i) => ({
      ...decision,
      id: `d-burst-${i}`,
      task: `B${i}`,
      opened_at: new Date(NOW - (10 - i) * 60_000).toISOString(),
    }));
    render(
      <NeedsYouWindow
        items={burst}
        tiers={Object.fromEntries(burst.map((i) => [i.id, "you" as const]))}
        waves={STATE.waves}
        control={vi.fn(async () => ({ ok: true }))}
        device="phone"
        narrow
        frame={frame}
        onClose={() => {}}
        onGoTo={() => {}}
        loadEvidence={async () => null}
      />,
    );
    const win = screen.getByRole("region", { name: "Needs you" });
    const rows = within(win).getAllByRole("listitem", { name: /^Inbox item/ });
    expect(rows).toHaveLength(1);
    const row = rows[0] as HTMLElement;
    expect(within(row).getByText("×3")).toBeInTheDocument();
    fireEvent.click(within(row).getByRole("button", { name: "Other…" }));
    for (const b of within(row).getAllByRole("button"))
      expect(
        b.classList.contains("inbox-target") || b.classList.contains("icon-btn"),
        b.getAttribute("aria-label") ?? b.textContent ?? "",
      ).toBe(true);
  });
});
