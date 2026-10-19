// C11: a broker holding hundreds of retained finished agents must not flash them onto the
// canvas on load (or on a reconnect) before their statuses classify them as finished.
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
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
  return { f, windows, step };
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
});
