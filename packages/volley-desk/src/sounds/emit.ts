/**
 * The Desk's sound bus: `emitSound(id)` from anywhere (a drag, a panel, the
 * notify hook) reaches every `onSound` listener, which is the sound manager.
 * `count` reports several at once (one policy pass, so they coalesce into one
 * play). No React and no audio: with no manager mounted, an emit is a no-op.
 */
import type { SoundEventId } from "./events";

type Listener = (id: SoundEventId, count: number) => void;

const listeners = new Set<Listener>();

export function emitSound(id: SoundEventId, count = 1): void {
  if (count < 1) return;
  for (const fn of [...listeners]) fn(id, count);
}

/** Subscribes; returns the unsubscribe. */
export function onSound(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
