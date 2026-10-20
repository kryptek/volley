/** The Web Audio player: lazy per-theme load, decoded-buffer cache, silent fallback. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlayer } from "../src/sounds/player";
import {
  type FakeAudio,
  type FakeFetch,
  installFakeAudio,
  installFetch,
  themeRoutes,
} from "./helpers/fake-audio";

let audio: FakeAudio | null = null;
let net: FakeFetch | null = null;

const ctx = () => {
  const c = audio?.contexts[0];
  if (!c) throw new Error("no context");
  return c;
};

beforeEach(() => {
  audio = installFakeAudio();
});

afterEach(() => {
  audio?.restore();
  net?.restore();
  audio = null;
  net = null;
  vi.restoreAllMocks();
});

describe("createPlayer", () => {
  it("is silent, never throwing, without an AudioContext", async () => {
    audio?.restore();
    audio = null;
    net = installFetch(themeRoutes("synthwave", ["ui_click"]));
    const p = createPlayer({ baseUrl: "/sounds" });
    await expect(p.loadTheme("synthwave")).resolves.toBeUndefined();
    await expect(p.play("ui_click")).resolves.toBeUndefined();
    await expect(p.unlock()).resolves.toBeUndefined();
    expect(() => p.setVolume(0.5)).not.toThrow();
    expect(net.calls).toEqual([]);
  });

  it("loads a theme lazily, once: its manifest then each clip, decoded and cached", async () => {
    net = installFetch({
      ...themeRoutes("synthwave", ["ui_click", "agent_complete"]),
      ...themeRoutes("arcade", ["ui_click"]),
    });
    const p = createPlayer({ baseUrl: "/sounds" });
    await p.loadTheme("synthwave");
    expect(net.calls).toEqual([
      "/sounds/synthwave/manifest.json",
      "/sounds/synthwave/ui_click.ogg",
      "/sounds/synthwave/agent_complete.ogg",
    ]);
    expect(ctx().decodeAudioData).toHaveBeenCalledTimes(2);
    await p.loadTheme("synthwave");
    expect(net.calls).toHaveLength(3);
    expect(p.isLoaded("synthwave")).toBe(true);
  });

  it("switching themes fetches only the new one and drops the old unless kept", async () => {
    net = installFetch({
      ...themeRoutes("synthwave", ["ui_click"]),
      ...themeRoutes("arcade", ["ui_click"]),
      ...themeRoutes("glass", ["ui_click"]),
    });
    const p = createPlayer({ baseUrl: "/sounds" });
    await p.loadTheme("synthwave");
    await p.loadTheme("arcade", { keep: true });
    expect(p.isLoaded("synthwave")).toBe(true);
    expect(p.theme()).toBe("synthwave");
    await p.loadTheme("glass");
    expect(net.calls.filter((u) => u.includes("glass"))).toHaveLength(2);
    expect(p.theme()).toBe("glass");
    expect(p.isLoaded("synthwave")).toBe(false);
    expect(p.isLoaded("arcade")).toBe(false);
  });

  it("a 404 manifest, a 404 clip or a failed decode is silence, logged once per id", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const routes = themeRoutes("synthwave", ["ui_click", "ui_drop", "agent_complete"]);
    Reflect.deleteProperty(routes, "/sounds/synthwave/ui_drop.ogg");
    net = installFetch(routes);
    audio?.undecodable.add("synthwave/agent_complete");
    const p = createPlayer({ baseUrl: "/sounds" });
    await p.unlock();
    await p.loadTheme("synthwave");
    await p.play("ui_drop");
    await p.play("ui_drop");
    await p.play("agent_complete");
    expect(ctx().sources).toHaveLength(0);
    expect(debug).toHaveBeenCalledTimes(2);
    await p.play("ui_click");
    expect(ctx().sources).toHaveLength(1);

    await expect(p.loadTheme("nope")).resolves.toBeUndefined();
    await expect(p.play("ui_click")).resolves.toBeUndefined();
  });

  it("a manifest's missing list short-circuits those ids", async () => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    net = installFetch(themeRoutes("minimal", ["ui_click"], "/sounds", { missing: ["ui_drop"] }));
    const p = createPlayer({ baseUrl: "/sounds" });
    await p.loadTheme("minimal");
    expect(net.calls).not.toContain("/sounds/minimal/ui_drop.ogg");
  });

  it("plays through the master gain; setVolume sets it; nothing before unlock", async () => {
    net = installFetch(themeRoutes("synthwave", ["agent_complete"]));
    const p = createPlayer({ baseUrl: "/sounds" });
    await p.loadTheme("synthwave");
    await p.play("agent_complete");
    expect(ctx().sources).toHaveLength(0);
    await p.unlock();
    expect(ctx().resume).toHaveBeenCalledTimes(1);
    await p.play("agent_complete", { gain: 0.5 });
    const [master, voice] = ctx().gains;
    const [src] = ctx().sources;
    expect(src?.started).toBe(true);
    expect(src?.buffer).toEqual({ decoded: "synthwave/agent_complete" });
    expect(src?.connectedTo).toBe(voice);
    expect(voice?.gain.value).toBe(0.5);
    expect(voice?.connectedTo).toBe(master);
    expect(master?.connectedTo).toBe(ctx().destination);
    p.setVolume(0.25);
    expect(master?.gain.value).toBe(0.25);
  });

  it("vibrates when the browser can, and is a no-op when it cannot", () => {
    const p = createPlayer({ baseUrl: "/sounds" });
    const nav = navigator as { vibrate?: unknown };
    const had = Object.hasOwn(nav, "vibrate");
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    p.vibrate([80, 40, 80]);
    expect(vibrate).toHaveBeenCalledWith([80, 40, 80]);
    Object.defineProperty(navigator, "vibrate", { value: undefined, configurable: true });
    expect(() => p.vibrate([80])).not.toThrow();
    if (!had) Reflect.deleteProperty(nav, "vibrate");
    expect(p.canVibrate()).toBe(false);
  });

  it("auditions another theme from a side cache without switching, then disposes it", async () => {
    net = installFetch({
      ...themeRoutes("synthwave", ["ui_click"]),
      ...themeRoutes("arcade", ["ui_click"]),
    });
    const p = createPlayer({ baseUrl: "/sounds" });
    await p.loadTheme("synthwave");
    await p.audition("arcade", "ui_click");
    expect(p.theme()).toBe("synthwave");
    expect(ctx().sources[0]?.buffer).toEqual({ decoded: "arcade/ui_click" });
    await p.audition("arcade", "ui_click");
    expect(net.calls.filter((u) => u.includes("arcade/manifest"))).toHaveLength(1);
    p.disposeAudition();
    expect(p.isLoaded("arcade")).toBe(false);
    expect(p.isLoaded("synthwave")).toBe(true);
  });
});
