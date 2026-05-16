import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useNotifySettings } from "../src/hooks/use-notify-settings";

const STORAGE_KEY = "volley-dash:notify";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("useNotifySettings", () => {
  it("returns defaults when localStorage is empty", () => {
    const { result } = renderHook(() => useNotifySettings());
    expect(result.current[0]).toEqual({
      enabled: false,
      sound: true,
      on: ["blocked", "failed", "reaped"],
    });
  });

  it("round-trips: writing settings persists to localStorage and reads back on remount", () => {
    const { result, unmount } = renderHook(() => useNotifySettings());
    act(() => {
      result.current[1]({ enabled: true, sound: false, on: ["blocked"] });
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
      enabled: true,
      sound: false,
      on: ["blocked"],
    });
    unmount();
    const { result: again } = renderHook(() => useNotifySettings());
    expect(again.current[0]).toEqual({
      enabled: true,
      sound: false,
      on: ["blocked"],
    });
  });

  it("falls back to defaults when localStorage contains malformed JSON", () => {
    localStorage.setItem(STORAGE_KEY, "{not valid json");
    const { result } = renderHook(() => useNotifySettings());
    expect(result.current[0]).toEqual({
      enabled: false,
      sound: true,
      on: ["blocked", "failed", "reaped"],
    });
  });

  it("setting enabled=true survives a remount", () => {
    const { result, unmount } = renderHook(() => useNotifySettings());
    act(() => {
      const current = result.current[0];
      result.current[1]({ ...current, enabled: true });
    });
    unmount();
    const { result: again } = renderHook(() => useNotifySettings());
    expect(again.current[0].enabled).toBe(true);
  });
});
