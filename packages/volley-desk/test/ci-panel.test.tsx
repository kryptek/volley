// A task held for CI with no agent running gets a CI panel window (#488), cabled to its wave
// window like an agent window; it replaces the tiny `CI` stub pill of #451.
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { GAP } from "../src/layout/arrange";
import { LOOK_STORAGE_KEY } from "../src/look/useLook";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMessage, WaveTask } from "../src/store/types";
import { CiPanel, etaLabel } from "../src/windows/wave/CiPanel";
import { NOW, S, fakeClient, registry, status, waveMsg, waveState } from "./helpers/desk-msgs";

const WHY = "CI 3/13 · running: Backend IT shard 2–6/6 · ~8 min left";
const URL = "https://example.invalid/pr/12";

const JOBS = {
  done: 3,
  total: 13,
  running: ["Backend IT shard 2/6", "Backend IT shard 3/6"],
  failed: [] as string[],
};

function held(over: Partial<WaveTask> = {}, jobs: Partial<typeof JOBS> = {}): WaveTask {
  return {
    id: "T1",
    issue: 1,
    stage: "implement",
    agents: { implementer: "impl-1" },
    why_waiting: WHY,
    pr: { number: 12, url: URL, jobs: { ...JOBS, ...jobs }, eta_s: 480 },
    ...over,
  };
}

const frame = {
  pos: { x: 0, y: 0 },
  z: 1,
  scale: 1,
  chrome: "glass" as const,
  onMove: () => {},
  onFocus: () => {},
};

const panel = (task: WaveTask) =>
  render(<CiPanel task={task} wave="w1" accent="#6ee7f9" frame={frame} />);

