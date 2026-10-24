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
  heartbeat_alarm_s: 600,
  idle_grace_s: 180,
  background_wait_max_s: 7200,
  stall_backoff_max_s: 1800,
  blocked_undecided_stall_ms: 300_000,
  tool_in_flight_max_s: 7200,
  mailbox_wake_after_ms: 20_000,
  fallback_model: null,
  mailbox: { session_expiry_s: 604800 },
  worktree_root: "~/.volley/worktrees",
  spawn_timeout_s: 120,
  spawn_retry_max_s: 900,
  spawn_retry_max: 8,
  brief_preface_max_bytes: 16384,
  wake_grace_s: 120,
  screen_tail_interval_s: 5,
  tmux_cols: 220,
  tmux_rows: 50,
  stop_grace_s: 30,
  dynsec_batch_ms: 50,
  credential_sweep_interval_s: 600,
  claude: { default_account: null, warn_at_pct: 90 },
  branch_update: "rebase",
  agent_mcp: "strict",
  agent_mcp_allow: [],
  agent_auto_compact_pct: 85,
  public_hygiene: "auto",
  hosts: {},
  repos: {},
  // --- Fleet: fresh base + merge nudge (SPEC §4.6.15) ---
  require_fresh_base: true,
  retire_close_session: true,
  placement: {
    nudge_on_merge: "files",
    // a wave file without placement: (wave-file.ts defaultPlacement)
    default: "auto",
    // --- Fleet: placement engine (placement.ts, SPEC §4.6.15) ---
    load_per_core_max: 1.5,
    mem_available_min_pct: 10,
    disk_free_min_gb: 5,
    weights: { cpu: 40, slots: 30, mem: 15, usage: 15 },
    // --- Fleet: a machine that stays down (SPEC §4.6.15) ---
    down_decision_after_s: 300,
  },
  // --- Fleet: the supervisor's own machine (SPEC §4.6.15); null: derived from the host name ---
  // local_agents null: fallback once any hosts.<name> is configured, else always.
  // local_terminal null: cmux on macOS when cmux is installed, else tmux (read at volleyd start).
  fleet: {
    local_name: null,
    local_agents: null,
    local_terminal: null,
    fallback: { max_agents: 3, per_machine: {} },
    repo_root: "~/.volley/repos",
  },
  // --- Autopilot: decisions volleyd answers itself (SPEC §4.6.16); merging (SPEC §4.6.17) ---
  autopilot: {
    enabled: true,
    owner_only: ["plan_change", "repo_untrusted", "model_switch", "release_go", "stage_go"],
    relaunch_max: 1,
    nudge_max: 1,
    respawn_max: 1,
    rereview_max: 2,
    ci_fixup_max: 2,
    question_max: 1,
    account_move_max: 2,
    budget_raise_max: 2,
    inbox_answered_ttl_s: 600,
    merge: "auto",
    merge_retry_max: 2,
    merge_transient_backoff_s: [60, 120, 300, 600],
    merge_transient_retry_max: 1,
    delete_branch: false,
    reconnect_grace_s: 900,
    incident_wait_max_s: 14_400,
    fix_flake_max: 3,
    digest_min_interval_s: 1800,
    merge_train: true,
  },
  // --- Archiving (SPEC §4.6.20) ---
  archive_ended_after_h: 24,
  archive_on_ack: true,
  ci_rate_limit_backoff_ms: 300_000,
};

/**
 * The defaults a daemon starts from: CONFIG_DEFAULTS, with `worktree_root` and
 * `fleet.repo_root` under `$VOLLEYD_HOME/worktrees` and `$VOLLEYD_HOME/repos` when VOLLEYD_HOME
 * is set (a second, smoke daemon keeps its worktrees and clones beside its state). config.yaml
 * and per-wave `config:` still override them.
 */
export function defaultsFor(env: { VOLLEYD_HOME?: string | undefined }): Tunables {
  const home = env.VOLLEYD_HOME;
  return home === undefined || home === ""
    ? CONFIG_DEFAULTS
    : {
        ...CONFIG_DEFAULTS,
        worktree_root: join(home, "worktrees"),
        fleet: { ...CONFIG_DEFAULTS.fleet, repo_root: join(home, "repos") },
      };
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
  /** `hosts.<name>.max_agents` unset: the supervised agents a peer runs at once (SPEC §4.6.15). */
  max_agents: 4,
  /** `hosts.<name>.drain` unset: the host takes placements. */
  drain: false,
} as const;

/**
 * The model a wave Volley writes for you runs (`model:`): `volley setup`'s test wave, and the one
 * the /volley-issues skill and the READMEs cite. Not a runtime tunable: every wave file names its
 * own model.
 */
