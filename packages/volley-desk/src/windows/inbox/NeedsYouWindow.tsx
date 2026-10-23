/**
 * The Needs you window: the needs-you inbox (SPEC §4.6.18), one row per item volleyd keeps on
 * `volley/_inbox/<id>`: decisions, pickers, handoffs and the release train's go/no-go, oldest
 * first; a held one (SPEC §4.6.2) is amber with what it waits on, never counted or pulsing. In
 * the glass window chrome like the coordinators window, with the Needs-you pulse ring while any
 * open item needs a person (owner-only, or at tier `you` per `attention.ts`), and the title's
 * `N need you` chip. Filters are Gooey tabs: All / Only you / Pickers / Decisions /
 * Handoffs. Rows are `InboxRow`s; Dismiss hides a row from this Desk only (the item stays open
 * and still counts), `Bring back` restores them. A row whose record clears (answered and past
 * volleyd's TTL, or closed) fades out over `LEAVE_MS`.
 *
 * Phone layout (`narrow`): stacked full-width cards, every button and tab at least 48 px tall,
 * the live line on one line, options as a vertical stack (styles/inbox.css).
 */
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useRef, useState } from "react";
import type { Tier } from "../../attention";
import { Frame, type FrameProps } from "../../canvas/Frame";
import { plural } from "../../lib/plural";
import { GooeyTabs, tabPanelProps } from "../../look/GooeyTabs";
import { usePanelSound } from "../../sounds/usePanelSound";
import type { SteerTransport } from "../../steer/transport";
import type { InboxItem, WaveView } from "../../store/types";
import { IconBtn } from "../wave/WaveWindow";
import { InboxRow } from "./InboxRow";
import type { LoadEvidence } from "./ReleaseItem";
import { INBOX_FILTERS, type InboxFilter, matchesFilter, needsPerson } from "./inboxFilters";
import "../../styles/attention.css";
import "../../styles/inbox.css";

export const INBOX_ID = "inbox";
export const INBOX_W = 460;
/** The window's height less its list: the title bar, the filter tabs and the closing note. */
export const INBOX_CHROME_H = 130;
/** How long a cleared row takes to fade out. */
export const LEAVE_MS = 600;

export interface NeedsYouWindowProps {
  /** The store's items (answered ones until volleyd clears them). */
  items: readonly InboxItem[];
  /** Each item's tier (`inboxAttention`), by id. */
  tiers: Readonly<Record<string, Tier>>;
  /** Each item's live line (`liveLine`), by id. */
  live?: Readonly<Record<string, string | null>>;
  waves?: Readonly<Record<string, WaveView>>;
  /** Now (ms): the held line's age. */
  now?: number;
  /** volleyd's control channel; null without broker credentials (rows offer the CLI command). */
  control: SteerTransport["control"] | null;
  /** This device, for `where.device` (`deskDevice`). */
  device: string;
  narrow?: boolean;
  /**
   * The tallest the window gets on the canvas (#397: the fit area's height); the list
   * scrolls inside, keeping its own scroll position.
   */
  maxHeight?: number;
  /** The Desk's origin, for evidence files (default: this page's). */
  origin?: string;
  loadEvidence?: LoadEvidence;
  frame: Omit<
    FrameProps,
    "id" | "title" | "label" | "accent" | "width" | "actions" | "footer" | "children" | "attn"
  >;
  onClose: () => void;
  /** Go-to: fit the viewport to the item's source window. */
  onGoTo?: (item: InboxItem) => void;
  /** Show: put the item's source window back on the canvas. */
  onShow?: (item: InboxItem) => void;
}

