/// <reference lib="dom" />
/**
 * Tiny wrapper around `Notification.requestPermission()` that copes with both
 * the modern Promise-returning signature and the legacy callback-only one
 * (Safari ≤ 15, older Firefox builds). Defensive against environments without
 * `window.Notification` (e.g. a hardened iframe, jsdom) by resolving to
 * `"denied"` so callers can safely treat the result as a tri-state.
 *
 * Triple-slash reference: this file is included in the root `tsc -p` pass,
 * whose `lib` is ES2022-only. We need `NotificationPermission` and `window`
 * from the DOM lib for both the root check and the dashboard's own check.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "denied";
  }
  const N = window.Notification;
  try {
    // Cast to the legacy signature: some browsers (Safari ≤ 15) accept a
    // callback and don't return a Promise. The modern signature is no-arg
    // and returns Promise<NotificationPermission>; passing an unused callback
    // is a harmless backward-compat shim.
    const result = (
      N.requestPermission as unknown as (
        cb?: (perm: NotificationPermission) => void,
      ) => Promise<NotificationPermission> | NotificationPermission | undefined
    )((legacy) => legacy);
    if (result !== undefined && typeof (result as Promise<unknown>).then === "function") {
      return await (result as Promise<NotificationPermission>);
    }
    return (result as NotificationPermission | undefined) ?? N.permission;
  } catch {
    return "denied";
  }
}
