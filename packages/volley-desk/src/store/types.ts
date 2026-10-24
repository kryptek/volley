/**
 * Types for the Desk store. Payload types mirror the T1 JSON schemas in
 * `spec/schemas/` (SPEC §3, §4.3, §4.6); they are read-side views, so every
 * open-ended schema keeps an index signature for forward-compatible extras
 * (SPEC §3.3).
 */

import type { MachineSample } from "./machineHistory";

/** SPEC §3 envelope. */
export interface Envelope {
  schema_version: string;
  agent_id: string;
  channel: string;
  type: string;
  wall_time?: string;
  parent_id?: string | null;
  namespace?: string;
  payload?: unknown;
  correlation_id?: string | null;
  [key: string]: unknown;
}

/**
 * One MQTT delivery. `envelope: null` is a cleared retained topic (zero-length
 * payload, SPEC §4.6); `receivedAt` is the local receipt time in ms.
 * `retained` is set for the broker's replay of a retained topic (on subscribe
 * or reconnect), as opposed to a live publish.
 */
export interface DeskMessage {
  topic: string;
  envelope: Envelope | null;
  receivedAt: number;
  retained?: boolean;
}

// ------------------------------------------------------------- agent topics

/** registry.schema.json payload (+ §4.3 coordinator extras). */
export interface RegistryPayload {
  capabilities: string[];
  started_at: string;
  cwd?: string;
  model?: string;
  model_source?: "self-reported" | "harness-hook" | "unknown";
  /** What the agent says it is working on (SPEC §6.2); unchecked, so read it with `typeof`. */
  title?: unknown;
  /** `{ repo?, issue?, pr? }` for that purpose (SPEC §6.2); unchecked. */
  links?: unknown;
  /** A session's terminal workspace title, from its hooks (SPEC §4.3); unchecked. */
  workspace_title?: unknown;
  session_url?: string;
  workspace?: string;
  [key: string]: unknown;
}

/** screen.schema.json payload. */
export interface ScreenPayload {
  lines: string[];
  captured_at: string;
  workspace: string;
  hash: string;
  source: string;
}

// -------------------------------------------------------------- wave state

/** wave-state.schema.json `$defs/stage`. */
export type Stage =
  | "queued"
  | "implement"
  | "spec_review"
  | "quality_review"
  | "fixup"
  | "merge_ready"
  | "done"
  | "blocked"
  | "awaiting_decision"
  | "cancelled";

/** Pipeline roles as they appear in `tasks[].agents` (a test keeps them in step with the schema). */
export type Role =
  | "implementer"
  | "spec_reviewer"
  | "quality_reviewer"
  | "fixup"
  | "rebase"
  | "integrator";

export const ROLES: readonly Role[] = [
  "implementer",
  "spec_reviewer",
  "quality_reviewer",
  "fixup",
  "rebase",
  "integrator",
];

export interface WaveTask {
  id: string;
  issue: number;
  stage: Stage;
  agents: Partial<Record<Role, string>>;
  waiting_on?: string[];
  why_waiting?: string;
  pr?: {
    number: number;
    url: string;
    head_sha?: string;
    ci?: "green" | "red" | "running" | "none";
    /** While held for CI, when volleyd could read the head's jobs (#415). */
    jobs?: {
      done: number;
      total: number;
      running: string[];
      failed: string[];
      /** The last job's completion; while none is done, the first job's start. */
      last_done_at?: string;
      /** The slowest job's last duration in an earlier run of the wave. */
      slowest_s?: number;
    };
    /** Seconds left by volleyd's estimate when the hold was journaled. */
    eta_s?: number;
  };
  evidence_path?: string;
  /** The remote host the task's agents run on; absent for the supervisor's own machine. */
  host?: string;
  /** Where the task was placed and why (SPEC §4.6.15); absent until it is placed. */
  placement?: TaskPlacement;
  /** The release-branch commit the task's current worktree was cut from. */
  base_sha?: string;
  /**
   * A task the supervisor added itself (a fixer), not one from the wave file: `true`, or
   * `{ for }` naming the tasks it fixes. Read with `fixerFor` (also takes `remediation.for`).
   */
  synthetic?: boolean | { for?: string[]; [key: string]: unknown };
  /** What a synthetic task remediates; `for` names the tasks it fixes. */
  remediation?: { for?: string[]; [key: string]: unknown };
  /** The overlap plan's cluster the task is in (`overlap_plan.clusters[].id`). */
  cluster?: string;
  /** The task's churn spawns so far: respawns, rebases and fixups an overlap forced. */
  churn?: number;
  /** A merge train's synthetic task (`train-<n>`): the gated PRs it merges as one. */
  train?: { members: { task: string; pr: number; head: string }[] };
  [key: string]: unknown;
}