/** Items whose record cleared, kept for `LEAVE_MS` so the row can fade. */
function useLeaving(items: readonly InboxItem[]): InboxItem[] {
  const prev = useRef<readonly InboxItem[]>(items);
  const [leaving, setLeaving] = useState<InboxItem[]>([]);
  // One timer per leaving id, outliving re-renders: `items` is a fresh array on every
  // store update, so an effect-scoped timer would be cleared before it ever fired.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    const gone = prev.current.filter((i) => !ids.has(i.id));
    prev.current = items;
    for (const id of ids) {
      const t = timers.current.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        timers.current.delete(id);
      }
    }
    setLeaving((l) => {
      const kept = l.filter((i) => !ids.has(i.id));
      return gone.length === 0 && kept.length === l.length ? l : [...kept, ...gone];
    });
    for (const g of gone) {
      timers.current.set(
        g.id,
        setTimeout(() => {
          timers.current.delete(g.id);
          setLeaving((l) => l.filter((i) => i.id !== g.id));
        }, LEAVE_MS),
      );
    }
  }, [items]);
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
    };
  }, []);
  return leaving;
}

export function NeedsYouWindow(p: NeedsYouWindowProps) {
  usePanelSound();
  const id = useId();
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const leaving = useLeaving(p.items);
  const tier = (i: InboxItem): Tier => p.tiers[i.id] ?? "none";
  const needsYou = p.items.filter((i) => needsPerson(i, tier(i))).length;
  const all = [
    ...p.items.map((item) => ({ item, leaving: false })),
    ...leaving.map((item) => ({ item, leaving: true })),
  ].sort((a, b) => a.item.opened_at.localeCompare(b.item.opened_at));
  const shown = all.filter(
    (r) => !dismissed.has(r.item.id) && matchesFilter(r.item, filter, tier(r.item)),
  );
  const dismissedCount = p.items.filter((i) => dismissed.has(i.id)).length;

  const title = (
    <>
      <span className="t-name">Needs you</span>
      {needsYou > 0 && <span className="chip chip--hot">{needsYou} need you</span>}
    </>
  );
  return (
    <Frame
      {...p.frame}
      id={INBOX_ID}
      title={title}
      label="Needs you"
      accent="#ff7a59"
      width={INBOX_W}
      {...(needsYou > 0 ? { attn: "you" as const } : {})}
      actions={<IconBtn label="Close Needs you" i={Cancel01Icon} onClick={p.onClose} />}
    >
      <div className={`inbox${p.narrow ? " inbox--phone" : ""}`}>
        <div className="inbox-tabs">
          <GooeyTabs
            id={id}
            label="Filter the inbox"
            tabs={INBOX_FILTERS}
            value={filter}
            onChange={setFilter}
            accent="#ff7a59"
          />
        </div>
        <div
          {...tabPanelProps(id, filter)}
          className="inbox-scroll"
          {...(p.maxHeight !== undefined
            ? { style: { maxHeight: Math.max(0, p.maxHeight - INBOX_CHROME_H) }, tabIndex: 0 }
            : {})}
        >
          {shown.length === 0 ? (
            <p className="inbox-empty dim">
              {p.items.length === 0 ? "Nothing needs you." : "Nothing here under this filter."}
            </p>
          ) : (
            <ul className="inbox-list">
              {shown.map(({ item, leaving: gone }) => (
                <InboxRow
                  key={item.id}
                  item={item}
                  needsYou={needsPerson(item, tier(item))}
                  live={p.live?.[item.id]}
                  wave={item.wave !== undefined ? p.waves?.[item.wave] : undefined}
                  control={p.control}
                  device={p.device}
                  {...(p.now !== undefined ? { now: p.now } : {})}
                  leaving={gone}
                  narrow={p.narrow ?? false}
                  release={{
                    ...(p.origin !== undefined ? { origin: p.origin } : {}),
                    ...(p.loadEvidence ? { loadEvidence: p.loadEvidence } : {}),
                  }}
                  onGoTo={p.onGoTo && (() => p.onGoTo?.(item))}
                  onShow={p.onShow && (() => p.onShow?.(item))}
                  onDismiss={() => setDismissed((d) => new Set(d).add(item.id))}
                />
              ))}
            </ul>
          )}
          {dismissedCount > 0 && (
            <p className="coord-dismissed">
              {plural(dismissedCount, "dismissed item")} ·{" "}
              <button type="button" className="coord-link" onClick={() => setDismissed(new Set())}>
                Bring back
              </button>
            </p>
          )}
        </div>
        <p className="coord-note">
          Dismissed items stay open: they still count in the top bar and on the dock.
        </p>
      </div>
    </Frame>
  );
}
