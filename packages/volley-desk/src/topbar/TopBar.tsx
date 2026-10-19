/**
 * The Desk top bar, ported from the prototype `App.tsx` header: brand, the
 * connection (or demo) tag, wave/agent/lease counts, the supervisor's health
 * pill (`volleyd · working · 4s`, red when it is not running or absent), and
 * the `N need you` pill (click → go to the first). On the right: the
 * coordinators window toggle and the notification and chime switches
 * (volley-dash's settings).
 */
import {
  Notification01Icon,
  NotificationOff01Icon,
  UserGroupIcon,
  VolumeHighIcon,
  VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { noun } from "../lib/plural";
import type { NotifyOptions, SetNotify } from "../notify/use-notify-settings";
import { useNotifyToggle } from "../notify/use-notify-toggle";
import type { Connection } from "../store/context";
import { supervisorHealth, supervisorList } from "../store/reducer";
import type { DeskState, SupervisorView } from "../store/types";
import { age } from "../windows/agent/AgentWindow";
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
  setNotify: SetNotify;
  /** Phone width: the counts collapse, the pill stays. */
  compact?: boolean;
  /** The supervisor's clock (the App shares it with the coordinators row); else its own 2 s tick. */
  now?: number;
}

/** `fixed`, else a 2 s clock that runs only while `active`. */
function useNow(fixed: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (fixed !== undefined || !active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 2000);
    return () => clearInterval(t);
  }, [fixed, active]);
  return fixed ?? now;
}

/**
 * One supervisor's health: `volleyd · working · 4s`; `volleyd · absent` when
 * there is none. `compact` (phone width) shows the dot alone, the text in its
 * label and tooltip, so the top bar stays on one line.
 */
export function SupervisorPill({
  id,
  sup,
  now,
  compact = false,
}: { id: string; sup: SupervisorView | undefined; now: number; compact?: boolean }) {
  const h = supervisorHealth(sup);
  const text = [id, h.label, ...(h.since === null ? [] : [age(now - h.since)])].join(" · ");
  return (
    <output
      // The age ticks: announce nothing on every tick.
      aria-live="off"
      aria-label={`Supervisor ${text}`}
      className={`chip sup-pill${h.down ? " chip--hot sup-pill--down" : ""}`}
      title={h.down ? `Supervisor ${id} is not running` : `Supervisor ${id}: last seen ${text}`}
    >
      <i />
      {!compact && ` ${text}`}
    </output>
  );
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
  const waves = Object.values(p.state.waves).filter((w) => w.state !== null).length;
  const working = Object.values(p.state.agents).filter((a) => a.status?.type === "working").length;
  const supervisors = supervisorList(p.state);
  const now = useNow(p.now, supervisors.length > 0);

  const { toggle: toggleNotify, blocked } = useNotifyToggle(p.setNotify);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">volley</span>
        <span className="brand-sub">desk</span>
      </div>
      <span className="proto">{p.demo ? "Demo · sample data" : p.connection}</span>
      {!p.compact && (
        <div className="topbar-mid">
          <span>
            <b>{waves}</b> {noun(waves, "wave")}
          </span>
          <span>
            <b>{working}</b> {noun(working, "agent")} working
          </span>
          {Object.keys(p.state.leases).length > 0 && (
            <span className="mono">{leaseSummary(p.state)}</span>
          )}
        </div>
      )}
      {supervisors.map((s) => (
        <SupervisorPill key={s.id} id={s.id} sup={s} now={now} compact={p.compact === true} />
      ))}
      {/* Waves need a supervisor; the demo has none to show. */}
      {supervisors.length === 0 && waves > 0 && !p.demo && (
        <SupervisorPill id="volleyd" sup={undefined} now={now} compact={p.compact === true} />
      )}
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
          onClick={() => toggleNotify(!p.notify.enabled)}
          {...(blocked ? { title: "Notifications are blocked: allow them in the browser" } : {})}
        />
        <Toggle
          label="Sound"
          on={p.notify.sound}
          i={p.notify.sound ? VolumeHighIcon : VolumeOffIcon}
          onClick={() => p.setNotify((prev) => ({ ...prev, sound: !prev.sound }))}
        />
      </div>
    </header>
  );
}
