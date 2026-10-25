/**
 * The Desk's notifications, ported from volley-dash: a browser notification
 * and an `attention_needed` sound event when an item's attention tier moves
 * into `you`, using volley-dash's settings (same storage key, so preferences
 * carry over). Whether the sound plays is the sound manager's call
 * (sound-manager.test.tsx).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestNotificationPermission } from "../src/notify/notify-permission";
import {
  type AttentionItem,
  inboxNotification,
  useNotifyOnAttention,
} from "../src/notify/use-notify-on-attention";
import {
  NOTIFY_STORAGE_KEY,
  type NotifyOptions,
  useNotifySettings,
} from "../src/notify/use-notify-settings";
import { onSound } from "../src/sounds/emit";
import type { InboxItem } from "../src/store/types";

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

/** The `attention_needed` emits, as their counts. */
let sounds: number[];
let offSound: () => void;

beforeEach(() => {
  setReducedMotion(false);
  installNotificationMock("granted");
  sounds = [];
  offSound = onSound((id, count) => {
    if (id === "attention_needed") sounds.push(count);
  });
});

afterEach(() => {
  offSound();
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
    ({ items, s }: { items: AttentionItem[]; s: NotifyOptions }) => useNotifyOnAttention(s, items),
    { initialProps: { items: first, s: settings } },
  );
}

describe("useNotifyOnAttention", () => {
  it("fires a notification and the attention sound on a transition into you, once", () => {
    const { rerender } = setup(on, [item("coordinator")]);
    rerender({ items: [item("you")], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledWith(
      "Volley: status-chip needs you",
      expect.objectContaining({ body: "Ties: shared or dense ranking?", tag: "wave:status-chip" }),
    );
    expect(sounds).toEqual([1]);
    // Still `you` on the next render: no re-fire.
    rerender({ items: [item("you", { body: "changed text" })], s: on });
    rerender({ items: [item("you")], s: { ...on } });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(sounds).toEqual([1]);
  });

  it("emits one attention sound for items that arrive together, with their count", () => {
    const { rerender } = setup(on, []);
    rerender({
      items: [item("you"), item("you", { key: "agent:a" }), item("you", { key: "agent:b" })],
      s: on,
    });
    expect(notificationCtor).toHaveBeenCalledTimes(3);
    expect(sounds).toEqual([3]);
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

  it("tracks but never fires while quiet (the store is settling), nor for what it saw then", () => {
    const { rerender } = renderHook(
      ({ items, quiet }: { items: AttentionItem[]; quiet: boolean }) =>
        useNotifyOnAttention(on, items, { quiet }),
      { initialProps: { items: [] as AttentionItem[], quiet: true } },
    );
    // Replay: items arrive at you, and a resync shuffles tiers and adds items.
    rerender({ items: [item("you")], quiet: true });
    rerender({ items: [item("none"), item("you", { key: "agent:coord-1" })], quiet: true });
    rerender({ items: [item("you")], quiet: true });
    // Settled: what is at you now was already at you while quiet.
    rerender({ items: [item("you")], quiet: false });
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(sounds).toEqual([]);
    // A real transition after settling fires.
    rerender({ items: [item("coordinator")], quiet: false });
    rerender({ items: [item("you")], quiet: false });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it("can still hold off for an extra period after mount (armAfterMs)", () => {
    const { rerender } = renderHook(
      ({ items }: { items: AttentionItem[] }) =>
        useNotifyOnAttention(on, items, { armAfterMs: 60_000 }),
      { initialProps: { items: [] as AttentionItem[] } },
    );
    rerender({ items: [item("you")] });
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("gates the banner on enabled + permission; the sound event goes out either way", () => {
    const off = { ...on, enabled: false, sound: false };
    const a = setup(off, [item("none")]);
    a.rerender({ items: [item("you")], s: off });
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(sounds).toEqual([1]);
    a.unmount();

    installNotificationMock("denied");
    const b = setup(on, [item("none")]);
    b.rerender({ items: [item("you")], s: on });
    expect(notificationCtor).not.toHaveBeenCalled();
    b.unmount();

    installNotificationMock("granted");
    setReducedMotion(true);
    const c = setup(on, [item("none")]);
    c.rerender({ items: [item("you")], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
  });

  it("no longer creates an audio element", () => {
    const audio = vi.spyOn(window, "Audio");
    const { rerender } = setup(on, [item("none")]);
    rerender({ items: [item("you")], s: on });
    expect(audio).not.toHaveBeenCalled();
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

describe("an owner-only notice's notification (SPEC §4.6.18)", () => {
  const LINK = "https://claude.ai/code/session_fake01";
  const notice: InboxItem = {
    id: "n-coordinator-link",
    kind: "notice",
    version: 1,
    owner_only: true,
    agent_id: "volleyd",
    title: "Coordinator on box-a: open it",
    question: LINK,
    pointers: { link: LINK },
    opened_at: "2026-10-25T12:00:00.000Z",
    source: { notice: "coordinator-link" },
  };

  it("carries the title and the link; an answered one is not pushed", () => {
    expect(inboxNotification(notice)).toEqual({
      key: "inbox:n-coordinator-link@2026-10-25T12:00:00.000Z",
      tier: "you",
      title: "Needs you · Coordinator on box-a: open it",
      body: LINK,
      link: LINK,
    });
    const answered = {
      ...notice,
      answered: { answer: "dismiss", by: "desk", where: { kind: "desk" as const }, at: "x" },
    };
    expect(inboxNotification(answered).tier).toBe("none");
  });

  it("a click on it opens the link", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { rerender } = setup(on);
    rerender({ items: [inboxNotification(notice)], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor.mock.calls[0]?.[0]).toContain("Coordinator on box-a: open it");
    const n = notificationCtor.mock.instances[0] as { onclick: (() => void) | null };
    n.onclick?.();
    expect(open).toHaveBeenCalledWith(LINK, "_blank", "noopener");
  });

  it("a notice reopened with a new link in the same update pushes again", () => {
    const { rerender } = setup(on);
    rerender({ items: [inboxNotification(notice)], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    // superseded and reopened on the same retained topic: the store delivers only the new opening
    const NEW = "https://claude.ai/code/session_fake02";
    const reopened: InboxItem = {
      ...notice,
      version: 3,
      question: NEW,
      pointers: { link: NEW },
      opened_at: "2026-10-25T12:05:00.000Z",
    };
    rerender({ items: [inboxNotification(reopened)], s: on });
    expect(notificationCtor).toHaveBeenCalledTimes(2);
    expect(notificationCtor.mock.calls[1]?.[1]).toMatchObject({ body: NEW });
  });
});
