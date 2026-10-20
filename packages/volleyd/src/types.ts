/**
 * Shared types for volleyd. Shapes that cross the wire mirror the T1 schemas in
 * `spec/schemas/` (wave-state, wave-event, config); the wave-file shapes are the
 * normalised output of `wave-file.ts`.
 */

export type TaskId = string;
export type WaveId = string;

/** Pipeline stage names a wave file may list (wave-file.schema.json $defs/stageName). */
export type PipelineStage =
  | "implement"
  | "spec_review"
  | "quality_review"
  | "fixup"
  | "merge_ready";

/** Task stage in the wave state (wave-state.schema.json $defs/stage). */
export type TaskStage =
  | "queued"
  | PipelineStage
  | "done"
  | "blocked"
  | "awaiting_decision"
  | "cancelled";

export type WaveStatus = "running" | "paused" | "awaiting_decision" | "complete" | "stopped";

/** One pipeline entry as written: a stage, or a group of stages that run in parallel. */
export type PipelineStep = PipelineStage | PipelineStage[];

// ---------------------------------------------------------------------------
// Config (config.schema.json $defs/tunables)
// ---------------------------------------------------------------------------

export interface LeasePoolConfig {
  capacity: number;
  /** The most leases holders on one machine may hold at once (1..capacity); unset: capacity. */
  per_machine?: number;
  ttl_s?: number;
  match?: string[];
}

export interface AdmissionConfig {
  memory_pressure_max_level: number;
  cmux_ping_max_ms: number;
  container_max: number;
  api_overload_window_s: number;
  api_overload_max: number;
  ci_queue_max: number;
  hysteresis_samples: number;
}

/** One SSH + tmux host (config `hosts.<name>`, or a wave task's inline `host:`). */
export interface RemoteHostConfig {
  type?: "ssh";
  /** ssh destination, `[user@]host`. */
  target?: string;
  /** The wave repo's clone on the remote machine (absolute). */
  repo?: string;
  worktree_root?: string;
  /** The volley checkout on the remote machine (its volley-hooks is `$VOLLEY_HOOKS_DIR`). */
  volley_dir?: string;
  tunnel?: { remote_port?: number; supervise?: boolean };
  /** The most supervised agents the host runs at once (default 4, SPEC §4.6.15). */
  max_agents?: number;
  /** true: no new placements on the host; its running agents finish. */
  drain?: boolean;
}

/** Every runtime tunable, fully populated (what `ConfigStore.effective()` returns). */
export interface Tunables {
  hard_ceiling: number;
  spawn_budget_multiplier: number;
  lease_pools: Record<string, LeasePoolConfig>;
  admission: AdmissionConfig;
  claim_after_s: number;
  heartbeat_alarm_s: number;
  idle_grace_s: number;
  /** Longest idle (from its start) that any own-work evidence (`background_wait`, lease, shells, worktree writes) holds off the nudge. */
  background_wait_max_s: number;
  /** Cap on the doubling gap between `agent_stalled` decisions of one idle cycle. */
  stall_backoff_max_s: number;
  fallback_model: string | null;
  mailbox: { session_expiry_s: number };
  worktree_root: string;
  spawn_timeout_s: number;
  /** Cap on the automatic retry delay of a failed spawn (it doubles from 30 s). */
  spawn_retry_max_s: number;
  /** Failed spawn attempts in a row after which automatic retries stop. */
  spawn_retry_max: number;
  /** Largest brief preface accepted (bytes); a larger one refuses the wave or the spawn. */
  brief_preface_max_bytes: number;
  wake_grace_s: number;
  screen_tail_interval_s: number;
  /** After `volleyd stop`, how long agents get to publish a terminal status before they are force-retired. */
  stop_grace_s: number;
  /** Window collecting broker login changes into one Dynamic Security control message. */
  dynsec_batch_ms: number;
  /** Seconds between credential sweeps (credential-sweep.ts). */
  credential_sweep_interval_s: number;
  /** Claude account profiles (src/claude/): the default account, and the 5-hour usage warning. */
  claude: { default_account: string | null; warn_at_pct: number };
  /**
   * How the pipeline's rebase step brings a PR branch up to date with the moved release branch:
   * `rebase` (rebase, then a lease-guarded force-push) or `merge` (merge it in, a normal push).
   */
  branch_update: BranchUpdate;
  /**
   * The MCP servers a launched agent loads: `strict` only volleyd's `volley` server; `inherit`
   * the user's own servers (plugins, connectors) too, with volleyd's `volley` taking that name.
   */
  agent_mcp: AgentMcp;
  /**
   * What the reviewers flag as public hygiene: `auto` (P1 for a public repository or one whose
   * visibility could not be read, P3 for a private one), `on` (always P1), `off` (never).
   */
  public_hygiene: PublicHygiene;
  hosts: Record<string, RemoteHostConfig>;
  // --- Fleet: fresh base + merge nudge (SPEC §4.6.15) ---
  /** A failed release-branch fetch refuses the spawn (BASE_STALE) instead of cutting from the host's last copy. */
  require_fresh_base: boolean;
  placement: PlacementConfig;
  /** The supervisor's own machine (SPEC §4.6.15). */
  fleet: FleetConfig;
}

