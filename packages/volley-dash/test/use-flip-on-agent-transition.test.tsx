/**
 * Phase 3 — useFlipOnAgentTransition.
 *
 * The Flip wrapper intercepts `AGENT_TRANSITION` actions to animate the
 * grid reflow. Tests cover the four branches:
 *   - reduced motion → skip the Flip cycle entirely (dispatch only)
 *   - no `[data-agent-id]` elements in DOM → skip Flip (dispatch only)
 *   - happy path → capture, flushSync(dispatch), play
 *   - non-transition action → pass through unchanged
 *
 * `gsap` and `gsap/Flip` are stubbed so the test exercises the wrapper
 * decision tree rather than GSAP's animation runtime. `flushSync` is
 * exercised against react-dom's real implementation since it has no I/O.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetState, mockFrom } = vi.hoisted(() => ({
  mockGetState: vi.fn(() => ({ marker: "flip-state" })),
  mockFrom: vi.fn(),
}));

vi.mock("gsap", () => ({
  gsap: {
    registerPlugin: vi.fn(),
  },
}));

vi.mock("gsap/Flip", () => ({
  Flip: {
    getState: mockGetState,
    from: mockFrom,
  },
}));

import { useFlipOnAgentTransition } from "../src/hooks/useFlipOnAgentTransition";
import type { DashAction } from "../src/state/reducer";

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  addEventListener: () => void;
  removeEventListener: () => void;
  addListener: () => void;
  removeListener: () => void;
  dispatchEvent: () => boolean;
  onchange: null;
}

function setReducedMotion(reduce: boolean): void {
  const mql: MockMediaQueryList = {
    matches: reduce,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  };
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue(mql),
  });
}

const TRANSITION: DashAction = {
  type: "AGENT_TRANSITION",
  id: "agent-1",
  status: "done",
  lastSeen: 1_700_000_000_000,
};

const SELECT: DashAction = { type: "SELECT_AGENT", id: "agent-1" };

beforeEach(() => {
  mockGetState.mockClear();
  mockFrom.mockClear();
  document.body.innerHTML = "";
  setReducedMotion(false);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useFlipOnAgentTransition", () => {
  it("captures Flip state, dispatches, and plays the animation on AGENT_TRANSITION", () => {
    document.body.innerHTML =
      '<div data-agent-id="agent-1"></div><div data-agent-id="agent-2"></div>';
    const rawDispatch = vi.fn();
    const { result } = renderHook(() => useFlipOnAgentTransition(rawDispatch));

    act(() => {
      result.current(TRANSITION);
    });

    expect(mockGetState).toHaveBeenCalledTimes(1);
    expect(rawDispatch).toHaveBeenCalledWith(TRANSITION);
    expect(mockFrom).toHaveBeenCalledTimes(1);
    expect(mockFrom).toHaveBeenCalledWith(
      { marker: "flip-state" },
      expect.objectContaining({
        duration: 0.28,
        ease: "quart.out",
        absolute: true,
      }),
    );
  });

  it("skips the Flip cycle when prefers-reduced-motion: reduce is active", () => {
    document.body.innerHTML =
      '<div data-agent-id="agent-1"></div><div data-agent-id="agent-2"></div>';
    setReducedMotion(true);
    const rawDispatch = vi.fn();
    const { result } = renderHook(() => useFlipOnAgentTransition(rawDispatch));

    act(() => {
      result.current(TRANSITION);
    });

    expect(mockGetState).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(rawDispatch).toHaveBeenCalledWith(TRANSITION);
  });

  it("skips the Flip cycle when no cards are mounted", () => {
    document.body.innerHTML = "";
    const rawDispatch = vi.fn();
    const { result } = renderHook(() => useFlipOnAgentTransition(rawDispatch));

    act(() => {
      result.current(TRANSITION);
    });

    expect(mockGetState).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(rawDispatch).toHaveBeenCalledWith(TRANSITION);
  });

  it("passes non-transition actions straight through", () => {
    document.body.innerHTML = '<div data-agent-id="agent-1"></div>';
    const rawDispatch = vi.fn();
    const { result } = renderHook(() => useFlipOnAgentTransition(rawDispatch));

    act(() => {
      result.current(SELECT);
    });

    expect(mockGetState).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(rawDispatch).toHaveBeenCalledWith(SELECT);
  });

  it("returns a stable wrapper across re-renders when rawDispatch is stable", () => {
    const rawDispatch = vi.fn();
    const { result, rerender } = renderHook(() => useFlipOnAgentTransition(rawDispatch));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
