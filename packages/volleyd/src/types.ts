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

export type WaveStatus =
  | "running"
  | "paused"
  | "awaiting_decision"
  | "releasing"
  | "complete"
  | "stopped"
  // Retired (archive.ts): published once, then the retained state is cleared.
  | "archived";

/** One pipeline entry as written: a stage, or a group of stages that run in parallel. */
export type PipelineStep = PipelineStage | PipelineStage[];

// ---------------------------------------------------------------------------
// Config (config.schema.json $defs/tunables)
// ---------------------------------------------------------------------------

export interface LeasePoolConfig {
  capacity: number;
  /** The most leases holders on one machine may hold at once (1..capacity); unset: capacity. */
  per_machine?: number;
  /**
   * Per machine name (a `hosts.<name>` key, the supervisor's `fleet.local_name`, or `local`), the
   * cap in place of `per_machine` there (0..capacity). `effective()` resolves `local`.
   */
  per_machine_overrides?: Record<string, number>;
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
  /** A `blocked` agent no decision names (open, or answered for its status) this long is stalled. */
  blocked_undecided_stall_ms: number;
  /** Longest a tool call in flight (PreToolUse, no PostToolUse yet) holds off the silence probe. */
  tool_in_flight_max_s: number;
  /** How long a mailbox steer waits for the hooks' ack before an idle agent is woken (WAKE_TEXT). */
  mailbox_wake_after_ms: number;
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
   * Under `agent_mcp: inherit`, the user's MCP servers that load (by name, copied from the
   * profile's `.claude.json` and the repository's `.mcp.json` into the agent's mcp.json, which
   * then launches strict); empty: every one.
   */
  agent_mcp_allow: string[];
  /**
   * The share of a launched agent's context window at which Claude Code compacts: the launch
   * exports `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as that share of the model's window in tokens
   * (src/claude/context-window.ts); 0 exports nothing (Claude Code's own default).
   */
  agent_auto_compact_pct: number;
  /**
   * What the reviewers flag as public hygiene: `auto` (P1 for a public repository or one whose
   * visibility could not be read, P3 for a private one), `on` (always P1), `off` (never).
   */
  public_hygiene: PublicHygiene;
  hosts: Record<string, RemoteHostConfig>;
  // --- Fleet: fresh base + merge nudge (SPEC §4.6.15) ---
  /** A failed release-branch fetch refuses the spawn (BASE_STALE) instead of cutting from the host's last copy. */
  require_fresh_base: boolean;
  /**
   * A retire also ends the agent's session (its workspace closed, its `claude` process stopped).
   * false: finished sessions stay open for inspection.
   */
  retire_close_session: boolean;
  placement: PlacementConfig;
  /** The supervisor's own machine (SPEC §4.6.15). */
  fleet: FleetConfig;
  /** Decisions volleyd answers itself from its policy table (SPEC §4.6.16), and autopilot merging (SPEC §4.6.17). */
  autopilot: AutopilotConfig;
  // --- Archiving (SPEC §4.6.20) ---
  /** Hours after its `wave_stopped` / `wave_complete` an ended wave is archived; 0: never. */
  archive_ended_after_h: number;
  /** A complete wave is archived as soon as its `wave_complete` decision is answered. */
  archive_on_ack: boolean;
  /**
   * After a rate-limited GitHub answer, the wave's pipeline makes no CI call for this long (or a
   * `Retry-After` in `gh`'s output, if longer; `gh` prints no headers, so rarely).
   */
  ci_rate_limit_backoff_ms: number;
}

/** Who merges a gated PR: volleyd itself (`auto`) or a human (`manual`). */
export type MergeMode = "auto" | "manual";

/**
 * Config `autopilot` (SPEC §4.6.16): whether volleyd answers routine decisions itself, the kinds
 * it never answers, and its remediation budgets (each `*_max` is per wave, per budget key).
 */
