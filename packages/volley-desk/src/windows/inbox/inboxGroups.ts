/**
 * Identical decisions as one Needs-you card (#417). A burst of decisions asking the same thing
 * (eleven tasks of a new wave each asking to trust the same folder) is one question: open,
 * unanswered, unheld `decision` items with the same wave, decision kind, question, option labels,
 * `allow_other` and `owner_only` form one group, its members oldest first, led by the oldest.
 * Everything else (pickers, handoffs, release items, answered or held decisions) is a group of one.
 */
import type { InboxItem } from "../../store/types";

export interface InboxGroup {
  /** The oldest member: its row's id, title and live line. */
  lead: InboxItem;
  /** Every item the group's answer goes to, oldest first (the lead first). */
  members: InboxItem[];
}

/** What makes two items one question; `null` for an item that never groups. */
function groupKey(item: InboxItem): string | null {
  if (item.kind !== "decision" || item.answered !== undefined || item.held) return null;
  return JSON.stringify([
    item.wave ?? null,
    item.source.decision_kind ?? item.source.kind ?? null,
    item.question,
    (item.options ?? []).map((o) => o.label),
    item.allow_other ?? false,
    item.owner_only,
  ]);
}

const byOpened = (a: InboxItem, b: InboxItem) => a.opened_at.localeCompare(b.opened_at);

/** The items as groups, ordered by each lead's `opened_at`. */
export function groupInboxItems(items: readonly InboxItem[]): InboxGroup[] {
  const groups: InboxGroup[] = [];
  const keyed = new Map<string, InboxGroup>();
  for (const item of [...items].sort(byOpened)) {
    const key = groupKey(item);
    const into = key === null ? undefined : keyed.get(key);
    if (into) {
      into.members.push(item);
      continue;
    }
    const group = { lead: item, members: [item] };
    groups.push(group);
    if (key !== null) keyed.set(key, group);
  }
  return groups;
}
