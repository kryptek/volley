import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { LOOK0, LOOK_STORAGE_KEY, loadLook, useLook } from "../src/look/useLook";

const stored = () => JSON.parse(localStorage.getItem(LOOK_STORAGE_KEY) ?? "null");

beforeEach(() => {
  localStorage.clear();
});

describe("useLook", () => {
  it("defaults to the prototype LOOK0 (pulse is the Needs-you default)", () => {
    expect(LOOK0).toEqual({
      bg: "GradientWaves",
      dim: 0.2,
      chrome: "glass",
      attn: "pulse",
      narr: "decrypt",
      tethers: true,
      theme: "volley",
      icons: "clawd",
      fx: "glint",
      autoArrange: true,
      showFinished: false,
      finishedGraceMin: 10,
    });
    const { result } = renderHook(() => useLook());
    expect(result.current[0]).toEqual(LOOK0);
  });

  it("uses the volley-desk-look localStorage key", () => {
    expect(LOOK_STORAGE_KEY).toBe("volley-desk-look");
  });

  it("persists every change and reloads it in a fresh hook", () => {
    const { result, unmount } = renderHook(() => useLook());
    act(() => result.current[1]({ bg: "Silk", dim: 0.45 }));
    act(() => result.current[1]({ chrome: "spotlight", attn: "electric", narr: "shiny" }));
    act(() => result.current[1]({ tethers: false, autoArrange: false }));
    act(() => result.current[1]({ showFinished: true, finishedGraceMin: 30 }));
    act(() => result.current[1]({ icons: "classic", theme: "dracula", fx: "aurora" }));
    const want = {
      bg: "Silk",
      dim: 0.45,
      chrome: "spotlight",
      attn: "electric",
      narr: "shiny",
      tethers: false,
      theme: "dracula",
      icons: "classic",
      fx: "aurora",
      autoArrange: false,
      showFinished: true,
      finishedGraceMin: 30,
    };
    expect(result.current[0]).toEqual(want);
    expect(stored()).toEqual(want);
    unmount();
    const again = renderHook(() => useLook());
    expect(again.result.current[0]).toEqual(want);
  });

  it("loads a stored theme and falls back to Volley for an unknown one", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ theme: "dracula" }));
    expect(loadLook().theme).toBe("dracula");
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ theme: "neon" }));
    expect(loadLook().theme).toBe("volley");
  });

  it("keeps a partial entry (D6 writes autoArrange alone) and fills the rest from LOOK0", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ autoArrange: false }));
    expect(loadLook()).toEqual({ ...LOOK0, autoArrange: false });
  });

  it("ignores a corrupt entry and values of the wrong kind", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, "{not json");
    expect(loadLook()).toEqual(LOOK0);
    localStorage.setItem(
      LOOK_STORAGE_KEY,
      JSON.stringify({
        bg: "NoSuchBackground",
        dim: 7,
        chrome: "chrome",
        attn: 3,
        narr: "loud",
        tethers: "yes",
        icons: "ring",
        fx: 4,
        theme: "neon",
        autoArrange: null,
        showFinished: 1,
        finishedGraceMin: -5,
      }),
    );
    expect(loadLook()).toEqual(LOOK0);
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ bg: "none", dim: 0 }));
    expect(loadLook()).toEqual({ ...LOOK0, bg: "none", dim: 0 });
  });

  it("agent icons: a stored classic loads; anything else falls back to clawd", () => {
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ icons: "classic" }));
    expect(loadLook().icons).toBe("classic");
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ icons: "ring" }));
    expect(loadLook().icons).toBe("clawd");
  });

  it("current step: glint by default, a stored classic loads, anything else falls back", () => {
    expect(LOOK0.fx).toBe("glint");
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ fx: "classic" }));
    expect(loadLook().fx).toBe("classic");
    localStorage.setItem(LOOK_STORAGE_KEY, JSON.stringify({ fx: "sparkle" }));
    expect(loadLook().fx).toBe("glint");
  });
});
