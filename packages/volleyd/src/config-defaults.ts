import { join } from "node:path";
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
  idle_grace_s: 180,
  background_wait_max_s: 7200,
  stall_backoff_max_s: 1800,
  fallback_model: null,
  mailbox: { session_expiry_s: 604800 },
  worktree_root: "~/.volley/worktrees",
  spawn_timeout_s: 120,
  spawn_retry_max_s: 900,
  spawn_retry_max: 8,
  brief_preface_max_bytes: 16384,
  wake_grace_s: 120,
  screen_tail_interval_s: 5,
  stop_grace_s: 30,
  dynsec_batch_ms: 50,
  credential_sweep_interval_s: 600,
  claude: { default_account: null, warn_at_pct: 90 },
  branch_update: "rebase",
  agent_mcp: "strict",
  public_hygiene: "auto",
  hosts: {},
};

/**
 * The defaults a daemon starts from: CONFIG_DEFAULTS, with `worktree_root` under
 * `$VOLLEYD_HOME/worktrees` when VOLLEYD_HOME is set (a second, smoke daemon keeps its
 * worktrees beside its state). config.yaml and per-wave `config:` still override it.
 */
export function defaultsFor(env: { VOLLEYD_HOME?: string | undefined }): Tunables {
  const home = env.VOLLEYD_HOME;
  return home === undefined || home === ""
    ? CONFIG_DEFAULTS
    : { ...CONFIG_DEFAULTS, worktree_root: join(home, "worktrees") };
}