/** Config `fleet`: `local_name` null derives the supervisor's machine name from its host name. */
export interface FleetConfig {
  local_name: string | null;
}

/** Who gets a steering nudge when a wave's PR merges (config `placement.nudge_on_merge`). */
export type NudgeOnMerge = "files" | "all" | "off";

/** Automatic placement across machines (config `placement`, SPEC §4.6.15). */
export interface PlacementConfig {
  nudge_on_merge: NudgeOnMerge;
  // --- Fleet: placement engine (placement.ts) ---
  /** A machine whose load per core (the higher of the 1- and 5-minute) is above this takes no new placement. */
  load_per_core_max: number;
  /** A machine with less available memory (percent) takes no new placement. */
  mem_available_min_pct: number;
  /** A machine with less free disk (GB) takes no new placement. */
  disk_free_min_gb: number;
  /** Relative weights of each headroom in a candidate's score (renormalised over the known ones). */
  weights: { cpu: number; slots: number; mem: number; usage: number };
  // --- Fleet: a machine that stays down ---
  /** Seconds a machine with unfinished tasks stays down before its `machine_down` decision opens. */
  down_decision_after_s: number;
}

export type BranchUpdate = "rebase" | "merge";
export type AgentMcp = "strict" | "inherit";
export type PublicHygiene = "auto" | "on" | "off";
/** `gh repo view --json visibility`, lowercased; `unknown` when it could not be read. */
export type RepoVisibility = "public" | "private" | "internal" | "unknown";

/**
 * How the reviewers treat public hygiene: `p1` (every hit blocks the merge, the result's
 * `hygiene` block is required), `p3` (hits are non-blocking notes, the block optional) or `off`.
 */
export type HygieneLevel = "p1" | "p3" | "off";

/** A partial tunables object: a wave file's `config:` block, a config_set patch, a config.yaml. */
export type TunablesPatch = {
  [K in keyof Tunables]?: Tunables[K] extends string | number | null
    ? Tunables[K]
    : Partial<Tunables[K]>;
};

/** The retained `volley/_waves/_config` payload (config.schema.json). */
export interface ConfigPayload extends Tunables {
  version: number;
  updated_at: string;
  updated_by: string;
}

// ---------------------------------------------------------------------------
// Wave file (wave-file.schema.json), normalised
// ---------------------------------------------------------------------------

export interface WaveTask {
  id: TaskId;
  issue: number;
  title?: string;
  after: TaskId[];
  /** The task's pipeline (its own, else the wave's) as stage groups; a group runs in parallel. */
  stages: PipelineStage[][];
  /** The task's pipeline as written (its own, else the wave's). */
  pipeline: PipelineStep[];
  model: string;
  /**
   * Where the task's agents run: `local` (the default), a remote host's name, or `auto` until
   * placement chooses (the reducer's `task_placed` then sets the chosen one).
   */
  host: string;
  /** An inline remote `host:` (layered over config `hosts.<host>`). */
  host_spec?: RemoteHostConfig & { type: "ssh"; name?: string };
  files: string[];
  /** `account:` as written on the task (a Claude account id); absent: the wave's. */
  account?: string;
  /** `heavy: true`: placement needs a free per-machine slot in each of the wave's `heavy_pools`. */
  heavy?: boolean;
}