/** One machine placement considered, best first: volleyd writes `line`, the Desk only shows it. */
export interface PlacementCandidate {
  host: string;
  /** 0..1; `null` when the machine was not eligible. */
  score: number | null;
  line: string;
}

/** `tasks[].placement` (SPEC §4.6.1): the machine a task was placed on, by whom and why. */
export interface TaskPlacement {
  /** A machine name: the supervisor's own machine under its `fleet.local_name`. */
  host: string;
  by: "auto" | "wave_file" | "decision";
  score: number | null;
  decided_at: string;
  candidates: PlacementCandidate[];
}

export type PipelineStep = string | string[];

/** wave-file `footprint`: how the task's files were found. */
export interface TaskFootprint {
  confidence: "listed" | "resolved" | "guessed" | "none";
  unresolved?: string[];
}

/** wave-file `plan`: where the overlap plan put the task, how its cluster runs and why. */
export interface TaskPlan {
  cluster?: string;
  by?: "collapse" | "chain" | "cap" | "independent";
  why?: string;
}

export interface WaveSpecTask {
  issue: number;
  title?: string;
  after: string[];
  /** Every issue the task closes, when it bundles several (contains `issue`). */
  issues?: number[];
  files?: string[];
  footprint?: TaskFootprint;
  plan?: TaskPlan;
}

export interface WaveSpec {
  version: number;
  release_branch?: string;
  model?: string;
  pipeline?: PipelineStep[];
  tasks: Record<string, WaveSpecTask>;
}

/** wave-state `$defs/planCluster`: one cluster of the overlap plan. */
export interface PlanCluster {
  id: string;
  tasks: string[];
  /** The files its tasks share: each file, its size and the tasks touching it. */
  hot: { file: string; bytes: number; shared_by: string[] }[];
  /** collapse: groups bundled into one task; chain: [before, after] pairs; cap: most in flight. */
  strategy: { collapse?: string[][]; chain?: string[][]; cap?: number };
  state: "planned" | "hold" | "train";
  why: string;
}

/** wave-state `trains[]`: gated PRs the merge queue integrates, gates and merges as one. */
export interface WaveTrain {
  id: string;
  pr?: number;
  tasks: string[];
  state: "forming" | "integrating" | "ci" | "gated" | "merged" | "failed";
  since: string;
}

/**
 * The supervisor's call for an offline owner (SPEC §4.6.1): `reconnecting` while the agent bound
 * to a coordinator-name owner went away less than `autopilot.reconnect_grace_s` ago; past that,
 * `gone` while something only the owner can answer waits in the wave, else `away` (autopilot runs
 * it). The Desk never derives any of the three from silence.
 */
export type CoordinatorState = "working" | "awaiting_input" | "reconnecting" | "away" | "gone";

export interface WaveCoordinator {
  agent_id: string;
  /** The owner's presence (SPEC §7.5); absent from a supervisor that predates it. */
  presence?: "online" | "offline";
  state: CoordinatorState;
  question?: string;
  session_url?: string;
  workspace?: string;
  last_seen: string;
}

/** wave-state `github` (SPEC §4.6.1): the repository on GitHub, as the supervisor read it. */
export interface GitHubRepo {
  /** `owner/repo`. */
  slug: string;
  /** The repository's canonical URL. */
  url: string;
}

/** wave-state `autopilot` (SPEC §4.6.16): on or off for the wave, and what it did. */
export interface WaveAutopilot {
  enabled: boolean;
  auto_resolved: number;
  escalated: number;
  budgets: Record<string, { used: number; max: number }>;
}

/** wave-state `merge_queue[]` (SPEC §4.6.17), in merge order. */
export interface MergeQueueEntry {
  task: string;
  state: "merging" | "updating" | "queued" | "refused";
  since: string;
}

/** wave-state `release` (SPEC §4.6.19): the train's stage in play and every stage's state. */
export interface WaveRelease {
  stage: string | null;
  stages: { name: string; state: "pending" | "awaiting_go" | "running" | "verified" | "failed" }[];
}