export interface AutopilotConfig {
  enabled: boolean;
  /** Decision kinds only the owner answers (`release_go` / `stage_go` arrive with the release train). */
  owner_only: string[];
  /** Relaunches of one `<task>/<role>` after a bad launch. */
  relaunch_max: number;
  /** Extra nudges of one stalled run (`<task>/<role>/<attempt>`). */
  nudge_max: number;
  /** Respawns of one `<task>/<role>`. */
  respawn_max: number;
  /** Re-reviews of one task (a moved head, a stale review at the gate). */
  rereview_max: number;
  /** CI fixups (a ci_failed answered `fixup`) of one task. */
  ci_fixup_max: number;
  /** Agent questions answered for one run. */
  question_max: number;
  /** Automatic account moves of one task's role (agent_account_limit). */
  account_move_max: number;
  /** Multiplier of the derived spawn budget that `raise by <n>` answers may reach. */
  budget_raise_max: number;
  /** How long an answered inbox item stays retained (with `answered`) before it is cleared. */
  inbox_answered_ttl_s: number;
  /** The merge mode for a wave file without `merge:` (SPEC §4.6.17). */
  merge: MergeMode;
  /** Refused autopilot merges at one gated head before a `merge_refused` decision. */
  merge_retry_max: number;
  /** Autopilot merges also delete the PR's head branch (`gh pr merge --delete-branch`). */
  delete_branch: boolean;
  /**
   * How long a wave owned by a coordinator name reads `reconnecting` after the agent bound to
   * the name went away, before `gone` (SPEC §4.6.1).
   */
  reconnect_grace_s: number;
  /**
   * How long a red head classified as an infra incident is held and re-checked before the owner
   * is asked (`ci_failed`, escalated `budget_exhausted`).
   */
  incident_wait_max_s: number;
  /**
   * Flake fixers (synthetic `fix-<slug>` tasks) one wave may add; a request past it escalates the
   * blocked task's `ci_failed` as `budget_exhausted`.
   */
  fix_flake_max: number;
  /** The shortest gap (s) between two digests of one wave with the same trigger. */
  digest_min_interval_s: number;
}

/** How the supervisor's own machine takes auto-placed tasks (config `fleet.local_agents`). */
export type LocalAgentsMode = "always" | "fallback" | "never";

/** Config `fleet`: `local_name` null derives the supervisor's machine name from its host name. */
export interface FleetConfig {
  local_name: string | null;
  /** null: `fallback` when any `hosts.<name>` is configured, else `always` (`effective()` resolves it). */
  local_agents: LocalAgentsMode | null;
  /** The own machine's profile while it is the fallback (no paired machine eligible). */
  fallback: FallbackProfile;
}

/** Config `fleet.fallback`. */
export interface FallbackProfile {
  /** The most supervised agents on the own machine while it is the fallback. */
  max_agents: number;
  /** Per heavy pool, the own machine's slots while it is the fallback; unnamed: 1 (when the pool sets `per_machine`). */
  per_machine: Record<string, number>;
}

/** Who gets a steering nudge when a wave's PR merges (config `placement.nudge_on_merge`). */
export type NudgeOnMerge = "files" | "all" | "off";

/** Config `placement.default`: the placement of a wave file that sets none. */
export type PlacementDefault = "local" | "auto";

/** Automatic placement across machines (config `placement`, SPEC §4.6.15). */
export interface PlacementConfig {
  nudge_on_merge: NudgeOnMerge;
  /**
   * A wave file without `placement:`: `auto` once a paired machine (`hosts.<name>`) is
   * configured, else `local` (wave-file.ts `defaultPlacement`).
   */
  default: PlacementDefault;
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

/** wave-state `github` (SPEC §4.6.1): the repository on GitHub, as `gh repo view` read it. */
export interface GitHubRepo {
  /** `owner/repo` (gh's `nameWithOwner`). */
  slug: string;
  /** The repository's canonical URL (gh's `url`; a GitHub Enterprise host as-is). */
  url: string;
}

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
  /**
   * Added by the supervisor, never by a wave file (journal-only, `issue: 0`): a flake's fixer
   * (SPEC §4.6.16), with the remediation it carries out.
   */
  synthetic?: true;
  remediation?: FixerRemediation;
}

