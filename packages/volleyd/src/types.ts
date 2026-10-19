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
  /** Claude account profiles (src/claude/): which account an agent runs under by default. */
  claude: { default_account: string | null };
  hosts: Record<string, RemoteHostConfig>;
}

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
  /** Where the task's agents run: `local` (the default) or a remote host's name. */
  host: string;
  /** An inline remote `host:` (layered over config `hosts.<host>`). */
  host_spec?: RemoteHostConfig & { type: "ssh"; name?: string };
  files: string[];
  /** `account:` as written on the task (a Claude account id); absent: the wave's. */
  account?: string;
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
  /** Set while the screen capture of one of the task's agents is backed off (screen-publisher.ts). */
  screen_stale?: boolean;
  pr?: {
    number: number;
    url: string;
    head_sha?: string;
    ci?: "green" | "red" | "running" | "none";
  };
  evidence_path?: string;
  /** The task's latest spawn failure, while it is not recovered (`spawn_failed`). */
  last_error?: { code: string; message: string; at: string };
  /** How many spawn attempts in a row have failed (with `last_error`). */
  attempt?: number;
  /** When the next automatic retry runs; null once `spawn_retry_max` stopped them. */
  next_retry_at?: string | null;
  /** Gated without reviews because its wave-file pipeline lists no review stage. */
  reviews_skipped_by_plan?: boolean;
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
