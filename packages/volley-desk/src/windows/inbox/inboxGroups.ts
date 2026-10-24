/**
 * Identical decisions as one Needs-you card (#417). A burst of decisions asking the same thing
 * (eleven tasks of a new wave each asking to trust the same folder) is one question: open,
 * unanswered, unheld `decision` items with the same wave, decision kind, question, option labels,
 * `allow_other` and `owner_only` form one group, its members oldest first, led by the oldest.
 * Everything else (pickers, handoffs, release items, answered or held decisions) is a group of one.
 *
 * A group the person has answered, held or released from is **pinned**: its members stay one
 * group, whatever their state, until they have all cleared. volleyd's retained update answers or
 * holds each member as the fan-out reaches it, and without the pin the group would split under
 * the running fan-out (its lead answered alone, the rest a new row with no error and live buttons).
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

/**
 * The items as groups, ordered by each lead's `opened_at`. Each of `pinned` (member ids) is one
 * group of whichever of its members are among `items`; the other items group by their question.
 */
export function groupInboxItems(
  items: readonly InboxItem[],
  pinned: readonly (readonly string[])[] = [],
): InboxGroup[] {
  const sorted = [...items].sort(byOpened);
  const groups: InboxGroup[] = [];
  const taken = new Set<string>();
  for (const pin of pinned) {
    const ids = new Set(pin);
    const members = sorted.filter((i) => ids.has(i.id) && !taken.has(i.id));
    const [lead] = members;
    if (lead === undefined) continue;
    for (const m of members) taken.add(m.id);
    groups.push({ lead, members });
  }
  const keyed = new Map<string, InboxGroup>();
  for (const item of sorted) {
    if (taken.has(item.id)) continue;
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
  return groups.sort((a, b) => byOpened(a.lead, b.lead));
}