/**
 * A synthetic fixer task's remediation (SPEC §4.6.16): the failing test, its file, the runs it
 * failed in, and the tasks it blocks (`for`, released when the fixer is done). `outcome` once
 * `remediation_closed` is journaled.
 */
export interface FixerRemediation {
  kind: "fix_flake";
  test: string;
  test_file: string | null;
  run_urls: string[];
  for: TaskId[];
  outcome?: "landed" | "failed";
  /** When the fixer was queued (the reducer sets it from its `task_queued`). */
  since?: string;
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
  /** `merge:` as written (SPEC §4.6.17); absent: the `autopilot.merge` tunable. */
  merge?: MergeMode;
  /** `playbook:` as written (SPEC §4.6.19): a path, or `none`; absent: `.volley/release.yaml`. */
  playbook?: string;
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
  /** A release stage's agent (the `_release` pseudo task's; never a wave task's). */
  release?: string;
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
  /** The host the task's agents were spawned on (`agent_spawned`): a plan version never moves it. */
  host_actual?: string;
  /** The host the current plan version writes for the task, while it differs from `host_actual`. */
  host_planned?: string;
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
    /**
     * While held, when the head's jobs could be read (#415): done / total, the running and failed
     * job names, the last job's completion (the first start while none is done) and the slowest
     * job's last duration in an earlier run of the wave.
     */
    jobs?: {
      done: number;
      total: number;
      running: string[];
      failed: string[];
      last_done_at?: string;
      slowest_s?: number;
    };
    /** While held: the estimated seconds left when the hold was journaled; absent: no estimate. */
    eta_s?: number;
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
  /** The task's agent woken for a mailbox message it has not acked yet (`agent_woken`). */
  steer_unacked?: string;
  /** Alarms on the task that still hold (e.g. merged_unverified_head), with a human line each. */
  alarms?: { alarm: string; message: string }[];
  /** A remediation requested for the task's red head that still holds (a flake awaiting its fixer). */
  remediation?: {
    kind: "fix_flake";
    test: string;
    since: string;
    /** A synthetic fixer's: the test's file, its failing runs and the tasks it blocks. */
    test_file?: string | null;
    run_urls?: string[];
    for?: TaskId[];
    outcome?: "landed" | "failed";
  };
  /** A supervisor-added task (a flake's fixer, SPEC §4.6.16): never from the wave file. */
  synthetic?: true;
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
  /**
   * The repository on GitHub as read for this version (SPEC §4.6.1): absent when it could not
   * be read, never derived from `repo` or a remote.
   */
  github?: GitHubRepo;
  /** What autopilot answered and escalated in this wave (SPEC §4.6.16). */
  autopilot?: AutopilotState;
  /** The merge queue in merge order (SPEC §4.6.17); absent while it is empty. */
  merge_queue?: MergeQueueEntry[] | undefined;
  /** The release train (SPEC §4.6.19), from `release_started` on; absent for a wave without one. */
  release?: ReleaseState;
  /** Wave-level alarms that hold (`peer_idle_under_load`, SPEC §4.6.15); absent: none. */
  alarms?: { alarm: string; message: string }[];
  /** When, by whom and why the wave was archived (`volleyd status --all` only). */
  archived?: { at: string; by: string; reason: string };
  updated_at: string;
}

/** wave-state `merge_queue[]` (SPEC §4.6.1, §4.6.17). */
export interface MergeQueueEntry {
  task: TaskId;
  state: "merging" | "updating" | "queued" | "refused";
  /** When the task entered the queue. */
  since: string;
}

/** One release stage's state in the wave state (SPEC §4.6.1, §4.6.19). */
export type ReleaseStageState =
  | "pending"
  | "awaiting_go"
  | "running"
  | "verified"
  | "failed"
  | "skipped";

/** wave-state `release`: the stage running or awaiting its go (else null), and every stage. */
export interface ReleaseState {
  stage: string | null;
  stages: { name: string; state: ReleaseStageState }[];
}

