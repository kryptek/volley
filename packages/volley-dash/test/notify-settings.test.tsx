/**
 * Tests for the NotifySettings popover — the gear-icon control surface that
 * sits on the right of the TopBar. Covers the three high-value behaviors: the
 * popover exposes all three control groups, the browser-notifications switch
 * rolls back when permission is denied, and a grant persists enabled=true.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotifySettings } from "../src/components/NotifySettings";

const STORAGE_KEY = "volley-dash:notify";

function installNotificationMock(permission: NotificationPermission): void {
  const ctor = vi.fn();
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

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  (globalThis as { Notification?: unknown }).Notification = undefined;
});

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("NotifySettings", () => {
  it("renders the three control groups inside the popover", async () => {
    installNotificationMock("default");
    render(<NotifySettings />);
    fireEvent.click(screen.getByRole("button", { name: /notification settings/i }));
    expect(await screen.findByLabelText(/browser notifications/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^sound$/i)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /blocked/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /failed/i })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /reaped/i })).toBeInTheDocument();
  });

  it("leaves the Browser Notifications switch off when permission is denied", async () => {
    installNotificationMock("denied");
    render(<NotifySettings />);
    fireEvent.click(screen.getByRole("button", { name: /notification settings/i }));
    const sw = await screen.findByRole("switch", { name: /browser notifications/i });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    await flushAsync();
    expect(sw).toHaveAttribute("aria-checked", "false");
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as {
      enabled?: boolean;
    };
    expect(persisted.enabled).not.toBe(true);
  });

  it("persists enabled=true to localStorage when permission is granted", async () => {
    installNotificationMock("granted");
    render(<NotifySettings />);
    fireEvent.click(screen.getByRole("button", { name: /notification settings/i }));
    const sw = await screen.findByRole("switch", { name: /browser notifications/i });
    fireEvent.click(sw);
    await flushAsync();
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as {
      enabled?: boolean;
    };
    expect(persisted.enabled).toBe(true);
  });
});
