import type { Tunables } from "./types";

/**
 * Built-in defaults for every runtime tunable (config.schema.json $defs/tunables) — the bottom
 * layer of `defaults ← $VOLLEYD_HOME/config.yaml ← per-wave config:`. This is the ONLY file
 * that may hold a literal value for a tunable; everything else reads through
 * `ConfigStore.get()` (enforced by test/no-constants.test.ts).
 */
export const CONFIG_DEFAULTS: Tunables = {
  hard_ceiling: 12,
  spawn_budget_multiplier: 3,
  lease_pools: {},
  admission: {
    memory_pressure_max_level: 2,
    cmux_ping_max_ms: 2000,
    container_max: 20,
    api_overload_window_s: 300,
    api_overload_max: 3,
    ci_queue_max: 10,
    hysteresis_samples: 3,
  },
  claim_after_s: 1800,
  heartbeat_alarm_s: 600,
  fallback_model: null,
  mailbox: { session_expiry_s: 604800 },
  worktree_root: "~/.volley/worktrees",
  spawn_timeout_s: 120,
  wake_grace_s: 60,
  screen_tail_interval_s: 5,
};

/** Who `updated_by` names before anyone has changed the config. */
export const DEFAULTS_AUTHOR = "volleyd-defaults";

/**
 * Daemon internals that are not runtime tunables (not in the config schema, not settable via
 * config_set). Kept here so every timing/size literal lives in one place.
 */
export const DAEMON_DEFAULTS = {
  /** Write a reducer snapshot every N journal events so restart replays only the tail. */
  snapshot_every: 50,
  /** Admission/monitor tick interval. Config changes also trigger an immediate tick. */
  tick_ms: 10_000,
  /** How long the CLI waits for the daemon's retained status before saying "not running". */
  probe_ms: 1_000,
  /** How long the CLI waits for a control response. */
  request_timeout_ms: 10_000,
  /** How often the daemon checks its broker connection; a lost connection makes it exit. */
  watchdog_ms: 1_000,
  /** How long a mailbox drain waits before re-arming (only bounds a wait; no latency cost). */
  mailbox_idle_ms: 30_000,
  /** Recently answered control requests remembered for QoS 1 redelivery dedupe. */
  dedupe_max: 256,
  /** After an exec timeout's SIGTERM, wait this long before SIGKILL. */
  exec_kill_grace_ms: 5_000,
  /** Cap on captured stdout and stderr per exec (each), in bytes. */
  exec_output_max_bytes: 4 * 1024 * 1024,
  /** How long `volleyd spawn` waits for the launch (verification continues in the daemon). */
  spawn_request_timeout_ms: 120_000,
  /** Terminal lines read when a spawn falls back to the screen (pre-hook window only). */
  screen_lines: 40,
  /** How often the screen publisher checks which agents are due a capture. */
  screen_tick_ms: 1_000,
  /** Lines read per screen-tail capture (`cmux read-screen --lines`), before the chrome is cut. */
  screen_capture_lines: 60,
  /** Lines kept in a published screen tail (screen.schema.json maxItems). */
  screen_tail_lines: 40,
  /** A capture slower than this backs the agent off and marks its screen stale. */
  screen_slow_ms: 2_000,
  /** Hard bound on one screen read; a read still pending then counts as failed (and slow). */
  screen_read_timeout_ms: 5_000,
  /** Consecutive failed captures that back the agent off and mark its screen stale. */
  screen_max_failures: 3,
  /** Capture interval while an agent is backed off. */
  screen_backoff_s: 30,
} as const;