export interface WaveStatePayload {
  wave: string;
  version: number;
  owner: string | null;
  repo: string;
  release_branch: string;
  /** `archived` is published once, just before the topic is cleared (SPEC §4.6.20). */
  status:
    | "running"
    | "paused"
    | "awaiting_decision"
    | "releasing"
    | "complete"
    | "stopped"
    | "archived";
  tasks: WaveTask[];
  open_decisions: string[];
  gates: string[];
  spec?: WaveSpec;
  coordinator?: WaveCoordinator;
  effective_config?: Tunables;
  /** Absent from an older supervisor or when the read failed: nothing then links. */
  github?: GitHubRepo;
  /** Absent from a supervisor that predates autopilot. */
  autopilot?: WaveAutopilot;
  /** Absent while the queue is empty. */
  merge_queue?: MergeQueueEntry[];
  /** Absent for a wave without a release train. */
  release?: WaveRelease;
  /** The overlap plan; absent for a wave the planner has not planned. */
  overlap_plan?: { clusters: PlanCluster[] };
  /** Spawns so far: productive (a role's first run) and churn (forced by an overlap). */
  spawns?: { productive: number; churn: number };
  /** Merge trains, in the order the queue formed them. */
  trains?: WaveTrain[];
  /** The account the wave's new agents start under; absent from an older supervisor. */
  account?: WaveAccount;
  updated_at: string;
  [key: string]: unknown;
}

/**
 * wave-state `account` (SPEC §4.6.1): the account the wave's new agents start under (`pinned`,
 * null: balanced), what names it, and the account its last move left.
 */
export interface WaveAccount {
  pinned: string | null;
  source: "wave" | "config" | "balanced";
  moved_from?: string;
}

