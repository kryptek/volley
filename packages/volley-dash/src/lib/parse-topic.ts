import type { ChannelKind } from "../types";

export interface ParsedTopic {
  namespace: string;
  agentId: string;
  channel: ChannelKind;
}

const USER_CHANNELS: ReadonlySet<ChannelKind> = new Set([
  "status",
  "progress",
  "mailbox",
  "result",
]);

/**
 * Parse an MQTT topic into `{namespace, agentId, channel}`.
 *
 * Recognised shapes:
 *   - `volley/<ns>/<agent_id>/{status|progress|mailbox|result}`
 *   - `volley/_system/registry/<agent_id>` → channel `system`
 *
 * Returns `null` for anything else. Defensive: a wildcard subscription will
 * occasionally surface topics outside this grammar (e.g. retained `_meta/*`
 * debug traffic) and we want the dashboard to drop them silently.
 */
export function parseTopic(topic: string): ParsedTopic | null {
  if (!topic) return null;
  const parts = topic.split("/");
  if (parts.length !== 4) return null;
  if (parts[0] !== "volley") return null;
  const a = parts[1] as string;
  const b = parts[2] as string;
  const c = parts[3] as string;

  if (a === "_system") {
    if (b !== "registry") return null;
    return { namespace: "_system", agentId: c, channel: "system" };
  }
  if (!USER_CHANNELS.has(c as ChannelKind)) return null;
  return { namespace: a, agentId: b, channel: c as ChannelKind };
}
