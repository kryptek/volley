/**
 * The dock and transient notices, ported from the prototype `App.tsx`: a
 * React Bits `Dock` with the coordinators window (badge: what needs you),
 * Appearance, tethers, arrange & fit, auto-arrange and zoom in / out, and a
 * React Bits `SwipeToast` for one notice at a time (`useToast`).
 */
import {
  FullScreenIcon,
  Link02Icon,
  MagicWand01Icon,
  PaintBoardIcon,
  UserGroupIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useRef, useState } from "react";
import Dock, { type DockItemData } from "../rb/Dock/Dock";
import SwipeToast from "../rb/SwipeToast/SwipeToast";
import "../styles/look.css";

/** Zoom step for the dock's zoom buttons (prototype). */
export const DOCK_ZOOM = 1.2;
export const TOAST_MS = 5200;

const icon = (i: typeof UserGroupIcon) => <HugeiconsIcon icon={i} size={22} />;

export interface DeskDockProps {
  coordsOpen: boolean;
  onToggleCoords: () => void;
  /** The dock badge: the "N need you" count. */
  needsYou: number;
  lookOpen: boolean;
  onToggleLook: () => void;
  tethers: boolean;
  onToggleTethers: () => void;
  onArrange: () => void;
  autoArrange: boolean;
  onToggleAutoArrange: () => void;
  onZoom: (factor: number) => void;
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
      icon: icon(PaintBoardIcon),
      label: "Appearance",
      onClick: p.onToggleLook,
      active: p.lookOpen,
    },
    {
      icon: icon(Link02Icon),
      label: p.tethers ? "Hide tethers" : "Show tethers",
      onClick: p.onToggleTethers,
      active: p.tethers,
    },
    { separator: true },
    { icon: icon(FullScreenIcon), label: "Arrange & fit", onClick: p.onArrange },
    {
      icon: icon(MagicWand01Icon),
      label: p.autoArrange ? "Auto-arrange: on" : "Auto-arrange: off",
      onClick: p.onToggleAutoArrange,
      active: p.autoArrange,
    },
    { icon: icon(ZoomInAreaIcon), label: "Zoom in", onClick: () => p.onZoom(DOCK_ZOOM) },
    { icon: icon(ZoomOutAreaIcon), label: "Zoom out", onClick: () => p.onZoom(1 / DOCK_ZOOM) },
  ];
}

export function DeskDock(p: DeskDockProps) {
  return (
    <div className="dock-wrap">
      <Dock
        items={dockItems(p)}
        magnification={62}
        baseItemSize={44}
        panelHeight={60}
        accentColor="#6ee7f9"
        badgeColor="#ff7a59"
        showLabels
      />
    </div>
  );
}

export interface Toast {
  title: string;
  desc?: string;
  n: number;
}

/** One transient notice at a time; a new one replaces the last. */
export function useToast(): [Toast | null, (title: string, desc?: string) => void, () => void] {
  const [toast, setToast] = useState<Toast | null>(null);
  const n = useRef(0);
  const say = useCallback((title: string, desc?: string) => {
    n.current += 1;
    setToast({ title, n: n.current, ...(desc !== undefined ? { desc } : {}) });
  }, []);
  const close = useCallback(() => setToast(null), []);
  return [toast, say, close];
}

export function DeskToast({ toast, onClose }: { toast: Toast | null; onClose: () => void }) {
  if (!toast) return null;
  return (
    <SwipeToast
      key={toast.n}
      open
      title={toast.title}
      {...(toast.desc !== undefined ? { description: toast.desc } : {})}
      duration={TOAST_MS}
      background="rgba(14,16,26,.95)"
      color="#e8ecf4"
      fuseColor="#6ee7f9"
      onClose={onClose}
    />
  );
}