/** `decision.schema.json`'s `payload.kind` enum (a test keeps the two in step). */
export const DECISION_KINDS = [
  "reviewers_disagree",
  "merge_conflict",
  "agent_blocked",
  "agent_question",
  "agent_stalled",
  "unknown_screen",
  "hooks_auth_failed",
  "mcp_not_registered",
  "spawn_failed",
  "model_switch",
  "repo_untrusted",
  "remote_repo_missing",
  "ci_failed",
  "wave_complete",
  "plan_change",
  "pr_closed",
  "pr_head_moved",
  "spawn_budget_exhausted",
  "account_limit",
  "agent_account_limit",
  "machine_down",
  "merge_refused",
  "release_go",
  "stage_go",
  "terminal_status_lost",
  "churn_exhausted",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** What a held decision waits on (SPEC §4.6.2): a task of its wave, a PR, an issue. */
export interface HeldOn {
  task?: string;
  pr?: number;
  issue?: number;
}

/** A decision's hold: open, waiting on `on` rather than on a person; never escalated. */
export interface Held {
  on: HeldOn;
  note?: string;
  by: string;
  at: string;
}

/** decision.schema.json payload. */
export interface DecisionPayload {
  decision_id: string;
  wave: string;
  task: string | null;
  /** A schema kind, or a newer one this Desk does not know: shown by its question either way. */
  kind: DecisionKind | (string & {});
  question: string;
  options?: string[];
  pointers?: { diff?: string; transcript?: string; screen?: string; pr?: string };
  opened_at: string;
  resolved?: { answer: string; by: string; at: string };
  /** `account_limit` extras (SPEC §4.6.12): the account, its 5-hour pct and reset, the suggestion. */
  acct?: string;
  /** `agent_account_limit` extras (SPEC §4.6.12): the agent, its role and the window at the level. */
  agent_id?: string;
  role?: string;
  window?: string;
  pct?: number;
  resets_at?: string | null;
  suggested?: string | null;
  /** `machine_down` extras (SPEC §4.6.2): the host, since when, its unfinished tasks, its state. */
  host?: string;
  down_since?: string;
  tasks?: string[];
  machine?: "down" | "draining" | "removing" | "removed";
  /** Held: waiting on a task, PR or issue (volleyd releases it when that lands). */
  held?: Held;
  /** A shared-precondition decision (`repo_untrusted`): every task waiting on it, opener first. */
  waiting?: string[];
}

// ------------------------------------------------------- config and leases

/** `repos.<owner/name>.machines`: every machine, or these by name. */
export type RepoMachines = "all" | string[];

/** How the supervisor's own machine takes auto-placed tasks (`fleet.local_agents`). */
export type LocalAgentsMode = "always" | "fallback" | "never";

/** config.schema.json `$defs/leasePool`: one configured lease pool. */
export interface LeasePoolConfig {
  capacity: number;
  per_machine?: number;
  /** The per-machine cap in force on a named machine in place of `per_machine`. */
  per_machine_overrides?: Record<string, number>;
  ttl_s?: number;
  match?: string[];
}

/** config.schema.json `$defs/tunables` (all optional: per-wave overrides share it). */
export interface Tunables {
  hard_ceiling?: number;
  spawn_budget_multiplier?: number;
  lease_pools?: Record<string, LeasePoolConfig>;
  admission?: {
    memory_pressure_max_level?: number;
    cmux_ping_max_ms?: number;
    container_max?: number;
    api_overload_window_s?: number;
    api_overload_max?: number;
    ci_queue_max?: number;
    hysteresis_samples?: number;
  };
  heartbeat_alarm_s?: number;
  fallback_model?: string | null;
  mailbox?: { session_expiry_s?: number };
  worktree_root?: string;
  spawn_timeout_s?: number;
  wake_grace_s?: number;
  screen_tail_interval_s?: number;
  /** Claude account profiles (SPEC §4.6.11); absent from a supervisor that predates them. */
  claude?: { default_account?: string | null; warn_at_pct?: number };
  /** The share of an agent's context window at which it compacts (SPEC §4.6.4). */
  agent_auto_compact_pct?: number;
  /** Remote hosts (SPEC §4.6.4); the Desk reads their names, caps and adopted clones. */
  hosts?: Record<
    string,
    {
      max_agents?: number;
      drain?: boolean;
      /** Adopted clones on the machine: `owner/name` → absolute path (SPEC §4.6.21). */
      repos?: Record<string, string>;
      [key: string]: unknown;
    }
  >;
  /**
   * Repositories by `owner/name` and the machines holding a clone of each (SPEC §4.6.21): `all`
   * or a list of machine names. Absent from a supervisor that predates repositories.
   */
  repos?: Record<string, { machines: RepoMachines }>;
  /** Autopilot (SPEC §4.6.16–17); absent from a supervisor that predates it. */
  autopilot?: {
    enabled?: boolean;
    owner_only?: string[];
    merge?: "auto" | "manual";
    delete_branch?: boolean;
    reconnect_grace_s?: number;
    [key: string]: unknown;
  };
  /**
   * The Fleet (SPEC §4.6.15): `local_name` is the supervisor's own machine; `local_agents` how it
   * takes auto-placed tasks (the retained config carries it resolved; null only in a config file);
   * `fallback` the profile it runs under while it is the fallback (no paired machine eligible).
   */
  fleet?: {
    local_name?: string | null;
    /** Where managed clones live on every machine (`~` is that machine's home). */
    repo_root?: string;
    local_agents?: LocalAgentsMode | null;
    fallback?: { max_agents?: number; per_machine?: Record<string, number> };
  };
  [key: string]: unknown;
}

/** Retained `volley/_waves/_archive` payload (archive.schema.json): archived waves, newest first. */
export interface ArchivePayload {
  archived: {
    wave: string;
    status: "stopped" | "complete";
    archived_at: string;
    by: string;
    reason: string;
  }[];
  updated_at: string;
}

/** Retained `volley/_waves/_config` payload. */
export interface ConfigPayload extends Tunables {
  version: number;
  updated_at: string;
  updated_by: string;
}

/** lease-pool.schema.json payload. */
export interface LeasePoolPayload {
  pool: string;
  capacity: number;
  /** The cap per machine (SPEC §4.6.5); absent means `capacity`. */
  per_machine?: number;
  /** The cap in force on a named machine in place of `per_machine`. */
  per_machine_overrides?: Record<string, number>;
  /** `host`: the holder's machine; `null` for a holder volleyd did not spawn, absent from an older one. */
  held: { lease_id: string; holder: string; host?: string | null; since: string; ttl_s: number }[];
  queue: { lease_id: string; holder: string; host?: string | null; since: string }[];
  reasons: string[];
}

// ----------------------------------------------------- Claude accounts

/** usage.schema.json `$defs/window`: one of an account's rate-limit windows. */
export interface UsageWindow {
  pct: number;
  resets_at: string | null;
}

/** usage.schema.json payload: an agent's retained `usage` sample (SPEC §4.6.12). */
export interface UsagePayload {
  account: string | null;
  config_dir?: string;
  model: string | null;
  context_window: { used_percentage: number | null; used: number | null; size: number | null };
  rate_limits: { five_hour?: UsageWindow; weekly?: UsageWindow };
  captured_at: string;
}

/** claude-account.schema.json payload: `volley/_system/claude-accounts/<acct>`. */
export interface ClaudeAccountPayload {
  account: string;
  label?: string;
  plan?: string;
  /** The login's e-mail (identity, never a credential); absent while not known. */
  email?: string;
  /** The login's organisation name; absent while not known. */
  org?: string;
  five_hour: UsageWindow | null;
  weekly: UsageWindow | null;
  /** Weekly windows scoped to one model family, as the machine's usage probe last read them. */
  model_weekly?: Partial<Record<ModelFamily, UsageWindow>>;
  /** The newest usage probe attempt for this login; absent until a probe has reported. */
  probe?: UsageProbe;
  agents: string[];
  waves: string[];
  sampled_at: string;
  sampled_by?: string;
}

/** claude-account.schema.json `model_weekly`'s keys. */
export type ModelFamily = "fable" | "opus" | "sonnet" | "haiku";

/** claude-account.schema.json `probe.state` (machine.schema.json `claude_logins[].state`). */
export type ProbeState = "ok" | "expired" | "no_credential" | "rate_limited" | "rejected" | "error";

/** claude-account.schema.json `probe`: how the holding machine's last usage probe went. */
export interface UsageProbe {
  machine: string;
  state: ProbeState;
  attempted_at: string;
  /** The last successful read. */
  read_at?: string;
}

/**
 * A Claude account sign-in, folded from `volley/_system/claude/<acct>/signin`
 * (`claude_signin_url` → waiting, then `claude_signin_done` / `_failed`). Only
 * the provider's sign-in link ever travels there, never a credential.
 */
export interface ClaudeSignin {
  acct: string;
  state: "waiting" | "done" | "failed";
  url?: string;
  /** `browser_callback`, or `manual_code` (the page shows a code to paste in the Desk). */
  flow?: string;
  /** The tmux session to attach to for a `manual_code` sign-in. */
  attach?: string;
  /** The printed (code-page) URL: it works from any device; the page shows a code. */
  manual_url?: string;
  /** The localhost-callback URL: a shortcut for a browser on the supervisor's machine. */
  callback_url?: string;
  /** The sign-in terminal shows Claude Code's `Paste code here` prompt. */
  code_prompt?: boolean;
  plan?: string;
  /** The login's e-mail, from `claude_signin_done` (SPEC §4.6.11). */
  email?: string;
  reason?: string;
  /** Local receipt time (ms). */
  at: number;
}

/** One doctor check on a machine record (SPEC §4.6.15): states only, never a fix's text. */
export interface MachineCheck {
  id: string;
  ok: boolean;
  /** `block`: failing makes the machine not ready; `warn`: shown only. */
  severity: "block" | "warn";
  detail: string;
  /** The repository (`owner/name`) a per-repository check is about: failing, it blocks that one only. */
  repo?: string;
}

/** machine.schema.json `repos[]`: one repository's clone on a machine, as its doctor found it. */
export interface MachineRepo {
  slug: string;
  path: string;
  exists: boolean;
  origin?: string;
  /** `true`: the managed clone (`<repo_root>/<owner>/<name>`); `false`: an adopted one. */
  managed: boolean;
  fetched_at: string | null;
  release_branch?: string;
  /** The tools the repository needs that the machine lacks or has too old. */
  toolchain: { ok: boolean; missing: string[]; outdated: string[] };
}

/**
 * machine.schema.json payload: a machine's retained health record on
 * `volley/_system/machines/<name>` (SPEC §4.6.14), published by the machine
 * every heartbeat and by volleyd when the heartbeat stops. volleyd publishes
 * its own machine's (`kind: "supervisor"`, `tunnel: "local"`). The Fleet
 * fields (§4.6.15) come with a doctor report.
 */
export interface MachinePayload {
  name: string;
  kind?: "peer" | "supervisor";
  os: string;
  arch?: string;
  cores: number;
  tunnel: "up" | "down" | "local";
  /** Why the tunnel is down; absent while it is up. */
  reason?: "disconnect" | "heartbeat_timeout";
  /** The 1, 5 and 15 minute load averages. */
  load: number[];
  agents: number;
  remote_port?: number;
  last_seen: string;
  memory?: { total_mb: number; available_pct: number };
  disk?: { path: string; free_gb: number; free_pct: number };
  uptime_s?: number;
  versions?: Record<string, string | null>;
  auth?: {
    gh: "ok" | "unauthenticated" | "missing" | "no_write";
    claude: "signed_in" | "not_signed_in" | "missing" | "unknown";
    trust: "ok" | "missing" | "unknown";
    claude_plan?: string;
    /** The default profile's login e-mail, only while it is signed in. */
    claude_email?: string;
    claude_org?: string;
  };
  repo?: {
    path: string;
    exists: boolean;
    origin?: string;
    release_branch?: string;
    fetched_at?: string | null;
  };
  /** Each repository the machine works on (SPEC §4.6.14); absent from an older peer. */
  repos?: MachineRepo[];
  checks?: MachineCheck[];
  doctor_at?: string;
}

/** The three machine roles (SPEC §4.6.24): which machine runs the broker, the supervisor, the Desk. */
export const MACHINE_ROLES = ["broker", "supervisor", "desk"] as const;
export type MachineRole = (typeof MACHINE_ROLES)[number];

/**
 * roles.schema.json payload: the supervisor's record of where each machine role runs, on the
 * retained `volley/_system/roles` (SPEC §4.6.24), accepted only from `volleyd`.
 */
export interface RolesPayload {
  broker: {
    machine: string;
    /** `ssh`: where every machine's tunnel reaches the broker's machine; null while it is local. */
    address: { ssh: string | null; mqtt_port: number; ws_port: number };
    lan: boolean;
  };
  supervisor: { machine: string };
  /** `url`: the address browsers and phones open the Desk at. */
  desk: { machine: string; url: string };
  version: number;
  updated_at: string;
  updated_by: string;
}

/** One step of a role move as the moves topic has it. */
export interface RoleMoveStep {
  id: string;
  title: string;
  /** The machine it runs on, or `every machine`. */
  where: string;
  status: "pending" | "running" | "ok" | "failed" | "skipped";
  /** Its last line of output, or why it failed. */
  line?: string;
}

/**
 * role-move.schema.json payload: one move's progress, on the retained
 * `volley/_system/roles/moves/<move_id>` (SPEC §4.6.24), republished at every change.
 */
export interface RoleMovePayload {
  move_id: string;
  role: MachineRole;
  from: string;
  to: string;
  status: "planning" | "running" | "health_check" | "done" | "failed" | "rolled_back";
  steps: RoleMoveStep[];
  since: string;
  error?: string;
  log_path?: string;
}

/** Where one repository stands on a machine (readiness.schema.json `repos`, SPEC §4.6.21). */
export type RepoState = "ready" | "cloning" | "blocked" | "absent";

/** readiness.schema.json `repos.<owner/name>`. */
export interface RepoVerdict {
  state: RepoState;
  /** The clone's path on the machine, when it has one. */
  path?: string;
  /** What keeps it from being ready there; empty when ready. */
  reasons: string[];
  fetched_at?: string;
}

/**
 * One progress row of a `machine_add` run (SPEC §4.6.14), a `progress` envelope on the op's
 * reply topic before its answer: a step starting (no `line`), a line of it, or its failure.
 */
export interface MachineAddRow {
  step: number;
  total: number;
  title: string;
  state: "running" | "failed";
  line?: string;
}

/**
 * readiness.schema.json payload: volleyd's verdict on a machine, on
 * `volley/_system/machines/<name>/readiness` (SPEC §4.6.15).
 */
export interface ReadinessPayload {
  name: string;
  ready: boolean;
  /** One line per blocker; empty when ready. */
  reasons: string[];
  drain: boolean;
  max_agents: number;
  placed: number;
  path_ok: { claude: boolean | null; bun: boolean | null };
  requirements: { volley: string; bun?: string; sharing?: Record<string, string> };
  /** Per heavy pool: leases held on this machine and the cap in force there (may be 0). */
  heavy: Record<string, { held: number; per_machine: number }>;
  usage: { account: string | null; five_hour_pct: number | null };
  eligible: boolean;
  ineligible_reason?: string;
  checked_at: string;
  /**
   * The supervisor's own machine only (absent from an older supervisor): its `fleet.local_agents`
   * mode, whether the fallback profile is in force, and why.
   */
  local_agents?: { mode: LocalAgentsMode; active: boolean; why?: string };
  /** Each repository on the machine, by `owner/name` (absent from a supervisor before them). */
  repos?: Record<string, RepoVerdict>;
}

/** inbox-item.schema.json payload.kind. */
export const INBOX_KINDS = ["decision", "picker", "handoff", "release"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** inbox-item.schema.json $defs.where.kind: where an answer was given. */
export const INBOX_WHERE_KINDS = ["desk", "terminal", "cli", "autopilot"] as const;

export interface InboxWhere {
  kind: (typeof INBOX_WHERE_KINDS)[number];
  device?: string;
  machine?: string;
}

/**
 * inbox-item.schema.json payload: one thing waiting for a person, on `volley/_inbox/<id>`
 * (SPEC §4.6.18). Answer it with an `inbox_answer { id, version, answer, where }` request to
 * volleyd, the referee: the first answer at the current `version` wins.
 */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  version: number;
  owner_only: boolean;
  wave?: string;
  task?: string;
  agent_id: string;
  title: string;
  question: string;
  options?: { label: string; description?: string }[];
  allow_other?: boolean;
  multi?: boolean;
  pointers: Record<string, string>;
  opened_at: string;
  source: Record<string, unknown>;
  answered?: { answer: string; by: string; where: InboxWhere; at: string };
  /** A decision's item: its hold, mirrored from the decision. */
  held?: Held;
}

/**
 * digest.schema.json payload: a wave's morning digest on `volley/_waves/<wave>/digest`
 * (SPEC §4.6.16) — what shipped, what autopilot handled, and what is waiting for the owner.
 */
export interface DigestPayload {
  wave: string;
  release_branch: string;
  generated_at: string;
  trigger: "wave_complete" | "release_go" | "escalation" | "stopped";
  shipped: {
    task: string;
    issue: number;
    title?: string;
    pr: { number: number; url: string };
    merge_sha: string | null;
    merged_by: "supervisor" | "operator" | "github";
  }[];
  /** The shipped tasks' issues: the release PR's `Closes #…` lines (absent: older volleyd). */
  closes?: number[];
  auto: {
    decisions_resolved: number;
    flakes_fixed: { test: string; fixer: string; prs_released: number }[];
    conflicts_resolved: number;
    retries: number;
    merges: number;
  };
  waiting: {
    id: string;
    kind: string;
    task?: string;
    question: string;
    since: string;
    owner_only: boolean;
  }[];
  /** Held decisions: open, waiting on a blocker rather than on the owner (absent: older volleyd). */
  held?: {
    id: string;
    kind: string;
    task?: string;
    question: string;
    since: string;
    on: HeldOn;
    label: string;
    held_since: string;
  }[];
  release?: WaveRelease;
  failures: { task: string; why: string }[];
  /** The wave's own alarms (`peer_idle_under_load`); absent: none. */
  alarms?: { alarm: string; message: string }[];
}

// ------------------------------------------------------------------- store

export interface FeedEntry {
  topic: string;
  envelope: Envelope;
  receivedAt: number;
}

/** A non-terminal attention state reported on `progress` (SPEC §4.3). */
export interface AgentAttention {
  state: "awaiting_input";
  text?: string;
  question?: string;
  sessionUrl?: string;
  workspace?: string;
  at: number;
  /**
   * The hooks saw a live background wait (`background_wait: true`): the agent
   * ended its turn waiting on events, not on a person.
   */
  backgroundWait?: boolean;
  /** The Notification hook's `notification_type` (`idle_prompt`, `permission_prompt`, …). */
  notificationType?: string;
}

/** What the hooks' `activity` / `idle` / `resumed` ticks say a session is doing (SPEC §4.3). */
export interface WorkLog {
  /** Tool calls so far (`payload.tool_calls`). */
  toolCalls: number;
  /** ms of the last tool call, when one has been reported. */
  lastToolAt: number | null;
  /** The last activity line (`Bash: …`, `prompt received`). */
  last: string | null;
  /** Working since the last activity / resumed; idle since the turn ended. */
  state: "working" | "idle";
  /** ms the state began. */
  since: number;
}

export interface AgentView {
  id: string;
  namespace: string | null;
  parentId: string | null;
  /** Wave id, or `UNASSIGNED` when no wave state references the agent. */
  wave: string;
  task: string | null;
  role: Role | null;
  registered: boolean;
  registry: RegistryPayload | null;
  model: string | null;
  /**
   * `at` is the envelope's `wall_time` (the sender's clock); `seenAt` is when
   * it reached this Desk (`wall_time` for a retained replay), skew-free.
   */
  status: { type: string; payload: unknown; at: number; seenAt?: number } | null;
  progress: number | null;
  narration: string | null;
  /** ms of the last `progress/heartbeat`. */
  heartbeat: number | null;
  /** How many heartbeats arrived: they update liveness only and are kept out of `feed`. */
  heartbeats?: number;
  /** When the narration was current (ms). */
  narrationAt?: number;
  /** The narration was restored from this browser's session, not heard since the page loaded. */
  narrationRestored?: boolean;
  /** The last `progress` envelope's type and time (ms), any type: a sign the agent is on this broker. */
  lastProgress?: { type: string; at: number };
  /** ms of the last message on any of the agent's topics. */
  lastSeen: number;
  /** ms of the last `progress` the agent itself sent (not its hooks): "no progress reported" is timed from it. */
  reportedAt?: number;
  /**
   * Local receipt time (ms) of the first message this page heard about the agent, retained or
   * live: "no progress reported" never counts time before the Desk could see the agent.
   */
  observedAt?: number;
  /** The first progress message the agent itself sent (kept: the feed is bounded). */
  firstSaid?: string;
  /** The hooks' work log (SPEC §4.3 `activity` / `idle`), once one arrived. */
  work?: WorkLog;
  /** Set when an `awaiting_input` is outstanding; cleared by `resumed` (SPEC §4.3). */
  attention: AgentAttention | null;
  /** True once the agent has published `resumed` (or `awaiting_input`) — i.e. its hooks report attention. */
  attentionObserved: boolean;
  feed: FeedEntry[];
  screen: ScreenPayload | null;
  /**
   * When the agent was born, for the window's `born` entrance: local receipt
   * time of a live registry entry, or the registry's `started_at` (else its
   * `wall_time`) for a retained replay, so agents that already existed at page
   * load or reconnect are not "just spawned".
   */
  bornAt: number | null;
}

export interface WaveView {
  id: string;
  /** `null` until the retained state arrives (a decision can land first). */
  state: WaveStatePayload | null;
  decisions: Record<string, DecisionPayload>;
  receivedAt: number;
  /** The state's `account`; absent from an older volleyd (no field) or before the state. */
  account?: WaveAccount;
}

export interface CoordinatorView {
  id: string;
  waves: string[];
  state: CoordinatorState;
  /** `working` but idle with a background wait armed: waiting on wave events, not on the owner. */
  waitingOnEvents?: boolean;
  question?: string;
  text?: string;
  sessionUrl?: string;
  workspace?: string;
}

/**
 * A supervisor (`volleyd`): a registered Volley agent that is shown as health
 * (the top-bar pill, the coordinators window's first row), never as an agent
 * window.
 */
export interface SupervisorView {
  id: string;
  namespace: string | null;
  registry: RegistryPayload | null;
  /** The latest status type (`working`, `reaped`, …); null while none is retained. */
  status: string | null;
  /** ms of its last sign of life: registry, status or progress. */
  lastHeartbeat: number | null;
  version?: string;
  /** How many waves it reports supervising (its `working` status's `waves`). */
  wavesOwned: number | null;
}

export interface DeskState {
  waves: Record<string, WaveView>;
  agents: Record<string, AgentView>;
  coordinators: Record<string, CoordinatorView>;
  /** Supervisors by agent id; they are never in `agents`. */
  supervisors: Record<string, SupervisorView>;
  config: ConfigPayload | null;
  /** The supervisor's index of archived waves (`volley/_waves/_archive`); null until retained. */
  archive: ArchivePayload | null;
  leases: Record<string, LeasePoolPayload>;
  /** `volley/_system/admission` summary; its schema lands with the daemon's admission controller. */
  admission: Record<string, unknown> | null;
  /**
   * Agents that were registered before the last reconnect `resync` and whose
   * retained registry entry has not come back yet; `pruneUnconfirmed` drops
   * them once the replay has settled.
   */
  unconfirmed?: string[];
  /**
   * The Desk's own agent id (its broker identity) once it signs in. Its
   * mailbox carries the acks and replies to what it sends, never an agent.
   */
  self?: string;
  /** Delivery receipts for mailbox messages (D4 steering); live-only. */
  steering?: SteeringReceipts;
  /** Retained per-account usage records, by account id. */
  claudeAccounts?: Record<string, ClaudeAccountPayload>;
  /** Retained `usage` samples, by agent id (kept apart: they can arrive before the registry). */
  usage?: Record<string, UsagePayload>;
  /**
   * volleyd's Claude registry revision (`volley/_system/claude/registry`, SPEC §4.6.11): the
   * Settings sections fetch the registry again whenever it changes.
   */
  claudeRegistryRev?: number;
  /** Claude account sign-ins heard since the page loaded, by account id; live-only. */
  signins?: Record<string, ClaudeSignin>;
  /** Paired machines' retained health records, by machine name. */
  machines?: Record<string, MachinePayload>;
  /** volleyd's readiness verdicts, by machine name. */
  readiness?: Record<string, ReadinessPayload>;
  /**
   * Each machine's readings over the last 10 minutes (the Machines window's sparklines), by
   * machine name, oldest first; kept across a resync (the replay's copy is deduplicated).
   */
  machineHistory?: Record<string, MachineSample[]>;
  /** volleyd's machine roles record (SPEC §4.6.24); absent until it is retained. */
  roles?: RolesPayload;
  /** Each role move's retained progress, by move id. */
  roleMoves?: Record<string, RoleMovePayload>;
  /** The needs-you inbox (SPEC §4.6.18): volleyd's retained items, by item id. */
  inbox?: Record<string, InboxItem>;
  /** Each wave's retained morning digest (SPEC §4.6.16), by wave. */
  digests?: Record<string, DigestPayload>;
  /**
   * Autopilot's events (`decision_auto_resolved`, `decision_escalated`, SPEC §4.6.16) from each
   * wave's `events` mirror, by wave; live-only (the topic is not retained), kept across a resync.
   */
  waveFeed?: Record<string, FeedEntry[]>;
  /**
   * The account events (`account_chosen`, `agent_account_moved`, SPEC §4.6.11) from each wave's
   * `events` mirror, by wave; live-only like `waveFeed`.
   */
  accountFeed?: Record<string, FeedEntry[]>;
}

/** When each agent (by id) answered a message id, in local ms. */
export type Receipts = Record<string, Record<string, number>>;

/**
 * What came back for mailbox messages, keyed by message id (`correlation_id`)
 * then by the answering envelope's `agent_id`: SPEC §4.4 `ack`s, the model's
 * own `steering_acked` (§4.3), and any other mailbox message correlated to it.
 */
export interface SteeringReceipts {
  acks: Receipts;
  applied: Receipts;
  replies: Receipts;
  /** When each agent last signalled live `resumed` / `working` (never a retained replay). */
  signals: Record<string, number>;
}
