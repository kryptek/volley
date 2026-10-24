/**
 * The dock, ported from the prototype `App.tsx`: a React Bits `Dock` with eight
 * items — the coordinators window (badge: what needs you), the Needs you window
 * (badge: the inbox items only a person answers), the Machines window (badge:
 * the machines that are down), tethers, arrange &
 * fit, zoom in / out and the Settings window (appearance and auto-arrange
 * live there), and, in a signed-in session, the account avatar, whose menu
 * signs out or switches account (`AccountMenu`). Its panel is lifted and lit like the Desk's windows (D10,
 * `.dock-wrap .dock` in look.css).
 */
import {
  ComputerIcon,
  FullScreenIcon,
  InboxIcon,
  Link02Icon,
  Settings02Icon,
  UserGroupIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AccountMenu, initials } from "../auth/AccountActions";
import Dock, { type DockItemData } from "../rb/Dock/Dock";
import "../styles/look.css";

/** Zoom step for the dock's zoom buttons (prototype). */
export const DOCK_ZOOM = 1.2;

const icon = (i: typeof UserGroupIcon) => <HugeiconsIcon icon={i} size={22} />;

export interface DeskDockProps {
  coordsOpen: boolean;
  onToggleCoords: () => void;
  /** The dock badge: the "N need you" count. */
  needsYou: number;
  inboxOpen: boolean;
  onToggleInbox: () => void;
  /** The Needs you tile's badge: open inbox items that need a person (owner-only + `you`). */
  inboxNeedsYou: number;
  machinesOpen: boolean;
  onToggleMachines: () => void;
  /** The Machines tile's badge: the machines that are down. */
  machinesDown: number;
  tethers: boolean;
  onToggleTethers: () => void;
  onArrange: () => void;
  onZoom: (factor: number) => void;
  settingsOpen: boolean;
  onToggleSettings: () => void;
  /** The signed-in account (the avatar and its menu); absent outside a sign-in gate (demo). */
  account?: {
    identity: string | null;
    /** The menu's second line ("Desk · can steer…", "Admin · …"). */
    role: string;
    open: boolean;
    onToggle: () => void;
    onClose: () => void;
  };
}

export function dockItems(p: DeskDockProps): DockItemData[] {
  return [
    {
      icon: icon(UserGroupIcon),
      label: "Wave coordinators",
      onClick: p.onToggleCoords,
      active: p.coordsOpen,
      ...(p.needsYou > 0 ? { badge: p.needsYou } : {}),
    },
    {
      icon: icon(InboxIcon),
      label: "Needs you",
      onClick: p.onToggleInbox,
      active: p.inboxOpen,
      ...(p.inboxNeedsYou > 0 ? { badge: p.inboxNeedsYou } : {}),
    },
    {
      icon: icon(ComputerIcon),
      label: "Machines",
      onClick: p.onToggleMachines,
      active: p.machinesOpen,
      ...(p.machinesDown > 0 ? { badge: p.machinesDown } : {}),
    },
    {
      icon: icon(Link02Icon),
      label: p.tethers ? "Hide tethers" : "Show tethers",
      onClick: p.onToggleTethers,
      active: p.tethers,
    },
    { separator: true },
    { icon: icon(FullScreenIcon), label: "Arrange & fit", onClick: p.onArrange },
    { icon: icon(ZoomInAreaIcon), label: "Zoom in", onClick: () => p.onZoom(DOCK_ZOOM) },
    { icon: icon(ZoomOutAreaIcon), label: "Zoom out", onClick: () => p.onZoom(1 / DOCK_ZOOM) },
    { separator: true },
    {
      icon: icon(Settings02Icon),
      label: "Settings",
      onClick: p.onToggleSettings,
      active: p.settingsOpen,
    },
    ...(p.account
      ? [
          {
            icon: (
              <span className="avatar dock-avatar">
                {p.account.identity ? initials(p.account.identity) : "?"}
              </span>
            ),
            label: "Account",
            className: "dock-item--account",
            onClick: p.account.onToggle,
            active: p.account.open,
          },
        ]
      : []),
  ];
}

export function DeskDock(p: DeskDockProps) {
  return (
    <nav className="dock-wrap" aria-label="Desk controls">
      <Dock
        items={dockItems(p)}
        magnification={62}
        baseItemSize={44}
        panelHeight={60}
        accentColor="var(--t-acc)"
        badgeColor="var(--hot)"
        showLabels
      />
      {p.account?.open && (
        <AccountMenu
          identity={p.account.identity}
          role={p.account.role}
          onClose={p.account.onClose}
        />
      )}
    </nav>
  );
}