/** wave-state `autopilot` (SPEC §4.6.1, §4.6.16). */
export interface AutopilotState {
  enabled: boolean;
  auto_resolved: number;
  escalated: number;
  /** Each budget key autopilot answered under: answers given (or spawns allowed) and its max. */
  budgets: Record<string, { used: number; max: number }>;
}

/**
 * wave-state `coordinator` (SPEC §4.6.1): the owning coordinator's attention state. For an owner
 * that is a coordinator name, `agent_id` is the agent bound to it, and `reconnecting` means that
 * agent went away less than `autopilot.reconnect_grace_s` ago.
 */
export interface CoordinatorAttention {
  agent_id: string;
  state: "working" | "awaiting_input" | "reconnecting" | "gone";
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
  // An ended wave retired (archive.ts): its open decisions closed, out of the live set.
  "wave_archived",
  "owner_claimed",
  "owner_reconnected",
  "task_queued",
  "task_admitted",
  "task_cancelled",
  "agent_spawned",
  "agent_registered",
  "agent_retired",
  "agent_session_closed",
  "spawn_failed",
  "spawn_recovered",
  // A launch whose outcome was unknown (spawn.ts reconcileLaunch): its agent registered and was
  // adopted; its workspace held no agent and was closed; or it could not be decided, so the
  // attempt's identity is never reused.
  "spawn_adopted",
  "launch_orphan_closed",
  "spawn_identity_burned",
  "verify_failed",
  "stage_entered",
  "artifact_verified",
  "steering_sent",
  // A steer to a task with no live agent: held for its next agent (or role), or dropped with it.
  "steering_queued",
  "steering_dropped",
  "steering_received",
  "agent_woken",
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
  // Account balancing (claude/usage.ts rankAccounts): the account a spawn runs under and why.
  "account_chosen",
  // Pipeline / lifecycle round 2: relaunches, CI holds, PR heads moved at a gate, merges outside
  // GitHub's merge button, agents retired without their ack, alarms that no longer hold.
  "relaunched",
  "ci_pending",
  "ci_green",
  "pr_head_moved",
  "merged_by_operator",
  // A PR GitHub reports CONFLICTING (no CI will run on it): its branch-update step starts.
  "pr_conflicting",
  // Autopilot merging (SPEC §4.6.17): volleyd merged a gated PR at its gated head.
  "merged_by_supervisor",
  // The merge queue (SPEC §4.6.17): a gated task entered or left it; volleyd's merge of it began,
  // or ended without an outcome (timed out, failed to run, interrupted by a restart).
  "merge_queued",
  "merge_dequeued",
  "merge_started",
  "merge_ended",
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
  // Autopilot (SPEC §4.6.16): a decision answered from the policy table, or left for the owner.
  "decision_auto_resolved",
  "decision_escalated",
  // Held decisions (#335): one waits on a task, PR or issue, never escalated; released when it lands.
  "decision_held",
  "decision_released",
  // The release train (SPEC §4.6.19): a settled wave whose repo has a playbook starts releasing;
  // each stage is entered, then verified or failed; the owner's `release_go` go completes it.
  "release_started",
  "release_stage_entered",
  "release_stage_verified",
  "release_stage_failed",
  "release_stage_skipped",
  "release_cancelled",
  "release_done",
  // The needs-you inbox (SPEC §4.6.18): an item opened, and the answer its referee accepted.
  "inbox_opened",
  "inbox_answered",
  // Self-healing CI (SPEC §4.6.16): a remediation for a classified red head (a flake's fixer).
  "remediation_requested",
  "remediation_closed",
  // The morning digest (SPEC §4.6.16): published retained, with its one push.
  "digest_published",
  // The terminal-status watchdog (#414): a dropped done / failed handed over again.
  "terminal_status_recovered",
  // A draft PR marked ready before the CI gate (SPEC §4.6.8): its full CI runs from `at` (#408).
  "pr_marked_ready",
  // A wave's issue lifecycle (#416, SPEC §4.6.19): what volleyd did to a task's issue, so a
  // restart never does it twice; `issues_verified` once the release reached main.
  "issue_labeled",
  "issue_unlabeled",
  "issue_commented",
  "issue_closed",
  "issues_verified",
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