/** Defaults for a remote host's unset keys (config `hosts.<name>`). */
export const REMOTE_HOST_DEFAULTS = {
  /**
   * Port on the remote machine's 127.0.0.1 that reaches the broker through the tunnel. Not
   * MQTT's 1883: a box running its own broker has that port taken.
   */
  remote_port: 21883,
  /** volleyd keeps the reverse tunnel up itself. */
  supervise_tunnel: true,
  /** `worktree_root` default: this directory beside the remote repo. */
  worktree_dir: ".volley-worktrees",
} as const;

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
  /** How often the cached agent-login count (`volleyd status`) is re-read from the broker. */
  login_count_refresh_ms: 30_000,
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
  /** TTL of a lease whose request names none, in a pool that sets none. */
  lease_default_ttl_s: 3600,
  /** Kill a pressure sampler (sysctl, docker, gh) after this long; its signal is then unknown. */
  sampler_timeout_ms: 5_000,
  /**
   * Re-sample a repo's CI queue (`gh api`, which spends the agents' GitHub rate limit) at most
   * this often; ticks in between reuse the cached sample.
   */
  ci_queue_sample_ms: 60_000,
  /**
   * `memory_pressure` fallback (no sysctl level): free percentage at or below which the level is
   * 4 (critical) or 2 (warn). Heuristic thresholds, not tunables.
   */
  memory_free_critical_pct: 10,
  memory_free_warn_pct: 20,
  /** How long `volleyd spawn` waits for the launch (verification continues in the daemon). */
  spawn_request_timeout_ms: 120_000,
  /** Terminal lines read when a spawn falls back to the screen (pre-hook window only). */
  screen_lines: 40,
  /** A did-not-start decision quotes this many last non-blank screen lines, up to this many chars. */
  decision_output_lines: 3,
  decision_output_chars: 300,
  /** After pressing Enter on an update prompt, how long the original launch gets to continue. */
  relaunch_settle_ms: 3_000,
  /** First retry delay of an automatic spawn that was refused; doubles per refusal, up to the
   * `spawn_retry_max_s` tunable. */
  spawn_retry_base_ms: 30_000,
  /** How long a spawn's (or `run`'s) `git fetch origin <release branch>` may take before it is
   * treated as failed (an ssh remote with no agent, a credential prompt). */
  git_fetch_timeout_ms: 30_000,
  /** Read-modify-write attempts on `~/.claude.json` while Claude Code keeps rewriting it. */
  trust_write_attempts: 5,
  /** How long `steer` waits for the recipient's `steering_acked` before reporting `delivered`. */
  steer_wait_ack_ms: 30_000,
  /** Upper bound on a caller's `wait_ack_ms`, so a steer cannot park a waiter indefinitely. */
  steer_wait_ack_max_ms: 300_000,
  /** How long the daemon waits for one `gh issue view` (issue Files sections, at submit). */
  issue_fetch_ms: 15_000,
  /** How long the daemon waits for `gh repo view --json visibility` (at submit, under `auto`). */
  repo_visibility_ms: 15_000,
  /** How long the CLI collects retained registry entries to auto-detect the caller's agent id. */
  registry_scan_ms: 250,
  /** Kill a `volley auth` account command (accounts.ts) after this long. */
  auth_exec_timeout_ms: 15_000,
  /**
   * Kill each command a `setup_apply` step runs (the Desk build, the hooks installer, the broker
   * restart) after this long. A step runs several, so its answer can come after the Desk's 120 s
   * wait; the Desk keeps listening for a late answer.
   */
  setup_apply_timeout_ms: 110_000,
  /** Lifetime of a `signin_link` whose request names no `ttl_s`. */
  signin_link_ttl_s: 600,
  /** The longest a sign-in link may live (`volley auth` enforces the same bound). */
  token_max_ttl_s: 86_400,
  /**
   * How often volleyd runs `volley auth list --json`, which drops the broker logins of expired
   * (and redeemed) one-time tokens, when the daemon uses broker auth.
   */
  token_prune_ms: 60_000,
  /** How long a Dynamic Security control message may wait for its answer (and the connect). */
  dynsec_timeout_ms: 10_000,
  /** Reconnect backoff of volleyd's control connection after a failed open: doubles up to max. */
  dynsec_reconnect_base_ms: 1_000,
  dynsec_reconnect_max_ms: 30_000,
  /** Smallest RSA modulus a request's `reply_key` may have: secrets are sealed to it. */
  reply_key_min_bits: 2048,
  /** Retry headroom of the derived spawn budget: this share of the wave's pipeline roles, at least `spawn_budget_retry_min`. */
  spawn_budget_retry_headroom: 0.5,
  spawn_budget_retry_min: 2,
  /** Two review findings in one file at most this many lines apart are on the same hunk. */
  review_hunk_lines: 10,
  /** How often the pipeline re-checks CI on a head whose runs are still pending. */
  ci_poll_ms: 60_000,
  /** How long a head may have no CI run at all before the pipeline asks the owner. */
  ci_none_grace_ms: 900_000,
  /** Bound on the advance rounds one pipeline observation may trigger (a guard, never reached). */
  pipeline_max_advances: 8,
  /** Hard bound on each git / gh call of the pipeline; a timeout is "not verified yet". */
  pipeline_io_ms: 30_000,
  /** How often the screen publisher checks which agents are due a capture. */
  screen_tick_ms: 1_000,
  /** Lines read per screen-tail capture (`cmux read-screen --lines`), before the chrome is cut. */
  screen_capture_lines: 60,
  /** Lines kept in a published screen tail (screen.schema.json maxItems). */
  screen_tail_lines: 40,
  /** Entries an idle agent's worktree walk visits before it gives up (activity-evidence.ts). */
  worktree_scan_max_entries: 2000,
  /** A capture slower than this backs the agent off and marks its screen stale. */
  screen_slow_ms: 2_000,
  /** Hard bound on one screen read; a read still pending then counts as failed (and slow). */
  screen_read_timeout_ms: 5_000,
  /** Consecutive failed captures that back the agent off and mark its screen stale. */
  screen_max_failures: 3,
  /** Capture interval while an agent is backed off. */
  screen_backoff_s: 30,
  /** Consecutive timed-out reads after which an agent's workspace is taken for closed. */
  screen_closed_after_timeouts: 3,
  /** Capture interval of a workspace taken for closed (at most hourly). */
  screen_closed_backoff_s: 3600,
  /** The broker port when the broker URL names none (MQTT's registered port). */
  mqtt_default_port: 1883,
  /** ssh `ConnectTimeout` for every remote command and tunnel (seconds). */
  ssh_connect_timeout_s: 10,
  /** ssh `ServerAliveInterval` for the reverse tunnel (seconds). */
  ssh_alive_interval_s: 15,
  /** Bound on one remote command (`ssh … bash -s`); a hung connection must not stall a spawn. */
  remote_exec_timeout_ms: 120_000,
  /** Bound on one tunnel check (`nc -z` over `bash -s`). */
  tunnel_check_timeout_ms: 15_000,
  /** Wait before restarting a reverse tunnel that exited; doubles per failure up to the max. */
  tunnel_restart_ms: 1_000,
  tunnel_restart_max_ms: 60_000,
  /**
   * How often each forward with an unfinished task on it (queued, parked or running: a running
   * agent's reap waits while its tunnel is down) is re-checked.
   */
  tunnel_check_ms: 10_000,
  /** How long a fresh tunnel ssh may take to bring its forward up before a failed check counts. */
  tunnel_settle_ms: 15_000,
  /** How often an open repo_untrusted decision on a remote host re-reads the box's trust. */
  remote_trust_check_ms: 10_000,
  /** Tail of a tunnel's stderr kept on its journaled exit alarm. */
  alarm_stderr_max_chars: 500,
  /** Session-name suffixes tried when a tmux session name is taken (a relaunch). */
  tmux_session_attempts: 20,
  /** Wall clock ahead of the monotonic clock by more than this between two samples = a wake. */
  wake_jump_ms: 60_000,
  /** How long a model switch waits for the hooks' PostModelSwitch registry re-publish. */
  model_switch_verify_ms: 60_000,
  /** The same recovery fires at most this many times per agent per `recovery_window_ms`. */
  recovery_max_per_window: 2,
  recovery_window_ms: 3_600_000,
  /** Longest agent message quoted in a recovery decision's question. */
  decision_text_max: 300,
  /** Bound on each git / gh call of restart reconciliation. */
  reconcile_probe_ms: 15_000,
  /** How often a Claude account sign-in checks for its URL and `claude auth status`. */
  claude_signin_poll_ms: 2_000,
  /** How long a background Claude sign-in may wait for the browser before it is failed. */
  claude_signin_timeout_ms: 900_000,
  /** Bound on one `claude auth status`. */
  claude_auth_status_timeout_ms: 15_000,
  /** Tries (and the wait between them) for a profile's `.claude.json.lock` during an MCP sync. */
  claude_json_lock_attempts: 50,
  claude_json_lock_wait_ms: 20,
  /** A `.claude.json.lock` older than this was left by a process that died holding it. */
  claude_json_lock_stale_ms: 10_000,
  /** How long an account move waits for the agent to stop before it respawns it. */
  account_move_stop_ms: 60_000,
  // --- Machines + pairing (peers.ts, machines.ts) ---
  /** How long a `peer_invite` pairing code stays valid. */
  peer_code_ttl_s: 600,
  /** Wrong codes tried before every outstanding pairing code is revoked (guessing). */
  peer_join_max_failures: 10,
  /** A paired machine's heartbeat interval: volley-cli's `volley peer run` mirrors it (a test checks). */
  machine_heartbeat_ms: 30_000,
  /** A machine whose record is older than this is down: its tunnel is marked down, spawns park. */
  machine_down_after_ms: 90_000,
} as const;
