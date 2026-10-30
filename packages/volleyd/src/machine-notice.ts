import { LAUNCHD_LABEL, SYSTEMD_UNIT } from "volley-cli/peer/units";
import type { InboxItem } from "./autopilot/inbox";
import type { NoticeSpec } from "./coordinator/notices";

/**
 * A paired machine gone silent (#638): the supervisor tells the owner, once per outage, when a
 * configured paired machine that holds a clone of a running wave's repository has been down for
 * `placement.down_decision_after_s`. The waves themselves carry on elsewhere (the own machine
 * takes their work under `fleet.local_agents: fallback`), so no decision asks anything; the
 * owner-only `notice` names the machine and how to restart its service. Pure: the daemon opens
 * the notice, journals the alarm, and supersedes the notice when the machine is back.
 */

/** `alarm_raised` / `alarm_cleared`'s `alarm` in `_system`. */
export const MACHINE_SILENT_ALARM = "machine_silent";

export const machineNoticeKind = (name: string) => `machine-down-${name}` as const;
export const machineNoticeId = (name: string) => `n-${machineNoticeKind(name)}`;

/** The command that restarts `volley peer run` on a machine of `os`. */
export function peerRestartHint(os: string): string {
  return os === "darwin"
    ? `launchctl kickstart -k gui/$(id -u)/${LAUNCHD_LABEL}`
    : `systemctl --user restart ${SYSTEMD_UNIT}`;
}

export interface SilentMachineInput {
  name: string;
  os: string;
  /** Its record's `last_seen` while down: one outage's key (it changes with the next heartbeat). */
  lastSeen: string;
  /** Why it is down (`Machines.whyDown`). */
  why: string;
  /** When volleyd saw it go down (ms). */
  downSince: number;
  now: number;
  /** `placement.down_decision_after_s`, in ms. */
  boundMs: number;
  /** A paired machine in config (`hosts.<name>`), not the supervisor's own. */
  paired: boolean;
  /** The running waves and their repositories. */
  waves: { wave: string; slug: string }[];
  /** Whether the machine holds a clone of `slug` (`holdersOf`). */
  holds: (slug: string) => boolean;
  /** The machine's notice as it stands (answered or not), if it ever opened. */
  prior: InboxItem | undefined;
}

const minutes = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

/** The notice to open for a silent machine, or null (not silent long enough, or already told). */
export function silentMachineNotice(i: SilentMachineInput): NoticeSpec | null {
  if (!i.paired || i.now - i.downSince < i.boundMs) return null;
  const waves = i.waves.filter((w) => i.holds(w.slug));
  if (waves.length === 0) return null;
  // Once per outage: open still, or shown for this one already.
  if (i.prior !== undefined) {
    if (i.prior.answered === undefined) return null;
    if (i.prior.source.since === i.lastSeen) return null;
  }
  const slugs = [...new Set(waves.map((w) => w.slug))];
  const hint = peerRestartHint(i.os);
  return {
    notice: machineNoticeKind(i.name),
    machine: i.name,
    name: i.name,
    since: i.lastSeen,
    title: `${i.name} has been silent for ${minutes(i.now - i.downSince)}`,
    question: `${i.name} has sent no heartbeat since ${i.lastSeen} (${i.why}), so ${waves.map((w) => w.wave).join(", ")} run${waves.length === 1 ? "s" : ""} without it, though it holds ${slugs.join(", ")}. On ${i.name}, restart its service: \`${hint}\``,
  };
}
