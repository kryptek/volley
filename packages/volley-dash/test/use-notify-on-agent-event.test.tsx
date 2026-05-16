/**
 * Tests for useNotifyOnAgentEvent — the side-effect hook that bridges Plan 8's
 * event ring buffer to the browser Notification API + bundled chime. Each test
 * renders the hook against an initially-empty events array (so the mount-time
 * snapshot is a no-op), then rerenders with a new event to assert the firing
 * decision tree.
 */
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotifyOnAgentEvent } from "../src/hooks/use-notify-on-agent-event";
import type { NotifyOptions } from "../src/hooks/use-notify-settings";
import type { FeedEvent } from "../src/types";

const baseEvent = (overrides: Partial<FeedEvent> = {}): FeedEvent => ({
  id: "ev-1",
  ts: 1_700_000_000_000,
  agent: "alpha",
  ch: "status",
  type: "blocked",
  msg: "",
  fresh: true,
  ...overrides,
});

const defaultSettings: NotifyOptions = {
  enabled: true,
  sound: true,
  on: ["blocked", "failed", "reaped"],
};

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

let notificationCtor: ReturnType<typeof vi.fn>;

function installNotificationMock(permission: NotificationPermission): void {
  notificationCtor = vi.fn();
  const ctor = notificationCtor as unknown as typeof Notification;
  Object.defineProperty(ctor, "permission", {
    value: permission,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(ctor, "requestPermission", {
    value: vi.fn().mockResolvedValue(permission),
    configurable: true,
    writable: true,
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
  // Clear the Notification global so the next test's installNotificationMock
  // starts clean (the in-jsdom global is per-process, not per-test).
  (globalThis as { Notification?: unknown }).Notification = undefined;
});

function renderForEvents(settings: NotifyOptions) {
  return renderHook(
    ({ events }: { events: FeedEvent[] }) => useNotifyOnAgentEvent(settings, events),
    { initialProps: { events: [] as FeedEvent[] } },
  );
}

describe("useNotifyOnAgentEvent", () => {
  it("fires new Notification on matching status event when enabled + permission granted", () => {
    const { rerender } = renderForEvents(defaultSettings);
    rerender({ events: [baseEvent({ id: "ev-A", agent: "alpha", type: "blocked" })] });
    expect(notificationCtor).toHaveBeenCalledTimes(1);
    expect(notificationCtor).toHaveBeenCalledWith(
      "Volley: alpha",
      expect.objectContaining({ body: "blocked", icon: "/favicon.svg", tag: "alpha" }),
    );
  });

  it("does not fire Notification when settings.enabled is false", () => {
    const { rerender } = renderForEvents({ ...defaultSettings, enabled: false });
    rerender({ events: [baseEvent({ id: "ev-B" })] });
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("does not fire when event type is not in settings.on", () => {
    const { rerender } = renderForEvents(defaultSettings);
    rerender({ events: [baseEvent({ id: "ev-C", type: "working" })] });
    expect(notificationCtor).not.toHaveBeenCalled();
  });

  it("does not fire when channel is not status (even if type literal matches)", () => {
    const { rerender } = renderForEvents(defaultSettings);
    rerender({ events: [baseEvent({ id: "ev-D", ch: "progress", type: "blocked" })] });
    expect(notificationCtor).not.toHaveBeenCalled();
    expect(playSpy).not.toHaveBeenCalled();
  });

  it("plays audio when sound=true and reduced-motion is off", () => {
    setReducedMotion(false);
    const { rerender } = renderForEvents(defaultSettings);
    rerender({ events: [baseEvent({ id: "ev-E" })] });
    expect(playSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT play audio when reduced-motion is on", () => {
    setReducedMotion(true);
    const { rerender } = renderForEvents(defaultSettings);
    rerender({ events: [baseEvent({ id: "ev-F" })] });
    expect(playSpy).not.toHaveBeenCalled();
  });
});
