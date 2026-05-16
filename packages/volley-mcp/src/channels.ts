/** The six reserved channels (SPEC.md §4.1). */
export type Channel = "status" | "progress" | "mailbox" | "control" | "result" | "capability";

export interface ChannelConfig {
  qos: 0 | 1;
  retain: boolean;
}

const CHANNEL_CONFIG: Record<Channel, ChannelConfig> = {
  status: { qos: 1, retain: true },
  progress: { qos: 0, retain: false },
  mailbox: { qos: 1, retain: false },
  control: { qos: 1, retain: false },
  result: { qos: 1, retain: true },
  capability: { qos: 1, retain: true },
};

const USER_CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export function isReservedChannel(channel: string): channel is Channel {
  return channel in CHANNEL_CONFIG;
}

/** A _user/<name> channel where <name> is a single conforming segment (SPEC.md §4.2). */
export function isUserChannel(channel: string): boolean {
  if (!channel.startsWith("_user/")) return false;
  return USER_CHANNEL_NAME.test(channel.slice("_user/".length));
}

/**
 * True if the channel name lives under a reserved-namespace prefix (`_system/*` or
 * `_meta/*`) and therefore MUST NOT be written from user space (SPEC.md §2.4). User
 * channels under `_user/*` are NOT reserved.
 */
export function isReservedChannelPath(channel: string): boolean {
  return channel.startsWith("_system/") || channel.startsWith("_meta/");
}

/**
 * Resolve the QoS/retain config for a publishable channel: a reserved channel uses its
 * SPEC §4.1 row; a _user/* channel is fire-and-forget (qos 0, not retained); anything
 * else (unknown name, reserved-namespace path, malformed _user channel) returns null.
 */
export function channelConfigFor(channel: string): ChannelConfig | null {
  if (isReservedChannel(channel)) return CHANNEL_CONFIG[channel];
  if (isUserChannel(channel)) return { qos: 0, retain: false };
  return null;
}