describe("CiPanel", () => {
  it("a jobs hold: title, chip, progress bar, the estimate, running jobs and the checks link", () => {
    panel(held());
    const win = screen.getByRole("region", { name: "T1 CI" });
    expect(win.querySelector(".t-name")).toHaveTextContent("T1 · #12");
    expect(win.querySelector(".chip--ci")).toHaveTextContent("waiting for CI");
    const bar = within(win).getByRole("progressbar", { name: "T1 CI jobs" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "13");
    expect(win.querySelector(".ci-jobs")?.textContent).toBe("3/13 jobs · ~8 min left");
    const running = within(win).getByRole("list", { name: "running" });
    expect(
      within(running)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Backend IT shard 2/6", "Backend IT shard 3/6"]);
    expect(within(win).queryByRole("list", { name: "failed" })).toBeNull();
    const link = within(win).getByRole("link", { name: "Checks for PR #12 on GitHub" });
    expect(link).toHaveAttribute("href", `${URL}/checks`);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("failed jobs are listed in red", () => {
    panel(held({}, { done: 4, failed: ["lint"] }));
    const failed = screen.getByRole("list", { name: "failed" });
    const li = within(failed).getByRole("listitem");
    expect(li).toHaveTextContent("lint");
    expect(li).toHaveClass("ci-failed");
  });

  it("queued when nothing runs yet and jobs remain", () => {
    panel(held({}, { done: 0, running: [] }));
    expect(screen.getByText("queued")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "running" })).toBeNull();
  });

  it("the estimate's wording", () => {
    expect(etaLabel(undefined)).toBe("");
    expect(etaLabel(30)).toBe("<1 min left");
    expect(etaLabel(480)).toBe("~8 min left");
    panel(held({ pr: { number: 12, url: URL, jobs: JOBS, eta_s: 30 } }));
    expect(document.querySelector(".ci-jobs")?.textContent).toBe("3/13 jobs · <1 min left");
  });

  it("no estimate: the line is the jobs alone", () => {
    panel(held({ pr: { number: 12, url: URL, jobs: JOBS } }));
    expect(document.querySelector(".ci-jobs")?.textContent).toBe("3/13 jobs");
  });

  it("a hold with no readable jobs shows its sentence instead of the bar", () => {
    const why = "CI unreadable (no answer), retrying";
    panel(held({ why_waiting: why, pr: { number: 12, url: URL } }));
    const win = screen.getByRole("region", { name: "T1 CI" });
    expect(within(win).queryByRole("progressbar")).toBeNull();
    expect(win).toHaveTextContent(why);
    expect(within(win).getByRole("link", { name: "Checks for PR #12 on GitHub" })).toBeTruthy();
  });

  it("no PR at all: the task id alone, no link", () => {
    const { pr: _, ...rest } = held({ why_waiting: "CI pending on abc1234 (0/5 checks)" });
    panel(rest);
    const win = screen.getByRole("region", { name: "T1 CI" });
    expect(win.querySelector(".t-name")?.textContent).toBe("T1");
    expect(within(win).queryByRole("link")).toBeNull();
  });
});

describe("CI panel in the Desk", () => {
  afterEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });

  const live = (id: string, type: string, at = NOW - 60 * S): DeskMessage[] => [
    registry(id, at),
    status(id, type, at),
  ];

  function mount() {
    // The placeholder layout (no arrange): the panel takes an agent window's slot.
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ autoArrange: false }));
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fakeClient();
    const view = render(
      <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
        <App />
      </DeskStoreProvider>,
    );
    const emit = (...ms: DeskMessage[]) =>
      act(() => {
        for (const m of ms) f.emit(m);
        vi.advanceTimersByTime(100);
      });
    act(() => f.up());
    // The implementer finished long ago: its window has left the canvas.
    emit(...live("coord-1", "working"), ...live("impl-1", "done", NOW - 30 * 60 * S));
    return { ...view, emit };
  }
  const cable = (c: HTMLElement, id: string) =>
    c.querySelector(`svg.tethers g.tether[data-agent="${id}"]`);

  it("comes with the hold, gives way to a fixup agent, and leaves when CI is done", () => {
    const { container, emit } = mount();
    emit(waveMsg(waveState({ tasks: [held()] })));
    const win = screen.getByRole("region", { name: "T1 CI" });
    expect(win.closest(".world")).not.toBeNull();
    expect(cable(container, "w1/ci/T1")).not.toBeNull();
    expect(container.querySelector(".tether-stub")).toBeNull();

    emit(
      ...live("fix-1", "working", NOW - 5 * S),
      waveMsg(waveState({ tasks: [held({ agents: { implementer: "impl-1", fixup: "fix-1" } })] })),
    );
    expect(screen.queryByRole("region", { name: "T1 CI" })).toBeNull();
    expect(cable(container, "fix-1")).not.toBeNull();
    expect(cable(container, "w1/ci/T1")).toBeNull();

    const { why_waiting: _, ...review } = held({ stage: "spec_review" });
    emit(...live("fix-1", "done", NOW - 30 * 60 * S), waveMsg(waveState({ tasks: [review] })));
    expect(screen.queryByRole("region", { name: "T1 CI" })).toBeNull();
    expect(cable(container, "w1/ci/T1")).toBeNull();
  });

  it("takes an agent window's slot right of the wave window; two holds get two panels", () => {
    const { container, emit } = mount();
    emit(waveMsg(waveState({ tasks: [held()] })));
    const wave = screen.getByRole("region", { name: "w1" });
    const one = screen.getByRole("region", { name: "T1 CI" });
    expect(one.style.left).toBe(`${Number.parseFloat(wave.style.width) + GAP}px`);
    expect(one.style.left).toBe("656px");
    expect(one.style.top).toBe(wave.style.top);

    emit(
      waveMsg(
        waveState({
          tasks: [held(), held({ id: "T2", issue: 2, agents: {} })],
        }),
      ),
    );
    const a = screen.getByRole("region", { name: "T1 CI" });
    const b = screen.getByRole("region", { name: "T2 CI" });
    expect(cable(container, "w1/ci/T1")).not.toBeNull();
    expect(cable(container, "w1/ci/T2")).not.toBeNull();
    expect([b.style.left, b.style.top]).not.toEqual([a.style.left, a.style.top]);
  });

  it("leaves with its wave when the wave is hidden and comes back when it is shown", () => {
    const { container, emit } = mount();
    emit(waveMsg(waveState({ tasks: [held()] })));
    expect(screen.getByRole("region", { name: "T1 CI" })).toBeInTheDocument();
    const row = container.querySelector('.coord-list > li[aria-label="w1"]') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Hide w1" }));
    expect(screen.queryByRole("region", { name: "T1 CI" })).toBeNull();
    expect(cable(container, "w1/ci/T1")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Show w1" }));
    expect(screen.getByRole("region", { name: "T1 CI" })).toBeInTheDocument();
    expect(cable(container, "w1/ci/T1")).not.toBeNull();
  });
});

describe("CI panel styles", () => {
  const css = (f: string) => readFileSync(path.resolve(__dirname, `../src/styles/${f}`), "utf8");

  it("the stub pill is gone; the panel is styled from tokens", () => {
    expect(css("look.css")).not.toContain(".tether-stub");
    const wave = css("wave.css");
    for (const sel of [".ci-panel", ".ci-bar", ".ci-failed"]) expect(wave, sel).toContain(sel);
  });
});
