import type { VolleyBroker } from "./broker";
import type { VolleyConfig } from "./config";

/** Mutable per-process server state, threaded through every tool. */
export interface ServerState {
  config: VolleyConfig;
  broker: VolleyBroker;
  /** Flips true after a successful vol_register; gates the publish-path tools. */
  registered: boolean;
  /** The `progress` heartbeat timer (lifecycle.ts); cleared on shutdown. */
  heartbeat?: ReturnType<typeof setInterval> | undefined;
}
