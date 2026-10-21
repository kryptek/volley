/**
 * The Needs you window's pure parts: its filters (All / Only you / Pickers / Decisions /
 * Handoffs), whether an item needs a person, the window each row is tethered from, its live
 * line, and how an answer's `where` reads (volleyd's `whereLabel`, so the Desk and a refusal say
 * the same thing).
 */
import type { Tier } from "../../attention";
import type { DeskState, InboxItem, InboxWhere } from "../../store/types";
import { COORDS_ID } from "../coordinators/CoordinatorsWindow";

export type InboxFilter = "all" | "you" | "pickers" | "decisions" | "handoffs";

export const INBOX_FILTERS: readonly { key: InboxFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "you", label: "Only you" },
  { key: "pickers", label: "Pickers" },
  { key: "decisions", label: "Decisions" },
  { key: "handoffs", label: "Handoffs" },
];

/** Open, and only a person answers it: owner-only, or at tier `you` (`inboxAttention`). */
export function needsPerson(item: InboxItem, tier: Tier): boolean {
  return item.answered === undefined && (item.owner_only || tier === "you");
}

/** A release's stage go / go-no-go is one more decision. */
export function matchesFilter(item: InboxItem, filter: InboxFilter, tier: Tier): boolean {
  switch (filter) {
    case "all":
      return true;
    case "you":
      return needsPerson(item, tier);
    case "pickers":
      return item.kind === "picker";
    case "decisions":
      return item.kind === "decision" || item.kind === "release";
    case "handoffs":
      return item.kind === "handoff";
  }
}

/** volleyd's `whereLabel`: `desk·phone`, `mbp·terminal`, `cli`, `autopilot`. */
export function whereLabel(w: InboxWhere): string {
  if (w.kind === "desk") return w.device !== undefined ? `desk·${w.device}` : "desk";
  if (w.kind === "terminal") return w.machine !== undefined ? `${w.machine}·terminal` : "terminal";
  return w.kind;
}

/**
 * The window an item comes from, when it has one on the Desk: a coordinator's session → the
 * coordinators window; a session with a window of its own → that agent; else the item's wave.
 */
export function sourceWindow(item: InboxItem, state: DeskState): string | null {
  if (item.kind === "picker" || item.kind === "handoff") {
    if (state.coordinators[item.agent_id]) return COORDS_ID;
    if (state.agents[item.agent_id]) return item.agent_id;
  }
  return item.wave !== undefined && state.waves[item.wave] ? item.wave : null;
}

/** One tether per row whose source window is on the Desk: `inbox:<id>` → that window. */
export function inboxSources(
  items: readonly InboxItem[],
  state: DeskState,
): { id: string; source: string }[] {
  return items.flatMap((i) => {
    const source = sourceWindow(i, state);
    return source === null ? [] : [{ id: `inbox:${i.id}`, source }];
  });
}

/**
 * The row's live line: the source session's latest narration, or for a wave's decision or
 * release the latest line volleyd journaled for the wave (its `events` mirror).
 */
export function liveLine(item: InboxItem, state: DeskState): string | null {
  if (item.kind === "picker" || item.kind === "handoff") {
    return state.agents[item.agent_id]?.narration ?? null;
  }
  const last = item.wave !== undefined ? state.waveFeed?.[item.wave]?.at(-1) : undefined;
  if (!last) return state.agents[item.agent_id]?.narration ?? null;
  const data = ((last.envelope.payload as { data?: Record<string, unknown> } | undefined)?.data ??
    {}) as Record<string, unknown>;
  const parts = [data.kind, data.answer, data.why].filter(
    (v): v is string => typeof v === "string" && v !== "",
  );
  return [last.envelope.type.replaceAll("_", " "), ...parts].join(" · ");
}
