/**
 * Which sound events one store change means: `deriveSoundEvents(prev, next,
 * ctx)` compares two `DeskState`s and returns event ids, one per thing that
 * happened (the policy coalesces repeats). Pure: it never reads the clock
 * (`ctx.now`) and touches no DOM or audio.
 *
 * While `ctx.settling` (a page load's or a reconnect's retained replay)
 * nothing in the store is news, so only the connection is diffed; a `prev`
 * of `null` (the first state seen) yields nothing either.
 */
import type { AgentView, DeskState, WaveTask } from "../store/types";
import type { SoundEventId } from "./events";

/** The store's `Connection` (`store/context.tsx`), restated to keep this file free of React. */
export type SoundConnection = "demo" | "connecting" | "connected" | "disconnected";

export interface SoundCtx {
  now: number;
  settling: boolean;
  connection: SoundConnection;
  /** The last connection state before `connection` that was not `connecting`. */
  prevConnection: SoundConnection;
}

/** A spawn older than this (a retained replay's `started_at`) is not news. */
export const LIVE_SPAWN_MS = 5000;

const REVIEWERS = new Set(["spec_reviewer", "quality_reviewer"]);

function agentStatus(prev: AgentView, next: AgentView): SoundEventId[] {
  const was = prev.status?.type ?? (prev.registered ? "registered" : null);
  const now = next.status?.type;
  if (now === undefined || now === was) return [];
  switch (now) {
    case "done":
      return next.role && REVIEWERS.has(next.role)
        ? ["agent_complete", "review_written"]
        : ["agent_complete"];
    case "failed":
    case "blocked":
      return ["agent_failed"];
    case "reaped":
      return ["agent_reaped"];
    case "working":
      return was === null || was === "spawning" || was === "registered" ? ["agent_working"] : [];
    default:
      return [];
  }
}

export function diffAgents(prev: DeskState, next: DeskState, ctx: SoundCtx): SoundEventId[] {
  return Object.values(next.agents).flatMap((a): SoundEventId[] => {
    const before = prev.agents[a.id];
    if (!before)
      return a.bornAt !== null && a.bornAt >= ctx.now - LIVE_SPAWN_MS ? ["agent_spawned"] : [];
    return agentStatus(before, a);
  });
}

function taskEvents(before: WaveTask, task: WaveTask): SoundEventId[] {
  const out: SoundEventId[] = [];
  const ci = task.pr?.ci;
  // A PR seen for the first time already green or red is not news.
  if (before.pr?.ci !== undefined && ci !== before.pr.ci) {
    if (ci === "green") out.push("ci_passed");
    if (ci === "red") out.push("ci_failed");
  }
  if (task.stage !== before.stage) {
    if (task.stage === "merge_ready") out.push("merge_ready");
    if (task.stage === "done") out.push("pr_merged");
  }
  return out;
}

export function diffTasks(prev: DeskState, next: DeskState): SoundEventId[] {
  return Object.values(next.waves).flatMap((w) => {
    const before = new Map((prev.waves[w.id]?.state?.tasks ?? []).map((t) => [t.id, t]));
    return (w.state?.tasks ?? []).flatMap((t) => {
      const b = before.get(t.id);
      return b ? taskEvents(b, t) : [];
    });
  });
}

export function diffWaves(prev: DeskState, next: DeskState): SoundEventId[] {
  return Object.values(next.waves).flatMap((w): SoundEventId[] => {
    const status = w.state?.status;
    const was = prev.waves[w.id]?.state?.status;
    if (status === undefined || status === was) return [];
    if (was === undefined) return status === "running" ? ["wave_start"] : [];
    if (status === "running" && was === "paused") return ["wave_start"];
    if (status === "complete") return ["wave_complete"];
    if (status === "stopped") return ["wave_stopped"];
    return [];
  });
}

export function diffDecisions(prev: DeskState, next: DeskState): SoundEventId[] {
  return Object.values(next.waves).flatMap((w) =>
    Object.values(w.decisions).flatMap((d): SoundEventId[] => {
      const before = prev.waves[w.id]?.decisions[d.decision_id];
      if (before) return d.resolved && !before.resolved ? ["decision_answered"] : [];
      if (d.resolved) return [];
      if (d.kind === "account_limit") return ["account_limit"];
      if (d.kind === "agent_blocked") return ["agent_failed"];
      return [];
    }),
  );
}

export function diffMachines(prev: DeskState, next: DeskState): SoundEventId[] {
  return Object.values(next.machines ?? {}).flatMap((m): SoundEventId[] =>
    m.tunnel === "down" && prev.machines?.[m.name]?.tunnel === "up" ? ["machine_down"] : [],
  );
}

export function diffConnection(ctx: SoundCtx): SoundEventId[] {
  if (ctx.prevConnection === "connected" && ctx.connection === "disconnected")
    return ["broker_disconnected"];
  if (ctx.prevConnection === "disconnected" && ctx.connection === "connected")
    return ["broker_reconnected"];
  return [];
}

export function deriveSoundEvents(
  prev: DeskState | null,
  next: DeskState,
  ctx: SoundCtx,
): SoundEventId[] {
  const conn = diffConnection(ctx);
  if (ctx.settling || prev === null || prev === next) return conn;
  return [
    ...diffAgents(prev, next, ctx),
    ...diffTasks(prev, next),
    ...diffWaves(prev, next),
    ...diffDecisions(prev, next),
    ...diffMachines(prev, next),
    ...conn,
  ];
}
