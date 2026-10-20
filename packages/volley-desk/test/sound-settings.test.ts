/** Settings › Sound's model: `volley-desk-sound`, validated key by key, mirrored into `volley-dash:notify`. */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NOTIFY_STORAGE_KEY } from "../src/notify/use-notify-settings";
import {
  SOUND0,
  SOUND_STORAGE_KEY,
  loadSoundSettings,
  saveSoundSettings,
  useSoundSettings,
} from "../src/sounds/settings";

afterEach(() => localStorage.clear());

const store = (v: unknown) =>
  localStorage.setItem(SOUND_STORAGE_KEY, typeof v === "string" ? v : JSON.stringify(v));

describe("loadSoundSettings", () => {
  it("returns the defaults for an empty store", () => {
    const s = loadSoundSettings();
    expect(s).toEqual(SOUND0);
    expect(s.theme).toBe("synthwave");
    expect(s.events.agent_working).toBe(false);
    expect(s.events.agent_complete).toBe(true);
    expect(s.followReducedMotion).toBe(true);
    expect(s.vibrate).toBe(true);
    expect(s.quietHours.attentionToo).toBe(false);
  });

  it("falls back on a corrupt entry", () => {
    store("{nope");
    expect(loadSoundSettings()).toEqual(SOUND0);
  });

  it("falls back key by key, never letting a wrong-typed value through", () => {
    store({
      theme: "kazoo",
      volume: 2,
      muted: true,
      quietHours: { on: true, from: "25:00", to: "06:30", attentionToo: true },
      events: { ui_click: false, bogus: true, agent_complete: "yes" },
    });
    const s = loadSoundSettings();
    expect(s.theme).toBe(SOUND0.theme);
    expect(s.volume).toBe(SOUND0.volume);
    expect(s.muted).toBe(true);
    expect(s.quietHours).toEqual({
      on: true,
      from: SOUND0.quietHours.from,
      to: "06:30",
      attentionToo: true,
    });
    expect(s.events.ui_click).toBe(false);
    expect(s.events.agent_complete).toBe(true);
    expect("bogus" in s.events).toBe(false);
  });

  it("seeds attention_needed from volley-dash:notify on first load only", () => {
    localStorage.setItem(
      NOTIFY_STORAGE_KEY,
      JSON.stringify({ enabled: true, sound: false, on: [] }),
    );
    expect(loadSoundSettings().events.attention_needed).toBe(false);
    localStorage.removeItem(NOTIFY_STORAGE_KEY);
    expect(loadSoundSettings().events.attention_needed).toBe(true);
    // Once a sound entry exists, it wins.
    store({ events: { attention_needed: true } });
    localStorage.setItem(NOTIFY_STORAGE_KEY, JSON.stringify({ sound: false }));
    expect(loadSoundSettings().events.attention_needed).toBe(true);
  });
});

describe("saveSoundSettings", () => {
  it("mirrors !muted && attention_needed into notify.sound, keeping the other keys", () => {
    localStorage.setItem(
      NOTIFY_STORAGE_KEY,
      JSON.stringify({ enabled: true, sound: true, on: ["failed"] }),
    );
    saveSoundSettings({ ...SOUND0, muted: true });
    expect(JSON.parse(localStorage.getItem(NOTIFY_STORAGE_KEY) ?? "")).toEqual({
      enabled: true,
      sound: false,
      on: ["failed"],
    });
    saveSoundSettings(SOUND0);
    expect(JSON.parse(localStorage.getItem(NOTIFY_STORAGE_KEY) ?? "").sound).toBe(true);
    saveSoundSettings({ ...SOUND0, events: { ...SOUND0.events, attention_needed: false } });
    expect(JSON.parse(localStorage.getItem(NOTIFY_STORAGE_KEY) ?? "").sound).toBe(false);
    expect(JSON.parse(localStorage.getItem(SOUND_STORAGE_KEY) ?? "").events.attention_needed).toBe(
      false,
    );
  });
});

describe("useSoundSettings", () => {
  it("merges a partial change, persists it and keeps the rest", () => {
    const { result } = renderHook(() => useSoundSettings());
    act(() => result.current[1]({ volume: 0.25 }));
    act(() => result.current[1]({ events: { ui_click: false } }));
    expect(result.current[0].volume).toBe(0.25);
    expect(result.current[0].events.ui_click).toBe(false);
    expect(result.current[0].events.ui_drop).toBe(true);
    expect(loadSoundSettings().volume).toBe(0.25);
    expect(loadSoundSettings().events.ui_click).toBe(false);
  });
});
