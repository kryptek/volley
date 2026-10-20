/**
 * A broker's retained state after months of use: `finished` agents that are long done
 * (old coordinator sessions) and `live` ones at work, each with a retained registry entry
 * and a retained status. `burst` lists them in the order a broker replays them to a new
 * subscriber, one subscription at a time: every registry entry, then every status. The
 * Desk tests feed it to a fake client; `seed-retained-burst.ts` publishes it to a private
 * broker for a browser check.
 */
import type { Envelope } from "../../src/store/types";

export interface RetainedRecord {
  topic: string;
  envelope: Envelope;
}

export const FINISHED_PREFIX = "old-coord-";
export const LIVE_PREFIX = "live-agent-";

const HOUR = 3_600_000;

function env(agent: string, channel: string, type: string, payload: unknown, at: number): Envelope {
  return {
    schema_version: "0.1",
    agent_id: agent,
    channel,
    type,
    wall_time: new Date(at).toISOString(),
    namespace: "default",
    payload,
  };
}

const finishedId = (n: number) => `${FINISHED_PREFIX}${String(n).padStart(3, "0")}`;
const liveId = (n: number) => `${LIVE_PREFIX}${n}`;

export function retainedBurst({
  finished = 300,
  live = 3,
  now = Date.now(),
}: { finished?: number; live?: number; now?: number } = {}): RetainedRecord[] {
  const agents = [
    // Finished between 1 and 25 hours ago: far past the 10 min grace.
    ...Array.from({ length: finished }, (_, n) => ({
      id: finishedId(n),
      at: now - HOUR - (n % 24) * HOUR,
      status: n % 7 === 0 ? "failed" : "done",
    })),
    ...Array.from({ length: live }, (_, n) => ({
      id: liveId(n),
      at: now - 60_000,
      status: "working",
    })),
  ];
  const registry = agents.map(({ id, at }) => ({
    topic: `volley/_system/registry/${id}`,
    envelope: env(
      id,
      "_system/registry",
      "registered",
      { capabilities: ["coordinates"], cwd: "/work/repo", started_at: new Date(at).toISOString() },
      at,
    ),
  }));
  const status = agents.map(({ id, at, status }) => ({
    topic: `volley/default/${id}/status`,
    envelope: env(id, "status", status, {}, at),
  }));
  return [...registry, ...status];
}

export const liveIds = (live = 3) => Array.from({ length: live }, (_, n) => liveId(n));