export const DEFAULT_MODEL = "claude-opus-5-5";

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
  /** Entries the retained `volley/_waves/_archive` index keeps (newest first). */
  archive_index_max: 200,
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
  /** Bound on one `cmux new-workspace`: a launch still pending then has an unknown outcome. */
  launch_timeout_ms: 60_000,
  /** After a launch with an unknown outcome: how long to wait for the agent's registration
   * signals before deciding it never started (spawn.ts reconcileLaunch). */
  launch_reconcile_ms: 30_000,
  /** Bound on one workspace lookup (`cmux list-workspaces`); a lookup still pending then fails. */
  workspace_lookup_timeout_ms: 10_000,
  /** How long a spawn's (or `run`'s) `git fetch origin <release branch>` may take before it is
   * treated as failed (an ssh remote with no agent, a credential prompt). */
  git_fetch_timeout_ms: 30_000,
  /** After a fetch that lost a ref-lock race (another git process updating the same ref): how
   * long to wait before its one retry (git-lock.ts lockedFetch). */
  git_fetch_race_retry_ms: 500,
  /** Read-modify-write attempts on `~/.claude.json` while Claude Code keeps rewriting it. */
  trust_write_attempts: 5,
  /** How long `steer` waits for the recipient's `steering_acked` before reporting `delivered`. */
  steer_wait_ack_ms: 30_000,
  /** A burst of `terminal_resize` requests for one agent within this long is one resize (#403). */
  terminal_resize_coalesce_ms: 150,
  /** Upper bound on a caller's `wait_ack_ms`, so a steer cannot park a waiter indefinitely. */
  steer_wait_ack_max_ms: 300_000,
  /** How long the daemon waits for one `gh issue view` (issue Files sections, at submit). */
  issue_fetch_ms: 15_000,
  /** How long the footprint resolver waits for `git ls-tree -r -l --full-tree <ref>`. */
  tree_read_ms: 15_000,
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
  /** The smallest `raise by <n>` a spawn_budget_exhausted decision offers: this share of the derived budget. */
  spawn_budget_raise_min_share: 0.25,
  /** Two review findings in one file at most this many lines apart are on the same hunk. */
  review_hunk_lines: 10,
  /** How often the pipeline re-checks CI on a head whose runs are still pending. */
  ci_poll_ms: 60_000,
  /**
   * How often a complete wave looks for its release branch's merged PR (the release reaching
   * main), until its task issues are verified (autopilot/issues.ts); a failed issue write is
   * retried after `ci_poll_ms`.
   */
  release_merge_poll_ms: 300_000,
  /** How long a head may have no CI run at all before the pipeline asks the owner. */
  ci_none_grace_ms: 900_000,
  /**
   * Clock skew allowed between volleyd and GitHub when a run's `createdAt` is compared with a
   * draft's ready mark (#408): a run created up to this long before the mark counts as after it.
   */
  ready_skew_ms: 30_000,
  /** Failed checks in a row after which the merge turn's holder passes the turn on (SPEC §4.6.17). */
  merge_turn_check_failures_max: 3,
  /** Bound on the advance rounds one pipeline observation may trigger (a guard, never reached). */
  pipeline_max_advances: 8,
  /** A blocked agent's reason is clipped to this many characters in its decision's question. */
  blocked_reason_max_chars: 500,
  /** A terminal status (done / blocked / failed) nothing in the journal names for this long alarms. */
  terminal_unjournaled_alarm_ms: 60_000,
  /** After that alarm, a done / failed still unhandled this long is handed over again (#414). */
  terminal_recover_ms: 60_000,
  /** The tail of a red head's failed-run logs kept on its ci_failed decision (a CI fixup's directive). */
  ci_log_max_chars: 4_000,
  /** Hard bound on each git / gh call of the pipeline; a timeout is "not verified yet". */
  pipeline_io_ms: 30_000,
  /** Hard bound on one read of GitHub's status page (a red head's classification). */
  status_page_timeout_ms: 5_000,
  /** How long one read of GitHub's status page is reused. */
  status_page_cache_ms: 60_000,
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
  /** Hard bound on one `cmux close-workspace` (a retire's, or cleanup's). */
  workspace_close_timeout_ms: 15_000,
  /** Between SIGTERM and SIGKILL when volleyd stops a retired agent's process (procs.ts). */
  proc_kill_grace_ms: 5_000,
  /** Hard bound on the `ps` that lists processes (procs.ts). */
  ps_timeout_ms: 10_000,
  /** Hard bound on one screen read; a read still pending then counts as failed (and slow). */
  screen_read_timeout_ms: 5_000,
  /**
   * A multi-select picker answered from the inbox: screen reads (this many, this far apart) that
   * wait for the review screen its Submit opens (autopilot/carry.ts).
   */
  picker_review_reads: 5,
  picker_review_gap_ms: 200,
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
  /** The broker's WebSocket listener (the Desk page's), as `volley setup` configures it. */
  ws_default_port: 9001,
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
  /** A login is primed (`claude_prime`: identity, plan, usage probe) at most once in this long. */
  claude_prime_interval_ms: 300_000,
  /**
   * How long a paired machine's sign-in forward (`ssh -N -L`) must stay up before it counts as
   * up: an ssh that exits sooner (the local port is taken) leaves the sign-in without one.
   */
  signin_forward_settle_ms: 3_000,
  /** How long a pasted sign-in code or redirect waits for the sign-in to end before it is read
   * as rejected (`claude_signin_entry`). */
  signin_entry_wait_ms: 30_000,
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
  // --- Fleet: readiness (readiness.ts), the supervisor's own record, peer_doctor ---
  /** The readiness PATH probe (`command -v claude bun` over ssh) runs at most this often per host. */
  path_probe_interval_ms: 300_000,
  /** Bound on one PATH probe. */
  path_probe_timeout_ms: 15_000,
  /** Bound on the supervisor's own doctor run (`volley peer doctor --json`, every heartbeat). */
  local_doctor_timeout_ms: 120_000,
  /** Bound on a `peer_doctor` run on a box (a `--fix` may check out and install volley there). */
  peer_doctor_timeout_ms: 900_000,
  /** Bound on `volley peer retarget` on a box (`peer_retarget`): it waits up to 30 s for its tunnel. */
  peer_retarget_timeout_ms: 90_000,
  /** How long `peer_retarget` waits for the box's record to come `up` through the new tunnel. */
  peer_retarget_grace_ms: 120_000,
  // --- Machine roles (roles/, SPEC §4.6.24) ---
  /**
   * How long a finished role move (its log, record and what it replaced) is kept for a
   * `role_rollback`: 7 days, fixed by the SPEC (no tunable). The supervisor's next start after
   * that removes it.
   */
  role_move_retention_ms: 7 * 86_400_000,
  /** A role move's health check: how many times it is tried, and how long apart. */
  role_health_attempts: 6,
  role_health_wait_ms: 5_000,
  /** Bound on one step of a role move run over ssh (a Desk install builds the Desk). */
  role_step_timeout_ms: 600_000,
  /** How long a Desk move's sign-in link for the new address stays valid. */
  role_signin_ttl_s: 3_600,
  /** Bound on a supervisor move's ssh-back probe from its target to one other machine. */
  role_ssh_probe_timeout_s: 10,
  /**
   * A broker move to a root-owned install: how long its receive step waits for the owner's
   * `sudo volley broker receive` on the target (polled every `role_health_wait_ms`).
   */
  role_broker_receive_wait_ms: 1_800_000,
  /**
   * A broker move (and its rollback) is answered before its first step stops the broker the
   * answer travels through: the move starts this long after the answer.
   */
  role_broker_reply_ms: 1_000,
  // --- Fleet: merge nudge (overlap.ts) ---
  /** Touched files a merge nudge names before "and N more" (`merge_nudge_sent` keeps them all). */
  nudge_files_shown: 5,
  // --- Overlap-aware waves: the planner (overlap-plan.ts) and the merge train ---
  /** Issues one collapsed task bundles at most: past it the bundle's PR is too big to review. */
  plan_bundle_issues_max: 4,
  /** Footprint files one collapsed task covers at most, for the same reason. */
  plan_bundle_files_max: 16,
  /** Two tasks sharing at least this share of their footprints are strongly coupled (collapse or chain). */
  plan_coupling_strong: 0.5,
  /** A cluster's tasks in flight at once under `cap`: more only churn on its hot files. */
  plan_cluster_in_flight_max: 4,
  /** Weight of a shared doc file (`*.md`, `docs/`) against a code file: docs merge cleanly more often. */
  plan_doc_weight: 0.2,
  /** Gated PRs one merge train carries at most (`autopilot.merge_train`): a red train bisects them. */
  train_size_max: 4,
  /** Churn spawns a task may have, as a multiple of its pipeline roles, before `churn_exhausted`. */
  churn_roles_multiple_max: 3,
  // --- Overlap-aware waves: the churn monitor (autopilot/churn.ts) ---
  /**
   * A cluster changes strategy (`cluster_strategy_changed`) at most this often: a cluster flapping
   * between hold and planned would admit and hold the same members every few ticks.
   */
  cluster_strategy_min_interval_ms: 1_800_000,
  /** The window merges and branch updates are counted over (`merges_in_window`, `updates_in_window`). */
  churn_window_ms: 7_200_000,
  /** Branch updates of one live member that put its cluster on hold: each one re-runs its reviews. */
  churn_updates_hold: 2,
  /** Gated members that, merging slower than `churn_merges_floor` per window, put a cluster on hold. */
  churn_gated_hold: 3,
  /** Merges per window below which a cluster with `churn_gated_hold` gated members is churning. */
  churn_merges_floor: 2,
  /** Gated members that make a cluster a train (the merge queue forms one under `autopilot.merge_train`). */
  churn_gated_train: 2,
} as const;
