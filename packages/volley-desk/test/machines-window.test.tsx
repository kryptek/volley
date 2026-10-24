import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { demoState } from "../src/store/fixtures";
import { reduce } from "../src/store/reducer";
import type { DeskState } from "../src/store/types";
import {
  MachinesWindow,
  type MachinesWindowProps,
  machineRows,
} from "../src/windows/machines/MachinesWindow";
import { machineMsg, machineRecord } from "./helpers/desk-msgs";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const STATE = demoState(NOW);

const frame: MachinesWindowProps["frame"] = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass",
  onMove: () => {},
  onFocus: () => {},
};

function renderWindow(state: DeskState = STATE, over: Partial<MachinesWindowProps> = {}) {
  const onOpen = vi.fn();
  const r = render(
    <MachinesWindow
      rows={machineRows(state, true)}
      now={NOW}
      frame={frame}
      onOpen={onOpen}
      onClose={() => {}}
      {...over}
    />,
  );
  return { ...r, onOpen };
}
const row = (name: string) =>
  screen.getByRole("button", { name: `${name}: open in Settings › Machines` });

describe("machineRows", () => {
  it("this machine first, then the configured hosts with a record, by name", () => {
    expect(machineRows(STATE, true).map((r) => [r.name, r.label])).toEqual([
      ["studio", "this machine"],
      ["box-a", "box-a"],
      ["box-b", "box-b"],
    ]);
  });

  it("a record that is not a configured host is not a row", () => {
    const s = reduce(STATE, machineMsg(machineRecord({ name: "stranger" })));
    expect(machineRows(s, true).map((r) => r.name)).not.toContain("stranger");
  });
});

describe("the Machines window", () => {
  it("is a section named Machines with one row per machine, in order", () => {
    renderWindow();
    const win = screen.getByRole("region", { name: "Machines" });
    expect(
      within(win)
        .getAllByRole("button", { name: /open in Settings › Machines$/ })
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "this machine: open in Settings › Machines",
      "box-a: open in Settings › Machines",
      "box-b: open in Settings › Machines",
    ]);
  });

  it("an up peer's row: load, memory, agents, specs and the up dot", () => {
    renderWindow();
    const r = row("box-a");
    expect(r).toHaveTextContent("load 1.6/32");
    expect(r).toHaveTextContent("mem 29%");
    expect(r).toHaveTextContent("2/6 agents");
    expect(r).toHaveTextContent("32 cores · 64 GB");
    expect(r.querySelector(".m-dot--up")).not.toBeNull();
    expect(r.querySelectorAll("svg.spark")).toHaveLength(2);
  });

  it("this machine: its agents against its cap, overloaded when volleyd finds it ineligible", () => {
    renderWindow();
    const r = row("this machine");
    expect(r).toHaveTextContent("this machine");
    expect(r).toHaveTextContent("load 3.1/12");
    expect(r).toHaveTextContent("5/12 agents");
    expect(r.querySelector(".m-dot--overloaded")).not.toBeNull();
  });

  it("a down machine: last seen, the down dot and two flat grey lines", () => {
    renderWindow();
    const r = row("box-b");
    expect(r).toHaveTextContent("down · last seen 6m ago");
    expect(r).not.toHaveTextContent(/load \d/);
    expect(r.querySelector(".m-dot--down")).not.toBeNull();
    const sparks = [...r.querySelectorAll("svg.spark")];
    expect(sparks).toHaveLength(2);
    for (const s of sparks) expect(s.getAttribute("class")).toContain("spark--down");
  });

  it("describes each row in words, so the state is not colour alone", () => {
    const hot = reduce(
      STATE,
      machineMsg(
        machineRecord({
          name: "box-a",
          cores: 4,
          load: [3.8, 3, 2],
          memory: { total_mb: 16_384, available_pct: 25 },
          last_seen: new Date(NOW).toISOString(),
        }),
      ),
    );
    renderWindow(hot);
    const r = row("box-a");
    const desc = r.getAttribute("aria-describedby");
    expect(desc).toBeTruthy();
    const text = document.getElementById(desc as string)?.textContent ?? "";
    expect(text).toBe(
      // The demo's box-a runs the Desk (SPEC §4.6.24).
      "box-a: load 3.8 of 4 cores, 95 %, critical — memory 75 %, high — 2 of 6 agents — runs the Desk",
    );
    expect(r.querySelector(".mrow-load")?.className).toContain("lvl--bad");
    expect(r.querySelector(".mrow-mem")?.className).toContain("lvl--warn");
    const down = document.getElementById(row("box-b").getAttribute("aria-describedby") as string);
    expect(down?.textContent).toBe("box-b: down, last seen 6m ago — 0 of 4 agents");
  });

  it("a click on a row opens that machine in Settings › Machines", () => {
    const { onOpen } = renderWindow();
    fireEvent.click(row("box-a"));
    expect(onOpen).toHaveBeenCalledWith("box-a");
    fireEvent.click(row("this machine"));
    expect(onOpen).toHaveBeenCalledWith("studio");
  });

  it("says so when there is no machine yet", () => {
    renderWindow(STATE, { rows: [] });
    expect(screen.getByRole("region", { name: "Machines" })).toHaveTextContent("No machines yet");
  });

  it("closes from its title bar", () => {
    const onClose = vi.fn();
    renderWindow(STATE, { onClose });
    fireEvent.click(screen.getByRole("button", { name: "Close Machines" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("at phone width the rows stack: name line, then the sparklines full width", () => {
    const { container } = renderWindow(STATE, { narrow: true });
    expect(container.querySelector(".machines-win--phone")).not.toBeNull();
    const css = readFileSync(join(__dirname, "../src/styles/machines-window.css"), "utf8").replace(
      /\s+/g,
      " ",
    );
    const at = css.indexOf("@media (max-width: 699px)");
    expect(at).toBeGreaterThanOrEqual(0);
    const phone = css.slice(at);
    expect(phone).toMatch(/\.mrow-sparks \{[^}]*grid-template-columns: 1fr;/);
    expect(css).toMatch(/\.machines-win--phone \.mrow-sparks \{[^}]*grid-template-columns: 1fr;/);
  });
});