export interface Wave {
  wave: WaveId;
  version: number;
  repo: string;
  release_branch: string;
  model: string;
  namespace?: string;
  pipeline: PipelineStep[];
  stages: PipelineStage[][];
  /** Tasks in file order. */
  tasks: Record<TaskId, WaveTask>;
  task_order: TaskId[];
  heavy_pools: string[];
  spawn_budget?: number;
  config: TunablesPatch;
  /** `brief_preface:` as written (relative to `repo`, or absolute); absent: the default file. */
  brief_preface?: string;
  /** `account:` as written (a Claude account id); absent: `claude.default_account`. */
  account?: string;
  /** `placement: auto` (absent: `local`): unpinned tasks are placed across machines (placement.ts). */
  placement?: "auto";
  /** Machines placement ranks first, and uses only when nothing else is eligible. */
  placement_prefer?: string[];
  placement_avoid?: string[];
}

// ---------------------------------------------------------------------------
// Wave state (wave-state.schema.json payload)
// ---------------------------------------------------------------------------

export interface TaskAgents {
  implementer?: string;
  spec_reviewer?: string;
  quality_reviewer?: string;
  fixup?: string;
  /** The pipeline's rebase agent, when the release branch moved before the gate. */
  rebase?: string;
}

export interface TaskState {
  id: TaskId;
  issue: number;
  stage: TaskStage;
  agents: TaskAgents;
  waiting_on?: string[];
  why_waiting?: string;
  /** The remote host the task's agents run on (absent for `local`). */
  host?: string;
  /** Why the task's host, a paired machine, is down (machines.ts); absent while it is up. */
  host_down?: string;
  /** Set while the screen capture of one of the task's agents is backed off (screen-publisher.ts). */
  screen_stale?: boolean;
  pr?: {
    number: number;
    url: string;
    head_sha?: string;
    ci?: "green" | "red" | "running" | "none";
    /** While the pipeline holds for CI on `head_sha`: its runs completed / all of them. */
    checks?: { done: number; total: number };
  };
  /** While a parallel stage group runs: its label (`review (spec + quality)`); `stage` stays the enum. */
  stage_label?: string;
  /** While a parallel stage group runs: each role, its agent and how far it is. */
  stage_group?: {
    role: string;
    agent_id?: string;
    state: "pending" | "running" | "done" | "retired";
  }[];
  /** Steers held for the task's next agent (none live when they were sent); absent when 0. */
  queued_steers?: number;
  /** Alarms on the task that still hold (e.g. merged_unverified_head), with a human line each. */
  alarms?: { alarm: string; message: string }[];
  evidence_path?: string;
  /** The task's latest spawn failure, while it is not recovered (`spawn_failed`). */
  last_error?: { code: string; message: string; at: string };
  /** How many spawn attempts in a row have failed (with `last_error`). */
  attempt?: number;
  /** When the next automatic retry runs; null once `spawn_retry_max` stopped them. */
  next_retry_at?: string | null;
  /** Gated without reviews because its wave-file pipeline lists no review stage. */
  reviews_skipped_by_plan?: boolean;
  /** The release-branch commit the task's current worktree was cut from (`agent_spawned`). */
  base_sha?: string;
  /** Where the task was placed and why (`task_placed`, placement.ts); absent until placed. */
  placement?: TaskPlacement;
}

/** wave-state `tasks[].placement` (SPEC §4.6.15). */
export interface TaskPlacement {
  /** A machine name: the supervisor's own under its `fleet.local_name`. */
  host: string;
  by: "auto" | "wave_file" | "decision";
  score: number | null;
  decided_at: string;
  candidates: { host: string; score: number | null; line: string }[];
}

export interface WaveSpec {
  version: number;
  release_branch?: string;
  model?: string;
  pipeline?: PipelineStep[];
  tasks: Record<TaskId, { issue: number; title?: string; after: TaskId[] }>;
}

export interface WaveState {
  wave: WaveId;
  version: number;
  owner: string | null;
  repo: string;
  release_branch: string;
  status: WaveStatus;
  tasks: TaskState[];
  open_decisions: string[];
  gates: TaskId[];
  spec?: WaveSpec;
  /** The owner's attention state, maintained by the daemon (not journaled). */
  coordinator?: CoordinatorAttention;
  effective_config?: TunablesPatch;
  /** The brief preface the current plan version's agents get (null: none). */
  brief_preface?: { path: string; sha256: string; bytes: number } | null;
  /** The repository's visibility as journaled for this version (null: set by config, not read). */
  repo_visibility?: RepoVisibility | null;
  /** How the reviewers treat public hygiene for this version (reviews.ts hygieneLevel). */
  hygiene_level?: HygieneLevel;
  updated_at: string;
}

