/**
 * The Desk's notifications, ported from volley-dash: a browser notification
 * and the bundled chime when an item's attention tier moves into `you`, using
 * volley-dash's settings (same storage key, so preferences carry over).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestNotificationPermission } from "../src/notify/notify-permission";
import { type AttentionItem, useNotifyOnAttention } from "../src/notify/use-notify-on-attention";
import {
  NOTIFY_STORAGE_KEY,
  type NotifyOptions,
  useNotifySettings,
} from "../src/notify/use-notify-settings";

const on: NotifyOptions = { enabled: true, sound: true, on: ["blocked", "failed", "reaped"] };

function setReducedMotion(reduce: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue({ matches: reduce, media: "", addEventListener() {} }),
  });
}

let notificationCtor: ReturnType<typeof vi.fn>;

function installNotificationMock(permission: NotificationPermission): void {
  notificationCtor = vi.fn();
  const ctor = notificationCtor as unknown as typeof Notification;
  Object.defineProperty(ctor, "permission", { value: permission, configurable: true });
  Object.defineProperty(ctor, "requestPermission", {
    value: vi.fn().mockResolvedValue(permission),
    configurable: true,
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    writable: true,
    value: ctor,
  });
}

let playSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  setReducedMotion(false);
  installNotificationMock("granted");
  playSpy = vi
    .spyOn(HTMLAudioElement.prototype, "play")
    .mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as { Notification?: unknown }).Notification = undefined;
  localStorage.clear();
});

const item = (tier: AttentionItem["tier"], over: Partial<AttentionItem> = {}): AttentionItem => ({
  key: "wave:status-chip",
  tier,
  title: "status-chip needs you",
  body: "Ties: shared or dense ranking?",
  ...over,
});

function setup(settings: NotifyOptions, first: AttentionItem[] = []) {
  return renderHook(
    ({ items, s }: { items: AttentionItem[]; s: NotifyOptions }) =>
      useNotifyOnAttention(s, items, { armAfterMs: 0 }),
    { initialProps: { items: first, s: settings } },
  );
}

describe("useNotifyOnAttention", () => {
  it("fires a notification and the chime on a transition into you, once", () => {
    const { rerender } = setup(on, [item("coordinator")]);
    rerender({ items: [item("you")], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledWith(
      "Volley: status-chip needs you",
      expect.objectContaining({ body: "Ties: shared or dense ranking?", tag: "wave:status-chip" }),
    );
    expect(playSpy).toHaveBeenCalledTimes(1);
    // Still `you` on the next render: no re-fire.
    rerender({ items: [item("you", { body: "changed text" })], s: on });
    rerender({ items: [item("you")], s: { ...on } });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("fires again after the item left you and came back", () => {
    const { rerender } = setup(on, [item("none")]);
    rerender({ items: [item("you")], s: on });
    rerender({ items: [item("coordinator")], s: on });
    rerender({ items: [item("you")], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(2);
  });

  it("does not re-fire when an item vanishes for a moment (reconnect resync) and returns", () => {
    const { rerender } = setup(on, [item("none")]);
    rerender({ items: [item("you")], s: on });
    rerender({ items: [], s: on });
    rerender({ items: [item("you")], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it("fires for a new item that arrives already at you", () => {
    const { rerender } = setup(on, []);
    rerender({ items: [item("you", { key: "agent:impl-1" })], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it("stays quiet about what already needed you before it was armed", () => {
    const { rerender } = renderHook(
      ({ items }: { items: AttentionItem[] }) =>
        useNotifyOnAttention(on, items, { armAfterMs: 60_000 }),
      { initialProps: { items: [] as AttentionItem[] } },
    );
    rerender({ items: [item("you")] });
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("gates the banner on enabled + permission and the chime on sound + motion", () => {
    const off = { ...on, enabled: false, sound: false };
    const a = setup(off, [item("none")]);
    a.rerender({ items: [item("you")], s: off });
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
    a.unmount();

    installNotificationMock("denied");
    const b = setup(on, [item("none")]);
    b.rerender({ items: [item("you")], s: on });
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalledTimes(1);
    b.unmount();

    installNotificationMock("granted");
    setReducedMotion(true);
    const c = setup(on, [item("none")]);
    c.rerender({ items: [item("you")], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalledTimes(1);
  });
});

describe("useNotifySettings", () => {
  it("reads and writes volley-dash's storage key, so existing preferences carry over", () => {
    expect(NOTIFY_STORAGE_KEY).toBe("volley-dash:notify");
    localStorage.setItem(
      NOTIFY_STORAGE_KEY,
      JSON.stringify({ enabled: true, sound: false, on: ["failed"] }),
    );
    const { result } = renderHook(() => useNotifySettings());
    expect(result.current[0]).toEqual({ enabled: true, sound: false, on: ["failed"] });
    act(() => result.current[1]({ enabled: false, sound: true, on: ["failed"] }));
    expect(JSON.parse(localStorage.getItem(NOTIFY_STORAGE_KEY) ?? "")).toEqual({
      enabled: false,
      sound: true,
      on: ["failed"],
    });
  });

  it("falls back to the defaults on a corrupt entry", () => {
    localStorage.setItem(NOTIFY_STORAGE_KEY, "{nope");
    const { result } = renderHook(() => useNotifySettings());
    expect(result.current[0]).toEqual({
      enabled: false,
      sound: true,
      on: ["blocked", "failed", "reaped"],
    });
  });
});

describe("requestNotificationPermission", () => {
  it("resolves the browser's answer, or denied without a Notification API", async () => {
    installNotificationMock("granted");
    await expect(requestNotificationPermission()).resolves.toBe("granted");
    (globalThis as { Notification?: unknown }).Notification = undefined;
    await expect(requestNotificationPermission()).resolves.toBe("denied");
  });
});
