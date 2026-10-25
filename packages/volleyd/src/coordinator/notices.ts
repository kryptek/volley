import type { InboxItem } from "../autopilot/inbox";
import type { CoordinatorRolePayload } from "./role";

/**
 * The coordinator role's owner-only notices (SPEC §4.6.25): `n-coordinator-link` when its link
 * changes (the phone opens it), `n-coordinator-failed` when it fails. Pure: the daemon answers
 * the superseded ones `superseded` and opens the new ones.
 */

export type NoticeKind = "coordinator-link" | "coordinator-failed";

export const noticeItemId = (notice: NoticeKind) => `n-${notice}`;
export const NOTICE_LINK = noticeItemId("coordinator-link");
export const NOTICE_FAILED = noticeItemId("coordinator-failed");

/** What one notice says; `itemForNotice` makes its inbox item. */
export interface NoticeSpec {
  notice: NoticeKind;
  machine: string;
  name: string;
  title: string;
  question: string;
  /** The coordinator's link (`pointers.link`): the link notice's. */
  link?: string;
}

/** The notices a payload change opens, and the open ones it supersedes. */
export interface NoticeActions {
  supersede: string[];
  open: NoticeSpec[];
}

export const RESTART_HINT = "Run `volley coordinator restart` (or Restart in Settings › Machines).";

/**
 * What `prev` → `next` (null: the role off) opens and supersedes. `open` is the notices open now
 * (unanswered): only those are superseded, and one already saying the same (a volleyd restart
 * adopting the running session, a failure republished) is not opened again. Without `open`,
 * every notice the change would supersede is listed.
 */
export function noticesFor(
  prev: CoordinatorRolePayload | null,
  next: CoordinatorRolePayload | null,
  open?: readonly InboxItem[],
): NoticeActions {
  const isOpen = (id: string) => open === undefined || open.some((i) => i.id === id);
  const supersede = new Set<string>();
  const opened: NoticeSpec[] = [];
  if (next === null) {
    if (prev !== null) for (const id of [NOTICE_LINK, NOTICE_FAILED]) supersede.add(id);
  } else {
    const link = next.session_url;
    if (link !== undefined && link !== prev?.session_url) {
      const same = open?.some((i) => i.id === NOTICE_LINK && i.pointers.link === link) === true;
      if (!same) {
        supersede.add(NOTICE_LINK);
        supersede.add(NOTICE_FAILED);
        opened.push({
          notice: "coordinator-link",
          machine: next.machine,
          name: next.name,
          title: `Coordinator on ${next.machine}: open it`,
          question: link,
          link,
        });
      }
    }
    if (next.state === "failed" && prev?.state !== "failed") {
      const already = open?.some((i) => i.id === NOTICE_FAILED) === true;
      if (!already) {
        supersede.add(NOTICE_LINK);
        const why = next.last_error?.trim();
        opened.push({
          notice: "coordinator-failed",
          machine: next.machine,
          name: next.name,
          title: `Coordinator on ${next.machine} stopped`,
          question: why ? `${why}\n\n${RESTART_HINT}` : RESTART_HINT,
        });
      }
    }
  }
  return { supersede: [...supersede].filter(isOpen), open: opened };
}
