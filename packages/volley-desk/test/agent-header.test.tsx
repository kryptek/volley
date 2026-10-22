import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { demoMessages } from "../src/store/fixtures";
import { initialState, reduceAll } from "../src/store/reducer";
import type { DeskState, UsagePayload, WaveTask, WaveView } from "../src/store/types";
import { AgentWindow, type AgentWindowProps } from "../src/windows/agent/AgentWindow";
import { machineFor } from "../src/windows/agent/machine";
import { machineRecord, placement, readiness } from "./helpers/desk-msgs";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const FIXUP = "status-chip-t1-fixup-1";
const LONG =
  "A deliberately long task title that runs to about ninety characters, so it has to wrap";

const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

const usage: UsagePayload = {
  account: "work",
  model: "claude-opus-5-5",
  context_window: { used_percentage: 10, used: 20_000, size: 200_000 },
  rate_limits: {},
  captured_at: new Date(NOW).toISOString(),
};
const accounts = [
  { id: "work", label: "Work", machine: "box-a", fivePct: 91, weeklyPct: 40 },
  { id: "personal", label: "Personal", machine: "box-a", fivePct: 12, weeklyPct: 22 },
];

/** The demo state with the fixup's task T1 changed (host, placement) and its title replaced. */
function demo(task: Partial<WaveTask> = {}, title?: string): DeskState {
  const s = reduceAll(initialState(), demoMessages(NOW));
  const agent = s.agents[FIXUP];
  const wave = agent && s.waves[agent.wave];
  const ws = wave?.state;
  if (!agent || !wave || !ws) throw new Error("no demo agent");
  const spec = ws.spec;
  const next: WaveView = {
    ...wave,
    state: {
      ...ws,
      tasks: ws.tasks.map((t) => (t.id === "T1" ? { ...t, ...task } : t)),
      ...(spec && title
        ? {
            spec: {
              ...spec,
              tasks: { ...spec.tasks, T1: { ...spec.tasks.T1, title } },
            },
          }
        : {}),
    } as WaveView["state"],
  };
  return {
    ...s,
    waves: { ...s.waves, [agent.wave]: next },
    machines: { ...s.machines, "box-a": machineRecord() },
    readiness: { ...s.readiness, "box-a": readiness() },
  };
}

function renderHeader(state: DeskState, props: Partial<AgentWindowProps> = {}) {
  const agent = state.agents[FIXUP];
  if (!agent) throw new Error("no agent");
  const wave = state.waves[agent.wave];
  return render(
    <AgentWindow
      agent={agent}
      wave={wave}
      accent="#c4b5fd"
      frame={frame}
      now={NOW}
      usage={usage}
      accounts={accounts}
      onMoveAccount={vi.fn()}
      machine={machineFor(agent, wave, state)}
      {...props}
    />,
  );
}

describe("agent window header: two rows", () => {
  it("row 1 holds the mark and the chips; row 2 the headline, its link and the account picker", () => {
    const { container } = renderHeader(demo({ host: "box-a", placement: placement() }));
    const row1 = container.querySelector(".win-bar > .win-title") as HTMLElement;
    expect(within(row1).getByRole("img", { name: /In progress/ })).toBeInTheDocument();
    expect(within(row1).getByText("status-chip")).toHaveClass("chip--wave");
    expect(within(row1).getByText("fixup")).toHaveClass("chip--role");
    expect(within(row1).getByRole("button", { name: "Runs on box-a: why here" })).toBeTruthy();
    expect(row1.querySelector(".t-name")).toBeNull();

    const row2 = container.querySelector(".win-bar > .win-sub") as HTMLElement;
    expect(row2.querySelector(".t-name")).toHaveTextContent(
      "T1 · Chip mapper + null-case handling",
    );
    expect(within(row2).getByRole("link", { name: "Issue #102 on GitHub" })).toBeInTheDocument();
    expect(within(row2).getByRole("combobox", { name: "Claude account for T1" })).toBeTruthy();
    expect(container.querySelector(".a-purpose")).toBeNull();
  });
});

