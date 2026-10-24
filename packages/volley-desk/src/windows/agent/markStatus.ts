/**
 * The agent's outcome as the classic status mark shows it (`markStatus`); the
 * Clawd character's state (`clawd/state.ts`) reads it too. Its own module so
 * `clawd/` need not import `AgentWindow.tsx`.
 */
import type { StatusMarkStatus } from "../../rb/StatusMark/StatusMark";
import type { AgentView, FeedEntry } from "../../store/types";
import { feedChannel } from "./Feed";

/** The mark for an outcome status: `blocked` (SPEC §5.2, terminal) needs the operator, like `failed`. */
function outcomeMark(type: string): StatusMarkStatus | null {
  if (type === "done") return "done";
  if (type === "failed" || type === "blocked") return "failed";
  return null;
}

/**
 * The status mark for an agent. `reaped` (SPEC §5.2) only says the connection
 * ended, normally right after `done`, so it shows the outcome before it: the
 * latest other `status` in the feed, else (a retained replay, where only the
 * `reaped` status survives) `done` if the agent left a `result`. Anything else
 * — reaped while working, or with nothing known — is a crash.
 */
export function markStatus(agent: Pick<AgentView, "status" | "feed">): StatusMarkStatus {
  const type = agent.status?.type;
  if (type === "working") return "running";
  if (type !== "reaped") return (type ? outcomeMark(type) : null) ?? "pending";
  for (let i = agent.feed.length - 1; i >= 0; i--) {
    const e = agent.feed[i] as FeedEntry;
    if (feedChannel(e) === "status" && e.envelope.type !== "reaped") {
      return outcomeMark(e.envelope.type) ?? "failed";
    }
  }
  return agent.feed.some((e) => feedChannel(e) === "result") ? "done" : "failed";
}
