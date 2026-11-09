import type { InboxItem } from "../autopilot/inbox";
import type { CoordinatorRolePayload } from "./role";

/**
 * The coordinator role's owner-only notices (SPEC §4.6.25): `n-coordinator-link` when its link
 * changes (the phone opens it), `n-coordinator-failed` when it fails. Pure: the daemon answers
 * the superseded ones `superseded` and opens the new ones.
 */

/**
 * The coordinator's two, a silent paired machine's (`machine-notice.ts`, #638), and an owner
 * session nothing will wake (`ownerAsleepNotice`, #649).
 */
export type NoticeKind =
  | "coordinator-link"
  | "coordinator-failed"
  | `machine-down-${string}`
  | `owner-asleep-${string}`;

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
  /** What the notice is about since (`source.since`): a silent machine's outage. */
  since?: string;
}

/** The notices a payload change opens, and the open ones it supersedes. */
export interface NoticeActions {
  supersede: string[];
  open: NoticeSpec[];
}

export const RESTART_HINT = "Run `volley coordinator restart` (or Restart in Settings › Machines).";

/**
 * What `prev` → `next` (null: the role off) opens and supersedes. `notices` is the notice items
 * as they stand, answered or not: only the open (unanswered) ones are superseded, and one the
 * owner was already shown (open, or answered other than `superseded`: a volleyd restart adopting
 * the running session, a failure republished) is not opened again. Without `notices`, every
 * notice the change would supersede is listed.
 */
export function noticesFor(
  prev: CoordinatorRolePayload | null,
  next: CoordinatorRolePayload | null,
  notices?: readonly InboxItem[],
): NoticeActions {
  const isOpen = (id: string) =>
    notices === undefined || notices.some((i) => i.id === id && i.answered === undefined);
  const shown = (i: InboxItem) => i.answered === undefined || i.answered.answer !== "superseded";
  const supersede = new Set<string>();
  const opened: NoticeSpec[] = [];
  if (next === null) {
    if (prev !== null) for (const id of [NOTICE_LINK, NOTICE_FAILED]) supersede.add(id);
  } else {
    const link = next.session_url;
    if (link !== undefined && link !== prev?.session_url) {
      const same =
        notices?.some((i) => i.id === NOTICE_LINK && i.pointers.link === link && shown(i)) === true;
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
    // A stop or restart drops the link: Open would point at a dead session.
    if (link === undefined && prev?.session_url !== undefined) supersede.add(NOTICE_LINK);
    // Running again (on a link already shown, or none yet): the failure is over.
    if (next.state === "running" && prev?.state !== "running") supersede.add(NOTICE_FAILED);
    if (next.state === "failed" && prev?.state !== "failed") {
      // Open, or shown for this failure (opened once it began).
      const already =
        notices?.some(
          (i) =>
            i.id === NOTICE_FAILED &&
            (i.answered === undefined || (shown(i) && i.opened_at >= next.since)),
        ) === true;
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

/** `n-owner-asleep-<wave>`: the owner of `wave` idles where nothing will wake it. */
export const ownerAsleepNoticeId = (wave: string) => noticeItemId(`owner-asleep-${wave}`);

/** The hooks' install section, where the owner wake comes from. */
export const HOOKS_INSTALL_URL =
  "https://github.com/kryptek/volley/blob/main/packages/volley-hooks/README.md#install";

/** The one command that arms a wait on `wave`'s digest (what the hooks' Stop block names). */
export const ownerWakeCommand = (wave: string) =>
  `volley sub --pattern "volley/_waves/${wave}/digest" --max-messages 1 --timeout 14400`;

/** One owned wave's owner, as `ownerAsleepNotice` judges it. */
export interface OwnerAsleepInput {
  wave: string;
  /** The wave's owner: a coordinator name or an agent id. */
  owner: string;
  /** The agent acting for it. */
  agentId: string;
  /** This supervisor's machine (the notice's `source.machine`). */
  machine: string;
  /** The owner's presence is online. */
  online: boolean;
  /** The wave is running or releasing. */
  inFlight: boolean;
  /**
   * Since when (epoch ms) the owner has idled at its prompt with nothing to wake it
   * (`awaiting_input` with no question and no `background_wait`); null when it is not.
   */
  asleepSince: number | null;
  /** The owner's session (`pointers.link`), from its awaiting_input. */
  sessionUrl?: string;
  now: number;
  /** `autopilot.owner_wake_grace_s`, in ms. */
  graceMs: number;
}

/**
 * Owner wake (SPEC §4.6.16): an online owner of a running wave that has idled with nothing to wake
 * it for `graceMs` opens `n-owner-asleep-<wave>` (the phone rings once; nothing blocks). It is
 * superseded when the owner arms a wait (`background_wait`), goes offline, or the wave ends.
 * `prior` is the notice's item as it stands: one open, or answered for this same idle, is not
 * opened again.
 */
export function ownerAsleepNotice(i: OwnerAsleepInput, prior?: InboxItem): NoticeActions {
  const id = ownerAsleepNoticeId(i.wave);
  const open = prior !== undefined && prior.answered === undefined;
  const asleep = i.online && i.inFlight && i.asleepSince !== null;
  if (!asleep) return { supersede: open ? [id] : [], open: [] };
  const since = i.asleepSince as number;
  if (i.now - since < i.graceMs || open) return { supersede: [], open: [] };
  const answeredThisIdle =
    prior?.answered !== undefined &&
    prior.answered.answer !== "superseded" &&
    Date.parse(prior.opened_at) >= since;
  if (answeredThisIdle) return { supersede: [], open: [] };
  return {
    supersede: [],
    open: [
      {
        notice: `owner-asleep-${i.wave}`,
        machine: i.machine,
        name: i.owner,
        title: `${i.wave}: your session will not be woken`,
        question: `${i.owner} (${i.agentId}) is idle and nothing will wake it when ${i.wave} ends: its session has no owner wake armed. In that session, run in the background: ${ownerWakeCommand(i.wave)} — or install the Volley hooks to make it automatic: ${HOOKS_INSTALL_URL}`,
        ...(i.sessionUrl !== undefined ? { link: i.sessionUrl } : {}),
        since: new Date(since).toISOString(),
      },
    ],
  };
}
