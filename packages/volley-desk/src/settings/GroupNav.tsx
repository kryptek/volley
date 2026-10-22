/**
 * The drill-in of a long Settings section, like macOS System Settings: the
 * section opens on `GroupList`, one row per group (its name, a one-line live
 * summary and a chevron), and a row opens that group's page in the same pane
 * (the Settings window draws the `‹ Section` back control and the group's
 * title). `useGroupNav` holds the open group per section while the window is
 * open (in memory only) and hands focus over: to the page's heading on open,
 * back to the group's row on return.
 */
import { useEffect, useRef, useState } from "react";
import type { SectionDef, SectionKey } from "./sections";

export interface GroupListProps {
  section: SectionDef;
  /** A one-line summary per group key. */
  summaries: Record<string, string>;
  onOpen: (group: string) => void;
  /** The group a sidebar search hit, highlighted. */
  hit?: string | undefined;
}

export function GroupList({ section, summaries, onOpen, hit }: GroupListProps) {
  return (
    <ul className="gl" aria-label={`${section.label} groups`}>
      {(section.groups ?? []).map((g) => {
        const id = `gl-${section.key}-${g.key}`;
        return (
          <li key={g.key}>
            <button
              type="button"
              className={`gl-row${hit === g.key ? " gl-row--hit" : ""}`}
              data-group={g.key}
              aria-labelledby={`${id}-label`}
              aria-describedby={`${id}-sum`}
              onClick={() => onOpen(g.key)}
            >
              <span className="gl-label" id={`${id}-label`}>
                {g.label}
              </span>
              <span className="gl-sum" id={`${id}-sum`}>
                {summaries[g.key] ?? ""}
              </span>
              <span className="gl-chev" aria-hidden="true">
                ›
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export interface GroupNav {
  /** The open group of `section`, or null for its list. */
  openOf: (section: SectionKey) => string | null;
  /** `focus: false` leaves focus to the page (a deep link focuses its row). */
  openGroup: (section: SectionKey, group: string, focus?: boolean) => void;
  /** Back to `section`'s list. */
  back: (section: SectionKey) => void;
}

/**
 * The open group per section, for as long as the window that calls it is open; focus moves
 * (inside `root`) to the page's `h2` after a group opens, and to the group's row after Back.
 */
export function useGroupNav(root: { current: HTMLElement | null }): GroupNav {
  const [open, setOpen] = useState<Partial<Record<SectionKey, string>>>({});
  /** Where focus goes once the next render lands. */
  const pending = useRef<{ heading: true } | { row: string } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    const el =
      "heading" in p
        ? root.current?.querySelector<HTMLElement>(".ms-head h2")
        : [...(root.current?.querySelectorAll<HTMLElement>(".gl-row[data-group]") ?? [])].find(
            (b) => b.dataset.group === p.row,
          );
    el?.focus();
  });
  return {
    openOf: (section) => open[section] ?? null,
    openGroup: (section, group, focus = true) => {
      pending.current = focus ? { heading: true } : null;
      setOpen((o) => ({ ...o, [section]: group }));
    },
    back: (section) => {
      const was = open[section];
      if (was === undefined) return;
      pending.current = { row: was };
      setOpen(({ [section]: _, ...rest }) => rest);
    },
  };
}
