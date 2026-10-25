/**
 * When Getting started opens, and what opening, closing, skipping and finishing it store. It
 * opens once per page load for an admin Desk (the wizard's steps need the admin channel): after
 * the admin sign-in (`takeFirstRun`) or on any load, unless this browser finished or skipped it;
 * `#getting-started` opens it whatever the marker says. Closing pauses it at the step reached.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { SceneId } from "./art/ids";
import {
  type Progress,
  type Summary,
  localStore,
  markDone,
  readProgress,
  writeProgress,
} from "./state";

export type FirstLoad = "getting-started" | "settings-setup" | null;

/**
 * Pure: what an admin Desk opens on load. A skipped Getting started leaves the first run with
 * today's Settings › Setup & Security; a finished one opens nothing.
 */
export function decide({
  admin,
  firstRun,
  progress,
}: {
  admin: boolean;
  firstRun: boolean;
  progress: Progress;
}): FirstLoad {
  if (!admin) return null;
  if (progress.done?.kind === "finished") return null;
  if (progress.done?.kind === "skipped") return firstRun ? "settings-setup" : null;
  return "getting-started";
}

export interface GettingStarted {
  /** The step it is open at; `null` while closed. */
  open: SceneId | null;
  progress: Progress;
  /** Open it at the stored step (Settings' Open…). */
  show(): void;
  /** The person moved to `step`: stored, so a closed window reopens there. */
  setStep(step: SceneId): void;
  setSummary(patch: Partial<Summary>): void;
  /** Close and pause at `step` (default: the step it is open at). */
  close(step?: SceneId): void;
  skip(): void;
  finish(): void;
}

export function useGettingStarted({
  admin,
  firstRun,
  hash,
  storage = localStore(),
}: {
  /** An admin Desk that can send admin ops (`useAdminRole`, not demo). */
  admin: boolean;
  /** An admin token was just redeemed (`takeFirstRun`, read once by the caller). */
  firstRun: boolean;
  /** The address bar asked for it (`#getting-started`, read once by the caller). */
  hash: boolean;
  storage?: Storage | null;
}): GettingStarted {
  const [progress, setProgress] = useState(() => readProgress(storage));
  const [open, setOpen] = useState<SceneId | null>(null);
  const decided = useRef(false);
  const save = useCallback(
    (next: Progress) => {
      writeProgress(storage, next);
      setProgress(next);
    },
    [storage],
  );

  // Decided once, when the Desk first knows it is an admin.
  useEffect(() => {
    if (!admin || decided.current) return;
    decided.current = true;
    const p = readProgress(storage);
    if (hash || decide({ admin, firstRun, progress: p }) === "getting-started") setOpen(p.step);
  }, [admin, firstRun, hash, storage]);

  const show = useCallback(() => setOpen(readProgress(storage).step), [storage]);
  const setStep = useCallback(
    (step: SceneId) => {
      setOpen(step);
      save({ ...readProgress(storage), step });
    },
    [save, storage],
  );
  const setSummary = useCallback(
    (patch: Partial<Summary>) => {
      const p = readProgress(storage);
      save({ ...p, summary: { ...p.summary, ...patch } });
    },
    [save, storage],
  );
  const close = useCallback(
    (step?: SceneId) => {
      if (step !== undefined) save({ ...readProgress(storage), step });
      setOpen(null);
    },
    [save, storage],
  );
  const skip = useCallback(() => {
    setProgress(markDone(storage, "skipped", new Date()));
    setOpen(null);
  }, [storage]);
  const finish = useCallback(() => {
    save({ ...readProgress(storage), step: "done" });
    setProgress(markDone(storage, "finished", new Date()));
    setOpen(null);
  }, [save, storage]);

  return { open, progress, show, setStep, setSummary, close, skip, finish };
}
