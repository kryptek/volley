import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDUCED_MOTION_QUERY } from "../src/a11y/motion";
import { CLAWD_FRAME_MS, useClawdTick } from "../src/clawd/clock";

const realMatchMedia = window.matchMedia;

function prefersReducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query === REDUCED_MOTION_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

/** A matchMedia whose reduced-motion answer flips with `set`, firing its change listeners. */
function switchableReducedMotion(on: boolean) {
  let matches = on;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return matches && query === REDUCED_MOTION_QUERY;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      for (const l of [...listeners]) l();
    },
    listeners,
  };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  prefersReducedMotion(false);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
});

describe("the Clawd clock", () => {
  it("two subscribers share one interval and see the same tick", () => {
    const spy = vi.spyOn(globalThis, "setInterval");
    const a = renderHook(() => useClawdTick());
    const b = renderHook(() => useClawdTick());
    expect(spy).toHaveBeenCalledTimes(1);
    const t0 = a.result.current;
    act(() => {
      vi.advanceTimersByTime(CLAWD_FRAME_MS * 3);
    });
    expect(a.result.current).toBe(t0 + 3);
    expect(b.result.current).toBe(a.result.current);
    a.unmount();
    b.unmount();
  });

  it("the interval exists only while someone subscribes", () => {
    const set = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    expect(vi.getTimerCount()).toBe(0);
    const a = renderHook(() => useClawdTick());
    const b = renderHook(() => useClawdTick());
    expect(vi.getTimerCount()).toBe(1);
    a.unmount();
    expect(vi.getTimerCount()).toBe(1);
    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
    expect(set).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("stops while the page is hidden and resumes when it is visible", () => {
    const a = renderHook(() => useClawdTick());
    act(() => setHidden(true));
    expect(vi.getTimerCount()).toBe(0);
    const t = a.result.current;
    act(() => {
      vi.advanceTimersByTime(CLAWD_FRAME_MS * 4);
    });
    expect(a.result.current).toBe(t);
    act(() => setHidden(false));
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(CLAWD_FRAME_MS);
    });
    expect(a.result.current).toBe(t + 1);
    a.unmount();
  });

  it("under reduced motion the tick stays 0 and no interval runs", () => {
    prefersReducedMotion(true);
    const a = renderHook(() => useClawdTick());
    expect(a.result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    act(() => {
      vi.advanceTimersByTime(CLAWD_FRAME_MS * 5);
    });
    expect(a.result.current).toBe(0);
    a.unmount();
  });

  it("follows the reduced-motion query while sprites are mounted", () => {
    const motion = switchableReducedMotion(false);
    const a = renderHook(() => useClawdTick());
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(CLAWD_FRAME_MS * 2);
    });
    expect(a.result.current).toBeGreaterThan(0);
    act(() => motion.set(true));
    expect(a.result.current).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    act(() => motion.set(false));
    expect(vi.getTimerCount()).toBe(1);
    const t = a.result.current;
    act(() => {
      vi.advanceTimersByTime(CLAWD_FRAME_MS);
    });
    expect(a.result.current).toBe(t + 1);
    a.unmount();
    expect(motion.listeners.size).toBe(0);
  });
});
