// C11: a broker holding hundreds of retained finished agents must not flash them onto the
// canvas on load (or on a reconnect) before their statuses classify them as finished.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { NO_SIGNAL_LABEL } from "../src/attention";
import { DeskStoreProvider } from "../src/store/context";
import type { DeskMessage } from "../src/store/types";
import { FINISHED_PREFIX, LIVE_PREFIX, liveIds, retainedBurst } from "./fixtures/retained-burst";
import { NOW, fakeClient } from "./helpers/desk-msgs";

const burst = retainedBurst({ now: NOW });
const replay = (part: "registry" | "status"): DeskMessage[] =>
  burst
    .filter((r) => (part === "registry") === r.topic.startsWith("volley/_system/registry/"))
    .map((r) => ({ ...r, receivedAt: NOW, retained: true }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

function mount() {
  const f = fakeClient();
  const view = render(
    <DeskStoreProvider demo={false} brokerUrl="ws://test.invalid" clientFactory={() => f.client}>
      <App />
    </DeskStoreProvider>,
  );
  const windows = (prefix: string) =>
    [...view.container.querySelectorAll(`section[aria-label^="${prefix}"]`)].map((e) =>
      e.getAttribute("aria-label"),
    );
  const step = (fn: () => void, ms: number) =>
    act(() => {
      fn();
      vi.advanceTimersByTime(ms);
    });
  return { f, view, windows, step };
}

describe("first load with ~300 retained finished agents (C11)", () => {
  it("the fixture is the owner's case: 300 finished, 3 live, registry entries replayed first", () => {
    expect(replay("registry")).toHaveLength(303);
    expect(replay("status")).toHaveLength(303);
  });

  it("never lays out a finished agent while the replay arrives in pieces", () => {
    const { f, windows, step } = mount();
    step(() => {
      f.up();
      for (const m of replay("registry")) f.emit(m);
    }, 30); // past a flush: the registry alone would put all 303 on the canvas
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    step(() => {
      for (const m of replay("status")) f.emit(m);
    }, 30);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    step(() => {}, 500);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
  });

  it("an agent with a registry entry but no status yet stays off the canvas until it has one", () => {
    const { f, windows, step } = mount();
    // The registry replay alone, released by the hold before any status arrives.
    step(() => {
      f.up();
      for (const m of replay("registry")) f.emit(m);
    }, 1000);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX)).toEqual([]);
    step(() => {
      for (const m of replay("status")) f.emit(m);
    }, 100);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
  });

  it("a status replay slower than the settle window still never flashes the finished agents", () => {
    const { f, windows, step } = mount();
    step(() => {
      f.up();
      for (const m of replay("registry")) f.emit(m);
    }, 4000); // a slow link: the statuses are still on their way when the replay settles
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    step(() => {
      for (const m of replay("status")) f.emit(m);
    }, 100);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
  });

  it("a reconnect keeps the live agents on the canvas and never brings the finished ones back", () => {
    const { f, windows, step } = mount();
    step(() => {
      f.up();
      for (const m of [...replay("registry"), ...replay("status")]) f.emit(m);
    }, 5000);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());

    step(() => {
      f.drop();
      f.up();
    }, 250); // a replay slower than the hold's quiet window: the resync applies first
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
    step(() => {
      for (const m of replay("registry")) f.emit(m);
    }, 30);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
    step(() => {
      for (const m of replay("status")) f.emit(m);
    }, 30);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
    step(() => {}, 5000);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
  });

  it("a reconnect whose resync applies before the replay still keeps the live agents in place", () => {
    const { f, windows, step } = mount();
    step(() => {
      f.up();
      for (const m of [...replay("registry"), ...replay("status")]) f.emit(m);
    }, 5000);
    // Nothing replayed until the hold's bound has released the resync on its own.
    step(() => {
      f.drop();
      f.up();
    }, 2000);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
    step(() => {
      for (const m of [...replay("registry"), ...replay("status")]) f.emit(m);
    }, 5000);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
  });
});

describe("an agent registered here that never publishes a status", () => {
  const [registry] = replay("registry").filter((m) => m.envelope?.agent_id === liveIds()[0]);
  const fresh = registry as DeskMessage;

  it("gets its window with the no-signal mark once the Desk has synced", () => {
    const { f, windows, step } = mount();
    step(() => {
      f.up();
      f.emit(fresh);
    }, 5000);
    expect(windows(LIVE_PREFIX)).toEqual([]); // its status may still be on its way
    step(() => {}, 35_000); // past the syncing grace, which judges no signal
    expect(windows(LIVE_PREFIX)).toEqual([liveIds()[0]]);
    expect(document.body.textContent).toContain(NO_SIGNAL_LABEL);
  });

  it("is hidden with the finished agents when its record is old and nothing live is heard from it", () => {
    const { f, windows, step, view } = mount();
    step(() => {
      f.up();
      for (const m of replay("registry")) f.emit(m); // 300 old records, 3 fresh ones
    }, 40_000);
    expect(windows(FINISHED_PREFIX)).toEqual([]);
    expect(windows(LIVE_PREFIX).sort()).toEqual(liveIds());
    expect(view.container.textContent).toMatch(/300 finished/);
  });
});
