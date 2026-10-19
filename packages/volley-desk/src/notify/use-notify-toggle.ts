/**
 * The browser-notifications switch, shared by the top bar and Settings ›
 * General. Turning it on asks for permission; the answer lands on the
 * settings as they are when it arrives (an updater), so a sound change made
 * while the prompt is open is kept. `blocked`: the browser refuses (its
 * permission, else the last answer where there is no Notification API).
 */
import { useCallback, useState } from "react";
import { requestNotificationPermission } from "./notify-permission";
import type { SetNotify } from "./use-notify-settings";

const deniedNow = () => typeof Notification !== "undefined" && Notification.permission === "denied";

export function useNotifyToggle(setNotify: SetNotify): {
  toggle: (on: boolean) => void;
  blocked: boolean;
} {
  const [answer, setAnswer] = useState<NotificationPermission | null>(null);
  const toggle = useCallback(
    (on: boolean) => {
      if (!on) return setNotify((prev) => ({ ...prev, enabled: false }));
      void requestNotificationPermission().then((result) => {
        // Only a refusal is "blocked"; dismissing the prompt leaves it askable.
        setAnswer(result);
        setNotify((prev) => ({ ...prev, enabled: result === "granted" }));
      });
    },
    [setNotify],
  );
  return { toggle, blocked: answer === "denied" || deniedNow() };
}