describe("agent window header: GitHub links", () => {
  /** The demo state with the fixup's wave state's `github` removed. */
  function noGithub(): DeskState {
    const s = demo();
    const agent = s.agents[FIXUP];
    const wave = agent && s.waves[agent.wave];
    if (!agent || !wave?.state) throw new Error("no demo agent");
    const { github: _, ...state } = wave.state;
    return { ...s, waves: { ...s.waves, [agent.wave]: { ...wave, state } as WaveView } };
  }

  it("the issue is a named link to the wave's github; a pointer-down on it starts no drag", () => {
    const onDrag = vi.fn();
    renderHeader(demo(), { frame: { ...frame, onDrag } });
    const issue = screen.getByRole("link", { name: "Issue #102 on GitHub" });
    expect(issue).toHaveAttribute("href", "https://github.com/example-org/example-repo/issues/102");
    expect(issue.getAttribute("rel")).toContain("noopener");
    expect(issue).toHaveAttribute("target", "_blank");
    expect(issue).toHaveTextContent("#102");
    fireEvent.pointerDown(issue, { button: 0, pointerId: 1, clientX: 5, clientY: 5 });
    expect(onDrag).not.toHaveBeenCalled();
  });

  it("without github the number is shown unlinked", () => {
    const { container } = renderHeader(noGithub());
    const row2 = container.querySelector(".win-bar > .win-sub") as HTMLElement;
    expect(within(row2).getByText("#102")).toHaveClass("a-link", "dim");
    expect(screen.queryByRole("link", { name: /Issue #102/ })).toBeNull();
  });
});

describe("agent window header: the machine chip", () => {
  it("a remote host: its name and an up dot; the tooltip gives why here and its load", () => {
    const onOpenMachine = vi.fn();
    renderHeader(demo({ host: "box-a", placement: placement() }), { onOpenMachine });
    const chip = screen.getByRole("button", { name: "Runs on box-a: why here" });
    expect(chip.querySelector(".m-dot--up")).toBeTruthy();
    // The account picker has a tooltip of its own: the chip's is the one it names.
    const tip = document.getElementById(chip.getAttribute("aria-describedby") ?? "");
    expect(tip).toHaveAttribute("role", "tooltip");
    expect(tip).toHaveTextContent("box-a: 0.82 (cpu 0.9, slots 0.5, mem 0.71, usage 0.58)");
    expect(tip).toHaveTextContent("cores");
    fireEvent.click(chip);
    expect(onOpenMachine).toHaveBeenCalledWith("box-a");
  });

  it("the supervisor's own machine reads `this machine`", () => {
    const s = demo({ placement: placement({ host: "studio" }) });
    renderHeader(s);
    expect(screen.getByRole("button", { name: "Runs on this machine: why here" })).toBeTruthy();
  });

  it("an agent with no placed task has no machine chip", () => {
    renderHeader(demo());
    expect(screen.queryByRole("button", { name: /^Runs on/ })).toBeNull();
  });
});

describe("agent window header: compact and long titles", () => {
  it("under 420 px it is compact; the picker keeps its name and options, in row 2", () => {
    const { container } = renderHeader(demo(), { frame: { ...frame, maxWidth: 380 } });
    expect(container.querySelector("section.win")).toHaveClass("win--compact");
    const pick = screen.getByRole("combobox", { name: "Claude account for T1" });
    expect(pick.querySelectorAll("option")).toHaveLength(2);
    expect(pick.closest(".win-sub")).toBeTruthy();
    const actions = container.querySelector(".win-actions") as HTMLElement;
    for (const el of actions.children) expect(el.tagName).toBe("BUTTON");
  });

  it("a 90-character title renders whole in .t-name, never ellipsised on one line", () => {
    expect(LONG.length).toBeGreaterThanOrEqual(85);
    const { container } = renderHeader(demo({}, LONG));
    const name = container.querySelector(".t-name") as HTMLElement;
    expect(name).toHaveTextContent(`T1 · ${LONG}`);
    expect(name).not.toHaveClass("ell");
    expect(name.style.whiteSpace).not.toBe("nowrap");
    expect(name).toHaveAttribute("title", expect.stringContaining(LONG));
    fireEvent.click(name);
    expect(name).toHaveClass("t-name--open");
  });
});

const STYLES = join(__dirname, "../src/styles");
const css = (f: string) => readFileSync(join(STYLES, f), "utf8");

/** Every declaration of the rules whose selector list includes exactly `selector`. */
function decls(sheet: string, selector: string): string {
  const out: string[] = [];
  for (const m of sheet.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sels = (m[1] ?? "").split(",").map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2] ?? "");
  }
  return out.join(";").replace(/\s+/g, " ");
}

describe("agent window header: the stylesheet holds the no-overlap rules", () => {
  const desk = css("desk.css");
  const agent = css("agent.css");
  it.each([
    [desk, ".win-bar", /flex-wrap: wrap/],
    [desk, ".win-sub", /flex-basis: 100%/],
    [desk, ".win-title", /min-width: 0/],
    [desk, ".win-title", /flex-wrap: wrap/],
    [desk, ".win-actions", /flex: none/],
    [desk, ".win-bar .chip", /overflow: hidden/],
    [desk, ".win-bar .chip", /text-overflow: ellipsis/],
    [desk, ".win-bar .chip", /max-width: \d+px/],
    [desk, ".win--compact .acct-pick", /(^|[ ;])width: \d+px/],
    // The machine chip keeps "this machine" readable in compact form (a phone has no hover tooltip).
    [desk, ".win--compact .win-bar .m-chip", /max-width: 120px/],
    [agent, ".win-sub .t-name", /-webkit-line-clamp: 2/],
    [agent, ".win-sub .t-name", /text-wrap: balance/],
  ])("%#: a rule declares it", (sheet, selector, re) => {
    expect(decls(sheet, selector)).toMatch(re);
  });

  it("the two-line clamp is scoped to the agent header: other windows' titles stay on one line", () => {
    // agent.css is global once an agent window loads; the wave, coordinators, settings and
    // setup titles share .t-name and must not wrap.
    expect(decls(agent, ".t-name")).toBe("");
    expect(decls(desk, ".t-name")).toMatch(/white-space: nowrap/);
    expect(decls(agent, ".win-sub .t-name")).toMatch(/white-space: normal/);
    expect(decls(agent, ".win-sub .t-name--open")).toMatch(/-webkit-line-clamp: unset/);
  });
});
