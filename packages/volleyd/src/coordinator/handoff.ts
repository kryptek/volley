/**
 * The handoff text (SPEC §4.6.25): what volleyd puts into a fresh coordinator session's first
 * turn, as a mailbox message — what it is, where it runs, the running waves, the open needs-you
 * items and the previous session's id when known. Pure.
 */

export interface HandoffWave {
  id: string;
  repo: string;
  done: number;
  total: number;
}

export interface HandoffInput {
  name: string;
  machine: string;
  dir: string;
  waves: readonly HandoffWave[];
  inbox: readonly { id: string; title: string }[];
  previousSessionId?: string;
}

const list = (items: string[]) => (items.length === 0 ? "none" : items.join("; "));

export function renderHandoff(h: HandoffInput): string {
  const waves = h.waves.map((w) => `\`${w.id}\` (${w.repo}, ${w.done}/${w.total} tasks done)`);
  const inbox = h.inbox.map((i) => `\`${i.id}\` ${i.title}`);
  return [
    `You are the coordinator \`${h.name}\` of this Volley fleet, running on \`${h.machine}\` in \`${h.dir}\` (repos under \`repos/\`).`,
    `Running waves: ${list(waves)}.`,
    `Open needs-you items: ${list(inbox)}.`,
    ...(h.previousSessionId !== undefined
      ? [
          `The previous coordinator session was \`${h.previousSessionId}\` (resume it with \`/resume ${h.previousSessionId}\` if you need the detail).`,
        ]
      : []),
    "Use `/volley` and `/volley-issues` as usual.",
  ].join("\n");
}
