/// <reference lib="dom" />
/**
 * Ported verbatim from volley-dash (`src/lib/notify-permission.ts`). Tiny wrapper around `Notification.requestPermission()`. Supported floor is
 * Safari 16+, Firefox 47+, Chrome / Edge (all Chromium with the modern
 * Promise-returning signature). Defensive against environments without
 * `window.Notification` (a hardened iframe, jsdom, SSR) by resolving to
 * `"denied"` so callers can safely treat the result as a tri-state.
 *
 * Legacy Safari ≤ 15 used a callback-only API. We deliberately do NOT support
 * that path: the correct legacy shape (await a Promise that the callback
 * resolves) is non-trivial to test against and Safari 16+ has been out since
 * 2022. If your support matrix needs ≤ Safari 15, see the v0.2 design notes.
 *
 * Triple-slash reference: this file is included in the root `tsc -p` pass,
 * whose `lib` is ES2022-only. We need `NotificationPermission` and `window`
 * from the DOM lib for the root check.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "denied";
  }
  const N = window.Notification;
  try {
    const result: unknown = N.requestPermission();
    if (result !== undefined && typeof (result as Promise<unknown>).then === "function") {
      return await (result as Promise<NotificationPermission>);
    }
    // Synchronous return — already-resolved permission state (rare).
    return (result as NotificationPermission | undefined) ?? N.permission;
  } catch {
    return "denied";
  }
}
