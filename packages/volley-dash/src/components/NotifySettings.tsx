/**
 * NotifySettings — the gear-icon popover that lives in the top bar (right of
 * the namespace dropdown, before the broker LED). Three control groups:
 *   1. "Browser notifications" — Radix Switch. On toggle-on, requests
 *      `Notification.requestPermission()`; if denied/unsupported, the switch
 *      snaps back to off and a caption explains.
 *   2. "Sound" — Radix Switch, no permission gate.
 *   3. "Trigger events" — three checkboxes for blocked/failed/reaped.
 *
 * State lives in localStorage via `useNotifySettings()` so preferences survive
 * reloads.
 */
import { Bell } from "lucide-react";
import { useId, useState } from "react";

import { useNotifySettings } from "../hooks/use-notify-settings";
import { requestNotificationPermission } from "../lib/notify-permission";
import { Checkbox } from "./ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { Switch } from "./ui/switch";

const TRIGGER_OPTIONS = ["blocked", "failed", "reaped"] as const;

export function NotifySettings(): JSX.Element {
  const [settings, setSettings] = useNotifySettings();
  const [permissionDenied, setPermissionDenied] = useState(false);
  const browserId = useId();
  const soundId = useId();

  const onBrowserToggle = (checked: boolean): void => {
    if (!checked) {
      setSettings({ ...settings, enabled: false });
      setPermissionDenied(false);
      return;
    }
    void requestNotificationPermission().then((result) => {
      if (result === "granted") {
        setSettings({ ...settings, enabled: true });
        setPermissionDenied(false);
      } else {
        setSettings({ ...settings, enabled: false });
        setPermissionDenied(true);
      }
    });
  };

  const onSoundToggle = (checked: boolean): void => {
    setSettings({ ...settings, sound: checked });
  };

  const onTriggerToggle = (trigger: string, checked: boolean): void => {
    const next = checked
      ? [...settings.on.filter((v) => v !== trigger), trigger]
      : settings.on.filter((v) => v !== trigger);
    setSettings({ ...settings, on: next });
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Notification settings" className="vd-notify-trigger">
          <Bell className="vd-icon" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="vd-notify-popover">
        <div className="vd-notify-row">
          <label htmlFor={browserId} className="vd-notify-label">
            Browser notifications
          </label>
          <Switch
            id={browserId}
            checked={settings.enabled}
            onCheckedChange={onBrowserToggle}
            aria-label="Browser notifications"
          />
        </div>
        {permissionDenied ? (
          <output className="vd-notify-caption">
            permission denied — change in browser settings
          </output>
        ) : null}
        <div className="vd-notify-row">
          <label htmlFor={soundId} className="vd-notify-label">
            Sound
          </label>
          <Switch
            id={soundId}
            checked={settings.sound}
            onCheckedChange={onSoundToggle}
            aria-label="Sound"
          />
        </div>
        <div className="vd-notify-group">
          <p className="vd-notify-label">Trigger events</p>
          <p className="vd-notify-caption">
            Notifies when an agent transitions to one of these states.
          </p>
          <div className="vd-notify-checkboxes">
            {TRIGGER_OPTIONS.map((trigger) => {
              const id = `notify-trigger-${trigger}`;
              return (
                <div key={trigger} className="vd-notify-check">
                  <Checkbox
                    id={id}
                    checked={settings.on.includes(trigger)}
                    onCheckedChange={(c) => onTriggerToggle(trigger, c === true)}
                    aria-label={trigger}
                  />
                  <label htmlFor={id}>{trigger}</label>
                </div>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