/** wave-state `coordinator` (SPEC §4.6.1): the owning coordinator's attention state. */
export interface CoordinatorAttention {
  agent_id: string;
  state: "working" | "awaiting_input" | "gone";
  question?: string;
  session_url?: string;
  workspace?: string;
  last_seen: string;
}

// ---------------------------------------------------------------------------
// Journal (wave-event.schema.json payload + type)
// ---------------------------------------------------------------------------

/** The closed wave-event type enum (wave-event.schema.json). */
export const WAVE_EVENT_TYPES = [
  "wave_submitted",
  "wave_versioned",
  "wave_paused",
  "wave_resumed",
  "wave_stopped",
  "wave_complete",
  "owner_claimed",
  "task_queued",
  "task_admitted",
  "task_cancelled",
  "agent_spawned",
  "agent_registered",
  "agent_retired",
  "spawn_failed",
  "spawn_recovered",
  "verify_failed",
  "stage_entered",
  "artifact_verified",
  "steering_sent",
  // A steer to a task with no live agent: held for its next agent (or role), or dropped with it.
  "steering_queued",
  "steering_dropped",
  "decision_opened",
  "decision_resolved",
  "lease_requested",
  "lease_granted",
  "lease_released",
  "lease_expired",
  "alarm_raised",
  "wake_detected",
  "reap_suppressed",
  "reconciled",
  "config_changed",
  // Account management over the control channel (accounts.ts), in the `_system` journal.
  "account_created",
  "account_rotated",
  "account_revoked",
  "signin_link_issued",
  "token_redeemed",
  // The setup ops (setup-ops.ts): a step applied for the Desk, a one-time admin token issued, the
  // shared desk login's new password issued.
  "setup_step_applied",
  "admin_token_issued",
  "desk_password_issued",
  // Claude account profiles (src/claude/): the registry and sign-ins in `_system`; a move in its wave.
  "claude_account_added",
  "claude_signin_started",
  "claude_signin_done",
  "claude_signin_failed",
  "claude_profile_synced",
  "agent_account_moved",
  // Pipeline / lifecycle round 2: relaunches, CI holds, PR heads moved at a gate, merges outside
  // GitHub's merge button, agents retired without their ack, alarms that no longer hold.
  "relaunched",
  "ci_pending",
  "ci_green",
  "pr_head_moved",
  "merged_by_operator",
  "agent_force_retired",
  "alarm_cleared",
  // Usage metering (claude/usage.ts): an answered account_limit decision moved the wave.
  "wave_account_moved",
  // Broker logins on Dynamic Security (retire.ts, credential-sweep.ts).
  "agent_reaped_by_supervisor",
  "credentials_revoked",
  "credentials_swept",
  // Machines + pairing (peers.ts), in the `_system` journal.
  "peer_invited",
  "peer_joined",
  "peer_removed",
  // Fleet (SPEC §4.6.15): a running implementer told that a sibling PR merged (pipeline.ts).
  "merge_nudge_sent",
  // Fleet (SPEC §4.6.15): where a task starts and why (placement.ts).
  "task_placed",
  // Fleet (SPEC §4.6.15): a machine's readiness verdict changed, in the `_system` journal.
  "machine_readiness_changed",
  // Fleet (SPEC §4.6.14): an admin's `peer_doctor` ran on a paired machine, in `_system`.
  "peer_doctor_run",
  // Fleet (SPEC §4.6.14): `peer_remove { drain | now }` started; `peer_removed` follows later.
  "peer_drain_started",
  // Public hygiene (reviews.ts): the repository's visibility, read once per wave version.
  "repo_visibility_detected",
] as const;

export type WaveEventType = (typeof WAVE_EVENT_TYPES)[number];

/** One journal line. `seq` is monotonic per wave journal. */
export interface JournalEvent {
  seq: number;
  at: string;
  type: WaveEventType;
  task?: TaskId;
  data: Record<string, unknown>;
}

/** An event before the journal assigns `seq` and `at`. */
export type NewEvent = Omit<JournalEvent, "seq" | "at"> & { at?: string };

/** The pseudo-wave that journals global (non-wave) events such as config_changed. */
export const SYSTEM_WAVE = "_system";
