# volleyd

```
░▒▓ volleyd · the durable wave supervisor ▓▒░
```

`volleyd` is a long-running, non-LLM process that owns **waves**: sets of GitHub-issue tasks with
dependencies, each driven through a review pipeline by agents it supervises. It keeps an
append-only journal per wave, schedules the dependency graph, runs every external command through
a code-level authority fence, and publishes the live wave state to Volley topics so dashboards,
panes and coordinators can render it. It runs as a launchd service, so it outlives any
coordinator session.

> **Status: pre-release.** This package has the wave file, journal, reducer, scheduler, fence,
> config store, daemon, CLI and launchd service, plus decisions, wave ownership, pause/stop and
> the kill switch, steering and overlap warnings, heavy-operation leases and load-aware spawn
> admission, and it spawns each admitted task's implementer (worktree, identity, cmux launch,
> hook-signal verification, per-worktree lock, retire). The reviewer/fixup pipeline stages and
> recovery come in later tasks of the volleyd epic.

---

## Contents

- [Quick start](#quick-start)
- [The wave file](#the-wave-file)
- [CLI](#cli)
- [How it works](#how-it-works)
- [Leases](#leases)
- [Spawn admission](#spawn-admission)
- [Topics and the control channel](#topics-and-the-control-channel)
- [Decisions](#decisions)
- [Ownership and claim](#ownership-and-claim)
- [Pause, stop and the kill switch](#pause-stop-and-the-kill-switch)
- [Steering](#steering)
- [Overlap warnings](#overlap-warnings)
- [Configuration](#configuration)
- [Spawning agents](#spawning-agents)
- [Recovery](#recovery)
- [Plan changes (versioned wave files)](#plan-changes-versioned-wave-files)
- [The authority fence](#the-authority-fence)
- [Running as a service (launchd)](#running-as-a-service-launchd)
- [Exit codes](#exit-codes)

---

## Quick start

From the repo root, after `bun install`:

```sh
# Validate a wave file (no daemon needed)
bun packages/volleyd/src/cli.ts validate wave.yaml

# Run the daemon in the foreground (or `volleyd install` for launchd)
bun packages/volleyd/src/cli.ts daemon

# In another terminal: submit and watch
bun packages/volleyd/src/cli.ts run wave.yaml
bun packages/volleyd/src/cli.ts status
```

State lives in `$VOLLEYD_HOME` (default `~/.volley/volleyd`). The broker and namespace come from
`--broker-url` / `--namespace` or `VOLLEY_BROKER_URL` / `VOLLEY_NAMESPACE`, like the `volley` CLI.

---

## The wave file

```yaml
wave: 2026-10-20-example            # wave id, [a-z0-9][a-z0-9_-]{0,62}
repo: ~/repos/example
release_branch: release/2026-10-20-example
model: claude-opus-5-5
pipeline: [implement, [spec_review, quality_review], fixup, merge_ready]   # nested = parallel
tasks:
  T0: { issue: 101 }
  T1: { issue: 102, after: [T0] }
  T2: { issue: 103, after: [T0] }
  T3: { issue: 104, after: [T1, T2], pipeline: [implement, merge_ready] }
# optional:
# version: 1                 # bumped by a versioned re-submission
# namespace: dispatch        # Volley namespace for the wave's agents
# spawn_budget: 20           # default: spawn_budget_multiplier × task count
# heavy_pools: [backend-it]  # lease pools this wave's heavy commands draw from
# config: { hard_ceiling: 4 }  # per-wave overrides of any tunable but lease_pools (see Configuration)
```

Per task: `issue` (required), `after`, `pipeline`, `model`, `title`, `host` (where its agents run;
default `local`), and `files` (a scheduling hint: paths the task will touch; tasks overlapping
active ones start later).

The schema is [`spec/schemas/wave-file.schema.json`](../../spec/schemas/wave-file.schema.json).
The parser adds the rules a schema cannot express and reports everything with a path:

```
tasks.T3.after[1]: unknown task 'T9'
tasks.T1: duplicate task id 'T1'
tasks.T1.after: dependency cycle T1 -> T3 -> T2 -> T1
wave: invalid wave id (must match [a-z0-9][a-z0-9_-]{0,62})
config.hard_ceiling: must be <= 100
```

---

## CLI

| Command | What it does |
|---|---|
| `volleyd daemon` | Run the supervisor in the foreground until SIGINT/SIGTERM. |
| `volleyd install [--dry-run]` | Write `~/Library/LaunchAgents/systems.volley.volleyd.plist` and `launchctl bootstrap` it. |
| `volleyd uninstall` | `launchctl bootout` the service and remove the plist (journals stay). |
| `volleyd run <wave.yaml> [--owner <id>] [--json]` | Validate locally, then submit to the daemon. Returns once the wave is journaled. Prints the owner and any overlap warnings. For a wave id the daemon already holds, the file is its next plan version ([Plan changes](#plan-changes-versioned-wave-files)). |
| `volleyd diff <wave> <wave.yaml> [--json]` | Print the structural diff between a submitted wave's current plan and the file, without submitting. |
| `volleyd validate <wave.yaml>` | Validate locally; exit 1 with path-qualified errors. |
| `volleyd status [wave] [--by <id>] [--json]` | Wave state from the daemon, with open decisions and `needs you: N` on waves the caller owns. `--json` prints the exact `wave_state` payload. |
| `volleyd decisions [wave] [--all]` | Open decisions (with `--all`, resolved ones too): question, options, evidence pointers. |
| `volleyd resolve <decision-id> <answer> [--rationale <why>] [--wave <w>]` | Answer a decision (owner only). |
| `volleyd claim <wave> [--by <id>]` | Take over a wave whose owner is gone. Needs an identity. |
| `volleyd pause <wave>` / `resume <wave>` | Stop / restart admissions (owner only); running agents carry on. |
| `volleyd stop <wave>` | Stop a wave (owner only): no admissions, `cancel` to every running agent. |
| `volleyd stop --all` / `resume --all` | Engage / release the kill switch (anyone). |
| `volleyd steer <wave> <task> <text> [--role <r>] [--wait-ack-ms <ms>]` | Mailbox steering to the task's agent; reports `acked`, `received` or `delivered`. |
| `volleyd events <wave> --cursor <name>` | Print (JSONL) every journal event after the named cursor. Does not move it. |
| `volleyd ack <wave> --cursor <name> --seq <N>` | Advance the cursor to `N`. Ack **after** acting, so a crash replays. |
| `volleyd config get [path] [--wave <id>] [--json]` | Effective config (or one dotted path), optionally with a wave's overrides. |
| `volleyd config set <path> <value> [--by <who>]` | Change a tunable at runtime (validated, journaled, hot-applied). `<value>` is YAML. |
| `volleyd admission [--json]` | The current spawn admission verdict: throttled or not, why, every pressure signal, per-wave verdicts. |
| `volleyd spawn <wave> <task> [--role <role>] [--json]` | Spawn one agent now, outside admission. Returns once it is launched or refused (`SPAWN_LOCKED`, …); the daemon then verifies it. |
| `volleyd cleanup <wave> [--yes] [--force]` | Remove retired agents' cmux workspaces and worktrees. Without `--yes` only prints the plan. Branches are kept. |

The mutating commands (`resolve`, `pause`, `resume`, `stop`, `steer`, `claim`) act as the caller's
agent id: `--by <id>`, else `VOLLEY_AGENT_ID`, else the top-level session registered for the
closest enclosing directory (newest first among equally close ones; the daemon's own entry and
sessions whose retained status is `reaped`/`done`/`failed` are skipped). `run` uses the same
detection for the owner (`--owner` overrides it). `run` and `claim` warn when `VOLLEY_AGENT_ID`
names an agent with no registry entry, and `claim` refuses to run without any identity.

Commands that talk to the daemon fail fast with `volleyd not running` (exit 1, within ~1 s) when
the daemon's retained status is missing or terminal. `events`/`ack` read `$VOLLEYD_HOME` directly
and work while the daemon is down; use the wave `_system` for global events (`config_changed`,
`lease_*`).

---

## How it works

```
 wave.yaml ──validate──► run ──mailbox query──► daemon ──append──► journal.jsonl (fsync)
                                                  │                    │
                                                  │              reduce (pure)
                                                  │                    ▼
                                                  │              WaveRecord ──► scheduler.ready/admit
                                                  ▼
                                  volley/_waves/<wave>/state  (retained, after every append)
                                  volley/_waves/<wave>/events (live mirror)
```

- **Journal** (`src/journal.ts`): `$VOLLEYD_HOME/waves/<wave>/journal.jsonl`, one
  `{ seq, at, type, task?, data }` per line, `fsync` per append; `seq` starts at 1. A torn
  trailing write (crash mid-append) is truncated on open. A snapshot of the reduced record is
  written every 50 events, so a restart replays only the tail. Event types are the closed
  `wave-event` enum.
- **Reducer** (`src/reducer.ts`): pure `reduce(events) → WaveState` in exactly the
  `wave-state.schema.json` payload shape. Re-applying an already-applied `seq` is a no-op.
- **Scheduler** (`src/scheduler.ts`): `ready` = queued, not admitted, every `after` done; ordered
  by critical path length (longest downstream chain first), then by `files` overlap with active
  tasks, then id. `admit` takes an admission verdict `{ allow, reasons }` (pressure-based
  admission plugs in here later) and never exceeds the hard ceiling (live agents across all waves)
  or the wave's spawn budget. Lowering a limit admits nothing new and preempts nothing.
  Unadmitted ready tasks show the reasons in `why_waiting`, e.g. `hard ceiling reached: 2/2 live agents`.
- **Restart**: the daemon reopens every journal under `$VOLLEYD_HOME/waves/`, re-publishes each
  wave's state, and resumes admission.
- **One daemon per home**: `$VOLLEYD_HOME/volleyd.lock` (holding the pid) is taken before any
  journal is opened; a lock whose pid is gone is replaced. A second daemon is also refused while
  the broker shows a live `volleyd` status in the namespace.
- **Broker loss is fatal**: if the broker connection drops, `volleyd daemon` exits 1 and launchd's
  `KeepAlive` restarts it, which resumes the persistent session and restores every wave.

---

## Leases

A bare concurrency cap is the wrong tool: six agents editing files is fine, six running
integration suites with containers is not. Heavy commands therefore take a lease from a
machine-global **pool** (`lease_pools` in the config: `capacity`, optional `ttl_s`, and the
`match` regexes the [volley-hooks](../volley-hooks/README.md) lease hook uses to wrap matching Bash
commands in [`volley lease run`](../volley-cli/README.md#volley-lease)).

- **Requests** arrive on `volley/_system/leases/<pool>/requests` (`acquire | release | renew`,
  SPEC §4.6.5). A request whose `holder` is not the sender is ignored; a repeated `acquire` for a
  lease already held or queued is a no-op; `release` of a queued request cancels it.
- **Grants** are FIFO, never past the pool's *current* capacity. The pool state is re-published
  retained after every request, with `reasons` such as `queued: 3/3 backend-it leases held`.
- **A lease ends** on release, on TTL expiry (`ttl_s` of the request, else the pool's, else
  1 hour; `renew` restarts it — `volley lease run` renews at half the TTL), or when the holder's
  retained `status` turns `reaped`, `done` or `failed`.
- **Hot config, never preempt**: a capacity increase grants queued requests on the next tick; a
  decrease stops granting until holders release; a removed pool keeps its holders, drops its
  queued requests (they never started; each gets `rejected <lease_id>: pool <p> removed from
  config`, and `volley lease run` then runs its command unleased), reports capacity 0 with
  `pool <p> removed from config: new requests rejected`, rejects new acquires and disappears when
  its last holder releases. Pools are machine-global: they come only from the global config, and a
  wave file that sets `config.lease_pools` is rejected.
- **Durable**: every grant/release/expiry is journaled as `lease_requested`, `lease_granted`,
  `lease_released` or `lease_expired` in the `_system` journal (mirrored on
  `volley/_waves/_system/events`); a restart replays it, so held leases survive. Requests sent
  while the daemon is down wait in its persistent session and are handled on the next start
  (the daemon drains them like its mailbox).

## Spawn admission

Every tick (10 s) the daemon samples machine pressure through the fence (`src/pressure/*`) and
computes a pure verdict (`src/admission.ts`, `decide(samples, state, config) → { allow, reasons }`)
that the scheduler applies on top of the hard ceiling and spawn budget:

| Signal | Measured by | Over when (`admission.*`) |
|---|---|---|
| `memory_pressure` | `sysctl -n kern.memorystatus_vm_pressure_level` (1 normal, 2 warn, 4 critical); `memory_pressure`'s free percentage as fallback | level > `memory_pressure_max_level` |
| `cmux_ping` | wall time of `cmux ping` (a ping that hangs counts as the time waited) | ms > `cmux_ping_max_ms` |
| `containers` | `docker info --format {{json .}}` → `ContainersRunning` | > `container_max` |
| `api_overload` | agents' progress (via the hooks): `awaiting_input` with `quota_auto_resume_*`, `idle` text matching `overloaded\|rate limit\|usage limit` | count in the last `api_overload_window_s` > `api_overload_max` |
| `ci_queue` | `gh api repos/{owner}/{repo}/actions/runs?status=queued` in the wave's repo → `total_count`, at most once a minute per repo (it spends the agents' GitHub API quota; ticks in between reuse the last sample) | > `ci_queue_max` |

- **Throttle starts only**: an over signal sets `allow` to 0; nothing running is touched.
- **Hysteresis**: after a breach a signal must be clear for `hysteresis_samples` consecutive
  samples (`recovering: cmux ping clear for 1/3 samples`) before the allowance rises again.
- **Unknown never throttles**: a tool that is missing (Linux has no memory-pressure sysctl, no
  cmux, docker or gh) makes its signal `unknown`. On a signal that is already recovering, an
  unknown sample counts toward the clean samples (`… clear for 2/3 samples (last sample
  unknown)`), so a tool that breaks after a breach cannot hold starts back forever.
- **Nothing starts before the first sample**: the daemon samples once before its first
  admission, so a daemon restarted on an overloaded machine does not admit every ready task.
- **Reasons everywhere**: the verdict's reasons become `why_waiting` on the wave's ready tasks
  (`memory pressure critical (level 4 > max 2)`), joined by the ceiling/budget reasons, and are
  published retained on `volley/_system/admission` (`spec/schemas/admission.schema.json`) with
  every signal's value and threshold. `volleyd admission` prints it.
- **Hot**: thresholds are read from the config store per wave (`config:` overrides apply); a
  `config_set` re-decides the last sample with the new thresholds immediately.

---

## Topics and the control channel

| Topic | Retained | What |
|---|---|---|
| `volley/<ns>/volleyd/status` | yes | The daemon's lifecycle status; LWT flips it to `reaped` on a crash. |
| `volley/_system/registry/volleyd` | yes | Registry entry (`capabilities: ["supervisor"]`). |
| `volley/_waves/<wave>/state` | yes | Full `wave_state` snapshot (with `effective_config`), after every change. |
| `volley/_waves/<wave>/events` | no | Live mirror of each journal event. The journal is the record. |
| `volley/_waves/_config` | yes | Effective global config + `version` / `updated_at` / `updated_by`. |
| `volley/_waves/<wave>/decisions/<id>` | while open | Each open decision (`decision.schema.json`); cleared on resolve. |
| `volley/<ns>/volleyd/progress` | no | Notify bridge: a `blocked`-typed envelope with `attention: "decision_opened"` per new decision. |
| `volley/_waves/_system/events` | no | Live mirror of `_system` journal events (the kill switch). |
| `volley/_system/leases/<pool>` | yes | One lease pool: `capacity`, `held`, FIFO `queue`, `reasons`. |
| `volley/_system/leases/<pool>/requests` | no | Agents' `acquire` / `release` / `renew` (any agent may publish). |
| `volley/_system/admission` | yes | The spawn admission verdict after every pressure sample. |
| `volley/<ns>/<agent>/screen` | yes | Tail of a supervised agent's terminal (`screen_tail`, see [Screen tails](#screen-tails)). |

**Control requests** go to the daemon's mailbox `volley/<ns>/volleyd/mailbox` as `type: "query"`
with a fresh `correlation_id` and `payload: { op, text, ... }`. The daemon answers on the sender's
own mailbox with `type: "ack"`, the same `correlation_id`, and
`payload: { text: "ACKED", acked_type: "query", op, ok, error?, result?, applied?, rejected? }`
— `ACKED` means received (SPEC §4.4); the outcome is `ok` / `applied` / `error`. A query without a
`correlation_id` is dropped (an ack must carry one). A redelivered request (same sender and
`correlation_id`) is answered again from memory, not re-run.

The daemon keeps its mailbox in a **persistent MQTT session** (`clean: false`, stable clientId
`volley-volleyd-daemon-<ns>`, MQTT 5 with `mailbox.session_expiry_s`), so a request sent while it
is restarting is delivered when it comes back. Mailbox messages are never retained: the daemon
clears a stray retained message on its mailbox at startup instead of executing it.

| `op` | Fields | `result` |
|---|---|---|
| `run` | `wave_yaml`, `source?` | the new wave state |
| `status` | `wave?` | one wave state, or `{ waves: [...] }` |
| `config_get` | `path?`, `wave?` | the value (the full retained payload when neither is given) |
| `config_set` | `patch`, `by` (SPEC §4.6.4) | `{ version }`, plus `applied` / `rejected: [{ path, reason }]` |
| `decisions` | `wave?`, `all?` | `{ decisions: [decision payload] }` |
| `resolve` | `decision_id`, `answer`, `by`, `wave?`, `rationale?` | `{ wave, decision_id, already_resolved, resolved, brief? }` |
| `claim` | `wave`, `by` | `{ wave, owner, previous, why }` |
| `pause` / `resume` | `wave` (or `all: true` for `resume`), `by` | `{ wave, status, changed }` / `{ kill_switch }` |
| `stop` | `wave` or `all: true`, `by` | `{ wave, status, changed, cancelled }` / `{ kill_switch, stopped }` |
| `steer` | `wave`, `task`, `text`, `by`, `role?`, `wait_ack_ms?`, `urgent?`, `escape_only?` | `{ agent_id, role, message_id, seq, supersedes?, delivery, received, acked, acked_by?, interrupted? }`; with `escape_only`: `{ wave, task, agent_id, role, escape_only: true, interrupted }` |
| `admission` | — | the retained admission summary (null before the first sample) |

`run` also takes `owner` and answers with `warnings: [...]` (overlap lines). `status` without a
wave adds `kill_switch: true` while the kill switch is engaged. `steer` answers once the ack
arrives or `wait_ack_ms` (default 30 s, at most 300 s) passes, and `run` answers once each task
issue's body has been fetched — neither wait blocks other control requests. A request redelivered
while its answer is still pending is not run twice; it gets the one answer.

---

## Decisions

A decision is a question only a human (or the owning coordinator) can answer — reviewers
disagree, a merge conflict, an agent blocked, a plan change. It is a journal event, not chat:

- **Open** (`daemon.openDecision(wave, { kind, task, question, pointers, options? })`, used by
  the pipeline and recovery subsystems): journals `decision_opened`, publishes the decision retained
  on `volley/_waves/<wave>/decisions/<id>` (ids look like `d-k3x9q2ab`), and parks the task in
  `awaiting_decision`. Its dependents wait with `why_waiting: "awaiting decision d-… (T2)"`;
  independent tasks keep running. A `task: null` decision is wave-level and parks nothing. A
  task that is already `done`, `merge_ready` or `cancelled` cannot be parked (its dependents have
  moved on); open a wave-level decision instead. While a task is parked, a `stage_entered` for it
  does not un-park it: it only changes the stage it resumes in.
- **Notify bridge**: every open also publishes a `blocked`-typed progress envelope on the
  daemon's own topic, so an existing `volley notify` rings with no new surface:

  ```sh
  volley notify --pattern 'volley/+/volleyd/progress'      # default --on includes blocked
  ```

- **Resolve** (`volleyd resolve d-… "<answer>" --rationale "<why>"`, owner only): journals
  `decision_resolved { answer, by, at, rationale? }`, re-publishes the decision once with
  `resolved` set and clears the retained topic, and, once the task's last open decision is
  resolved, puts it back in the stage it was in. The task's resolved decisions are written to
  `.volley/decisions.md` in its task directory for the next stage's brief: the task's latest
  worktree (from its `agent_spawned`), or `$VOLLEYD_HOME/waves/<wave>/tasks/<task>/` before the
  task has one or when spawning is off. A failed write is logged and the answer omits `brief`; the
  resolution itself stands. Resolving an unknown id is an error; resolving twice is a no-op.

Open decisions survive a restart (they are re-published from the journal), and a restart clears
the retained topic of every resolved one, in case the daemon died between the two.

## Ownership and claim

Every wave has one **owner**, the coordinator agent id that submitted it — the single writer. It
comes from `volleyd run --owner <id>`, else is auto-detected (`VOLLEY_AGENT_ID`, else the session
registered for the caller's directory; printed as `owner: … (auto)`), else `null` (unowned).
`resolve`, `pause`, `resume`, `stop`, `steer` and re-running the wave id require `by == owner`;
anyone else is refused with the owner's id. An unowned wave accepts anyone.

`volleyd claim <wave>` hands the wave to the caller when the owner is gone: its retained status
is `reaped`, `done` or `failed`, or nothing has been heard from it — registry entry, status,
any event on its `progress` channel (heartbeats) — for `claim_after_s` (config, read at claim
time, so a `volleyd config set claim_after_s …` applies to the next claim). Otherwise the claim
is refused, naming the owner. A claim is journaled as `owner_claimed { owner, previous, why }`.

Silence is never measured from before the owner got the wave (its `wave_submitted` or latest
`owner_claimed`) or from before the daemon started, because heartbeats are remembered in memory
only: an owner the broker has never seen, or one the daemon has not heard from since a restart,
becomes claimable only after a full `claim_after_s`. A claim must name a stable identity (`--by`,
`VOLLEY_AGENT_ID` or a registered session); the CLI's own per-invocation id is never used.

## Pause, stop and the kill switch

- `pause <wave>`: no new admissions; running agents continue. Held tasks show
  `why_waiting: "wave paused"`. `resume <wave>` re-admits.
- `stop <wave>`: journals `wave_stopped` (no new admissions), then sends a mailbox `cancel`
  to every running agent of the wave (journaled as `steering_sent { type: "cancel" }`). The
  daemon also interrupts each agent: with spawning on, Escape into its cmux workspace (from its
  `agent_spawned`); with `--no-spawn`, only the mailbox cancel is sent. A stopped
  wave can be resumed explicitly. Known gap until the pipeline stages can respawn: `stop` journals
  no `task_cancelled`, so after `resume` the tasks that were running come back as active (still
  in their stage, counting against `hard_ceiling`) with no agent working them.
- `stop --all` is the **kill switch**: the switch is journaled in `_system` first (so it holds
  even if the daemon dies part-way, and survives restarts), every wave stops, and the daemon refuses `run` with `kill switch engaged` until
  `resume --all`, and spawns nothing (neither admitted tasks nor `volleyd spawn`). Anyone may
  pull it; releasing it leaves stopped waves stopped.

## Steering

`volleyd steer <wave> <task> "<text>"` sends a mailbox `steering` envelope to the task's current
agent (the current stage's role, else the implementer; `--role` picks one). Its `correlation_id`
is the message id; `payload.seq` counts steers to that task (1, 2, …) and `payload.supersedes`
names the previous steer, so the recipient can drop stale guidance. The steer is journaled as
`steering_sent`. The command then waits up to `--wait-ack-ms` (default 30000) and reports:

- `acked by <agent>`: the recipient published `type: "steering_acked"` on its own `progress`
  channel with `correlation_id` = the steer's message id (SPEC §4.3) — the model acted on it;
- `received`: only its SPEC §4.4 mailbox `ack` (to `volley/<ns>/volleyd/mailbox`) arrived;
- `delivered`: neither arrived in time.

Only the steered agent's acks count (the progress topic or the ack envelope must name it).

`urgent: true` interrupts the agent's session (the same interrupt as `stop`: the configured
hook, else Escape into the spawned agent's workspace) **before** the steering message is published, and the answer adds `interrupted`.
`escape_only: true` (implies `urgent`; `text` not needed) only interrupts: nothing is published or
journaled, so a client that sends its own mailbox message (the Desk) asks for the interrupt first
and then publishes, and the agent gets exactly one message. When there is nothing to interrupt with
(no hook, no workspace) or it fails, the request still answers `ok` with `interrupted: false`.

## Overlap warnings

At submit the daemon reads each task issue's `Files` section (`## Files` / `### Files` heading or
a `Files:` line; comma lists, brace expansion and package-relative entries are understood) via
`gh issue view` (outside the daemon's serial queue, so a slow GitHub delays only that `run`) and
compares it, together with the wave file's `files` hints, with the unfinished tasks of every other
running wave. The issue lists are journaled on each `task_queued` as `data.issue_files` and are
never merged into the wave definition, so they do not change the scheduler's same-file ordering. Each shared path journals an `alarm_raised` event with
`data.alarm: "overlap_warning"` (paths and both wave/task ids) and prints a line in the `run`
output:

```
warning: overlap: w2/T4 and w1/T7 both touch packages/volleyd/src/daemon.ts
```

Overlap is advisory only; nothing is refused.

---

## Configuration

One model (T1's `config.schema.json`), three layers:

**built-in defaults** (`src/config-defaults.ts`) ← **`$VOLLEYD_HOME/config.yaml`** ← **the wave
file's `config:` block**.

The daemon validates `config.yaml` on load (a bad value fails startup naming the path), publishes
the effective global config retained on `volley/_waves/_config`, and every subsystem reads
tunables through the store — no tunable is a constant anywhere else (`test/no-constants.test.ts`).

`volleyd config set` (or any client sending `config_set`) is validated against
`config-set-request.schema.json` and the merged result against the config schema — an unknown
key, an out-of-bounds value or an empty sub-object rejects the whole patch; a patch may set one
field of an existing object, e.g. `lease_pools.build.ttl_s` — then written to `config.yaml`
atomically, journaled as `config_changed { by, patch, previous, version }` in the `_system`
journal (mirrored live on `volley/_waves/_system/events`), re-published with `version + 1`, and applied **without a restart**:

| Tunable | Takes effect | In-flight work |
|---|---|---|
| `hard_ceiling`, `spawn_budget_multiplier` | next admission tick (immediately after the change) | never preempted; a limit below current use only stops new admissions |
| `admission.*` | next admission tick | never preempted |
| `lease_pools` | next lease grant | a pool shrunk below its holders stops granting until holders release; no holder is preempted |
| `claim_after_s`, `heartbeat_alarm_s`, `idle_grace_s`, `wake_grace_s` | next monitor tick | — |
| `fallback_model` | decisions opened after the change | open decisions keep their offer |
| `mailbox.session_expiry_s` | new connections only | existing sessions keep their expiry until they reconnect |
| `worktree_root` | spawns after the change | existing worktrees untouched |
| `spawn_timeout_s` | spawns after the change | — |
| `screen_tail_interval_s` | each agent's next screen capture | — |

The scheduler consumes `hard_ceiling` and `spawn_budget_multiplier`, the lease book
`lease_pools`, and admission `admission.*`; the other rows describe the contract the subsystems
that read them (monitors, decisions, spawning) follow. [`config.example.yaml`](config.example.yaml)
lists every key with its default and example pools, commented out.

---

## Spawning agents

`volleyd daemon` spawns an implementer for every admitted task (`--no-spawn` turns that off;
`volleyd spawn` starts one by hand). One spawn (`src/spawn.ts`) runs these steps through a
`Host` (`src/hosts/host.ts`; `local-cmux` is the local one), every command through the fence:

| # | Step | Module | Refusal (journaled as `alarm_raised { code }`) |
|---|---|---|---|
| 0 | **Repo trust**: is the repo root trusted in `~/.claude.json` (`projects[<root>].hasTrustDialogAccepted`, or a parent's)? | `trust.ts` | untrusted → decision `repo_untrusted` ("Needs you: trust `<repo>` for dispatch?"), the wave's spawns park on it |
| 1 | **Lock** `$VOLLEYD_HOME/locks/<worktree-hash>.lock`, `O_EXCL` | `locks.ts` | `SPAWN_LOCKED` |
| 2 | **Worktree** `git -C <repo> worktree add <worktree_root>/<wave>/<task>-<role> -b <wave>/<task>-<role>-<attempt> <release_branch>`; `.volley/` and `/ISSUE.md` appended to the repo's `info/exclude` once | `worktree.ts` | `WORKTREE_FAILED` |
| 3 | **ISSUE.md** from `gh issue view <n> --json number,title,body,url`, `<n>` from the wave file only | `issue.ts` | `ISSUE_MISMATCH`, `ISSUE_FETCH_FAILED` |
| 4 | **Brief** `briefs/<role>.md.tmpl` → `.volley/brief.md`, then the brief gate | `brief.ts` | `SPAWN_BRIEF_REJECTED` |
| 5 | **Identity** `volley auth add-agent <id> --ack-to <parent> --ack-to volleyd --json` → `.volley/agent.json` (mode 0600) | `identity.ts` | `CREDENTIALS_FAILED` |
| 6 | **Launch** `.volley/launch.sh`, then `cmux new-workspace --cwd <worktree> --name "<wave> <task> <role>" --command "  bash .volley/launch.sh"` | `launch.ts`, `hosts/local-cmux.ts` | `LAUNCH_FAILED` |
| 7 | **Verify** through the hook signals (below) | `verify.ts`, `screens.ts` | decisions, not refusals |

A refusal releases the lock, revokes credentials minted for the attempt and never launches.
The gate runs before credentials are minted, so a rejected brief costs nothing to undo. An
automatic spawn the loop got refused is retried with backoff (30 s, doubling, capped at 15 min);
`volleyd spawn` retries at once. While the kill switch is engaged nothing is spawned.

**Identity.** The agent id is `<wave>-<task>-<role>-<attempt>`, lowercased (a long wave id is
shortened with a hash). `.volley/agent.json` carries `agent_id`, `namespace`, `parent_id` (the
wave owner, else `volleyd`), `wave`, `task`, `role`, `broker_url` and the minted `broker`
block; the MCP server and the hooks both read it, so no flag or env carries identity.
`volleyd daemon --no-mint` skips minting for an anonymous broker (no `broker` block).

**Launch script.** `launch.sh` runs under bash (`#!/usr/bin/env bash`; login shells may be zsh),
exports `VOLLEY_HOOKS_DIR=<checkout>/packages/volley-hooks` and execs
`claude --dangerously-skip-permissions --model <model> --settings <hooks settings template> --name <id> "$(cat .volley/brief.md)"`.
The hooks come in through `--settings`, never `--mcp-config` (variadic: it would swallow the
prompt). The cmux command starts with two spaces, which keeps it out of shell history and away
from prompts that eat the first character. Nothing else is typed into the pane, with two
exceptions: the Enter that answers an update prompt and the relaunch after it (below), and the
Escape that `volleyd stop` sends. The brief never appears in an argv.

**Brief gate and extras.** If `$VOLLEYD_HOME/brief-gate` exists and is executable, it runs as
`brief-gate <worktree>/.volley/brief.md` in the worktree; a non-zero exit is
`SPAWN_BRIEF_REJECTED`. It is a local file rather than a config tunable on purpose: a gate is a
program, and tunables can be changed over the broker. Repo-specific brief text comes from
`<repo>/.volley/brief-extra.md` (kept out of git by the exclude above). See
[`briefs/README.md`](briefs/README.md).

### Lock semantics

The lock file holds `{ wave, task, role, attempt, agent_id, pid, at }`. A second spawn into the
same worktree asks about the holder's agent:

| Holder's agent | Verdict |
|---|---|
| retained status `spawning` / `registered` / `working` / `blocked` | live → `SPAWN_LOCKED` |
| retained status `done` / `failed` | stale → reclaimed |
| retained status `reaped` (the LWT, which a network blip also fires) | live until no heartbeat (and no lock write) for longer than `heartbeat_alarm_s`, then stale |
| no status, but a registry entry, or the writing process is another live pid | live |
| no status, no registry entry, no heartbeat (and no lock write) for longer than `heartbeat_alarm_s` | stale → reclaimed |

`blocked` is terminal in SPEC §5.2, but SPEC lets a blocked agent stay alive awaiting mailbox
guidance, so here it keeps its lock and credentials until it reaches `done`, `failed` or
`reaped`. The one relaunch after an update prompt keeps the lock and rewrites its holder
(attempt + 1). Retiring the agent releases it.

### Verification signals

Before launching, the daemon subscribes to `volley/_system/registry/<id>`,
`volley/<ns>/<id>/status` and `volley/<ns>/<id>/progress`. The expected sequence from the hooks
(`packages/volley-hooks`) is: MCP auto-registration (no `model_source`) → the SessionStart hook's
registry re-publish with `model_source` and `model` → status flipped to `working` → a
`progress` `heartbeat` with `hook_event: "SessionStart"`. A spawn is verified when **both** the
SessionStart heartbeat and a registry entry with `model_source` `harness-hook` or `unknown`
arrive within `spawn_timeout_s`; it is journaled as `agent_registered { model, model_source,
model_verified }`.

- `model_source: "harness-hook"`: the model id is compared exactly with the task's. Only an
  8-digit date suffix or a `[1m]` context suffix is ignored, so `claude-opus-5` is a mismatch for
  `claude-opus-5-5`. A mismatch opens decision `model_switch` and leaves the agent running.
- `model_source: "unknown"` (the hook input had no model): the terminal's status line is read
  once as the model source; unreadable → `model_verified: false`.

### Pre-hook screen table

Screens are read only in the window before the hooks run (afterwards the hooks are the source of
truth). When no SessionStart heartbeat arrived in time, the screen is captured to
`$VOLLEYD_HOME/waves/<wave>/screens/` and classified:

| Screen | Action |
|---|---|
| `trust_dialog` (folder-trust prompt) | decision `repo_untrusted` — never answered automatically |
| `update_prompt` (e.g. a shell's `update? [Y/n]`) | press Enter, then see below |
| `login`, `credit_exhausted` (a usage-limit prompt), `working` (Claude up, hooks silent), `shell_prompt`, `empty`, `unknown` | decision `unknown_screen`, pointing at the capture |

After the Enter the original launch gets `relaunch_settle_ms` (3 s) to continue. If its hook
signals arrive, or the screen shows anything but a bare shell prompt, the original attempt is
verified once more and nothing is typed. Only when the pane is back at a bare `shell_prompt`
(the prompt ate the launch command) is it relaunched, once, **in the same workspace**: the
first attempt is retired as `agent_retired { status: "superseded" }` (credentials revoked,
retained records cleared, lock kept), then attempt + 1 gets a new id and credentials and the
launch command is typed into that pane (`agent_spawned { recovered_from, recovery:
"update_prompt" }`). A second workspace is never opened in the same worktree. A second failed
verification opens `unknown_screen`.

### Journal mapping

The journal's event types are the closed `wave-event` enum, so the steps use it as follows:
refusals → `alarm_raised { code, … }`; a launch → `agent_spawned { agent_id, role, attempt,
host, workspace, worktree, branch, issue, credentials, lock }` (plus `stage_entered implement`
for an implementer's first attempt); verification → `agent_registered`; trust, model and screen
questions → `decision_opened { decision_id, kind, question, options, pointers }`, opened through
the decision store (retained on `volley/_waves/<wave>/decisions/<id>`, notify bridge; a
`repo_untrusted` one also carries `repo`); trust accepted later → `decision_resolved { answer:
"trusted", by: "claude-trust-dialog" }`; retire → `agent_retired`.

### Screen tails

The daemon is the only reader of agents' terminals (`src/screen-publisher.ts`). Every
`screen_tail_interval_s` (default 5 s, per-wave overridable) it reads each supervised agent's
workspace through its host (`cmux read-screen --workspace <ref> --lines 60` locally), cuts the
tail with `screenTail()` (`src/screen-tail.ts`: everything from Claude Code's input box down —
the rule above the `❯` prompt, any draft typed into it, the status bar — is dropped, `(ctrl+…)`
hints are removed, blank lines skipped; a screen without an input box keeps its last lines),
keeps the last 40 lines, and publishes a retained QoS 0 envelope on `volley/<ns>/<agent>/screen`:

```json
{ "agent_id": "volleyd", "channel": "screen", "type": "screen_tail",
  "payload": { "lines": ["…"], "captured_at": "…", "workspace": "workspace:3",
               "hash": "…", "source": "cmux" } }
```

A capture whose `hash` equals the last published one is not published. Every capture is also
emitted in-process (`ScreenPublisher.onCapture`), so other daemon subsystems reuse it instead of
reading the screen again. A read slower than 2 s (flagged the moment 2 s pass, not when the read
returns), or three failed reads in a row, backs that agent off to one capture every 30 s and sets
`screen_stale: true` on its task in the wave state (the Desk shows a stale marker) until a read
succeeds in time. Every read is bounded at 5 s; a read still pending then counts as failed.
Captures run on their own 1 s timer beside the daemon's serial queue, never on it, so a slow or
hung terminal cannot delay admissions, control ops or retire (the timer is off when `tickMs` is
0, as in tests). Retire stops the agent's capture — after any publish in flight, never waiting
for a read — and then clears the topic with an empty retained payload.

**Privacy.** A screen tail is whatever the agent's terminal shows, including anything an agent
printed — tokens, keys, file contents. It is published to the same broker as every other agent
record and has the same trust boundary: anyone who can subscribe to `volley/<ns>/+/screen` can
read it, so restrict broker access (per-agent credentials and ACLs) as for the rest of the
namespace.

### Retire and cleanup

When a supervised agent's `done` or `failed` status arrives, the daemon retires it. `reaped` (its
LWT) is retired only after the reap grace passes with no fresh status or heartbeat (see
[Recovery](#recovery): `heartbeat_alarm_s`, or `wake_grace_s` right after a host wake): a
network blip or an MCP-server restart also fires the LWT, and the assigned identity may
reconnect with a fresh `spawning` (SPEC §6.5). Retiring means `volley auth rm-agent <id>`, empty
retained payloads on its `registry`, `status`, `result`, `capability` and `screen` topics, the
lock released, and `agent_retired { status, terminal, result }` journaled. `terminal` is the
terminal status payload (`summary`, `pr_url`, `reason`, …) and `result` is the retained result,
so the cleared records live on in the journal. Only the wave's own agents, only terminal ones. Nothing on disk is deleted: `volleyd cleanup <wave>
--yes` closes the retired agents' workspaces and runs `git worktree remove` with the fence's
consent token (`--force` for dirty worktrees); worktrees of agents not yet retired are skipped,
and branches are never deleted.

Answering a `repo_untrusted` decision with `volleyd resolve <id> trust` (owner only) records
exactly `projects[<root>].hasTrustDialogAccepted: true` (`recordRepoTrust`; it re-checks the
file just before its rename and retries rather than drop a concurrent Claude Code write).
Accepting the dialog by hand in any worktree of the repo works too: every tick re-checks the
open `repo_untrusted` decisions, resolves those whose repo is now trusted, and the parked spawns
resume.

---

## Recovery

Once an agent is supervised, its hooks (volley-hooks) are the primary source of truth about what
it is doing; its screen is read only when the hooks go silent. `src/liveness.ts` folds every
`harness-hook` progress event of the agent (its own narration does not count) into an activity
model: the last hook signal (`at`, `seq`, `hook_event`), `working | idle | awaiting_input`, the
last Stop text, and what it is waiting on. Every monitor tick (10 s) checks it against the
agent's retained status. All rules are pure functions; the daemon carries out their actions.

| Signal | Action | What needs approval |
|---|---|---|
| `awaiting_input` with `permission_prompt` (bypass mode: the agent used `AskUserQuestion`) or `agent_needs_input` | decision `agent_question` at once, with the Stop text of the current idle (never an earlier turn's: `resumed` clears it; else the notification text) and a pointer to the agent's screen topic. No screen read | the answer: resolving it steers the answer to the agent (a numbered `steering`, acks tracked); `resumed` closes it if the agent went on by itself |
| `idle` (Stop) with no terminal status and no `resumed` for `idle_grace_s` (default 3 min; an `idle_prompt` confirms the idle sooner) | one steer: "Continue; publish done/blocked/failed when finished" | — |
| still idle `idle_grace_s` after that steer | decision `agent_stalled` (options `nudge again`, `stop task`) | the answer is steered to the agent and counts as the next nudge: a further decision only if it is still idle a full `idle_grace_s` later; `stop task` cancels it |
| `idle_prompt` while a question or credit prompt is open | nothing: still a wait on the human (never a "continue" steer or an `agent_stalled`) | — |
| `awaiting_input` with `class: "credit"` (`quota_auto_resume_*`) | `credit_exhausted` at once → decision `model_switch` (below) | the switch |
| no hook signal for `heartbeat_alarm_s` (default 10 min) while the status is `working` | read the screen (bounded, once per tick until decided) and classify it: | |
| ↳ the credit prompt (`screens.ts` `credit_exhausted`) | decision `model_switch` with the capture | the switch |
| ↳ readable and changing (two reads differ, or the screen-tail capture changed since the last hook signal) | decision `unknown_screen`, `class: "hooks_silent"`: "hooks may be broken by a harness update" | — |
| ↳ readable and unchanged on a second read | decision `unknown_screen`, `class: "screen_static"` | — |
| ↳ unreadable, pane gone | `alarm_raised { alarm: "crash_candidate" }` only: wait for the LWT. Nothing is killed because a pane or process cannot be seen | — |
| any hook signal | ends a silence; closes an open `hooks_silent` / `screen_static` decision | — |

Every recovery decision carries `class` and `agent_id` (on the journal event and the retained
topic) and answers `stop task` the same way: a `cancel` to the agent, an interrupt (Escape), and
`task_cancelled`. While one is open the task's `why_waiting` says what the agent is stuck on:
`question pending (decision d-…)`, `stalled: credit prompt (decision d-…)`, `hooks silent 12 min`,
`stalled: idle 9 min (decision d-…)`, `idle 4 min: nudged to continue`.

**Model switch (`src/recovery.ts`).** `credit_exhausted` opens `model_switch` with the options
`switch to <fallback_model>`, `wait`, `stop task` (`fallback_model` from the config store, read
when the decision opens; null → `wait` / `stop task` only). Nothing is typed into the agent's
terminal before the decision is resolved. On `switch to <m>` (or `switch`, meaning the fallback)
the daemon journals `alarm_raised { alarm: "model_switch_sent" }`, types `/model <m>` and Enter,
and waits up to 60 s for the hooks' PostModelSwitch registry re-publish naming `m` (an entry that
already named it does not count). Verified → `alarm_raised { alarm: "model_switch_verified" }`;
otherwise `model_switch_unverified` and the decision is re-opened (`class:
"model_switch_unverified"`) with a fresh screen capture. The same recovery fires at most twice
per agent per hour: the third credit exhaustion in an hour is decision only (no switch offered),
and an approved third switch is not typed (`alarm_raised { alarm: "recovery_limited" }`, the
decision re-opened as `class: "model_switch_limited"`, which says so). Models are never switched without approval. Known-screen actions
beyond this stay with spawning: `update_prompt` → Enter is pre-hook only.

**Sleep/wake (`src/clock.ts`).** Every tick samples a monotonic clock (stopped while the host
sleeps) and the wall clock; the wall clock running more than 60 s ahead between two samples
journals `wake_detected { jump_ms }` in `_system`. Liveness clocks restart at the wake (the sleep
is not silence) and liveness alarms are held for `wake_grace_s` (default 120 s). A `reaped`
status (an LWT) is never retired at once: it is held as a pending reap for the reap grace
(`heartbeat_alarm_s`; right after a wake at least `wake_grace_s`: a wake never shortens it). A
heartbeat from the agent after the LWT journals `reap_suppressed { agent_id, reaped_at,
heartbeat_at, wake }` and drops that reap for good: the agent stays supervised, however long it
then sits quiet, and a re-delivery of the same retained LWT changes nothing. The daemon never
republishes `working` on an agent's behalf (SPEC linearity), so its retained status stays
`reaped` until the agent publishes one; meanwhile liveness checks it as its last status before
the reap, so a session that really died ends in the silence path (`crash_candidate`, alarm
only). Only a new LWT is held again. No heartbeat by the end of the grace: the reap is accepted
(on the reap timer or the next tick) and the agent retired.

**Restart reconciliation (`src/reconcile.ts`).** On start (spawning on or off), for every task
that is not `done` / `merge_ready` / `cancelled`, its current agents — the latest spawn per role,
not retired — are compared with the retained registry entry and status, any heartbeat seen while
reconciling (the daemon keeps none across a restart, so only a live one counts), the worktree
lock, git (`rev-parse --verify` of the branch) and — for an agent that reported `done` while the
daemon was down — GitHub (`gh pr list --head`, `gh pr checks`). The probes run concurrently and
beside the serial queue, after the mailbox loop started (control ops are answered meanwhile);
one `reconciled { agent_id, drift, action?, branch: { name, exists, head } }` per agent is
journaled inside it:

| Finding | `action` | Then |
|---|---|---|
| consistent | none (`drift: []`) | the agent is watched again (status, hooks, screen tail) |
| the agent reported `done`, its PR exists and CI is green | `mark_done_verified` | `artifact_verified { pr }`; watched again, so its `done` retires it |
| any sign it may be alive (registry, live status, lock, recent heartbeat), or `done` without a green PR, or `failed` | `re_wait` | watched again; the normal status path takes over |
| no registry entry, no status, no heartbeat, no lock | `respawn_needed` | decision `agent_blocked`, `class: "respawn_needed"` (options `respawn`, `stop task`; `stop task` only with spawning off) — not a second one while it is open |

Nothing is respawned automatically — only on the owner's `respawn` answer, through the normal
spawn path (its lock check still applies). Either answer journals `agent_retired { status:
"gone" }` for the vanished agent (its minted credentials revoked), so no later restart
reconciles it again. Open recovery decisions are re-linked to the agent
they name when it is watched again, so `resumed` still closes them after a restart.

---

## Plan changes (versioned wave files)

Plans change while a wave runs. `volleyd run <wave.yaml>` with the id of a wave the daemon already
holds (running, paused or awaiting a decision) submits the file as that wave's **next version**:

1. The file is stored as `$VOLLEYD_HOME/waves/<wave>/v<N>.yaml`. The daemon numbers versions:
   the first submission is always `v1.yaml` (plan v1), whatever the file's own `version:` field
   says; that field is informational.
2. `wave_versioned` is journaled with the structural diff (`src/plan-diff.ts`: tasks added,
   removed, and changed — dependencies, issue, pipeline, model), the submitted plan and the
   effective plan, then the rule events below. A file with no changes is refused (`already
   submitted as vN`); the order of tasks or keys alone is no change. Other edits that are not
   structural (a title, a `files` hint, `config:`) still make a new version, with an empty diff.
   A different `repo:`, `release_branch:` or `namespace:` is refused: running agents work against
   them. A re-submission of a wave with an owner must come from that owner (`--owner`).
3. The rules (`src/plan-apply.ts`) apply mechanically, against the wave's current state:

| Change | Task not started | Task in flight (an agent spawned or spawning, or past `queued`) |
|---|---|---|
| task added | `task_queued` (a task removed earlier and re-added is re-queued) | — |
| task removed | `task_cancelled` (an admitted task gives its admission back) | untouched; decision `plan_change` "stop T3 (implementer working 14 min)?" — `stop` / `let finish` |
| `after` changed | the new dependencies apply (`waiting_on` re-evaluated) | not paused (it already started); its dependents re-evaluate |
| `issue` changed | applies | keeps the old issue; decision `plan_change` — `restart` / `let finish` |
| `pipeline` / `model` changed | applies | applies to stages not yet started; running agents keep theirs |

Tasks that finished (`merge_ready`, `done`) are left as they are. The scheduler and spawner use the
*effective* plan: the submitted one, plus removed in-flight tasks and in-flight tasks' old issues,
kept until their decision is answered. The wave state's `spec` is the plan as submitted and
`version` is the plan version; `volleyd status` shows `plan v3 (2 tasks pending decision)`.

`plan_change` decisions are ordinary [decisions](#decisions): opened through the decision store,
published retained on `volley/_waves/<wave>/decisions/<id>`, listed by `volleyd decisions` and
answered with `volleyd resolve`. Unlike other decisions they do **not** park their task — the
in-flight work is untouched until the answer. Each carries `change` (`removed` | `issue`),
`plan_version` and, for an issue change, `from_issue` / `to_issue`. The answers act:

- `stop` (task removed): the task's running agents get a mailbox `cancel` and an interrupt, and
  the task is `task_cancelled`.
- `restart` (issue changed): the same cancel, then the task is queued again on the new issue (if
  the current plan still points it there) and starts over.
- `let finish`: nothing; the task finishes on what it was doing.

A question is asked once. A later version does not ask again about a decision that is open or
answered; re-pointing an issue to yet another issue is a new question with a new id
(`plan_change-<hash of wave, task, change, version>`), and supersedes an open one
(`decision_resolved` with answer `superseded`). A later version that undoes a change withdraws its
open decision (answer `withdrawn`), and removing a task withdraws its open issue decision before
asking to stop it. A version's `config:` block replaces the wave's overrides.

```sh
volleyd diff 2026-10-20-example wave-v2.yaml   # + T6 / - T3 / ~ T2  after +T6; model a -> b
volleyd run wave-v2.yaml                        # submitted wave 2026-10-20-example plan v2
```

---

## The authority fence

`src/exec.ts` is the only place volleyd spawns a child process (a test enforces it), and it calls
`assertAllowed(argv)` first. Denials throw `FENCE_DENIED` naming the verb. The deny list is checked
before the allow-list, so widening the allow-list can never silently un-deny a verb. The policy,
verbatim from `src/fence.ts`:

```
DENY (never, consent or not):
  git merge | push | rebase | reset --hard | branch -D/-d/--delete/-m/-M/-c/-C/--force
  gh pr merge | gh workflow run | gh repo delete | gh api with any method other than GET
  infrastructure CLIs: terraform, terragrunt, kubectl, helm, aws, gcloud, gsutil, az, pulumi,
    ansible, ansible-playbook, eksctl, doctl, flyctl
  docker rm | rmi | container rm | image rm | volume rm | network rm | system prune
  rm -rf (any spelling that combines -r/-R/--recursive with -f/--force)

CONSENT (denied unless a ConsentToken from `volleyd cleanup --yes` is passed):
  git worktree remove · cmux close-workspace

ALLOW (program by bare name only — never a path):
  git [-C <dir>] [--no-pager] worktree add | fetch | rev-parse | log | diff | status |
    branch --list | merge-base | show
  gh issue view · gh pr view | list | checks · gh run list | view | watch · gh api (GET only)
  cmux new-workspace | list-workspaces | send | send-key | read-screen | ping
  claude (any arguments)
  volley auth add-agent <agent_id> [--ack-to <agent_id>]… [--json] [--no-reload]
  volley auth rm-agent <agent_id> [--no-reload]
  launchctl bootstrap | bootout | kickstart [-k] [-p] | print — only for the
    systems.volley.volleyd service
  pressure samplers, exact argv only: sysctl -n kern.memorystatus_vm_pressure_level ·
    memory_pressure (no arguments: report only) · docker info --format {{json .}}

SCRIPT (allowed only with a ScriptToken naming exactly that path): the brief gate
  (`$VOLLEYD_HOME/brief-gate`), the one program volleyd runs by path.

OPTIONS: every git and gh subcommand above has an exact option allow-list (GIT_SPECS and
GH_SPECS in src/fence.ts); any other option is denied — e.g. `fetch --upload-pack`/`-u`,
`--exec`, `--receive-pack`, `--config`, `--output`, `--ext-diff`, `--textconv`,
`gh api --hostname`, `--input`, `-F`. Bundled short flags and git global options other than `-C`/`--no-pager`
(`-c`, `--config-env`, `--exec-path`) are denied, as are subcommand aliases and `fetch`
transport-helper URLs (`ext::…`).
```

Anything else is denied — including shells (`bash -c`, `sh -c`), `env`/`sudo` wrappers, a path
as the program (`/tmp/x/git`), and git global options other than `-C`/`--no-pager` (git config
such as `-c alias.x=!…` can turn any subcommand into an arbitrary command). Each allowed git and
gh subcommand accepts only the options listed for it in `src/fence.ts`; an option that takes a
value must have it attached (`--depth=1`) or as a next argument that does not start with `-`, so
the fence and the tool always agree on where an option starts. `gh api` counts as a write when
it sends fields (`-f`) without an explicit `-X GET`. The wave-file schema also forbids a leading
`-` in `repo` and `release_branch`, so neither can ever be read as an option.

volleyd never merges, never pushes, never touches infrastructure: it stops at merge-ready and a
human merges.

---

## Running as a service (launchd)

```sh
volleyd install               # writes the plist and loads it
volleyd install --dry-run     # print the plist instead
launchctl kickstart -k gui/$UID/systems.volley.volleyd   # restart
volleyd uninstall             # unload + remove the plist
```

The plist (`launchd/systems.volley.volleyd.plist.tmpl`) runs `bun src/cli.ts daemon` with
`RunAtLoad` and `KeepAlive`, logs to `$VOLLEYD_HOME/volleyd.log`, and captures `VOLLEYD_HOME`,
`VOLLEY_BROKER_URL`, `VOLLEY_NAMESPACE` and your `PATH` (so `git`, `gh`, `cmux` and `claude`
resolve) at install time. Re-run `volleyd install` after changing any of them.

---

## Exit codes

Same table as `volley`: `0` success · `1` error (validation failure, daemon not running, broker
down, request rejected) · `2` usage error · `124` the daemon did not answer in time.
