/**
 * The Desk top bar, ported from the prototype `App.tsx` header: brand, the
 * connection (or demo) tag, wave/agent/lease counts, and the `N need you`
 * pill (click → go to the first). On the right: the coordinators window
 * toggle and the notification and chime switches (volley-dash's settings).
 */
import {
  Notification01Icon,
  NotificationOff01Icon,
  UserGroupIcon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { requestNotificationPermission } from "../notify/notify-permission";
import type { NotifyOptions } from "../notify/use-notify-settings";
import type { Connection } from "../store/context";
import type { DeskState } from "../store/types";
import { Clawd } from "../windows/wave/Clawd";
import "../styles/attention.css";

export interface TopBarProps {
  state: DeskState;
  connection: Connection;
  demo: boolean;
  /** How many items need you (`needsYouTargets(...).length`). */
  needsYou: number;
  onNeedsYou: () => void;
  coordsOpen: boolean;
  onToggleCoords: () => void;
  notify: NotifyOptions;
  setNotify: (next: NotifyOptions) => void;
}

function leaseSummary(state: DeskState): string {
  return Object.values(state.leases)
    .map((p) => `${p.pool} ${p.held.length}/${p.capacity}`)
    .join(" · ");
}

function Toggle(p: {
  label: string;
  on: boolean;
  i: typeof UserGroupIcon;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-btn${p.on ? " icon-btn--hot" : ""}`}
      aria-label={p.label}
      aria-pressed={p.on}
      title={p.title ?? p.label}
      onClick={p.onClick}
    >
      <HugeiconsIcon icon={p.i} size={16} strokeWidth={1.8} />
    </button>
  );
}

export function TopBar(p: TopBarProps) {
  const [denied, setDenied] = useState(false);
  const waves = Object.values(p.state.waves).filter((w) => w.state !== null).length;
  const working = Object.values(p.state.agents).filter((a) => a.status?.type === "working").length;

  const toggleNotify = () => {
    if (p.notify.enabled) {
      p.setNotify({ ...p.notify, enabled: false });
      return;
    }
    void requestNotificationPermission().then((result) => {
      setDenied(result !== "granted");
      p.setNotify({ ...p.notify, enabled: result === "granted" });
    });
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">volley</span>
        <span className="brand-sub">desk</span>
      </div>
      <span className="proto">{p.demo ? "Demo · sample data" : p.connection}</span>
      <div className="topbar-mid">
        <span>
          <b>{waves}</b> waves
        </span>
        <span>
          <b>{working}</b> agents working
        </span>
        {Object.keys(p.state.leases).length > 0 && (
          <span className="mono">{leaseSummary(p.state)}</span>
        )}
      </div>
      {p.needsYou > 0 && (
        <button type="button" className="ny-pill" onClick={p.onNeedsYou}>
          <Clawd size={18} waiting /> {p.needsYou} need{p.needsYou === 1 ? "s" : ""} you
        </button>
      )}
      <div className="topbar-tools">
        <Toggle
          label="Wave coordinators"
          on={p.coordsOpen}
          i={UserGroupIcon}
          onClick={p.onToggleCoords}
        />
        <Toggle
          label="Browser notifications"
          on={p.notify.enabled}
          i={p.notify.enabled ? Notification01Icon : NotificationOff01Icon}
          onClick={toggleNotify}
          {...(denied ? { title: "Notifications are blocked: allow them in the browser" } : {})}
        />
        <Toggle
          label="Sound"
          on={p.notify.sound}
          i={p.notify.sound ? VolumeHighIcon : VolumeOffIcon}
          onClick={() => p.setNotify({ ...p.notify, sound: !p.notify.sound })}
        />
      </div>
    </header>
  );
}
