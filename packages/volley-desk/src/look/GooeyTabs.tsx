/**
 * Tabs on React Bits Gooey Nav (D10): the active pill breaks into goo and
 * flows to the tab you pick, tinted by the window accent. The tab semantics
 * are the Desk's own: a `tablist` of `tab`s with `aria-selected`, roving
 * focus (only the selected tab is in the Tab order), ←/→ (wrapping) and
 * Home/End to move, and `aria-controls` pointing the selected tab at the
 * panel the caller renders with `tabPanelProps`. Gooey Nav already settles
 * without the goo under `prefers-reduced-motion`.
 */
import type { KeyboardEvent, ReactNode } from "react";
import GooeyNav from "../rb/GooeyNav/GooeyNav";

export interface GooeyTab<K extends string> {
  key: K;
  label: string;
  icon?: ReactNode;
}

export const tabId = (id: string, key: string) => `${id}-tab-${key}`;
export const panelId = (id: string) => `${id}-panel`;

/** Props for the panel of the selected tab. */
export function tabPanelProps(id: string, selected: string) {
  return { role: "tabpanel", id: panelId(id), "aria-labelledby": tabId(id, selected) } as const;
}

export function GooeyTabs<K extends string>({
  id = "tabs",
  label,
  tabs,
  value,
  onChange,
  accent,
}: {
  /** Base for the tab and panel ids (`useId()` in the caller). */
  id?: string;
  label: string;
  tabs: readonly GooeyTab<K>[];
  value: K;
  onChange: (key: K) => void;
  accent: string;
}) {
  const index = Math.max(
    0,
    tabs.findIndex((t) => t.key === value),
  );
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    const last = tabs.length - 1;
    const next =
      e.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : e.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : null;
    if (next === null) return;
    e.preventDefault();
    const t = tabs[next];
    if (!t) return;
    if (next !== index) onChange(t.key);
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <GooeyNav
      className="tabs gooey-tabs"
      role="tablist"
      aria-label={label}
      size="sm"
      color={accent}
      items={tabs.map((t) => ({ label: t.label, icon: t.icon }))}
      activeIndex={index}
      onChange={(i: number) => {
        const t = tabs[i];
        if (t) onChange(t.key);
      }}
      onKeyDown={keys}
      itemProps={(i: number) => {
        const t = tabs[i];
        const selected = i === index;
        return {
          role: "tab",
          id: t ? tabId(id, t.key) : undefined,
          "aria-selected": selected,
          "aria-controls": selected ? panelId(id) : undefined,
          tabIndex: selected ? 0 : -1,
        };
      }}
    />
  );
}
