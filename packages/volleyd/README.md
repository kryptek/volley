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

> **Status: pre-release (v0.4.0).** This package has the wave file, journal, reducer, scheduler,
> fence, config store, daemon, CLI and service (launchd on macOS; `volley setup` installs a
> systemd user unit on Linux), plus decisions, wave ownership, pause/stop
> and the kill switch, steering and overlap warnings, heavy-operation leases and load-aware spawn
> admission. It spawns each admitted task's agents (worktree, identity, cmux launch, hook-signal
> verification, per-worktree lock, retire), drives them through the review pipeline to a
> merge-ready gate and notices the merge, recovers stalled agents, applies mid-wave plan changes,
> publishes screen tails, and can run agents on a second machine over ssh + tmux. Since v0.3.0 it
> also answers the Desk's setup wizard and account ops (`setup_plan` / `setup_apply`, one-time
> sign-in links and admin tokens), pairs machines (`volley peer`) and runs agents under several
> Claude accounts (`volley claude`). Since v0.4.0 (the Fleet) it judges which machines can run
> an agent, places tasks across them with a "why here" line, and asks before re-placing anything
> when a machine goes down, gets busy or leaves (see Fleet below).

---

## Contents

- [Quick start](#quick-start)
- [The wave file](#the-wave-file)
- [CLI](#cli)
- [How it works](#how-it-works)
- [Leases](#leases)
- [Spawn admission](#spawn-admission)
- [Topics and the control channel](#topics-and-the-control-channel)
- [Accounts and one-time tokens](#accounts-and-one-time-tokens)
- [Claude accounts](#claude-accounts)
- [Decisions](#decisions)
- [Autopilot](#autopilot)
- [Ownership and claim](#ownership-and-claim)
- [Pause, stop and the kill switch](#pause-stop-and-the-kill-switch)
- [Steering](#steering)
- [Overlap warnings](#overlap-warnings)
- [Configuration](#configuration)
- [Spawning agents](#spawning-agents)
- [Fleet](#fleet)
  - [Fleet: readiness, the supervisor's card, Repair](#fleet-readiness-the-supervisors-card-repair)
  - [Fleet: placement](#fleet-placement)
  - [Fleet: down, overload, drain, remove](#fleet-down-overload-drain-remove)
- [Recovery](#recovery)
- [Plan changes (versioned wave files)](#plan-changes-versioned-wave-files)
- [The pipeline and the merge-ready gate](#the-pipeline-and-the-merge-ready-gate)
- [The authority fence](#the-authority-fence)
- [Running as a service (launchd)](#running-as-a-service-launchd)
- [Exit codes](#exit-codes)
- [Testing: the clock contract](#testing-the-clock-contract)

---

## Quick start

On a machine set up with `volley setup` (root README, quickstart step 2), volleyd is already
running as a service, logged in to the broker with `$VOLLEYD_HOME/broker.json`, and `volleyd` is
installed in `~/.volley/bin`. To run it by hand instead, from the repo root, after `bun install`:

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
# spawn_budget: 20           # default: every task's pipeline roles + 50% retry headroom (min 2), or spawn_budget_multiplier × task count if more
# heavy_pools: [backend-it]  # lease pools this wave's heavy commands draw from
# config: { hard_ceiling: 4 }  # per-wave overrides of any tunable but lease_pools (see Configuration)
# brief_preface: .volley/brief-preface.md  # the default; relative to repo, or absolute (see Brief preface)
# account: work              # the Claude account its agents run under (see Claude accounts)
# placement: auto            # place every task without a host: across machines (see Fleet: placement)
# placement_prefer: [box-a]  # machines placement ranks first
# placement_avoid: [box-c]   # machines placement uses only when nothing else is eligible
# merge: manual              # who merges a gated PR: auto (volleyd, at exactly the gated head) or
#                            # manual (a human); default: the autopilot.merge tunable (auto)
```

Per task: `issue` (required), `after`, `pipeline`, `model`, `title`, `host` (where its agents run:
`local`, a configured host's name, an inline ssh host, or `auto` to have volleyd place it; default
`local`, or `auto` under `placement: auto`), `heavy` (`true`: placement needs a free per-machine
slot in each of the wave's `heavy_pools`), `account` (overrides the wave's; see
[Claude accounts](#claude-accounts)), and `files` (a scheduling hint: paths the task will touch;
tasks overlapping active ones start later).

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
| `volleyd validate <wave.yaml>` | Validate locally; exit 1 with path-qualified errors, or `RELEASE_BRANCH_MISSING` when the wave's repo (if on this machine) has neither the release branch nor `origin/<branch>`. |
| `volleyd status [wave] [--by <id>] [--json]` | Wave state from the daemon, with open decisions, `needs you: N` on waves the caller owns and `alarms: N` (tasks whose spawn failed and has not recovered), and under the header the merge queue (`merge queue: T3 merging · T5 updating · T7, T9 queued`). `--json` prints the exact `wave_state` payload. |
| `volleyd decisions [wave] [--all]` | Open decisions (with `--all`, resolved ones too): question, options, evidence pointers. |
| `volleyd resolve <decision-id> <answer> [--rationale <why>] [--wave <w>]` | Answer a decision (owner only). |
| `volleyd merge <wave> <task>` | Merge one gated task now, at its gated head, through the merge queue's fenced verb (owner only; under `merge: manual` too). Answers with the merge commit, or the refusal ([The merge queue](#the-merge-queue)). |
| `volleyd policy [wave] [--json]` | Autopilot's effective policy table: the decisions volleyd answers itself, with each budget ([Autopilot](#autopilot)). `--json` prints `{ rules, config }`. |
| `volleyd claim <wave> [--by <id>]` | Take over a wave whose owner is gone. Needs an identity. |
| `volleyd pause <wave>` / `resume <wave>` | Stop / restart admissions (owner only); running agents carry on. |
| `volleyd stop <wave>` | Stop a wave (owner only): no admissions, `cancel` to every running agent. |
| `volleyd stop --all` / `resume --all` | Engage / release the kill switch (anyone). |
| `volleyd steer <wave> <task> <text> [--role <r>] [--wait-ack-ms <ms>]` | Mailbox steering to the task's live agent; reports `acked`, `received` or `delivered`, or `queued` for the task's next agent when none is live. |
| `volleyd events <wave> --cursor <name>` | Print (JSONL) every journal event after the named cursor. Does not move it. |
| `volleyd ack <wave> --cursor <name> --seq <N>` | Advance the cursor to `N`. Ack **after** acting, so a crash replays. |
| `volleyd config get [path] [--wave <id>] [--json]` | Effective config (or one dotted path), optionally with a wave's overrides. |
| `volleyd config set <path> <value> [--by <who>]` | Change a tunable at runtime (validated, journaled, hot-applied). `<value>` is YAML. |
| `volleyd admission [wave] [--json]` | The current spawn admission verdict: throttled or not, why, every pressure signal, per-wave verdicts (with a wave: that wave's only). |
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
machine-global **pool** (`lease_pools` in the config: `capacity`, optional `per_machine` and
`ttl_s`, and the `match` regexes the [volley-hooks](../volley-hooks/README.md) lease hook uses to
wrap matching Bash commands in [`volley lease run`](../volley-cli/README.md#volley-lease)).

- **Requests** arrive on `volley/_system/leases/<pool>/requests` (`acquire | release | renew`,
  SPEC §4.6.5). A request whose `holder` is not the sender is ignored; a repeated `acquire` for a
  lease already held or queued is a no-op; `release` of a queued request cancels it.
- **Grants** are FIFO, never past the pool's *current* capacity. The pool state is re-published
  retained after every request, with `reasons` such as `queued: 3/3 backend-it leases held`.
- **Machine-aware**: each held and queued lease records its holder's `host`, resolved when the
  request arrives from the holder's `agent_spawned` (its host; for this machine, its
  `fleet.local_name`, by default derived from the host name, e.g. `MacBook-Pro.local` is
  `macbook-pro`: never `local`), or `null` for a holder volleyd did not spawn (a hand-run
  `volley lease acquire`). A held lease keeps its host across renewals. A pool that sets
  `per_machine` (1 to `capacity`; unset means `capacity`, so a pool without it behaves as before)
  also caps the leases the holders on one machine hold at once: a grant needs a free slot under
  both caps, and a `null`-host holder counts toward `capacity` only. The earliest queued request
  both caps admit is granted, so a request its own machine's cap holds back does not block one
  from another machine behind it (FIFO still holds per machine), and its `reasons` line names
  that cap: `queued l-4: 1/1 backend-it leases held on box-a (per machine)`. The pool state
  carries `per_machine` and `held[].host` / `queue[].host`. `config_set` and `config.yaml` refuse
  a `per_machine` above `capacity` (`lease_pools.<pool>.per_machine: must be at most capacity
  (<n>)`), also when the patch lowers `capacity` under it.
- **A lease ends** on release, on TTL expiry (`ttl_s` of the request, else the pool's, else
  1 hour; `renew` restarts it — `volley lease run` renews at half the TTL), or when the holder's
  retained `status` turns `reaped`, `done` or `failed`.
- **Hot config, never preempt**: a capacity increase grants queued requests on the next tick; a
  decrease (of `capacity` or `per_machine`) stops granting until holders release; a removed pool
  keeps its holders, drops its queued requests (they never started; each gets `rejected
  <lease_id>: pool <p> removed from config`, and `volley lease run` then runs its command
  unleased), reports capacity 0 with `pool <p> removed from config: new requests rejected`,
  rejects new acquires and disappears when its last holder releases. Pools are machine-global:
  they come only from the global config, and a wave file that sets `config.lease_pools` is
  rejected.
- **Durable**: every grant/release/expiry is journaled as `lease_requested`, `lease_granted`,
  `lease_released` or `lease_expired` in the `_system` journal (mirrored on
  `volley/_waves/_system/events`); `lease_requested` and `lease_granted` (a renewal's too) carry
  the holder's `host`, and a restart replays it, so held leases and their per-machine counts
  survive. Requests sent while the daemon is down wait in its persistent session and are handled
  on the next start (the daemon drains them like its mailbox).

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
| `volley/_system/leases/<pool>` | yes | One lease pool: `capacity`, `per_machine?`, `held`, FIFO `queue` (each with the holder's `host`), `reasons`. |
| `volley/_system/leases/<pool>/requests` | no | Agents' `acquire` / `release` / `renew` (any agent may publish). |
| `volley/_system/admission` | yes | The spawn admission verdict after every pressure sample. |
| `volley/<ns>/<agent>/screen` | yes | Tail of a supervised agent's terminal (`screen_tail`, see [Screen tails](#screen-tails)). |
| `volley/_system/auth/ops/<username>` | no | An admin account's account ops (see [Accounts and one-time tokens](#accounts-and-one-time-tokens)). |
| `volley/_system/auth/replies/<correlation_id>` | no | The daemon's answer to an account op; secrets sealed to the requester's `reply_key`. |
| `volley-auth/redeem/<token id>` | no | A one-time token's redemption request, from that token's own login. |
| `volley-auth/redeem/<token id>/reply` | no | The daemon's answer to it: the one topic that login may read. |
| `volley/_system/claude/<acct>/signin` | no | A Claude account sign-in: its URL, then done / failed (see [Claude accounts](#claude-accounts)). |

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
| `diff` | `wave`, `wave_yaml`, `source?` | the structural diff between the wave's current plan and the file, plus `plan: { version, diff, unchanged }`; submits nothing |
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
| `spawn` | `wave`, `task`, `role?` (default `implementer`) | `{ kind: "launched", agent_id, workspace, worktree }`, or the spawn's decision `{ kind, decision, decision_id }`; outside admission. A failure carries `{ code, lock }` |
| `claude_accounts` | — | `{ root, accounts: [{ id, label, machine, created, plan?, signed_in_at?, dir, signin: { state, url?, flow?, attach? } }], primary: { plan? }, sharing }` |
| `claude_account_add` | `label`, `machine?`, `by` | answered once the sign-in URL is known: `{ account, acct, topic, url, flow, attach }` |
| `claude_signin` | `acct`, `by` | the same, for an existing profile |
| `claude_sync` | `acct?`, `by` | `{ synced: [{ acct, shared, mcp_servers? }] }` |
| `agent_move_account` | `agent`, `acct`, `by` | answered after the respawn: `{ agent_id, decision?, from, to }` |

`run` also takes `owner` and answers with `warnings: [...]` (overlap lines). `status` without a
wave adds `kill_switch: true` while the kill switch is engaged. `steer` answers once the ack
arrives or `wait_ack_ms` (default 30 s, at most 300 s) passes, and `run` answers once each task
issue's body has been fetched — neither wait blocks other control requests. A request redelivered
while its answer is still pending is not run twice; it gets the one answer.

---

## Accounts and one-time tokens

The Desk manages broker accounts through the daemon, never by creating logins itself
(SPEC §4.6.10). The daemon in turn only runs `volley auth` through the [fence](#the-authority-fence):
`volley auth` owns the accounts' and tokens' broker logins and `accounts.json` / `tokens.json` in
`$VOLLEY_AUTH_DIR`.

**Account ops** are not mailbox ops: anyone who may steer can write the daemon's mailbox, so the
mailbox cannot say who sent a request (the daemon refuses them there with a pointer). An admin
publishes `{ op, ..., reply_key }` (envelope `channel: "_system/auth"`, `type: "query"`, a fresh
`correlation_id`) on `volley/_system/auth/ops/<its username>`. The broker's admin role grants that
topic only to admin accounts and only for their own username (`%u`), so the topic names the sender; the daemon
then checks that account's role with `volley auth list --json` and refuses anything but `admin`.
`account_list`'s `last_seen` is the newest of the account's last auth request to this daemon
process and the `wall_time` of a retained registry entry or retained `status` (where the LWT lands)
under its name. Requests are never retained: the daemon clears a request topic's retained message
after each request, so a restart cannot replay one. `account_rotate` of the sender's own account is
refused: setting the new password disconnects the client holding the old one
before the answer arrives (rotate yourself with `volley auth rotate` or through another admin).

| `op` | Fields | `result` | `sealed` (decrypts to) | Journal (`_system`) |
|---|---|---|---|---|
| `account_list` | — | `{ accounts: [{ name, role, kind, created, label?, last_seen? }] }` | — | — |
| `account_create` | `name`, `role` (`admin` \| `steer` \| `watch` \| `supervisor` \| `peer`), `kind?` | `{ name, role }` | `{ username, password }` | `account_created { by, name, role, kind? }` |
| `account_rotate` | `name` | `{ name, role }` | `{ username, password }` | `account_rotated { by, name }` |
| `account_revoke` | `name` | `{ name }` | — | `account_revoked { by, name }` |
| `signin_link` | `role` (`steer` \| `watch`), `label`, `ttl_s?` (default 600), `desk_url?` | `{ role, label, expires_at, link_base? }` | `{ token }`; the link is `<link_base>#signin=<token>` (sealing the link too could exceed what RSA-OAEP fits) | `signin_link_issued { by, role, label, token_id, expires_at }` |
| `admin_token` | — | `{ token_id, expires_at }` | `{ token }` (`volley auth token --json`) | `admin_token_issued { by, token_id, expires_at }` |
| `setup_plan` | `lan?`, `repair?` | `{ steps: [{ step, title, found, changes: [{ summary, detail?, terminal? }], blocked?, skipped?, plan_id, lan? }], last_setup?, broker? }` | — | — |
| `setup_apply` | `step`, `plan_id`, `lan?`, `repair?` | `{ step, lines, problems, terminal?, restarting? }` | `{ token }` when the accounts step issued the one-time admin token | `setup_step_applied { by, step, summaries }`; `setup.log` lines with `by: "desk:<username>"` |
| `desk_password` | — | `{ username: "desk" }` | `{ username, password }`: the shared `desk` login's new password | `desk_password_issued { by }` |

**Setup ops** (`src/setup-ops.ts`) run `volley setup`'s own planners and steps (volley-cli's
`setup/`) for the Desk's wizard; no step logic lives in the daemon. Every command a step runs goes
through the fenced exec with a setup token (the fence's SETUP rows) behind the terminal's own fence
(volley-cli's `setupFence`);
nothing asks (the Desk's `setup_apply` naming a plan is the confirmation). Planning is fresh every
time, and `setup_apply` plans the step again, refusing with `plan changed` when its `plan_id`
differs, while an earlier step is `blocked`, or while another `setup_apply` runs (one at a time).
A change only a terminal can make carries `terminal: { reason, command }` and is never applied:
anything that needs `sudo` (the `etc` and `snap` layouts' broker config, state file and restart:
`sudo volley setup --step security [--lan|--no-lan]`), the `container` layout's restart (its own
command, from the host), volleyd's own service or password (either would stop the volleyd
answering: `volley setup --step services` / `--step accounts`), and the macOS keychain copy of the
coordinator's login (the logged-in session's: `volley setup --step accounts`). volleyd never reads
the keychain, so once the coordinator's login is on file the accounts step plans no keychain change
at all: its `notes` say that the keychain can't be checked from the Desk and that `volley setup`
checks it in a terminal (only a login that is new, or gets a new password, plans the copy there).
A Desk apply logs what it leaves for a terminal (`left` in `setup.log`); while a password the Desk
gave the coordinator has not been stored by a terminal's `--step accounts` since, the keychain copy
stays a terminal's change, and the note says it is stale and names the command. On a brew layout the
broker restart is applied last, after the answer is published (`restarting: true`); its result and
the step's checks land in `setup.log`, and the Desk re-plans once it has reconnected. Setup ops are
answered beside the daemon's serial queue, so a long step (the Desk build) never holds up waves.
Each command a step runs is killed after `setup_apply_timeout_ms` (110 s; the step's error then
says so). A step runs several commands, so its answer can come after the Desk's 120 s wait: the
Desk keeps listening for a late answer. Passwords `volley auth init` prints for a new identity
never reach the answer. The shared `desk` login's password, which no file keeps, is issued only by
`desk_password` (Setup & Security › New desk password), sealed to the admin who asked.

**Token redemption.** `volley auth token` prints a one-time admin token in the operator's
terminal; `signin_link` makes one for a phone. Each token is also the password of a short-lived
broker login named by the token id `<id>`, so the broker keeps `allow_anonymous false`. That login
holds only the `volley-token` role: it may write `volley-auth/redeem/<id>` and read
`volley-auth/redeem/<id>/reply` (`%u`), and subscribe to nothing else, so it sees nothing of the
tree and nothing of other tokens. The client connects as that
login, subscribes to the reply topic and publishes `{ op: "token_redeem", token, label, reply_key }`
on the request topic; the daemon refuses a token whose id is not the topic's, then pipes the token to `volley auth redeem --label <label> --json` on **stdin** (never argv),
which burns it and creates an account with the token's role (`admin-<id>` / `steer-<id>`),
journaled as `token_redeemed { by, name, role, label }` (`by` is the token id: the redeeming login). A used, expired or unknown token is
refused. The token's login is not removed during redemption (deleting it would disconnect the
client before it hears the answer): `volley auth` drops it about a minute after redemption
or once the token expires, and the daemon runs `volley auth list --json` every `token_prune_ms`
(when it uses broker auth) so that happens without anyone running a command.

**Answers** go to `volley/_system/auth/replies/<correlation_id>` (a `token_redeem`'s to `volley-auth/redeem/<id>/reply`) as an `ack` from `volleyd` with
`{ text: "ACKED", acked_type: "query", op, ok, error?, result?, sealed? }`. Every authenticated
client may read that topic, so passwords and sign-in tokens appear only in `sealed`: base64url
RSA-OAEP (SHA-256) ciphertext for the request's `reply_key`, an RSA public JWK of at least 2048
bits (WebCrypto: `generateKey({ name: "RSA-OAEP", hash: "SHA-256", modulusLength: 2048 })`, export
the public key as JWK, decrypt with the private one). An op that would return a secret without a
usable `reply_key` is refused before anything is created. A redelivered request (same topic and
`correlation_id`) gets the first answer again.

---

## Claude accounts

volleyd can run agents under several Claude accounts. Each account is its own Claude Code
profile: a directory under `~/.volley/claude/<acct>/` (`$VOLLEY_CLAUDE_DIR` moves the root) that
the agent gets as `CLAUDE_CONFIG_DIR`. `primary` is your own default profile (`~/.claude`, no
`CLAUDE_CONFIG_DIR`): what agents run under when nothing selects an account. The registry is
`~/.volley/claude/accounts.json` (`{ id, label, machine, created, plan?, signed_in_at? }`).
The primary is never in it: `claude_accounts` asks `claude auth status` of the default profile and
answers its plan as `primary: { plan? }` (none when it is not logged in or names no plan), and the
primary's usage record carries that plan from then on.
SPEC §4.6.11 is the contract; the accounts spike (`docs/claude-accounts-spike.md`) has the
evidence behind each choice below.

> **Terms note.** Volley never collects, stores or intermediates Claude credentials. Sign-in
> completes through Anthropic's own flow (`claude auth login`, in your browser); volleyd sees the
> authorize URL and the plan label, never a code, a token or a Keychain item. Usage limits assume
> individual use: several profiles are for an individual's own accounts, not for pooling or
> sharing one subscription among people.

```sh
volley claude add "Work"            # profile + background sign-in; prints the sign-in URL
volley claude add "Work" --wait     # … and waits until the sign-in finishes
volley claude signin work           # sign an existing profile in again
volley claude list                  # profiles, sign-in state, plan, sharing modes
volley claude sync [work]           # re-apply sharing.yaml, re-sync the MCP servers
volley claude move <agent-id> work  # stop an agent and respawn it under another account
```

**Sign-in.** `claude_account_add` creates the directory (`0700`) and registry entry, then runs
`claude auth login` under that `CLAUDE_CONFIG_DIR` in a detached tmux session
(`volley-signin-<acct>`, from a script the [fence](#the-authority-fence) seals) with `$BROWSER`
set to a helper that only writes down the URL Claude Code asks it to open. That URL redirects to
Claude Code's own listener on this machine, so open it in a browser **here**; the browser hands
the code straight back to the `claude` process. volleyd answers the op with the URL and publishes
`claude_signin_url { acct, url, flow, attach }` on `volley/_system/claude/<acct>/signin` (not
retained: whoever opens it first picks the account; not retained is not private — under the
example broker ACL every client, agents included, may read `volley/#` and so the URL while the
sign-in runs: restrict `volley/_system/claude/#` to the owner's clients to keep it from them), then polls `claude auth status` until
`loggedIn` → `claude_signin_done { acct, plan }`, or `claude_signin_failed { acct, reason }`
(the login exited, `claude_signin_timeout_ms` passed, or tmux is missing — then it tells you to
run `CLAUDE_CONFIG_DIR=<dir> claude auth login` yourself). Without a `$BROWSER` call the URL is
the one Claude Code printed (`flow: manual_code`): its page shows a code to paste into the
sign-in terminal (`tmux attach -t volley-signin-<acct>`), never into the Desk. `claude setup-token`
is never used: it prints a bearer token Volley would have to carry. The `_system` journal records
`claude_account_added`, `claude_signin_started` and `claude_signin_done` / `_failed`, never the
URL; while a sign-in waits, `claude_accounts` returns its URL for a client that attached late.

**Signing a paired machine in.** `claude_signin { acct: "primary@<name>" }` (the Desk's **Sign in
on <machine>**) signs a paired machine's own default profile in, with Claude Code's own flow on
that machine (`src/claude/remote-signin.ts`; every step a fenced REMOTE step over ssh). volleyd
reads the box's `$HOME`, writes the sealed `signin.sh` (no `CLAUDE_CONFIG_DIR`: the box's default
profile; the credential env unset) and `browser.sh` to `~/.volley/signin/primary/` there, and
starts `bash signin.sh` in the box's tmux session `volley-signin-primary`. It polls the url file
and the session's screen every `claude_signin_poll_ms`. For the localhost-callback URL's port *p*
it holds a transient forward, `ssh -N -L 127.0.0.1:p:127.0.0.1:p … <target>` (`src/claude/forward.ts`):
the same port on this machine's loopback as on the box's, because the OAuth redirect must match
verbatim. Only then does it publish `claude_signin_url { acct, url, flow: "browser_callback",
manual_url, attach: "ssh <target> -t tmux attach -t volley-signin-primary" }`: `url` opens in a
browser on **this** machine and the forward carries the callback to `claude` on the box (an opaque
encrypted pipe; no byte of it is read or logged). `manual_url`, the URL Claude Code printed, is for
a phone: its page shows a code, typed into the terminal `attach` reaches, never into Volley. A
forward that exits within `signin_forward_settle_ms` because the port is taken here (or a port a
broker tunnel uses, which is never forwarded) restarts the sign-in once (Claude Code picks a fresh
port), then fails naming the port. The box's `claude auth status` reporting `loggedIn` ends it with
`claude_signin_done { acct, plan }`. The timeout, the login exiting, the daemon stopping, ssh
failing or a box without tmux (the reason gives `ssh <target> -t claude auth login` to run by
hand) end it with `claude_signin_failed`. Every end kills the session (no consent: it holds no
agent's work) and the forward. A newer sign-in for the same machine supersedes it: its forward goes
at once and nothing more of it is published. A machine whose `claude auth status` already reports
`loggedIn` is refused (log it out with `ssh <target> claude auth logout` first). While it waits,
`claude_accounts` lists it under `remote_signins: [{ acct, state: "pending", url?, flow?, attach?,
manual_url? }]` for a late client.

**Selection.** An agent runs under its task's `account:`, else the wave's, else
`claude.default_account` (a tunable; `null` = primary), else the primary. `most_headroom` is the
signed-in account with the lowest 5-hour usage (see "Usage metering"), or the primary while no
account has usage data. An account that has not reported usage yet is not ranked, so a profile
at 80% wins over a primary that simply has not reported (it may be at 0%). A spawn under an unknown account, one
not signed in yet, or one on another machine is refused (`CLAUDE_ACCOUNT_UNAVAILABLE`, through the
usual spawn-failure retries). `launch.sh` then exports `CLAUDE_CONFIG_DIR` and unsets
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, so the profile's own login is the one claude uses (the fence
seals a `CLAUDE_CONFIG_DIR` only when it is exactly `<root>/<acct>` for an account in that root's
registry: a real directory, not a symlink, never in or above the agent's worktree; a root that is,
holds or sits in `$VOLLEYD_HOME` admits none);
`.volley/agent.json`, `agent_spawned` and the agent's registry entry record `claude_account`.
Folder trust is per profile: the spawn reads the profile's own `.claude.json`, and a
`repo_untrusted` decision carries `claude_config_dir` so a `trust` answer is recorded there.
Remote-host tasks run under the box's default profile: an account named for one is refused, and
the config default does not apply there.

**Sharing** (`~/.volley/claude/sharing.yaml`, `item: mode`): what each profile shares with the
primary. Applied before every spawn under a profile and by `volley claude sync`.

| Item | Default | Why |
| --- | --- | --- |
| `CLAUDE.md`, `agents`, `commands` | `linked` | read-only in practice |
| `skills`, `plugins` | `linked` | account-synced content lands in per-account buckets; installs from any profile affect all |
| `settings.json` | `copy` | `/model` and other settings writes go through a link into every profile |
| `mcp` | `copy` | the `mcpServers` section of `.claude.json`, re-synced from `~/.claude.json` |

`linked` is a symlink to `~/.claude/<item>` (Claude Code reads **and writes** through it);
`copy` is copied once, when the profile has none, and is the profile's own from then on; `own` is
never touched (a link volleyd made is removed). A real file or directory of the profile's own is
never replaced. `.claude.json` holds the profile's own account and is never linked or copied
whole: only `mcpServers` is rewritten, and `hasCompletedOnboarding: true` seeded once so a fresh
profile's first agent does not stop at onboarding (read → set that key → temp file `0600` →
rename, under Claude Code's own `.claude.json.lock/`; a lock older than
`claude_json_lock_stale_ms` was left by a crashed process and is taken over). MCP entries can carry third-party secrets (`env`,
`headers`), so volleyd never publishes or journals them (`claude_profile_synced` carries counts).
`.credentials.json` (Claude Code's fallback when the Keychain is locked) is never touched;
`test/no-credentials.test.ts` keeps every credential location out of `src/`.

**Moving an agent.** `agent_move_account { agent, acct }` journals `agent_account_moved
{ agent_id, role, from, to, by }` first, cancels the agent (mailbox `cancel` + Escape) and waits
up to `account_move_stop_ms` for its terminal status. Then it retires it (`moved`) and respawns
the role under the other account: a new attempt in the same worktree, with a resume note at the
end of its brief. A reviewer, fixup or rebase keeps its start point and its own attempt's worktree,
with the `.volley/` inputs it was given. The move is replayed from the journal, so later spawns of that task role keep
the new account. An agent that does not stop is not respawned (`ACCOUNT_MOVE_STOP_TIMEOUT`
alarm): two sessions never share a worktree. Nothing rotates accounts automatically.

### Usage metering

Every spawned agent's `--settings` (the hooks template) carries volley-hooks' statusLine
publisher, so Claude Code hands it the session's usage after each assistant message and it
publishes a retained sample on `volley/<ns>/<agent>/usage` (SPEC §4.6.12): the context window
(`used_percentage`, `used`, `size`) and the account's 5-hour and weekly windows (`pct`,
`resets_at`), at most every 15 s unless a percentage moved by more than a point. The daemon
folds the samples per account (the windows are the account's, so the newest sample carrying a
window wins) and publishes `volley/_system/claude-accounts/<acct>` retained: label and plan from
the registry, both windows, the agents on it and their waves. A sample that names no account
but a `CLAUDE_CONFIG_DIR` (a coordinator session under a profile) is matched to that profile.
Retiring an agent clears its `usage` topic, which drops it from its account's record; the
account's windows stay, across restarts too (`$VOLLEYD_HOME/claude-usage.json`, written on every
change and read back at start, not from the broker). A sample's wave and host come from the
agent's `agent_spawned`, so a sample retained while the daemon was down is attributed (and can
open `account_limit`) as soon as the restarted daemon reads it. A remote host's agent runs under
that host's own Claude login: its samples fold into `<acct>@<host>` (e.g. `primary@gpu-box`),
never the local `primary`, and that record opens no decision (a wave move cannot reach it).

When an account's 5-hour window reaches `claude.warn_at_pct` (default 90; a wave's `config:`
can override it), each running wave with agents on that account gets one wave-level
`account_limit` decision: `acct`, `pct`, `resets_at`, and `suggested`, the account with the
most headroom among those under the threshold in both windows, else a signed-in account that
has not reported 5-hour usage yet (labelled "no usage yet", or "no 5-hour usage yet" when it has
reported weekly usage; a signed-in profile before `primary`, whose interactive use goes
unreported; none: only `not now`), with
the options `move wave <w> to <suggested>` and `not now`. It is not asked again while open,
nor for the same window once answered. **Nothing switches on its own.**
Answering `move wave <w> to <acct>` (any signed-in account, not only the suggestion; an unusable
one is refused and the decision stays open) journals `wave_account_moved { from, to, by,
decision_id }`: the wave's new agents that would have started under `from` start under `to`,
and running agents finish where they are. The weekly window is informational. The same data
resolves `most_headroom`.

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
- **Notify bridge**: every open that stays open (one [Autopilot](#autopilot) did not answer)
  also publishes a `blocked`-typed progress envelope on the daemon's own topic, so an existing
  `volley notify` rings with no new surface:

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

**A blocked agent.** An agent of any role (implementer, either reviewer, fixup, rebase or merge)
that publishes `status: blocked` (SPEC §5.1) gets an `agent_blocked` decision on its task, with
its reason (`payload.reason`, else `summary`, else `text`; clipped to 500 characters in the
question, whole in the decision's `reason` and `payload`) and the options:

- `continue`: you steered the agent by hand (or it will go on by itself); the task returns to its
  stage and volleyd waits for the agent's next status. A later `blocked` asks again.
- `respawn`: the agent is retired (`relaunched`) and the role's next attempt is spawned.
- `cancel`: the agent is retired (`stopped`) and the task cancelled.

The agent is never retired while the question is open: SPEC §5.2 lets a blocked agent stay alive
waiting for mailbox guidance, so it keeps its lock and login. The decision carries the status's
`wall_time` (`status_at`), so the same retained status re-delivered after a restart is not asked
about twice.

## Autopilot

Most decisions have one obvious answer: retry, relaunch once, treat a disputed P1 as a blocker,
nudge once more, raise the spawn budget by what the wave needs. volleyd gives those answers itself
(SPEC §4.6.16), from a policy table that is data in one module (`src/autopilot/policy.ts`, pure),
within per-wave remediation budgets, and journals every answer. What the table cannot answer is
left for you, with one push.

- **Answered**: when a decision opens, in the same serial turn, volleyd journals
  `decision_auto_resolved { decision_id, kind, policy, answer, rationale, evidence, budget? }`
  and then the ordinary `decision_resolved { by: "volleyd" }`, once the answer is accepted (a
  refused answer journals neither and spends no budget). The retained decision is published
  resolved and cleared like any other; the notify bridge does **not** ring for it. A decision a
  launch opens while it is being verified is answered only once that agent is supervised, so a
  relaunch never retires an agent volleyd is not yet watching.
- **Escalated**: a decision no rule answers (`no_policy`), one whose kind is in
  `autopilot.owner_only` (`owner_only`), one whose budget is spent (`budget_exhausted`), or one
  whose answer could not be applied (`unattended_safety`, e.g. an account move the account
  registry refuses) stays open. volleyd journals `decision_escalated { decision_id, kind, why,
  budget? }`, its retained `question` starts with `Autopilot could not resolve this (<why>): `,
  and only then does the notify bridge ring.
- **Never an answer the decision does not offer**: a rule whose answer is not in the decision's
  `options` escalates `no_policy` (a free-text decision, `agent_question`, offers none and takes
  any answer).
- **Budgets** are per wave and key: `relaunch_max` and `respawn_max` per `<task>/<role>`,
  `nudge_max` and `question_max` per run (`<task>/<role>/<attempt>`), `rereview_max` per task,
  and `budget_raise_max`, a multiple of the wave's derived spawn budget that `raise by <n>`
  answers may reach. Each is reduced from the journal's `decision_auto_resolved` events, so a
  restart keeps them.
- **Off**: `volleyd config set autopilot.enabled false` (or a wave's `config: { autopilot: {
  enabled: false } }`) takes effect at the next decision: nothing is answered or escalated, and
  every decision waits for you as before.

`volleyd status` prints `autopilot: on · N auto-resolved · M escalated` under each wave header,
and the wave state carries `autopilot: { enabled, auto_resolved, escalated, budgets: { <key>: {
used, max } } }`. The table, as `volleyd policy` prints it with the default config (rules are
tried in order; the first whose kind and condition match wins):

```text
autopilot: on
  plan_change, repo_untrusted, model_switch, release_go, stage_go · always · escalate owner_only · no budget
    owner_only: autopilot.owner_only: only the owner answers these
  spawn_failed · next_retry_at !== null (the daemon still retries) · retry now · no budget
    spawn_failed/retrying: the daemon retries with backoff; the question is informational
  spawn_failed · retries stopped (next_retry_at === null) · escalate budget_exhausted · no budget
    spawn_failed/retries-stopped: spawn_retry_max is the budget
  hooks_auth_failed, mcp_not_registered, unknown_screen · pipeline.on === "relaunch" · relaunch · relaunch_max per <task>/<role> · max 1
    relaunch/bad-launch: one relaunch fixes a bad launch; a second needs eyes
  unknown_screen · class: hooks_silent or screen_static (liveness) · keep running · no budget
    unknown_screen/alive: the agent is alive; the LWT or its status has the last word
  reviewers_disagree · always · blocker · no budget
    reviewers_disagree/blocker: the fixup applies it; the P1 reviewer's view costs one fixup, never a bad merge
  agent_stalled · asked === 1 · nudge again · nudge_max per <task>/<role>/<attempt> · max 1
    agent_stalled/nudge: one more nudge
  agent_stalled · asked > 1 · respawn · respawn_max per <task>/<role> · max 1
    agent_stalled/respawn: a second stall needs a fresh agent (escalated no_policy while the decision does not offer respawn)
  agent_blocked · pipeline.on === "agent_failed" or class: respawn_needed · respawn · respawn_max per <task>/<role> · max 1
    agent_blocked/respawn-failed: a fresh agent picks the work up where the failed one left it
  agent_blocked · pipeline.on === "review_result" or "fixup_result" · respawn · respawn_max per <task>/<role> · max 1
    agent_blocked/respawn-result: a fresh agent publishes the result; skip would lose a review
  agent_blocked · pipeline.on === "merge_ready_invariant" · rereview · rereview_max per <task> · max 2
    agent_blocked/rereview-stale: a re-review is the safe way past a stale review
  agent_question · within question_max per run · Proceed with your best judgement and the issue as written; you are running unattended. If you truly cannot continue, publish blocked with the reason. · question_max per <task>/<role>/<attempt> · max 1
    agent_question/unattended: what a hand coordinator answered
  spawn_budget_exhausted · used + n <= derived budget × budget_raise_max · raise by <n> (n from the option) · budget_raise_max (× derived budget) · max 2
    spawn_budget_exhausted/raise: retries are the normal cost of a long wave
  machine_down · re-place queued tasks offered · re-place queued tasks · no budget
    machine_down/re-place: nothing is lost by re-placing a queued task
  account_limit · suggested !== null · move wave <wave> to <suggested> · no budget
    account_limit/move: the daemon suggested a healthy account
  account_limit · suggested === null · not now · no budget
    account_limit/wait: no account has headroom: wait for the window to reset
  pr_head_moved · a green merge of the release branch only (accept offered) · accept · no budget
    pr_head_moved/accept: a release-branch merge into the PR is not new code
  pr_head_moved · otherwise (rereview offered) · rereview · rereview_max per <task> · max 2
    pr_head_moved/rereview: nobody reviewed the new head
  wave_complete · always · acknowledged · no budget
    wave_complete/acknowledge: the end of a wave needs no answer; the owner reads its outcome
  ci_failed · always (ci_none included) · escalate no_policy · no budget
    ci_failed/owner: a CI fixup and the flake route need pipeline work; a repository without workflows is the owner's
  merge_conflict · within respawn_max per task/role · respawn · respawn_max per <task>/<role> · max 1
    merge_conflict/respawn: a fresh rebase (or merge) agent retries the update; a conflict it cannot resolve either is the owner's
  pr_closed, remote_repo_missing · always · escalate no_policy · no budget
    pr/owner: where the work went, or a clone that is missing, is the owner's call
```

---

## Ownership and claim

Every wave has one **owner**, the coordinator that submitted it — the single writer. It comes
from `volleyd run --owner <name|id>`, else is auto-detected (`VOLLEY_AGENT_ID`, else
the session registered for the caller's directory — its coordinator name when it has one — else
`VOLLEY_COORDINATOR`; printed as `owner: … (auto)`), else `null` (unowned). The exported name comes
last so a supervised worker whose shell inherited it acts as itself: the MCP server also ignores
`VOLLEY_COORDINATOR` under a `.volley/agent.json` identity, and `launch.sh` unsets it. `resolve`, `pause`,
`resume`, `stop`, `steer` and re-running the wave id require `by == owner` (or the agent bound to
it, below); anyone else is refused with the owner's id. An unowned wave accepts anyone.

**Coordinator names.** The MCP server appends a fresh suffix to `VOLLEY_AGENT_ID` at every start,
so an owner that is an agent id is lost when the session's MCP server restarts. Set a stable
**coordinator name** once in the MCP registration's `env` block instead —
`"VOLLEY_COORDINATOR": "coord-main"` (agent-id grammar: `[a-z0-9][a-z0-9_-]{0,62}`) — and submit
with `--owner "$VOLLEY_COORDINATOR"`. The server publishes the name in its registry entry
(`coordinator`) and `vol_register` returns it beside `agent_id`. volleyd watches the registry and
binds each name to the newest live entry carrying it (status not `reaped`/`done`/`failed`): that
agent may do everything the owner may, any other is refused. When a new agent binds to a name
that owns waves, volleyd journals `owner_reconnected { owner, agent_id, previous_agent_id }` in
each unfinished one and re-publishes their state — nothing is claimed, ownership does not move, so one
session keeps all its waves across restarts. The wave state's `coordinator.agent_id` is the bound
agent; when it goes away (terminal status, or its LWT) with no other agent binding the name,
`coordinator.state` is `reconnecting` for `autopilot.reconnect_grace_s` (default 900), then
`gone`. Until another agent binds the name, the binding stays on that departed agent id (that is
what lets the state read `reconnecting`), but its id is no longer accepted for the name: only the
name itself, or the next agent to bind it, may act. `volleyd status` prints such an owner as `owner: coord-main (via coordinator-c7d9)`.

`volleyd claim <wave>` hands the wave to the caller when the owner is gone: its retained status
is `reaped`, `done` or `failed`, or nothing has been heard from it — registry entry, status,
any event on its `progress` channel (heartbeats) — for `claim_after_s` (config, read at claim
time, so a `volleyd config set claim_after_s …` applies to the next claim). Otherwise the claim
is refused, naming the owner. A claim is journaled as `owner_claimed { owner, previous, why }`.
For a coordinator-name owner, liveness is the newest binding's — never an agent id the name has
left — and a bound agent that went away frees the wave only after `claim_after_s`, since it may
come back under a new id. The two timers are independent: with `claim_after_s` shorter than
`autopilot.reconnect_grace_s`, a wave still shown `reconnecting` can already be claimed.

Silence is never measured from before the owner got the wave (its `wave_submitted` or latest
`owner_claimed`) or from before the daemon started, because heartbeats are remembered in memory
only: an owner the broker has never seen, or one the daemon has not heard from since a restart,
becomes claimable only after a full `claim_after_s`. A claim must name a stable identity (`--by`,
`VOLLEY_AGENT_ID`, a registered session or `VOLLEY_COORDINATOR`); the CLI's own per-invocation id is never used.

## Pause, stop and the kill switch

- `pause <wave>`: no new admissions; running agents continue. Held tasks show
  `why_waiting: "wave paused"`. `resume <wave>` re-admits.
- `stop <wave>`: journals `wave_stopped` (no new admissions), then sends a mailbox `cancel`
  to every running agent of the wave (journaled as `steering_sent { type: "cancel" }`). The
  daemon also interrupts each agent: with spawning on, Escape into its cmux workspace (from its
  `agent_spawned`); with `--no-spawn`, only the mailbox cancel is sent. The wave's agents leave
  screen capture at once. Agents then get `stop_grace_s` (default 30 s, a tunable, on the
  daemon's clock) to publish a terminal status; one that acks is retired as usual. Every agent
  still running when the grace ends is **force-retired** without its ack, through the same
  delete path as a retire: `agent_force_retired { agent_id, role, reason: "stop" }`, then its
  retained `registry`/`status`/`progress`/`result`/`capability`/`screen`/`usage` records are cleared, its
  login deleted, its lock released (`agent_retired { status: "stopped" }`), so the Desk stops
  drawing it; their logins are deleted together, in one control message, so no broker login
  outlives a stop. A daemon restarted into a stopped wave gives its agents what is left of the grace
  (counted from `wave_stopped`), then force-retires what is left; a workspace ref read back from
  the journal is closed only when it still names that agent (a UUID or its own tmux session; a
  short `workspace:<n>` ref may name another workspace by then, so it is left for `cleanup --yes`
  with `workspace_closed: false`). A stopped wave can be resumed explicitly; resumed within the
  grace, its agents carry on and their screens are captured again. Known gap until the pipeline stages can respawn: `stop` journals
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
names the previous steer, so the recipient can drop stale guidance (a [merge
nudge](#the-pipeline-and-the-merge-ready-gate) is additive: it supersedes nothing, and the next
steer supersedes the one before the nudge). The steer is journaled as
`steering_sent`. The command then waits up to `--wait-ack-ms` (default 30000) and reports:

- `acked by <agent>`: the recipient published `type: "steering_acked"` on its own `progress`
  channel with `correlation_id` = the steer's message id (SPEC §4.3) — the model acted on it;
- `received`: only its SPEC §4.4 mailbox `ack` (to `volley/<ns>/volleyd/mailbox`) arrived;
- `delivered`: neither arrived in time.

Only the steered agent's acks count (the progress topic or the ack envelope must name it).

A steer never goes to a retired agent (`task.agents` keeps the last agent per role after it is
retired, and nobody drains its mailbox). When the task has no live agent, between stages or before
its next agent is up (with `--role`, none in that role), the steer is **queued**: journaled as
`steering_queued` (same `seq` / `supersedes` numbering), answered at once with
`delivery: "queued"` and `queued_for` (the role, else `next agent`), with no ack wait. The wave
state's `tasks[].queued_steers` counts them and `volleyd status` prints `steer queued (n)`. The
next agent of the task to register (of that role, when one was named) gets every matching queued
steer in order, with the id and `seq` it was queued with, journaled as `steering_sent` with
`queued: true`. A steer sent after the next agent is spawned but before it registers goes to it
directly, so it can arrive ahead of the queued ones; its `seq` is still the higher one, so order
by `seq`. A task that is cancelled or done, or a wave that stops, drops its queue
(`steering_dropped { message_ids, reason }`); the journal keeps it across a restart. `urgent` /
`escape_only` with no live agent is an error (`no live agent to interrupt`), a task that is
done, cancelled or blocked cannot be steered, and a stopped or complete wave queues nothing.

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
| `claim_after_s`, `heartbeat_alarm_s`, `idle_grace_s`, `background_wait_max_s`, `stall_backoff_max_s`, `wake_grace_s` | next monitor tick | — |
| `fallback_model` | decisions opened after the change | open decisions keep their offer |
| `mailbox.session_expiry_s` | new connections only | existing sessions keep their expiry until they reconnect |
| `worktree_root` | spawns after the change | existing worktrees untouched |
| `spawn_timeout_s` | spawns after the change | — |
| `spawn_retry_max_s`, `spawn_retry_max` | the next failed spawn | a retry already scheduled keeps its time |
| `brief_preface_max_bytes` | the next `run` and the next spawn | briefs already written untouched |
| `screen_tail_interval_s` | each agent's next screen capture | — |
| `stop_grace_s` | the next `stop` | a grace already running keeps its length |
| `autopilot.reconnect_grace_s` | the next wave-state publish ([ownership](#ownership-and-claim)) | — |
| `dynsec_batch_ms` | the next batch of broker login changes | — |
| `credential_sweep_interval_s` | after the next sweep | — |
| `hosts` | spawns after the change (and the next tunnel check) | running agents and their tunnels untouched |
| `claude.default_account` | spawns after the change | running agents keep their account (move one with `agent_move_account`) |
| `require_fresh_base` | spawns after the change ([base ref](#base-ref)) | worktrees already cut untouched |
| `retire_close_session` | retires after the change ([retire and cleanup](#retire-and-cleanup)) | sessions already kept open stay open |
| `placement.nudge_on_merge` | the next merge ([the merge nudge](#the-pipeline-and-the-merge-ready-gate)) | nudges already sent stand |
| `autopilot.merge` | the next gate of a wave whose file has no `merge:` ([autopilot merging](#autopilot-merging)) | a gate already entered keeps the mode its evidence names until it is gated again |
| `autopilot.merge_retry_max` | the next refused merge ([autopilot merging](#autopilot-merging)) | refusals already counted stand |
| `branch_update` | rebase steps started after the change | a step already running keeps the mode it started with (its brief, `.volley/rebase.md` and its verification agree) |
| `agent_mcp` | spawns after the change | running agents keep the MCP servers they launched with |
| `public_hygiene` | the next wave version (`run` of a new wave, or a new version of a live one) | the level journaled for the current version holds for its reviewers and their results |

The scheduler consumes `hard_ceiling` and `spawn_budget_multiplier`, the lease book
`lease_pools`, and admission `admission.*`; the other rows describe the contract the subsystems
that read them (monitors, decisions, spawning) follow. [`config.example.yaml`](config.example.yaml)
lists every key with its default and example pools, commented out.

`worktree_root` defaults to `~/.volley/worktrees`, or to `$VOLLEYD_HOME/worktrees` when
`VOLLEYD_HOME` is set (so a second daemon — a smoke run — keeps its worktrees beside its state);
`config.yaml` or a wave's `config:` still wins.

---

## Spawning agents

`volleyd daemon` spawns an implementer for every admitted task (`--no-spawn` turns that off;
`volleyd spawn` starts one by hand). One spawn (`src/spawn.ts`) runs these steps through a
`Host` (`src/hosts/host.ts`; `local-cmux` is the local one, `ssh-tmux` a
[remote one](#remote-hosts-ssh--tmux)), every command through the fence:

| # | Step | Module | Refusal (journaled as `alarm_raised { code }`) |
|---|---|---|---|
| 0 | **Repo trust**: is the repo root trusted in `~/.claude.json` (`projects[<root>].hasTrustDialogAccepted`, or a parent's)? | `trust.ts` | untrusted → decision `repo_untrusted` ("Needs you: trust `<repo>` for dispatch?"), the wave's spawns park on it |
| 1 | **Lock** `$VOLLEYD_HOME/locks/<worktree-hash>.lock`, `O_EXCL` | `locks.ts` | `SPAWN_LOCKED` |
| 2 | **Worktree** `git -C <repo> worktree add <worktree_root>/<wave>/<task>-<role> -b <wave>/<task>-<role>-<attempt> <base>`, `<base>` the release branch as origin has it ([base ref](#base-ref)); `.volley/` and `/ISSUE.md` appended to the repo's `info/exclude` once | `worktree.ts` | `BASE_STALE`, `RELEASE_BRANCH_MISSING`, `WORKTREE_FAILED` |
| 3 | **ISSUE.md** from `gh issue view <n> --json number,title,body,url`, `<n>` from the wave file only | `issue.ts` | `ISSUE_MISMATCH`, `ISSUE_FETCH_FAILED` |
| 4 | **Brief** the [brief preface](#brief-preface), then `briefs/<role>.md.tmpl` → `.volley/brief.md`, then the brief gate | `brief.ts` | `BRIEF_PREFACE_TOO_LARGE`, `SPAWN_BRIEF_REJECTED` |
| 5 | **Identity** one Dynamic Security `createClient` (username = agent id, role `volley-agent`), batched with the wave's other mints → `.volley/agent.json` (mode 0600) | `identity.ts`, `dynsec.ts` | `CREDENTIALS_FAILED` |
| 6 | **Launch** `.volley/mcp.json` + `.volley/launch.sh`, then `cmux new-workspace --cwd <worktree> --name "<wave> <task> <role>[ <attempt>]" --command "  bash .volley/launch.sh"` (with the stored cmux socket password in its environment) | `launch.ts`, `hosts/local-cmux.ts` | `LAUNCH_FAILED` (cmux refusing volleyd or not running: says how to fix it) |
| 7 | **Verify** through the hook signals (below) | `verify.ts`, `screens.ts` | decisions, not refusals |

A refusal releases the lock, revokes credentials minted for the attempt and never launches.
The gate runs before credentials are minted, so a rejected brief costs nothing to undo. A
refused spawn is never silent ([failures and retries](#spawn-failures-and-retries)); `volleyd
spawn` retries at once. While the kill switch is engaged nothing is spawned.

### Base ref

An agent's branch is cut from the wave's release branch **as origin has it**: the branch is
often pushed from another clone (`git push -u` in a batch setup), so the daemon's clone may
know it only as `origin/<release_branch>`, or have a stale local copy. Before `worktree add`,
volleyd runs `git -C <repo> fetch origin <release_branch>`, then picks the base:

| The repo has | Base |
|---|---|
| only `origin/<b>` | `git branch --track <b> origin/<b>`, then `<b>` (`origin/<b>` if that fails) |
| both, the local `<b>` behind `origin/<b>`, or diverged from it (origin has commits the local one lacks) | `origin/<b>` |
| the local `<b>`, level with or ahead of origin's (or never pushed) | `<b>` |
| neither | refused: `RELEASE_BRANCH_MISSING: <repo> has neither <b> nor origin/<b> — push it first` |

`git fetch` is bounded (30 s) and never prompts for credentials; a timeout counts as a failed
fetch. A failed fetch (offline, no remote, a timeout) refuses the spawn while
`require_fresh_base` is on (the default, on every host): `BASE_STALE: git fetch origin <b> failed
in <repo> (<git's first line>); … Fix: …`, a [spawn failure](#spawn-failures-and-retries) like any
other, retried with the usual backoff, so no agent starts from a stale copy of the release branch.
A failure no retry can fix is refused up front instead, by `volleyd validate` and `run` (before
any task is admitted): a repo with no `origin` remote (validate reads its git config, offline),
or (`run`, after its fetch) an `origin` without `<b>`. The refusal is one sentence and the fix:
add the remote and push the branch, or `volleyd config set require_fresh_base false` (or
`config: { require_fresh_base: false }` in the wave file) to work from the local copy, which is
the setting for a repo that lives on this machine only. With `require_fresh_base: false` the base
is picked from what the repo has and the spawn goes on; the wave journals a warning,
`alarm_raised { code: "BASE_STALE", severity: "warning", base_sha, fetch_error }`. That warning is
in the journal and the `/events` mirror only (not in `tasks[].alarms`); the task's `base_sha`
says where it started.

The commit the worktree was cut from is the spawn's `base_sha`: on its `agent_spawned` event, on
the task in the wave state (`tasks[].base_sha`, kept across restarts and pipeline roles cut from
a start commit) and in the [evidence package](#the-pipeline-and-the-merge-ready-gate)
("cut from `<sha7>`, N behind"). When a task of the wave runs on the local host, `volleyd validate` checks the same
(locally or `origin/<b>`, offline — it says to fetch a branch pushed from another clone) when
the wave's repo is on its machine, and the daemon fetches, then refuses `run` with
`RELEASE_BRANCH_MISSING` before any task is admitted (`<repo> is not a git repository` for a
directory that is not one). A pipeline role cut from a start commit
(reviewers, fixups) uses that commit as given (no `base_sha`). A remote host fetches and cuts
from `origin/<b>` on the box, under the same `require_fresh_base` rule, and reports the commit
it cut from.

### Spawn failures and retries

Every refused spawn — the daemon's automatic ones (implementers, pipeline roles), and
`volleyd spawn` — is visible:

- the journal gets `spawn_failed { code, message, role, attempt, next_retry_at }` (besides the
  step's `alarm_raised`), and the daemon log a `spawn <wave>/<task>/<role> failed (<code>),
  attempt <k>: retry in <n>s` line;
- the task's `why_waiting` reads `spawn failed: <code> — retry in <n>s (attempt <k>)`, and its
  wave-state entry carries `last_error { code, message, at }`, `attempt` and `next_retry_at`
  (`volleyd status --json`); the `volleyd status` header counts these open alarms
  (`alarms: N`);
- **one** `spawn_failed` decision opens on the task (options `retry now` / `stop task`; it does
  not park the task) and is not re-opened while it is open.

Automatic retries back off: 30 s, doubling per failure, capped at `spawn_retry_max_s`. After
`spawn_retry_max` failures in a row they stop: `next_retry_at` is `null`, `why_waiting` says
`retries stopped after <k> attempts`, and the open decision is superseded (resolved
`retries_stopped`) by one whose question says the retries stopped. Answering `retry now` spawns
at the next tick whatever the backoff said; `stop task` cancels the task.

A spawn that launches after failures journals `spawn_recovered { role, agent_id,
after_failures, attempt }`, clears `last_error` / `why_waiting`, resolves the open decision
(`recovered`, by `volleyd`), and the log prints `spawned <agent_id> (<wave>/<task>/<role>)`.
Failures are counted per role (two reviewers of one step fail and back off independently) and
per agent attempt; the task shows its most recent one, and its decision resolves once no role
is still failing. The backoff carries over a restart: the retry runs when the journal's
`next_retry_at` says, and stopped retries stay stopped until someone answers "retry now".

**Launches whose outcome is unknown.** A launch can fail without saying whether it created
anything: the cmux CLI gives up on its own (`Error: Command timed out`) or hits volleyd's bound
on it (`launch_timeout_ms`, 60 s), exits with no workspace ref, or ssh drops after a remote
`tmux new-session` was sent. Such a launch may still have opened the workspace and started the
agent, so before anything retries it volleyd reconciles: it looks the workspace up by the exact
name it gave it (`cmux list-workspaces`; `tmux has-session` on a remote host) and waits up to
`launch_reconcile_ms` (30 s) for the agent's hook signals on the watch it subscribed before the
launch. That name is one per agent id: `<wave> <task> <role>`, with the attempt appended after the
first (`w1 T1 fixup 2`), so the lookup never finds a workspace an earlier attempt left open.

- The agent registered: it is **adopted**. The journal gets `spawn_adopted { agent_id, role,
  attempt, workspace, after: "launch_unknown", waited_ms }`, then the usual `agent_spawned`
  with `adopted: true`; nothing is launched a second time and verification goes on as for any
  launch. If neither lookup found its workspace, `spawn_adopted` says `workspace: "unknown"` and
  `agent_spawned` carries an empty `workspace`: the agent runs and is supervised through its
  messages, but volleyd cannot read its screen, send it keys or close its workspace on retire (a
  human closes it).
- A workspace is there but no agent registered: volleyd closes it (`launch_orphan_closed {
  agent_id, workspace }`) and the spawn fails as above; its retry may reuse the agent id, since
  that session is known gone.
- Nothing is there and the host answered: the spawn fails as above.
- The host could not be asked (the lookup failed or timed out), more than one workspace carries
  the name (which one is this launch's cannot be told) or the workspace could not be closed:
  the attempt is **burned** (`spawn_identity_burned { agent_id, role, attempt, why }`), its
  login revoked, and the retry takes the next attempt number, so no retry ever reuses an agent
  id that may be live. Its branch follows (`-2` after a never-used `-1`). The failure still
  counts toward `spawn_retry_max`.

A launch cmux refused (not running, not installed, refusing volleyd) created nothing and fails
straight away. Launches are serialized per host: one `cmux new-workspace` (or remote
`tmux new-session`) is in flight at a time, so a slow cmux does not stack them.

**Identity.** The agent id is `<wave>-<task>-<role>-<attempt>`, lowercased (a long wave id is
shortened with a hash). `.volley/agent.json` carries `agent_id`, `namespace`, `parent_id` (the
wave owner, else `volleyd`), `wave`, `task`, `role`, `broker_url` and the minted `broker`
block; the MCP server and the hooks both read it, so no flag or env carries identity.
`volleyd daemon --no-mint` skips minting for an anonymous broker (no `broker` block).

**Broker logins** (mosquitto ≥ 2.1, Dynamic Security; [`examples/mosquitto-auth/`](../../examples/mosquitto-auth/README.md),
SPEC §4.6.13). The daemon keeps **one** admin control connection to the plugin
(`$VOLLEYD_HOME/dynsec-admin.json`, from `volley auth init --volleyd-file`; else
`$VOLLEY_AUTH_DIR/admin.json`), opened at start, version-checked on every open (a broker older than
2.1 makes `volleyd daemon` exit with `BROKER_TOO_OLD`), and reconnected with backoff after a drop. A
mint is one `createClient` (username = agent id, a random password, role `volley-agent` inline);
the mints (and deletes) of the same `dynsec_batch_ms` window go as **one** control message, so the
broker rewrites its state file once per batch, and each answer is matched to its own agent (a failed
element fails only that spawn, `CREDENTIALS_FAILED`). A connection drop fails the commands in
flight once (`CREDENTIALS_FAILED`: the spawn's own retry runs later over the reconnected link). A mint
that finds its agent login already there (a retry) sets it a new password; it never takes over a
login that is not an agent login. No ACL is changed per agent and no `volley auth` command or signal
is involved: the agent role already lets an agent ack volleyd and the Desk (an ack to a
random-suffixed coordinator is dropped, SPEC §4.4).

**Launch script.** `launch.sh` runs under bash (`#!/usr/bin/env bash`; login shells may be zsh),
exports `VOLLEY_HOOKS_DIR=<checkout>/packages/volley-hooks` and execs
`claude --dangerously-skip-permissions --model <model> --settings <hooks settings template> --strict-mcp-config --mcp-config=<worktree>/.volley/mcp.json --name <id> -- "$(cat .volley/brief.md)"`
(without `--strict-mcp-config` under `agent_mcp: inherit`, below).
The hooks come in through `--settings`. Just before the exec it checks `claude` is on the
session's `PATH`: if not it prints `volleyd: cannot start the agent: claude is not on this
session's PATH (<PATH>)` with the fix and keeps the session open, so the screen volleyd reads
(and the decision it opens) says why instead of an empty, dead session.

**MCP wiring.** The agent's `volley` MCP server is volleyd's, not the user's: volleyd writes
`.volley/mcp.json` = `{ "mcpServers": { "volley": { "command": "bun", "args": ["run",
"<checkout>/packages/volley-mcp/src/index.ts"] } } }` — the **same release's** volley-mcp (a
remote host's: its `volley_dir` checkout), which reads the broker URL, identity and minted
credentials from `.volley/agent.json` in its cwd, so nothing secret is in either file.
`--strict-mcp-config` keeps the user's own MCP servers (an everyday `volley` on another broker,
an older install) out of the session. `--mcp-config` is variadic, so it is passed in the `=`
form (exactly one value) and `--` ends option parsing before the prompt, which is last: the
prompt can never be swallowed as a config path. The fence pins this exact form, the path inside
the sealed worktree, and (remote hosts) the `mcp.json` content.

**`agent_mcp: strict | inherit`** (a tunable, like `branch_update`; default `strict`). `strict` is
the launch above: the agent has volleyd's `volley` server and nothing else, so every agent is
reproducible and minimal, whatever the machine's user has installed. `inherit` drops
`--strict-mcp-config`: the user's own MCP servers (plugin servers such as browser tools,
claude.ai connectors, user- and project-scope servers) load beside volleyd's, as they do in a
session started by hand. volleyd's server keeps the name `volley`, which Claude Code lets an
`--mcp-config` server take over from a user-scope server of the same name, so an everyday
`volley` entry (the coordinator's, with its own `VOLLEY_AGENT_ID`) never starts in an agent's
session and the agent registers only as itself. A user server under another name that runs
volley-mcp would start too (and read the agent's `.volley/agent.json`): keep the everyday entry
named `volley`. volleyd warns at each `inherit` spawn that has one in the profile's `.claude.json`
`mcpServers` or the worktree's `.mcp.json` (it logs it and journals
`alarm_raised { alarm: "agent_mcp_stray_volley", servers }`; the spawn goes on). The trade-off:
more tools, but an agent whose tool set depends on the machine and on servers that may prompt,
fail to connect or slow its start. The fence accepts both forms and nothing else;
`agent_spawned` records `agent_mcp: "inherit"` when it applies, and a respawn of a moved or
vanished agent keeps the servers it launched with. The cmux command starts with two spaces, which keeps it out of shell history and away
from prompts that eat the first character. Nothing else is typed into the pane, with two
exceptions: the Enter that answers an update prompt and the relaunch after it (below), and the
Escape that `volleyd stop` sends. The brief never appears in an argv.

**Brief gate and extras.** If `$VOLLEYD_HOME/brief-gate` exists and is executable, it runs as
`brief-gate <worktree>/.volley/brief.md` in the worktree; a non-zero exit is
`SPAWN_BRIEF_REJECTED`. It is a local file rather than a config tunable on purpose: a gate is a
program, and tunables can be changed over the broker. Repo-specific notes come from
`<repo>/.volley/brief-extra.md` (kept out of git by the exclude above), appended as a
"Repository notes" section. See [`briefs/README.md`](briefs/README.md).

### Brief preface

Repository **rules** go in the brief preface; repository **notes** in `brief-extra.md`. The
preface is `<repo>/.volley/brief-preface.md`, or the file the wave file names with
`brief_preface:` (relative to `repo`, or absolute). Its bytes are put at the top of **every**
brief volleyd writes — implementer, both reviewers, fixup, rebase — verbatim (no `{{…}}`
expansion), followed by a `---` rule and then the role's template. `brief-extra.md` is the
opposite end: optional notes (build commands, gates) rendered into the template's
"Repository notes" section at the bottom. `/volley-issues` writes `brief_preface:` into the wave
files it generates and creates the file from its public-repo hygiene template when it is missing
(never overwriting one).

- **Which repo.** The default path is under the wave's `repo:` as written. `brief-extra.md` is
  looked up at the clone's top level instead (`git rev-parse --show-toplevel`). So if `repo:`
  points at a subdirectory, name the preface with `brief_preface:` or point `repo:` at the top
  level.
- **Where it is read.** On volleyd's own host, at `run` (and each plan version) and again at
  every spawn, so an edit reaches the next spawn. A task on a remote host gets the preface read
  here.
- **Size.** At most `brief_preface_max_bytes` (default 16 KiB, a tunable): over it,
  `volleyd validate` exits 1 and `volleyd run` is refused with `BRIEF_PREFACE_TOO_LARGE`, and a
  spawn after the file grew is refused (journaled `alarm_raised { code }`, like any refusal).
- **No file.** Briefs are the role templates alone; `brief_preface_missing { path }` is
  journaled once per wave (at `run`, or at the first plan version without one). A blank file
  (whitespace only) counts as no file, so what `validate` / `status` report is what the agents
  get.
- **Encoding.** The file must be UTF-8 (its exact bytes go into the brief): one that is not is
  refused by `validate`, `run` and a spawn.
- **Visibility.** `volleyd validate` prints `brief preface: <path> (<bytes> B, sha256 <12 hex>)`
  or `brief preface: none (no <path>)`. `wave_submitted` and every `wave_versioned` carry
  `brief_preface: { path, sha256, bytes } | null`, which is the wave state's `brief_preface`
  (SPEC §4.6.9), so the Desk and the coordinator can see which rules the agents got;
  `volleyd status` prints the same line under the wave's header.

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
`volley/<ns>/<id>/status` and `volley/<ns>/<id>/progress`. The expected sequence is: the MCP
server's retained `spawning` status and auto-registration (no `model_source`) → the SessionStart
hook's registry re-publish with `model_source` and `model` (`packages/volley-hooks`) → status
flipped to `working` → a `progress` `heartbeat` with `hook_event: "SessionStart"`. A spawn is
verified when the SessionStart heartbeat, a registry entry with `model_source` `harness-hook` or
`unknown`, **and** the MCP server's own `spawning` (or `registered`) status — which only
volley-mcp publishes — all arrive on volleyd's broker within `spawn_timeout_s`; it is journaled
as `agent_registered { model, model_source, model_verified }`.

If the hooks verified but the MCP status never came, the session runs some other MCP server
(version skew, or one on another broker), and the agent's status and progress would never reach
volleyd: the spawn journals `verify_failed { agent_id, role, reason: "mcp_not_registered" }` and
opens decision `mcp_not_registered` ("the agent's MCP server is not on this broker — version
skew or wrong broker; see `.volley/mcp.json`"), which parks the task (its `why_waiting` names the
decision). The SessionStart hook publishes `working` when it finds no retained status at all, so
a hook-only registration never shows as `unknown`.

- `model_source: "harness-hook"`: the model id is compared exactly with the task's. Only an
  8-digit date suffix or a `[1m]` context suffix is ignored, so `claude-opus-5` is a mismatch for
  `claude-opus-5-5`. A mismatch opens decision `model_switch` and leaves the agent running.
- `model_source: "unknown"` (the hook input had no model): the terminal's status line is read
  once as the model source; unreadable → `model_verified: false`.

### Pre-hook screen table

Screens are read only in the window before the hooks run (afterwards the hooks are the source of
truth). When no SessionStart heartbeat arrived in time, a local worktree's
`.volley/hooks-error.json` written during this launch is checked first: it means the broker
refused the hooks' credentials (or the hooks could not read them), so decision
`hooks_auth_failed` opens with the username, and the screen is not read. Otherwise the screen is
captured to `$VOLLEYD_HOME/waves/<wave>/screens/` and classified:

| Screen | Action |
|---|---|
| `trust_dialog` (folder-trust prompt) | decision `repo_untrusted` — never answered automatically |
| `update_prompt` (e.g. a shell's `update? [Y/n]`) | press Enter, then see below |
| `login`, `credit_exhausted` (a usage-limit prompt), `working` (Claude up, hooks silent), `shell_prompt`, `empty`, `unknown` | decision `unknown_screen`, pointing at the capture; its question quotes the session's last output (its last non-blank lines, also in the journal's `decision_opened` event as `data.last_output`; not on the retained decision), or says the screen was empty and the session may have ended at once |

After the Enter the original launch gets `relaunch_settle_ms` (3 s) to continue. If its hook
signals arrive, or the screen shows anything but a bare shell prompt, the original attempt is
verified once more and nothing is typed. Only when the pane is back at a bare `shell_prompt`
(the prompt ate the launch command) is it relaunched, once, **in the same workspace**: the
first attempt is retired as `agent_retired { status: "superseded" }` (credentials revoked,
retained records cleared, lock kept), then attempt + 1 gets a new id and credentials and the
launch command is typed into that pane (`agent_spawned { recovered_from, recovery:
"update_prompt" }`). A second workspace is never opened in the same worktree. A second failed
verification opens `unknown_screen`.

### Relaunch decisions

`hooks_auth_failed`, `mcp_not_registered` and `unknown_screen` offer `relaunch` / `cancel`, and
the answer is acted on: each carries a pipeline marker naming the run it is about (`{ on:
"relaunch", wave, task, role, attempt, agent_id }`; the daemon's `spawn_failed` carries one too).
An agent whose hooks the broker refused is **paused** as soon as the decision opens (Escape in its
workspace and a steering "stop: your broker login is being repaired"), so it does no work it
cannot deliver; nobody is asked to edit credentials by hand.

- `relaunch`: the failed agent is retired through the delete path (retained records cleared,
  its login deleted, its worktree lock released; `agent_retired { status: "relaunched" }`),
  `relaunched { from_agent, to_agent, role, attempt }` is journaled, and the same role is spawned
  again at attempt + 1 through the pipeline's role spawn (admission and budget apply): a new
  agent id, a freshly minted login, `<role>-<n+1>` registering as usual.
- `cancel`: the agent is retired the same way and the task is `blocked`
  (`stage_entered { stage: "blocked", why }`, the decision text as its `why_waiting`).

### Unattended coordinator starts

A coordinator session that runs without a human at the keyboard needs two things in its Claude
Code configuration. Its settings must list the release checkout it reads (the repository's main
clone, outside the session's own working directory) under `permissions.additionalDirectories`,
or every read there stops at the "read outside the working directories" prompt:

```json
{ "permissions": { "additionalDirectories": ["/path/to/the/repo/checkout"] } }
```

And its volley-mcp server must be registered with the coordinator's id **prefix**
(`env.VOLLEY_AGENT_ID=coordinator`: the server appends `-xxxx`), so the session registers as
`coordinator-xxxx`, the id its waves are submitted with (`--owner`).

Claude Code's first-run *Claude in Chrome* prompt ("use Chrome browser?") waits for a key, and
it is asked once per user profile, whenever Chrome is found and `claudeInChromeDefaultEnabled`
is unset in the profile's `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` with a custom
config dir). An unattended start — a coordinator session, or an agent spawned on a host whose
profile never answered it — stalls on that prompt. Before the first unattended start on each
host and user profile, answer it once in an interactive `claude` (or set *Claude in Chrome →
Enabled by default* in `/config`) so the key holds `true` or `false`; `claude --no-chrome` also
skips it, for that session only. Today the screen classifies as `unknown_screen`; a dedicated
`browser_prompt` class (decision: "Needs you: answer Claude Code's Chrome prompt on `<host>`")
is a follow-up.

### Journal mapping

The journal's event types are the closed `wave-event` enum, so the steps use it as follows:
refusals → `alarm_raised { code, … }`, then `spawn_failed` (and `spawn_recovered` once a later
attempt launches); a launch → `agent_spawned { agent_id, role, attempt,
host, workspace, worktree, branch, issue, credentials, lock }` (plus `stage_entered implement`
for an implementer's first attempt); verification → `agent_registered` (or `verify_failed`);
trust, model, MCP and screen questions → `decision_opened { decision_id, kind, question, options, pointers }`, opened through
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
Three timed-out reads in a row mean the workspace is gone: the agent is then read at most hourly
and its `read timed out` line is logged once more, not every capture. An agent leaves capture
when it is retired and, at once, when its wave is stopped.
Captures run on their own 1 s timer beside the daemon's serial queue, never on it, so a slow or
hung terminal cannot delay admissions, control ops or retire (the timer is off when `tickMs` is
0, as in tests). Retire stops the agent's capture — after any publish in flight, never waiting
for a read — and then clears the topic with an empty retained payload.

**Privacy.** A screen tail is whatever the agent's terminal shows, including anything an agent
printed — tokens, keys, file contents. It is published to the same broker as every other agent
record and has the same trust boundary: anyone who can subscribe to `volley/<ns>/+/screen` can
read it, so restrict broker access (per-agent credentials and ACLs) as for the rest of the
namespace.

### Spawn budget

A wave's spawn budget counts every agent it spawns (retries and reviewers included). Its default
is enough to finish with no retry at all plus headroom: the roles of every task's pipeline
(implement, each review, fixup: 4 for the default pipeline) plus 50% of that for retries (at
least 2), or `spawn_budget_multiplier` × task count when that is more. A wave file's
`spawn_budget:` overrides both. Exhaustion is never silent: a spawn the budget holds opens one
`spawn_budget_exhausted` decision (`raise by <n>` | `cancel`; on a task it parks the task, so its
`why_waiting` names the decision). `raise by <n>` adds n spawns to the wave's budget (journaled
with the answer, so it survives a restart) and the next tick spawns; `cancel` cancels the task (a
wave-level one stops the wave).

### Retire and cleanup

When a supervised agent's `failed` status arrives, the daemon retires it (a `blocked` one is not
retired: it gets an [`agent_blocked` decision](#decisions)); a `done` is first
handed to the pipeline, which verifies the claim and retires the agent once it is checked (see
[the pipeline](#the-pipeline-and-the-merge-ready-gate)). `reaped` (its
LWT) is retired only after the reap grace passes with no fresh status or heartbeat (see
[Recovery](#recovery): `heartbeat_alarm_s`, or `wake_grace_s` right after a host wake): a
network blip or an MCP-server restart also fires the LWT, and the assigned identity may
reconnect with a fresh `spawning` (SPEC §6.5). Retiring deletes the agent's login through the
**delete path** (SPEC §4.6.13; a deleted login is disconnected without its will, so no LWT reports
it): volleyd publishes the agent's retained `status: reaped { reason: "credentials_deleted" }`,
then empty retained payloads on its `registry`, `status`, `progress`, `result`, `capability`,
`screen` and `usage` topics, then the batched `deleteClient` (journaled `agent_reaped_by_supervisor`
and `credentials_revoked`); then the lock is released, the agent's session ended, and
`agent_retired { status, terminal, result }` journaled. `terminal` is the
terminal status payload (`summary`, `pr_url`, `reason`, …) and `result` is the retained result,
so the cleared records live on in the journal. Only the wave's own agents, only terminal ones.

**The retired marker.** Before the login is deleted, volleyd writes
`<worktree>/.volley/retired.json` `{ agent_id, status, at }` through the agent's host (so a
remote box gets it too). The agent's hooks read it: a marker naming their own agent id makes them
end quietly (exit 0, no broker connect, a one-time `{ code: "RETIRED" }` note in
`hooks-error.json`) instead of reporting the refused login as `AUTH_FAILED`. A marker naming
another id (a reused worktree) is ignored.

**Ending the session.** With `retire_close_session` on (the default) the retire then closes the
agent's workspace (its cmux workspace, bounded by a 15 s timeout, or its tmux session on an ssh
host) and, on this machine, stops whatever process still runs under the agent's worktree: a
closed cmux workspace does not always end its `claude`. A process counts only by its argv (the
launch script's `--mcp-config=<worktree>/.volley/mcp.json`; volleyd lists processes with the
fenced `ps -axo pid=,command=` and signals them itself: SIGTERM, a 5 s grace, SIGKILL). It is
journaled `agent_session_closed { agent_id, workspace, how, pids }` (`how`: `close-workspace`,
`kill-session`, `signal` when only a process was stopped, or `none`) before
`agent_retired { workspace, workspace_closed }`. An agent retired after a daemon restart has
only a journaled ref; a short cmux ref (`workspace:<n>`) may name another workspace by then, so
volleyd re-finds the workspace by its `<wave> <task> <role>` title (`cmux list-workspaces`,
exactly one match) and, when it cannot, closes nothing and still stops the processes under the
worktree. A worktree or title another live agent of the wave now holds (a relaunch into the same
worktree) is left alone. With `retire_close_session: false` finished sessions stay open for
inspection (`workspace_closed: false`; the marker is still written).

Nothing on disk is deleted: `volleyd cleanup <wave>
--yes` closes any workspace a retire could not close, runs `git worktree remove` with the fence's
consent token (`--force` for dirty worktrees), and stops the retired agents' processes still
running on this machine: every process whose `--mcp-config=` lies inside the worktree of a
target whose every agent is retired, never one under any other worktree (an agent not yet
retired, or one the daemon is launching and has not journaled yet) (`stopped <pid> (<agent
id>)`; the dry run prints `would stop …`). Worktrees of agents not yet retired are skipped, and branches are never
deleted.

Answering a `repo_untrusted` decision with `volleyd resolve <id> trust` (owner only) records
exactly `projects[<root>].hasTrustDialogAccepted: true` (`recordRepoTrust`; it re-checks the
file just before its rename and retries rather than drop a concurrent Claude Code write).
Accepting the dialog by hand in any worktree of the repo works too: every tick re-checks the
open `repo_untrusted` decisions, resolves those whose repo is now trusted, and the parked spawns
resume.


### Credential sweep

Dynamic Security logins never expire, and every change rewrites the plugin's whole state file, so
the file size (about 300 bytes per login) drives the cost of every mint. With a dynsec admin login
the daemon therefore **sweeps**: at start and every `credential_sweep_interval_s` (default 600) it
lists the logins holding `volley-agent` alone and deletes, through the delete path, each one with no
live agent behind it: not supervised, not running in a wave that is neither stopped nor complete, no
worktree lock naming it, no non-terminal retained status (`spawning`, `registered`, `working`,
`blocked`…, in any namespace), and not minted (or first seen) within `spawn_timeout_s`. One sweep's
deletes go as one control message; it journals `credentials_swept { agent_ids }` in `_system`. The
fixed identities, accounts, token logins and the admin are never candidates. `volleyd status` starts
with `agent logins: N live, M swept` (the agent logins on the broker, a count volleyd re-reads after
each of its mints and deletes, each sweep and every 30 s, so `status` never waits on the broker,
and the total swept per the `_system` journal); `--json` has
`agent_logins: { live, swept }`.
### Remote hosts (ssh + tmux)

A task can run its agents on a second machine: no cmux there, agents in tmux sessions, reached
over SSH, the broker reached through a reverse SSH tunnel. Name the host in the wave file, either
inline or as an entry of the config's `hosts` map (an inline `host:` is layered over the entry it
`name`s):

```yaml
# $VOLLEYD_HOME/config.yaml
hosts:
  box:
    target: dev@box.example          # ssh destination ([user@]host or an ssh config alias)
    repo: /home/dev/src/example-repo # the wave repo's clone on the box
    volley_dir: /home/dev/src/volley # a volley checkout on the box (its hooks)
    # worktree_root: /home/dev/src/.volley-worktrees   (default: beside repo)
    # tunnel: { remote_port: 21883, supervise: true }

# wave file
tasks:
  T1: { issue: 102, host: box }
  T2: { issue: 103, host: { type: ssh, name: box, tunnel: { remote_port: 2883 } } }
```

**Prerequisites on the box** (volleyd does not provision it): `bash`, `bun`, `claude` (logged
in), `gh` (authenticated, for `gh issue view`), `git`, `tmux`, `nc`, `base64`, `cmp`, a clone of
the wave repo at `repo` (its `origin` must have the release branch) and a volley checkout at
`volley_dir` with `bun install` run. Two that are easy to miss:

- `claude` (and `bun`) must be on the `PATH` of a non-interactive ssh session
  (`ssh <target> bash -s` reads no `~/.zshrc`, and bash stops early in `~/.bashrc`), because the
  tmux session that runs `launch.sh` takes that environment. Claude Code's installer puts it in
  `~/.local/bin`, which sshd's default `PATH` lacks: set it in `~/.zshenv` (zsh) or at the top of
  `~/.bashrc` (bash), or link it into `/usr/local/bin`. `volley peer join` checks this before it
  pairs and prints the exact line. A tmux server that was already running keeps the `PATH` it
  started with, so before each launch volleyd adds the ssh session's own in front of it
  (`printenv PATH` and `tmux show-environment -g PATH`, then `tmux set-environment -g PATH` with
  the ssh session's directories first and every directory the server already had after them;
  nothing to do when none is missing, or no server runs). volleyd uses tmux's default server, so
  this may be your own: its PATH only ever gains directories.
- The agent's MCP server is the box's `volley_dir` checkout (`.volley/mcp.json` runs its
  `packages/volley-mcp/src/index.ts` with `bun`), so `bun` must be on the non-interactive ssh
  `PATH` too, and that checkout must be this release with `bun install` run. User-scope MCP
  servers on the box are not loaded (`--strict-mcp-config`), unless `agent_mcp` is `inherit`. The
daemon's machine needs key-based, non-interactive ssh to `target` (`BatchMode=yes`: a password
or host-key prompt fails the command). `remote_port` (default 21883) must be free on the box's
loopback: a box that runs its own MQTT broker usually has 1883 taken, and a forward that cannot
bind its port is reported (`TUNNEL_FORWARD_FAILED`) and parks spawns rather than letting agents
reach whatever else listens there.

**Transport.** Every remote command is a script sent on stdin to
`ssh -T <target> bash -s` — never `ssh <target> '<command>'`: login shells on the box may be
zsh, which word-splits a command string differently. The script is built from fenced steps
(see [the fence](#the-authority-fence)'s SSH and REMOTE rules); files (`ISSUE.md`,
`.volley/brief.md`, `.volley/agent.json` with mode 0600, `.volley/launch.sh`) travel as base64
through `base64 -d`. The spawn steps are those of the local host, with these differences:

| Step | On a remote host |
|---|---|
| Repo trust | the box's own `~/.claude.json`, read at every spawn (only the trust bits); an untrusted repo opens `repo_untrusted` with `host` and `target` (see below) |
| Lock | `$VOLLEYD_HOME/hosts/<target>/locks/` — keyed by target and worktree path |
| Worktree | `git -C <repo> fetch origin <release_branch>`, then `worktree add … origin/<release_branch>` on the box; no clone at `repo` → decision `remote_repo_missing` naming the path (an ssh failure is not "no clone": the spawn is refused with `LAUNCH_FAILED` and retried with backoff) |
| Brief | `.volley/brief-extra.md` is read from the box's clone; the [brief preface](#brief-preface) on volleyd's host |
| Identity | minted on the daemon's machine; `agent.json` carries `broker_url: mqtt://127.0.0.1:<remote_port>` |
| Launch | `launch.sh` exports `VOLLEY_HOOKS_DIR=<volley_dir>/packages/volley-hooks` and, for tooling that reads env, `VOLLEY_BROKER_URL`, `VOLLEY_NAMESPACE`, `VOLLEY_AGENT_ID` (the identity file still wins); started with `tmux new-session -d -s <wave>-<task>-<role> -c <worktree> 'bash .volley/launch.sh'`. Never `--mcp-config` |
| Screen | `tmux capture-pane -p -t =<session>: -S-<lines>`; keys via `tmux send-keys`; screen tails publish `source: "tmux"` |
| Verify / retire | identical: the hook signals arrive over the tunnel; retire revokes the credentials and clears the topics |
| Cleanup | `volleyd cleanup --yes` kills the tmux session and runs `git worktree remove` on the box, both with the consent token; its lines end in `on <target>`, and a worktree already gone from the box is reported `gone`, so a re-run is a no-op |

**Trust on the box.** A remote clone is trusted in the box's own `~/.claude.json`, never the
daemon machine's, and its `repo_untrusted` decision id is keyed by target and root (a local and
a remote clone at the same path never share one). Answering it with `volleyd resolve <id>
trust` writes that one key on the box over the same `bash -s` transport: read the file, write
the new one beside it (`~/.claude.json.volleyd.tmp`, mode 0600), and swap it in only if the file
is still what was read (`cmp`, then `mv`), retrying when Claude Code rewrote it meanwhile. A box
with no `~/.claude.json` yet is refused: run `claude` there once. Accepting the dialog by hand on
the box works too: open remote decisions re-read the box's trust every 10 s and resolve once it
shows.

**Tunnel.** With `tunnel.supervise: true` (the default) the daemon keeps one
`ssh -N -R <remote_port>:<broker host>:<broker port> <target>` per forward — per target *and*
`remote_port`, so two tasks on one box with different ports get two tunnels and two checks —
started when a wave first has an unfinished task on it and kept up until the daemon stops,
restarting it with backoff (1 s doubling to 60 s). There is no bind address, so the forwarded
port listens on the box's loopback only. Every exit is journaled log-spaced (the 1st, 2nd, 4th,
8th … of a streak, with ssh's stderr): `TUNNEL_EXITED`, and from the second quick exit in a row
`TUNNEL_FORWARD_FAILED` — the forward is then down whatever answers on the port. A fresh tunnel
counts as up only once its ssh has stayed up 15 s (`checking tunnel to <target>` until then).
With `supervise: false` the tunnel is yours to run and the daemon only checks it. The check is
`nc -z 127.0.0.1 <remote_port>` on the box (through `bash -s`), every 10 s for each forward with
an unfinished task. While it fails, new spawns on that host park with
`why_waiting: "tunnel down to <target>"` (and an `alarm_raised { code: TUNNEL_DOWN }` in the
journal); when it recovers they resume. Running agents are never touched — an agent whose
tunnel drops keeps working on the box. Its broker connection dies with the tunnel and the broker
fires its LWT, but while the tunnel is down its reap waits (one `REAP_DEFERRED` alarm) instead
of revoking its credentials, so its MQTT client can reconnect when the tunnel is back; if it
does not, it is reaped then, after the usual grace.

The wave state labels remote tasks with `host` (the host's name), so the Desk can show where an
agent runs.

### Paired machines (`volley peer`)

Pairing does the remote-host recipe above (account, tunnel, trust, host entry) with one code
(SPEC §4.6.14). On the daemon's machine, as an admin account (`invite` and `remove` are admin
ops: they go to volleyd on the admin's own `volley/_system/auth/ops/<username>` topic, never the
mailbox, and volleyd checks the admin role as for the account ops; the broker drops a
non-admin's op without a word, so `volley peer` first checks the login against this machine's
`accounts.json` and the fixed identities, and refuses a known non-admin at once instead of
waiting out `--timeout`):

```sh
VOLLEY_AUTH_USERNAME=<admin> VOLLEY_AUTH_PASSWORD=... \
  volley peer invite               # Pairing code: ABCD-EFGH (single use, 10 minutes)
```

On the new machine (bun, claude, gh, git, tmux and a volley checkout already there; key-based
ssh to the daemon's machine):

```sh
volley peer doctor --repo ~/src/example-repo     # optional: join runs it anyway
volley peer join ABCD-EFGH --to dev@supervisor --repo ~/src/example-repo
```

`join` first runs `volley peer doctor` (the volley-cli README's "`volley peer doctor`": tools and
their versions, `claude` and `bun` on the non-interactive ssh `PATH`, the volley checkout, the
clone and its origin, GitHub push access, the Claude sign-in and folder trust, memory and disk).
A failing `block` check (no bun, no tmux, no clone or no `--repo`) stops the join *before* the
code is used, so it stays valid while you fix things (the join prints the
`volley peer doctor --fix --repo …` that applies the safe fixes); `warn` checks are printed and the
join goes on. `claude` and `bun` on the ssh `PATH` are among them: the doctor can only estimate
that `PATH`; the join's own check below and volleyd's probe (readiness `path_ok`) see the real
one. Then it checks ssh to `--to` (an untrusted host key is reported as such, with the one-time
`ssh <host> true` to accept it, not as missing key-based ssh), then sends a script to
`ssh <host> bash -s` that first checks the daemon's machine can ssh back to `--target`
(`ssh -o BatchMode=yes <target> true`: every spawn there needs it; if not, the join stops before
the code is used), then that `claude`, `bun` and `tmux` are on the PATH of that non-interactive
ssh session (what an agent session gets there; if not, the join stops before the code is used,
names what is missing and prints the line to add, with the directories this shell finds them in:
`~/.zshenv` for zsh, the top of `~/.bashrc` for bash), and then runs
`volley peer redeem` (`--remote-volley <command>` when `volley` is not on that non-interactive
ssh `PATH`; it signs in with `VOLLEY_AUTH_*`, else the coordinator's `coordinator.json` from
`VOLLEY_AUTH_DIR`, else from the auth dir `volley setup` recorded in `setup.json`). volleyd (`peer_join`) burns the code, creates a `peer`
account named after the machine (`--name`, default its short hostname) and adds
`hosts.<name>`:

```yaml
hosts:
  box-a:
    target: dev@box-a           # --target: how this machine reaches the new one (default $USER@<hostname>)
    repo: /home/dev/src/example-repo
    volley_dir: /home/dev/src/volley
    tunnel: { remote_port: 21883, supervise: false }   # the machine keeps its own tunnel
```

so a wave file can say `host: box-a` at once (volleyd also records the name in
`$VOLLEYD_HOME/peers.json`). The machine then writes `~/.volley/peer.json` (mode 0600: it holds
the peer password), installs `volley peer run` as a user service, prints whether Claude Code
trusts `--repo` there (it or a parent folder; an untrusted one opens `repo_untrusted` at the
first spawn; accept the dialog once by running `claude` in it), and registers itself.

The service must outlive the ssh session the join runs in:

- **Linux:** a systemd user unit `volley-peer.service`. systemd stops a user's services when
  their last session ends unless the user *lingers*, so `join` runs `loginctl enable-linger
  <user>` first. Where that is not allowed without root it warns: run
  `sudo loginctl enable-linger <user>`, or the tunnel drops when you log out and comes back only
  at your next login. A re-join restarts the unit with the new `peer.json`.
- **macOS:** a launchd agent `systems.volley.peer`, bootstrapped into `gui/<uid>` when someone is
  logged in at the console, else into `user/<uid>` (a Mac paired over ssh); the join says which.

If the service cannot be installed, the pairing still stands on the host: the join says so and
exits 1. Run `volley peer run` yourself, or `volley peer remove <name>` on the daemon's machine
and join again with a new code.

**The service** keeps `ssh -N -L 127.0.0.1:<remote_port>:<broker> <host>` up (restarting it with
backoff) and publishes the machine's retained record on `volley/_system/machines/<name>` every
30 s through it: os, cores, load averages, its tmux session count, `tunnel: up`. Its LWT is the
record with `tunnel: down` (built when it connected: volleyd keeps the last heartbeat's
`last_seen`, load and agents). Every record also carries the Fleet fields (SPEC §4.6.15):
`kind: peer`, `disk` (where the worktrees go) and `uptime_s` read fresh each heartbeat, `memory`
too (on macOS, `available_pct` is the last doctor run's `vm_stat` figure), and the last
finished doctor run's `versions`, `auth` (states only: `gh`, `claude`, `trust`, `claude_plan`),
`repo`, `checks` (no fix text) and `doctor_at`. The service re-runs the doctor every 600 s
(`PEER_DEFAULTS.doctor_interval_s`) beside the heartbeat, so a slow network probe never delays a
beat past `machine_down_after_ms`; the version it compares the checkout against is the
supervisor's readiness verdict's `requirements.volley`. The service file carries the `PATH` the
join ran with (launchd's own has no Homebrew or `~/.bun/bin`). volleyd only counts records for a configured host, and marks a
machine whose record stopped for 90 s down (republishing the record with
`reason: heartbeat_timeout`). While a machine is down its spawns park with
`why_waiting: "tunnel down to <name>: no heartbeat for 90 s"`, every unfinished task on it
(running ones too) carries `host_down` in the wave state, and each wave on it journals
`MACHINE_DOWN`. Running agents are left alone, as with any tunnel outage.

**What the machine's Claude profile gets.** The doctor (by hand, at join, in every heartbeat
and on a Desk's Repair) also checks the machine's own Claude profile, `~/.claude` of the user
the service runs as, and its `--fix` prepares it: the `/volley` and `/volley-issues` skills
linked to its volley checkout, the hooks installed with `--broker-url` at the tunnel
(`mqtt://127.0.0.1:<remote_port>`) and `--namespace` outside `default`, and the volley MCP
server registered there (`claude mcp add-json -s user volley`, again after a port change), each
under the per-item sharing modes this daemon publishes in the machine's readiness verdict
(`requirements.sharing`, from its own `sharing.yaml`: `own` leaves an item as is). One `warn`
row each (`skills`, `hooks`, `mcp`, `sharing`): agents volleyd spawns there do not need them.
No credential is involved: the MCP registration carries no broker login, the hooks keep their
coordinator file out of `settings.json`, and the owner's own sessions on that machine sign in
to the broker as they would anywhere (the hooks README).

`volley peer list` shows the paired machines; `volley peer remove <name>` (`peer_remove`, an
admin op) revokes the account, removes `hosts.<name>` and clears the record. It only removes a
paired machine or a `peer` account: a host you configured by hand is refused. The machine's service stops on its own
the next time the broker refuses the revoked account (exit 0, so the service manager leaves it
stopped).

**Re-pairing.** A machine that is already paired (a new ssh target, a lost `peer.json`, a fresh
install) re-pairs without being removed first. On the daemon's machine, as an admin:

```sh
volley peer invite --for box-a     # a code that re-pairs box-a only
```

and on the machine, `volley peer join <code> --to dev@supervisor --repo <its clone> --name box-a --replace`.
volleyd (`peer_invite { for }`, `peer_join { replace: true }`) keeps the binding in the code's
hashed entry; with such a code it rotates the `peer` account's password (`volley auth rotate`)
and rewrites `hosts.box-a` with the join's fields (a hand-set `max_agents` or `drain` stays)
instead of refusing the configured name, and journals `peer_joined { ..., replaced: true }`. The
machine rewrites `~/.volley/peer.json` and restarts its service. An ordinary code for a configured
name is still refused, `replace` or not; a `--for` code joins under its own name only; neither
refusal uses the code up. A name whose account is not a `peer` is never replaced.

## Fleet

The Fleet (v0.4.0, SPEC §4.6.15) is volleyd running agents on more than one machine and choosing
where. The pieces, in the order a machine meets them:

| Piece | What it does | Where |
|---|---|---|
| Pairing | one code gives a machine its own broker account, an ssh tunnel service and a heartbeat | [Paired machines](#paired-machines-volley-peer) |
| Doctor and Repair | `volley peer doctor` checks the machine; the admin op `peer_doctor` (the Desk's **Repair…**) runs it, with `--fix`, over ssh | [readiness](#fleet-readiness-the-supervisors-card-repair), the volley-cli README |
| Remote sign-in | `claude_signin { acct: "primary@<name>" }` runs `claude auth login` on the machine and forwards its localhost callback for the length of the sign-in | [Claude accounts](#claude-accounts) |
| Readiness | a retained verdict per machine: ready, eligible, and why not, in plain words | [readiness](#fleet-readiness-the-supervisors-card-repair) |
| Placement | `placement: auto` scores the eligible machines and writes a "why here" line for each | [placement](#fleet-placement) |
| Leases per machine | a pool's `per_machine` caps the holders on one machine; each holder carries its host | [Leases](#leases) |
| Down, overload, drain, remove | the owner decides every re-placement; a running agent is never moved | [down, overload, drain, remove](#fleet-down-overload-drain-remove) |
| The fence | the doctor's argv, the PATH probe and the sign-in's `ssh -N -L` forward are the only Fleet commands volleyd may run | [The authority fence](#the-authority-fence) |

The owner's end-to-end check on a real second machine is `SMOKE.md` Plan 12 at the repository
root.

## Fleet: readiness, the supervisor's card, Repair

The Fleet (SPEC §4.6.15) lets volleyd judge where an agent can run. This section covers what it
computes and publishes today; placement itself uses these verdicts.

**The supervisor's own machine record.** volleyd publishes a record for its own machine, as
`volleyd`, on `volley/_system/machines/<local_name>` with `kind: supervisor` and
`tunnel: local`, every `machine_heartbeat_ms` (30 s). `<local_name>` is `fleet.local_name`, or,
when that is `null`, the host name's first label lowercased (`MacBook-Pro.local` is
`macbook-pro`; a reserved result becomes `supervisor`). The retained config carries the resolved
name, never `null`. `load`, `cores`, `memory` and `uptime_s` are read live from the OS, `agents`
is its live supervised agents, and the rest (`checks`, `versions`, `auth`, `repo`, `disk`,
`doctor_at`) comes from its own doctor: `volleyd daemon` runs `volley peer doctor --json --repo
<repo>` locally (fenced: that argv only, never `--fix`) at start, every heartbeat, and at once when
the running wave's repo changes. volleyd is no peer (it has no `peer.json`), so `<repo>` is the
running wave's repo (the first by wave id when several run); with no wave running it runs without
`--repo`, and the report's `repo.*` checks, which then only say that no repo was given, do not
count against its own machine (nor is any origin compared). `versions.volley` is
volleyd's own version. The name is never a configured host's: `config_set` (or `config.yaml`)
that would make `fleet.local_name` equal a `hosts.<name>` key, or a host key equal the derived
name, is refused, and so is `peer_join` under that name.

**Readiness.** For its own machine and every configured host, volleyd publishes a verdict,
retained, on `volley/_system/machines/<name>/readiness` (`readiness.schema.json`; only volleyd
publishes there):

```jsonc
{ "name": "box-a", "ready": false,
  "reasons": ["volley 0.3.0 on box-a, host runs 0.4.0"],
  "drain": false, "max_agents": 4, "placed": 1,
  "path_ok": { "claude": true, "bun": true },
  "requirements": { "volley": "0.4.0", "bun": "1.3.0", "sharing": { "skills": "linked", "...": "..." } },
  "heavy": { "build": { "held": 1, "per_machine": 2 } },
  "usage": { "account": "main@box-a", "five_hour_pct": 42 },
  "eligible": false, "ineligible_reason": "volley 0.3.0 on box-a, host runs 0.4.0",
  "checked_at": "2026-10-19T09:00:00.000Z" }
```

`ready` is false while anything blocks an agent there, each said in one plain line: no record
yet, the tunnel down, no doctor report (`no doctor report: run volley peer doctor`), a failing
`block` check, a volley version other than volleyd's, `claude` or `bun` missing from the PATH an
agent gets, GitHub without push access (`gh: no write permission on <owner/repo>`), Claude signed
out (`claude: not signed in`), or a clone whose origin differs from the supervisor's. The PATH
is volleyd's own probe: for a peer, `command -v claude bun` as a fenced step of the same
`ssh -T <target> bash -s` that runs `launch.sh`, at most every `path_probe_interval_ms` (5 min)
while its record is up; the doctor's own `claude_on_path` / `bun_on_path` only estimate that PATH
(they are `warn` checks), and the reason says the probe decides. For volleyd's own machine the
probe is its own agents' environment, with no ssh hop: volleyd's own `PATH`, which is an
approximation (local sessions start through cmux, whose shell may set its own `PATH`; under
launchd volleyd's `PATH` is the one its plist recorded). `eligible` is placement's own
machine filter (`machineIneligible` in `src/placement.ts`, the one function both read), under
volleyd's config: ready, not draining (`ineligible_reason: "draining"`), `placed` under
`max_agents` (`"4/4 agents (max_agents)"`), its own admission open, load, memory, disk and usage
within the thresholds (see Fleet: placement). `ineligible_reason` is the machine's placement
candidate line without `ineligible: `, so the verdict never says `eligible` about a machine
placement skips; a blocker of `ready` reads `<reason> (readiness)` there. Only a heavy task's
slots are per task: they show in `heavy`. `requirements` is what a machine's doctor checks against:
volleyd's version, the bun the running wave's repo asks for (the same repo as the own doctor's;
`engines.bun`, else `packageManager`) when it names one, and the Claude profile sharing modes of `sharing.yaml`.

The verdict is re-computed on every tick, on each folded record, on a config change and after a
probe; it is re-published when anything but `checked_at` changed, and otherwise every
heartbeat. A change of `ready` or `reasons` is journaled in `_system` as
`machine_readiness_changed { name, ready, reasons }`.

A verdict waits for its inputs. Until a peer's record has folded in and its first PATH probe has
finished (no probe runs while its tunnel is not up), or until volleyd's own first doctor run has
finished, volleyd neither publishes nor journals that machine's verdict, at most for
`machine_down_after_ms` after it starts. So a restart leaves the last retained verdict in place
and journals nothing for a machine that did not change: the first verdict with its inputs is
compared with the last journaled one, or, when there is none, is the baseline.
`peer_remove`, or a host leaving the config, clears the verdict.

**Caps and drain.** `hosts.<name>.max_agents` (1 to 100, default 4) and `hosts.<name>.drain`
(default `false`) are validated by `config_set`, applied hot and journaled as `config_changed`:

```sh
volleyd config set hosts.box-a.max_agents 2
volleyd config set hosts.box-a.drain true     # no new placements; running agents finish
```

The supervisor's own machine is capped by `hard_ceiling`, which still caps the total: its verdict
reads `max_agents: hard_ceiling` and `placed` every live supervised agent, wherever it runs, so
with 12 agents on peers and a ceiling of 12 it is `"12/12 agents"`.

**Repair (`peer_doctor`).** An admin (the account-op topic and admin check of `peer_remove`;
refused on the mailbox) asks volleyd to run the doctor on a configured host:
`{ op: "peer_doctor", name, fix?, clone? }`. volleyd runs `volley peer doctor --json`, plus
`--fix --yes` with `fix: true` and `--clone --origin <url>` with `clone: true` (which needs `fix`),
in the box's `volley_dir` as one fenced remote step; the fence allows exactly those argv on a box
and no other `volley` command. `<url>` is the running wave's origin as the supervisor's own doctor
read it from its clone, as `https://<host>/<path>` (`gh auth setup-git` signs git in to it; the
fence admits no credentials, port or other form); while no wave runs, or its origin has a port,
`clone: true` is refused before ssh (`the wave repo's origin is not known …`). The answer is the doctor's report (`checks`, `versions`, `auth`, ...); without
`fix` it also carries `plan`, each failing check with its fix, so the sheet shows what a fix would
do before anyone runs it. An ssh failure answers `ok: false` with ssh's reason. The run (up to
`peer_doctor_timeout_ms`, 15 min, for a `--fix`) happens outside volleyd's serial queue, so ticks
and control ops go on meanwhile; a second `peer_doctor` for the same host while one runs is
refused (`a doctor run on "<name>" is already in progress`). Each run is journaled in `_system`
as `peer_doctor_run { by, name, fix, clone, ok }`. After a Repair the box's PATH is probed again
on the next re-compute. Repair runs the bare `volley` of the box's non-interactive ssh PATH: on a
box whose PATH probe finds no `bun` (and so no `volley`), fix the PATH first, or Repair answers
only `volley: command not found`.

---

## Fleet: placement

Placement (SPEC §4.6.15) is opt-in: a wave's `placement: auto` places every task that does not
name a host, and a task's `host: auto` is placed in any wave. Every other task runs where its
`host:` says, and a wave with neither runs exactly as before (nothing is journaled for it).

**When.** A task is placed once, when the scheduler admits it, and never moved afterwards: every
role of the task (implementer, reviewers, fixup, rebase) runs on that host. volleyd journals
`task_placed { task, host, score, candidates, by, local? }` before `task_admitted`
(`local: true` on its own machine, so a replay needs no config and survives a `fleet.local_name`
rename), and the reducer folds it into the wave state's `tasks[].placement` and the task's host
(`tasks[].host`, absent for its own machine). Under `placement: auto`, a task that names its host is journaled `by: "wave_file"`,
unscored, with that one candidate. `volleyd spawn` refuses a task that is still `auto` (it is
placed when admitted).

**Eligible.** The candidates are volleyd's own machine and every configured host with a machine
record. A machine is eligible when its readiness verdict is `ready`, it is not draining, `placed`
is under `max_agents`, its load per core (the higher of its 1- and 5-minute load averages) is at
most `placement.load_per_core_max` (1.5),
its available memory is at least `placement.mem_available_min_pct` (10 %), its free disk at least
`placement.disk_free_min_gb` (5 GB), its account's 5-hour usage is under `claude.warn_at_pct`
(unknown usage passes), its own admission is not holding starts (below), and, for a `heavy: true`
task, every pool of the wave's `heavy_pools` that sets `per_machine` has a free slot there.
Memory is the record's `memory.available_pct`, which has one definition on every machine: memory
the kernel can hand out without paging anything active out, over total memory. On Linux that is
`MemAvailable` (`os.freemem()`), for volleyd's own record and a peer's heartbeat alike. On macOS
free pages alone under-count (a healthy Mac keeps them in single digits), so the figure is
`vm_stat`'s free + inactive + speculative + purgeable pages times the page size, taken by the
machine's doctor: a peer's heartbeat carries its last doctor run's, and volleyd's own record its
own doctor's (re-run every heartbeat); with no doctor figure yet the record has no `memory` rather
than the free pages. Placement does not re-sample it. Unknown memory or disk passes.

**Score.** Each eligible machine scores, in 0..1 (two decimals), the weighted mean of its
headrooms: CPU `max(0, 1 - load per core / load_per_core_max)`, slots
`(max_agents - placed) / max_agents`, memory `available_pct / 100` and usage
`1 - five_hour_pct / 100`, weighted by `placement.weights` (`cpu 40, slots 30, mem 15, usage 15`;
relative, so they need not sum to 100; all four at 0 is refused, in `config.yaml`, by `config_set`,
and across the layers: a wave whose `config:` would bring them to 0 with the global config's is
refused by `volleyd run` and `volleyd validate`). An unknown headroom (no memory figure, usage not metered)
is left out and the other weights renormalised; with no weighted headroom known the machine
scores 0 and its line says so. The order is: `placement_prefer` machines first,
`placement_avoid` ones only when nothing else is eligible, then score, then fewer placed agents,
then the name.

**Why here.** Every candidate gets a one-line `line`, which the Desk and `volleyd status` show
as written:

```
load 3.2 on 16 cores · 1/4 agents · 71% mem · usage 34%
load 3.2 on 16 cores · 0/4 agents · 71% mem · usage 34% · heavy slots 1/1 free (backend-it) · preferred
ineligible: overloaded: load 32.0 on 16 cores · no new agents
ineligible: overloaded: memory available 9% (min 10%) · no new agents
ineligible: claude not on the non-interactive ssh PATH (...) (readiness)
ineligible: 4/4 agents (max_agents)
ineligible: heavy slots 0/1 free (backend-it)
```

When no machine is eligible the task stays queued, its `why_waiting` naming the closest machine
(fewest reasons, then best headroom), e.g. `no eligible machine: box-b: draining`, and it is
placed again on the next tick.

**Reservations.** A placement counts in its machine's `placed` (readiness and the next placement)
from the moment it is admitted until its implementer is a live supervised agent, so the second
placement of one tick sees the first; a `heavy: true` placement also counts in `heavy.<pool>.held`
of each of the wave's heavy pools there, so two heavy tasks never stack on one per-machine slot.
The machines placed on have their readiness verdicts re-computed and re-published right after the
tick's placements. volleyd's own machine counts every live agent and every reservation, wherever it
runs: `hard_ceiling` caps them all.

**Per-host admission.** A task placed on a peer is admitted by that peer's own signals: memory
available under `placement.mem_available_min_pct`, or load per core over
`placement.load_per_core_max`, read from its record at each heartbeat with the same
`admission.hysteresis_samples` hysteresis (a breach holds starts there until the machine is clear
for that many heartbeats). volleyd keeps each peer's last heartbeats and decides at admission
time, with the wave's own effective thresholds (its `config: placement:` overrides, a
`config_set` that just landed); only a heartbeat with a newer `last_seen` is a new sample, so a
reconnect's retained copy or a QoS 1 duplicate is not counted twice. A breach is placement's own
load or memory line; while the peer recovers its candidate line and readiness verdict say
`recovering: memory available clear for 1/3 samples`, and a task pinned there waits with
`box-a: recovering: …`. The global signals (API overload, CI queue) still hold starts everywhere;
volleyd's own machine signals (memory pressure, cmux ping, containers) hold only placements on
its own machine, so in a placing wave agents may start on peers while the published admission
verdict's `allow` is 0 for one of those. A paused wave, the kill switch or a global signal holds
every task, and `why_waiting` says that, not a machine reason from an earlier tick. Tasks of a
wave that does not opt in are admitted as before.

**Preview.** `volleyd validate` and `volleyd run` print, for a wave that places tasks, where its
auto tasks would go if admitted now, from the records and verdicts retained on the broker:

```
if admitted now: T1 → box-a (0.85), T3 → local (0.58)
  (from the machines' records now; the real decision is made at admission)
```

`volleyd status` prints each placed task's host and every candidate's line under it:

```
  T1  #101   implement
    on box-a (auto, 0.81)
      box-a    0.81  load 3.2 on 16 cores · 1/4 agents · 71% mem · usage 34%
      control  0.63  load 6.0 on 8 cores · 2/12 agents · 40% mem · usage 34%
      box-b    -     ineligible: draining
```

Tunables (`config set`, hot): `placement.load_per_core_max`, `placement.mem_available_min_pct`,
`placement.disk_free_min_gb`, `placement.weights.{cpu,slots,mem,usage}` (not all four 0).
A machine that stays down, re-placement and drain are the owner's decisions (next section):
nothing running is ever moved.

---

## Fleet: down, overload, drain, remove

What happens when a machine goes away, gets busy, or is taken out of the fleet (SPEC §4.6.14,
§4.6.15). The rule throughout: nothing is re-placed or moved without the owner's answer, and a
running agent is never migrated.

**Down.** A machine whose heartbeat stops (or whose LWT arrives) is down: its spawns park, every
unfinished task there shows `host_down`, and each wave with tasks there journals `MACHINE_DOWN`
(§4.6.14). volleyd remembers since when, on its own clock (`MachineHealth.downSince`). Once it has
been down for `placement.down_decision_after_s` (default 300), each running wave with unfinished
tasks there gets one wave-level `machine_down` decision carrying `host`, `down_since`, `tasks`
(running and waiting) and `machine: "down"`. A task counts as running only while an agent of it
is live (supervised, launched and being verified, or spawning); one whose agent ended (between
roles, or waiting on its respawn question) is waiting:

```
box-a has been down 5 min (no heartbeat for 90 s). 2 tasks placed there have no agent running
(queued, or waiting for their next role): T3 and T4. T1 is running there and is left alone: a
running agent is never moved. wait: keep them parked until box-a is back; this is what happens if
nobody answers, and this question closes itself when box-a returns. re-place queued tasks: place
T3 and T4 again without box-a (best now for T3: studio). cancel: cancel T1, T3 and T4 (T1's
running agent is told to stop).
```

- `wait` (also what happens with no answer): everything stays parked. volleyd asks again only when
  a waiting task appears there that the last question did not name.
- `re-place queued tasks` (the Desk pre-fills it): each listed task that still has no live agent
  and is still on that machine goes through placement again (F3's `place`, with the machine
  excluded and each choice reserved for the next), journaled `task_placed { by: "decision",
  from: "box-a" }`; its next role starts where it now is. Tasks with a live agent stay where they
  are. A task with no eligible machine stays and says why (`alarm_raised { code: NOT_REPLACED }`),
  and the answer keeps applying: it is placed as soon as a machine is eligible.
- `cancel`: every listed task not finished is cancelled; a running agent there is sent `cancel`
  (it waits in its mailbox while the machine is away).
- The machine coming back resolves an open `machine_down` with `wait` (`by: volleyd`).

**Closed to new agents: draining, being removed, removed.** Nothing new starts on a machine that is
draining (`hosts.<name>.drain`), being removed (a pending `peer_remove { drain | now }`) or was
removed: a spawn for a task placed there (its first agent, its next role, a respawn) parks with a
plain `why_waiting` (`box-a is being removed: nothing new starts there; re-place or cancel T3 (its
machine_down decision)`), never a spawn that fails on a host that is gone. Each running wave with
such a waiting task gets a `machine_down` decision at once, with `machine: "draining" |
"removing" | "removed"`: `re-place queued tasks` and `cancel` as above, and `wait` only while the
machine is draining (until its drain is lifted; a machine being removed or removed is not coming
back, and its tasks stay parked if nobody answers). A task whose own open question already offers
`respawn on <best>` is left to that question. An open `machine_down` whose trouble changed (a
down machine removed, a drain lifted) closes itself (`superseded`, or `wait`), and the question
about the new trouble follows.

**Respawn on another machine.** A decision that offers `respawn` for an agent whose machine is
down or not eligible (an agent reaped while its machine is away, an agent stopped by a remove-now)
also offers `respawn on <best>`, `<best>` being the best eligible machine when it opened (F3's
placement with that machine excluded), and its question says what each option does and that
nothing is respawned without an answer. On a machine closed to new agents, plain `respawn` is not
offered (it could only park). Answering `respawn on <machine>` checks that machine again: one that
is down, closed or not eligible by then refuses the answer (journaled as `respawn on <machine>
(refused: <why>)`, nothing re-placed), and the question is asked again with a fresh offer.
Otherwise the task is re-placed there first (`task_placed { by: "decision", from }`), then the
role respawns in a fresh worktree there. An implementer respawn (anywhere) continues the branch
the earlier attempt pushed: when origin has it, the new worktree is that branch, cut from origin's
copy, and the brief names it and the PR open from it, so no second branch or PR is started; a
branch never pushed starts afresh from `origin/<release>`. A later role (reviewer, fixup) starts
at the task's verified head with its branch and PR, by name. Only the offered machine counts as
an answer.

**Overloaded.** A machine whose load per core (the higher of the 1- and 5-minute averages) is over
`placement.load_per_core_max`, or whose available memory is under
`placement.mem_available_min_pct`, takes no new placement, and its readiness says
`ineligible_reason: "overloaded: load 24.1 on 16 cores · no new agents"`. Nothing running there is
touched. A peer stays ineligible until `admission.hysteresis_samples` (3) clean heartbeats in a
row (`recovering: load per core clear for 2/3 samples`).

**Drain.** `hosts.<name>.drain: true` (hot, `config set`) takes a machine out of placement and
stops new spawns there (above); its readiness shows `drain: true` and `placed`.

**Remove: at once, drain, now.** `peer_remove { name }` (`volley peer remove <name>`) removes a
paired machine at once. With live agents there (supervised, launched and still being verified,
or spawning):

- `{ name, drain: true }` (`--drain`) sets `hosts.<name>.drain`, answers at once
  (`result: { removing: "drain", agents }`) and journals `peer_drain_started { by, name, mode,
  agents }` in `_system`; each tick, once no agent is left there, volleyd finishes the removal and
  journals `peer_removed`.
- `{ name, now: true }` (`--now`) does the same and sends each agent there a `cancel` (an agent
  that comes up after the removal began gets it once it is supervised); one still live
  `stop_grace_s` after its own `cancel` is force-retired (`agent_force_retired { reason:
  peer_remove }`), its role ends as stopped and the pipeline opens its respawn decision, which
  offers `respawn on <best>`. A `done` an agent publishes before that is verified as usual: a
  finished implementer's pushed work and PR count.

With no live agent either removes at once. A pending removal is kept in `peers.json`
(`removing`), so it survives a restart, and it cannot be called off: the machine stays closed to
new agents (its readiness keeps `drain: true`, whatever `hosts.<name>.drain` says) until the
removal finishes; pair it again afterwards to bring it back. `drain` and `now` exclude each other,
and a second removal of a machine being removed is refused.

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
| still idle `idle_grace_s` after that steer | decision `agent_stalled` (options `nudge again`, `stop task`) | the answer is steered to the agent and counts as the next nudge; each further decision of the same idle waits twice as long after the answer (`idle_grace_s` × 2, × 4, …, at most `stall_backoff_max_s`, default 30 min) and says how many times it asked; `resumed` resets the count, so an agent the answer wakes starts again from one grace at its next idle; `stop task` cancels it |
| `idle` while the agent waits on its own work: the hooks' `background_wait` (a background shell still running), a lease it holds or waits on, a terminal footer counting running shells, or (local agents) a file under its worktree written within `idle_grace_s` (`.git`, `.volley`, `node_modules`, `target`, `build`, `dist`, `.venv`, `.next`, `coverage`, `.turbo` skipped; at most 2000 entries walked, a larger tree gives no write evidence); none of it counts once the idle is older than `background_wait_max_s` (default 2 h), so a shell that never exits still ends in a nudge | nothing: no steer, no `agent_stalled`; the task's `why_waiting` says `idle N min: <reason>` (e.g. `waiting on its own background task`, `holds lease <pool>`, `waits on lease <pool>`, `2 shells still running`, `worktree written in the last 3 min`) | — |
| `idle_prompt` while a question or credit prompt is open | nothing: still a wait on the human (never a "continue" steer or an `agent_stalled`) | — |
| `awaiting_input` with `class: "credit"` (`quota_auto_resume_*`) | `credit_exhausted` at once → decision `model_switch` (below) | the switch |
| no hook signal for `heartbeat_alarm_s` (default 10 min) while the status is `working` | read the screen (bounded, once per tick until decided) and classify it: | |
| ↳ the credit prompt (`screens.ts` `credit_exhausted`) | decision `model_switch` with the capture | the switch |
| ↳ readable and changing (two reads differ, or the screen-tail capture changed since the last hook signal) | decision `unknown_screen`, `class: "hooks_silent"`: "hooks may be broken by a harness update" | — |
| ↳ readable and unchanged on a second read | decision `unknown_screen`, `class: "screen_static"` | — |
| ↳ unreadable, pane gone | `alarm_raised { alarm: "crash_candidate" }` only: wait for the LWT. Nothing is killed because a pane or process cannot be seen | — |
| any hook signal | ends a silence; closes an open `hooks_silent` / `screen_static` decision | — |

**Terminal-status watchdog.** Every terminal status a supervised agent publishes (`done`,
`blocked`, `failed`) must lead to something in the wave journal that names the agent
(`decision_opened`, `agent_retired`, `artifact_verified`, `ci_pending`, `steering_sent`,
`relaunched`, …). One that nothing names within `terminal_unjournaled_alarm_ms` (60 s, on the
daemon's clock) is a status volleyd dropped: it journals `alarm_raised { alarm:
"terminal_status_unjournaled", agent_id, role, task, status, since }` once per status (`since` is
the status's `wall_time`), logs `watchdog: <agent> <status> unjournaled for <n>s`, and journals
`alarm_cleared` for it once something finally names the agent. A coordinator watching the journal
learns a task is stuck even when no decision was opened for it.

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
daemon was down — GitHub (`gh pr list --head`, `gh pr checks --json
bucket,workflow,event,link`; checks are grouped by the run id in `link` and only the latest
run per workflow and event counts, so `volleyd status` shows the replacement's CI, and a run
cancelled with nothing replacing it stays red even when some of its jobs passed). The probes run concurrently and
beside the serial queue, after the mailbox loop started (control ops are answered meanwhile);
one `reconciled { agent_id, drift, action?, branch: { name, exists, head } }` per agent is
journaled inside it:

| Finding | `action` | Then |
|---|---|---|
| consistent | none (`drift: []`) | the agent is watched again (status, hooks, screen tail) |
| the agent reported `done`, its PR exists and CI is green | `mark_done_verified` | `artifact_verified { pr }`; watched again, so its `done` retires it |
| any sign it may be alive (registry, live status, lock, recent heartbeat), or `done` without a green PR, or `failed` | `re_wait` | watched again; the normal status path takes over |
| no registry entry, no status, no heartbeat, no lock | `respawn_needed` | decision `agent_blocked`, `class: "respawn_needed"` (options `respawn`, `stop task`; `stop task` only with spawning off) — not a second one while it is open |

A wave whose status is `stopped` or `complete` is not reconciled at all: each of its unretired
agents is reported as `reconciled { agent_id, drift: [], skipped: "stopped" }` — never re_wait'ed,
respawned or asked about — and a stopped wave's leftovers are force-retired (see
[Pause, stop and the kill switch](#pause-stop-and-the-kill-switch)).

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

## The pipeline and the merge-ready gate

`done` from an agent is a claim. `src/pipeline.ts` drives each task through its `pipeline`
(default `[implement, [spec_review, quality_review], fixup, merge_ready]`) and only moves on when
the claim checks out. It is a pure interpreter, `next(view, event) → actions[]`, over a per-task
`TaskPipeline` the reducer folds from the journal (step, role runs, verified head, reviews), so
the position survives a restart; `PipelineDriver` executes the actions through the daemon.
Every git / gh call it makes is bounded by `pipeline_io_ms` and runs beside the daemon's serial
queue: the result comes back as an event through the queue, so a hung `git fetch` or `gh` call
never holds up control ops, the kill switch or shutdown. A timed-out check is "not verified yet"
(no alarm; the next tick re-checks); any other failure is one `pipeline_error` alarm per
condition, and the other tasks and waves still get their tick. For a task on a remote host the checks run on
the box, through that host's exec, where its worktrees are.

| Stage | Role(s) | Worktree | Accepted when |
|---|---|---|---|
| `implement` | `implementer` | `<task>-implementer`, branch from the release branch | artifacts verified |
| `spec_review` ∥ `quality_review` | two fresh reviewers | each its own `--detach` worktree at the verified head | a parseable `review` result |
| `fixup` | `fixup` | its own branch from the head; pushes `HEAD:<PR branch>` | artifacts verified |
| (rebase) | `rebase` | its own branch from the head; lease-guarded push (`branch_update: merge`: a merge and a normal push) | artifacts verified (merge: the new head descends from the old) |
| `merge_ready` | — | — | evidence written; the task is a gate |

**Artifact verification** (`src/artifacts.ts`, read-only verbs only): the role's local HEAD
equals `origin/<PR branch>` after a `git fetch`; `gh pr list --head <branch>` has an open PR whose
`headRefName` *equals* the branch (the CLI has returned another branch's PR) and whose base is the
release branch; CI on exactly that head (`gh run list --commit <sha>`) is green. A missing
artifact is journaled (`alarm_raised { alarm: "artifact_missing", missing: push|pr|base }`), the
agent is steered once ("push + open PR, then publish done again") and re-waited; still missing →
an `agent_blocked` decision. Success journals `artifact_verified { role, head_sha, pr, ci_runs }`.
The steer names what the role publishes: the implementer its branch and PR, the fixup its
`git push origin HEAD:<PR branch>`, the rebase its lease-guarded push (under `branch_update: merge`,
its merge and normal push).

**CI** is never re-run. CI on a head is the latest run per workflow and trigger event: a run that
a newer run of the same workflow and event replaced on the same head (a concurrency
`cancel-in-progress` cancel, a re-push) is superseded. It decides nothing, is left out of the run
URLs and check counts, and is listed under `ci.superseded` in the evidence package; a `push` run
and a `pull_request` run of one workflow are both the head's CI. Red on the head → a `ci_failed`
decision with the run URLs and failed job names (`data.infra`, and `data.infra_reason`:
`startup` \| `steps` \| `cancelled` \| `null`). A run that never started, or failed only in
runner, checkout or network steps, adds "check the hosting provider's status page first"; when
every failed run was cancelled and nothing replaced it, the decision says to re-run it (or push
again) instead. Pending CI is re-checked every
`ci_poll_ms` (the agent is retired meanwhile); a head with no CI run at all for
`ci_none_grace_ms` asks the owner (`accept` / `cancel`). The hold is visible: entering it (and
every change of head or counts) journals `ci_pending { role, sha, checks: { done, total },
next_poll_at, pr }`, the task's `why_waiting` reads `CI pending on <sha7> (n/m checks)` and its
`pr` carries `{ number, head_sha, ci: running, checks }` (what `volleyd status --json` prints);
CI green journals `ci_green` and clears it.

**Stage groups.** While a parallel group runs, the task's `stage` stays the closed enum (its
first stage, `spec_review`) and the state adds `stage_label: "review (spec + quality)"` and
`stage_group: [{ role, agent_id, state: pending|running|done|retired }]`; `volleyd status`
prints the label and one line per role.

**Reviews.** Reviewers publish `vol_publish(channel="result", type="review", payload={ findings:
[{ severity: P1|P2|P3, file, line?, text }], verdict, hygiene?: { checked: true, findings } })`
(`review-result.schema.json`). Both reviewer briefs carry a hygiene line, whatever the repo's
preface says, at the wave's hygiene level:

- **P1** (a public repository, one whose visibility could not be read, or `public_hygiene: on`):
  "flag as P1 any person name, local username, machine path (home directories, temp paths),
  private hostname or IP in the diff, commit messages or PR text". The `hygiene` block is
  required: a result without `hygiene.checked` is not a parseable result, and every hit in
  `hygiene.findings` is a P1, whatever severity the reviewer gave it.
- **P3** (a private or internal repository under `auto`): the same check as a non-blocking note.
  The block is optional; its hits are P3s, never promoted.
- **off** (`public_hygiene: off`): no hygiene line, no block; a block a reviewer sends anyway is
  ignored.

volleyd folds the hits into the review's findings, so the fixup gets them. **`public_hygiene:
auto | on | off`** (a tunable: `config.yaml`, `config_set` or a wave file's `config:`; default
`auto`) picks the level. Under `auto` the daemon reads the repository's visibility once per wave
version, at `run` (off the serial queue, beside the issue fetches), with `gh repo view --json
visibility` in the repo (bounded by `repo_visibility_ms`), and journals `repo_visibility_detected
{ visibility: public|private|internal|unknown, source: "gh", public_hygiene }`; `on` and `off`
skip `gh` and journal `visibility: null, source: "config"`. A failed or timed-out read is
`unknown` plus `alarm_raised { alarm: "repo_visibility_unknown" }`, and is treated as public. The
wave state carries `repo_visibility` and `hygiene_level`, and `volleyd status` prints
`hygiene: P1 (public)`, `P3 (private)`, `P1 (unknown)`, `P1 (forced)` or `off` under the
header. A daemon that spawns no agents reads and journals nothing (the level is then P1). A
`done` without a parseable result (at that level) is steered once with the level's contract,
then `agent_blocked` (`respawn` / `skip`). The spec reviewer gets `ISSUE.md` and the diff; the quality reviewer gets the diff only (no
`ISSUE.md` in its worktree). A P1 from
one reviewer that the other rated P3 on the same hunk (same file, lines within
`review_hunk_lines`) opens `reviewers_disagree` (`blocker` / `fine`; `fine` hands it to the fixup
as a P3). The fixup gets `.volley/findings.md` + `.json` — every finding of the round, numbered
`S1…`/`Q1…`, with the rule "every P1; P2/P3 only if trivial" — and reports
`{ resolved: [{ finding, how }] }` (`type: "fixup"`); a fixup `done` without one is steered once,
then `agent_blocked` (`skip`: verify its work anyway, its findings stay unresolved / `respawn` /
`cancel`). The result is kept with the fixup's retire (`agent_retired.result`), so a fixup whose CI
was still running at its `done` — the usual case — still has its resolutions in the evidence. A
round with no findings skips the fixup.

**Decision answers** are matched exactly (case and surrounding space aside): `cancel` cancels,
`re-verify` re-verifies (as does any other answer to a `verify` / `ci_failed` decision), and any
other answer that is not one of the decision's options re-asks the question. A `respawn` drops the
role's run, so the spawn is retried on every tick until it goes through. A role whose agent is
reaped (its LWT, past the reap grace) is handled like a `failed` one: retired, then a
`respawn` / `cancel` decision.

**Rebase rule.** Before the gate the release branch is fetched and compared with the head's
merge-base. Moved → a `rebase` agent rebases; its new head must verify (CI green on it) and, if
the rebase changed a file a reviewer flagged (`git diff --name-only <old> <new>`), only that
reviewer runs again (then the fixup, if it finds anything), and the check repeats.

**`branch_update: rebase | merge`** (a tunable: `config.yaml`, `config_set` or a wave file's
`config:`; default `rebase`) is how that step updates the branch. `rebase` is the above: rebase
onto `origin/<release branch>`, then `git push --force-with-lease=<PR branch>:<old head>`. `merge`
is for repositories that allow no force-push of any kind: the step's agent gets the merge brief
(`briefs/rebase-merge.md.tmpl`) and a `.volley/rebase.md` that runs
`git merge --no-edit origin/<release branch>` and a normal `git push origin HEAD:<PR branch>`, and
its verification also requires the new head to descend from the head the step started at
(`git merge-base --is-ancestor <old> <new>`): a rewritten branch (a rebase force-pushed anyway) is
`artifact_missing` (`push`), steered once with its own fix (no force-push: `git checkout -B fix
<old>`, merge the release branch and then the rewritten branch into it, a normal push) and then
put to the owner. The merge commit contains
the release head, so the gate's check finds the branch current. The mode is read when the step
starts and journaled on its `stage_entered` (`branch_update: "merge"`), so the agent's brief, its
`.volley/rebase.md` and the check agree even if the tunable changes meanwhile (an account move
or the respawn of a vanished agent keeps it too). Steers and decisions call that role's work "merge (branch update)"; the role is
still `rebase` in the wave state and the journal.

**The merge_ready invariant.** The review stage is load-bearing, so the transition into the gate
goes through a pure guard (`mergeReadyCheck`): every reviewer role in the task's pipeline must
have a stored review with a verdict that holds for the **current head** — a review of that
head, or of one it descends from only through fixups that ran after that review (they worked
from its round or a later one) and branch updates (rebase or merge). A head pushed outside the
pipeline (`pr_head_moved`, re-verified) was reviewed by nobody, so reviews of the heads before
it no longer count — unless the owner accepted it without a re-review by answering that `pr_head_moved` decision `fixup`,
or `accept` for a merge of the release branch only (`moves[].accepted_by`, and `how:
"release_merge"`, in the evidence; SPEC §4.6.8). A
violation gates nothing: the guard runs when the task reaches the end of its pipeline (before
any GitHub check) and again at the gate, and journals
`alarm_raised { alarm: "merge_ready_invariant", head, missing, stale }`, then parks the task on an
`agent_blocked` decision (`rereview` / `cancel`) that names the roles. `rereview` runs those
reviewers again at the current head (the next review round; the fixup follows if they find
anything), then the gate is checked again; `cancel` cancels the task. The only way past the reviews is a wave file whose
pipeline for the task lists no review stage (`pipeline: [implement, merge_ready]`): that gate is
journaled as `alarm_raised { alarm: "reviews_skipped_by_plan" }` and the task carries
`reviews_skipped_by_plan: true` in the wave state (`volleyd status`: "reviews skipped by plan").
A review the owner `skip`ped through a decision is a stored review and counts.

**Evidence package** at the gate: `$VOLLEYD_HOME/waves/<wave>/evidence/<task>.md` + `.json` —
PR URL, head SHA, CI status and run links on that exact head, both reviews' findings and how each
was resolved (unresolved P1s called out), each fixup's diffstat, the rebases, and "branch current
with release branch: yes/no (behind by N)", or, with the task's [`base_sha`](#base-ref), "yes/no
— cut from `<sha7>`, N behind" (`base_sha` in the `.json` too). A P1 the owner ruled not a blocker is listed as a P3
with the ruling (`owner: not a blocker (<who>)`), not as an unresolved P1. Just before gating, the
PR's head is read again (`gh pr view --json headRefOid`): if someone pushed after the
verification, `alarm_raised { alarm: "pr_head_moved", expected, actual }` re-opens that role's
verification on the PR branch's new head (CI must be green on it), and the evidence lists the
push under "Pushes outside the pipeline" (the reviews keep the heads they name). Then
`artifact_verified { role: "gate",
evidence_path }` and `stage_entered merge_ready`: the task appears in the wave state's `gates`
with its `evidence_path`.

**Who merges.** Under `merge: manual` volleyd never merges: a human merges the PR. Under
`merge: auto` volleyd merges it itself, exactly at the gated head ([autopilot
merging](#autopilot-merging), below). Either way, the pipeline polls every task's PR read-only
(`gh pr view <n> --json state,mergedAt,mergeCommit,baseRefName,headRefOid`, every `ci_poll_ms`),
in any stage short of `done` and `cancelled` — at `merge_ready`, and also while the task waits
on a decision, while the reviews run or during a fixup. Once it is `MERGED` into the release
branch, the task's open decisions are resolved first (`superseded_by_merge`, by `volleyd`, with
the merge commit in the rationale; a parked task would otherwise stay parked), its live agents
are retired, and it journals `artifact_verified { role: "merged", head_sha, merge_sha }` and
`stage_entered done`, which releases the task's dependents. Merged at another head than the
gated one, or before the task reached `merge_ready` → also `alarm_raised { alarm:
"merged_unverified_head", gated, merged }` (`gated`: the task's verified head, `null` if none), and the merge record describes the commit that merged: `gated_head_sha`,
`merged_head_sha` and `merged_ci`, the CI of that head (read with `gh run list --commit`;
`unknown` when it cannot be read), never the gated head's CI carried over; the task's `pr` names
that head. The alarm is published in the wave state (`alarms: [{ alarm, message }]` and
`why_waiting: "merged with an unverified head: gated <a>, merged <c>"`) and listed by
`volleyd status`; the task still completes.

**The merge nudge.** volleyd never rebases anyone. When a task's PR merges (any of the ways
above), each running implementer of the same wave whose task's wave-file `files` hints overlap
the merged PR's changed files (`gh pr view <n> --json files`, read-only, beside the queue) gets
exactly one mailbox steering, through the same path as `volleyd steer` (`steering_sent { reason:
"merge_nudge" }`): `origin/<release> moved to <sha7> with #<n> (touches N of your files: …);
rebase when convenient, before you push again.` (at most 5 files are named, then `and N more`).
The nudge is additive: it carries no `supersedes`, so it never hides an owner's or the
pipeline's steer the agent has not read yet. Each is journaled on the nudged task as
`merge_nudge_sent { task, agent_id, merged_pr, files, merged_task, pr_url }` (every touched
file), and an agent is nudged at most once per merged PR, however often the merge is observed.
Only implementers spawned before the merge are nudged (a later one's base already has it). A
nudge that did not go out (the PR's file list could not be read, or the daemon stopped first) is
sent by a later tick, at most once per CI re-check interval and once after a restart.
`placement.nudge_on_merge`
chooses who: `files` (the default; a task with no `files` hint is never nudged), `all` (every
running implementer of the wave, `files: []`, no PR file list read) or `off`. The agent rebases
in its own session; the fence denies volleyd `git rebase` anyway.

**Merges outside GitHub's merge button.** A local squash + push closes the PR with
`mergedAt: null`. Before calling it abandoned, the release branch is checked read-only for the
gated head: `git merge-base --is-ancestor <head> origin/<release>`, else every head commit has an
equivalent patch there (`git log --left-right --cherry-pick <release>...<head>`, the fenced form
of `git cherry`), else a release commit whose subject ends with the PR as GitHub's squash writes it
(`… (#<n>)`, not a revert) **and** whose own diff is the PR's whole diff — a subject alone, a
mention (`follow-up to (#<n>)`) or a superseding PR never counts. A match journals
`artifact_verified { role: "merged", via: "outside_github", how, sha }` (plus the merged
commit's own CI as above) and the task is done; an older `pr_closed_unmerged` alarm is cleared
(`alarm_cleared`). No match: the task leaves the gate (`blocked`) and decision `pr_closed`
asks `landed` or `abandoned` (cancelled). A closed, unmerged PR never counts as landed on an
answer alone: `landed` asks again, pointing at `volleyd merged`. `volleyd merged <wave> <task> --sha <sha>` (owner only) records such a merge with
proof: the sha must be on the release branch and carry the gated head (an ancestor, equivalent
patches, or one squashed patch equal to the PR's whole diff); then `merged_by_operator { by,
sha, head, how }` and the task is done (an open `pr_closed` is answered `landed`). Anything else
is refused.

**A PR head that moves at a gate.** At `merge_ready`, and while the reviews run, the PR's
`headRefOid` is read every `ci_poll_ms` (the driver's injected clock). In the CI hold after an
implementer's or fixup's `done`, the hold's re-verification watches it: origin's branch at
another commit than the role pushed is the same move (from the last verified head). A head the pipeline did
not push journals `pr_head_moved { from, to, during }` and invalidates the gate: the task leaves
`merge_ready` (`stage_entered { stage: "fixup", gate_invalidated: true }`), its evidence package
is marked stale (`stale: { from, to, at }` and a banner), nothing downstream is admitted. CI on
the new head is awaited (`ci_pending`, as above), then decision `pr_head_moved` asks
`rereview` (the reviewers again on the new head, a new review round, then the fixup and the
gate), `fixup` (a fixup agent at the next attempt on the new head; the reviews of the old head
hold for it on the owner's word), `accept` or `cancel`. `accept` is offered only when CI on the
new head is green and the move is a merge of the release branch only: the new head's parents
are the old head and a commit on `origin/<release>` (`git log -n 1 --format=%P`, `git merge-base
--is-ancestor`), and every file the move changed (`git diff --name-only <old> <new>`) is one the
release branch changed since the PR branched from it (a conflict resolved inside such a file, the
CHANGELOG case, still counts). `accept` verifies the head role again at the new head
(`artifact_verified { adopted: true, accepted_by, move: { how: "release_merge", parent, touched
} }`), keeps the reviews of the old head (like a branch update) and goes on to the rebase check
and the gate; the evidence says "Accepted by <who>: a merge of the release branch only". An
`accept` the decision did not offer is asked again. The fixup's `.volley/findings.md` opens with a
directive: CI on the new head, and when it is red its failed jobs and the failing test ids read
from `gh run view <id> --log-failed`, plus the diff since the gated head. A red CI on a moved
head is routed there, not into a `ci_failed` dead end, and a fixup is never skipped while that
CI is red; a green CI still asks (the reviews saw another head). The gate is re-entered through
the normal machinery and its evidence regenerated with every head in `head_history`. The fence denies `git merge`,
`git push` and `gh workflow run` anyway, and `gh pr merge` but for the one gated PR at its gated
head ([autopilot merging](#autopilot-merging)); `test/no-merge.test.ts` also holds the source
(only `src/autopilot/merge.ts` builds a `gh pr merge`) and two full pipeline runs on an unfenced
fake exec: under `merge: manual` no merge, push or CI re-run at all, under `merge: auto` exactly
one `gh pr merge <n> --squash --match-head-commit <gated head>` and nothing else.

Role spawns go through the same lock, launch and verification as the implementer's, under T5's
admission verdict, within the wave's spawn budget and only while the wave is running
(`roleSpawnHold`); a held spawn is retried on the next tick.

### Autopilot merging

In an unattended wave the gate is where work stalls: every merge waited for a person. Under
`merge: auto` (the wave file's `merge:` key; without it the `autopilot.merge` tunable, default
`auto`) volleyd merges a gated PR itself, under the same evidence it already produces:

- **Only the gated head.** When `gate()` has written the evidence package it mints a
  `MergeToken` over `{ wave, task, pr, head, release_branch }` (`src/fence.ts`, checked by
  identity like a consent token). The fence allows exactly `gh pr merge <n> --squash
  --match-head-commit <head> [--delete-branch]` with a token whose `pr` and `head` are that
  argv's, and nothing else new: never `--admin`, `--auto`, `--merge` or `--rebase`, and `git
  merge`, `push` and `rebase` stay denied. `--match-head-commit` makes GitHub refuse a PR whose
  head moved since the gate. The token lives in the driver's memory only; after a restart the
  next tick re-runs the gate's checks (the rebase check, then the gate, which rewrites the
  evidence) to mint it again.
- **Beside the queue.** The `merge` action runs `gh pr merge` like every pipeline call (hard
  timeout `pipeline_io_ms`, at most once per `ci_poll_ms`), then reads the merge commit back
  (`gh pr view <n> --json mergeCommit,state`). Merged: `merged_by_supervisor { task, pr, head,
  merge_sha, by: "volleyd" }`, then what any merge gets: the task's open decisions resolved
  (`superseded_by_merge`), `artifact_verified { role: "merged", via: "supervisor" }`,
  `stage_entered done` and the merge nudge.
- **Refused, never forced.** `gh` exiting non-zero (the head moved, required checks, branch
  protection) journals `alarm_raised { alarm: "merge_refused", pr, head, stderr, attempt }` and
  reads the PR at once as any gate does (someone else may have merged it; a moved head
  invalidates the gate). After `autopilot.merge_retry_max` (default 2) refusals at one gated
  head the task leaves the gate (`blocked`) and decision `merge_refused` asks `retry` (one more
  attempt, at the task's next turn in the merge queue), `manual` (this task goes back to the
  gate and a human merges it) or `cancel`. A new gated head starts the count again.
- **When: the merge queue.** Nothing merges at the gate itself: the merge queue below gives one
  task at a time its turn.
- **`autopilot.delete_branch`** (default `false`) adds `--delete-branch` to the merge.

The evidence package names who merges: `volleyd merges this PR itself (merge: auto) at exactly
this head; the merge is journaled as merged_by_supervisor.`, or under `manual` the old `volleyd
never merges. A human merges this PR after reading the above.`

### The merge queue

A 30-task wave gates many tasks, often at once, and every merge moves the release branch under
the PRs still waiting. Merging everything green at once gets half the merges refused by
`--match-head-commit` races or lands conflicting changes; so volleyd merges a wave's gated tasks
one at a time, in order, and brings each up to date just before its merge
(`src/autopilot/merge-queue.ts` is the pure part; the driver's `mergeNext` runs it from the tick):

- **Entering and leaving.** A task gated under `merge: auto` enters the queue
  (`merge_queued { task, position }`) and leaves it when it merged (by volleyd or anyone),
  was cancelled, or went to a human (`merge_dequeued { task, why: merged | cancelled | manual }`).
  `merge: manual` keeps a wave's tasks out of the queue altogether.
- **Order.** Dependency first: a task more tasks name in their `after` goes first, and a task
  never goes ahead of a queued task it comes after. Then readiness: the task queued earliest. A
  task GitHub refused goes after the tasks still waiting.
- **One merge in flight per release branch.** The task at the front takes the release branch's
  lock (`<repo>#<release_branch>`, held by the daemon, so two waves on one release branch share
  it) and keeps it until it merged, GitHub refused it, or it waits for an answer. A task whose
  turn checks fail `merge_turn_check_failures_max` (3) times in a row (its PR was retargeted, `gh`
  keeps failing, its worktree is gone; each failure is a `pipeline_error` alarm) gives up the turn
  and is passed over, with the tasks that come after it, while another queued task can go.
  `merge_started { task, pr, head }` is journaled before each `gh pr merge`. A merge that ends
  without an outcome (the hard timeout fired, `gh` could not run, or the daemon restarted while
  it ran) is journaled `merge_ended { task, why: timed_out | failed | interrupted }`: the task is
  queued again and takes the turn (or `volleyd merge`) as usual. A stopped wave gives its turn up
  only once its running merge is back. Across waves on one release branch the lock goes to the
  wave whose front task asks first (the daemon's tick order), not to the task queued earliest.
- **Updated just before its merge.** At its turn the task is checked against the release branch
  at once (an event-driven rebase check, not delayed by `ci_poll_ms`). Up to date: the gate runs
  again (evidence rewritten, token re-minted) and it merges. Behind (a merge before it landed):
  the usual rebase step runs under the wave's `branch_update`, its agent pushes, CI runs on the
  new head, the gate checks it again and it merges. Only the front task is updated, after the
  merge before it: a 30-task wave does at most 29 updates, one at a time, never a storm, and the
  tasks behind keep their gates and evidence meanwhile. **Use `branch_update: merge` for an
  unattended wave**: it merges the release branch in with a normal push (no force-push, and the
  history the reviewers saw stays).
- **Conflicts.** Resolving a conflict is the rebase (or merge) agent's job; its brief
  (`.volley/rebase.md`) says so. An agent that publishes `blocked` on a conflict it cannot
  resolve, or fails, while the task is queued opens decision `merge_conflict` (options
  `respawn`, `manual`, `cancel`); during a rebase before the gate it is an ordinary
  `agent_blocked`.
  Autopilot answers `respawn` once per task (`merge_conflict/respawn`, under `respawn_max`), then
  leaves it to the owner; `manual` takes the task out of the queue and leaves it at the gate for a
  person, and the turn passes to the next task.
- **The wave state** carries `merge_queue: [{ task, state, since }]`, `state` being `merging`,
  `updating`, `queued` or `refused`, and `volleyd status` prints it under the header:
  `merge queue: T3 merging · T5 updating · T7, T9 queued`.
- **`volleyd merge <wave> <task>`** (the `merge` control op, owner only) merges one task at
  `merge_ready` now through the same verb, under `merge: manual` too; it answers with the merge
  commit (`merged_by_supervisor` carries `requested_by`), or with GitHub's refusal, and is refused
  while another task holds the release branch's turn (naming it: that task may be being brought
  up to date, which takes a rebase agent and a CI run).

---

## The authority fence

`src/exec.ts` is the only place volleyd spawns a child process (a test enforces it), and it calls
`assertAllowed(argv)` first. Denials throw `FENCE_DENIED` naming the verb. The deny list is checked
before the allow-list, so widening the allow-list can never silently un-deny a verb. The policy,
verbatim from `src/fence.ts`:

```
DENY (never, consent or not):
  git merge | push | rebase | reset --hard | branch -D/-d/--delete/-m/-M/-c/-C/--force
  gh pr merge (except MERGE below) | gh workflow run | gh repo delete | gh api with any method
    other than GET
  infrastructure CLIs: terraform, terragrunt, kubectl, helm, aws, gcloud, gsutil, az, pulumi,
    ansible, ansible-playbook, eksctl, doctl, flyctl
  docker rm | rmi | container rm | image rm | volume rm | network rm | system prune
  rm -rf (any spelling that combines -r/-R/--recursive with -f/--force)

MERGE (only with a MergeToken, `mintMergeToken`, minted by the pipeline's gate after the
  evidence package is written, checked by identity like consent tokens): exactly
    gh pr merge <n> --squash --match-head-commit <sha40> [--delete-branch]
  with <n> the token's PR and <sha40> its gated head (GitHub refuses the merge if the head
  moved since the gate). Never --admin, --auto, --merge or --rebase; the token unlocks nothing
  else (git merge, push and rebase stay denied).

CONSENT (denied unless a ConsentToken is passed — minted by `volleyd cleanup --yes`, or by a
retire for the retired agent's own workspace only):
  git worktree remove · cmux close-workspace

ALLOW (program by bare name only — never a path):
  git [-C <dir>] [--no-pager] worktree add | fetch | rev-parse | log | diff | status |
    branch --list | branch --track <b> <remote>/<b> | merge-base | show
    worktree add needs -b <new branch> or --detach (never checks out an existing branch), or
    -B only to re-create an agent branch (`<wave>/<task>-<role>-<n>`, worktree.ts
    AGENT_BRANCH — never a release or any other branch); the new branch is never main/master
    (in any case); fetch takes a remote name or a
    network URL (https, ssh, git, user@host:path — never a local path) and its refspecs only
    write refs/remotes/…
  gh issue view · gh repo view · gh pr view | list | checks · gh run list | view | watch ·
    gh api (GET only; a relative endpoint — never a URL — and never graphql in any path
    segment; no request headers)
  cmux — exact argv shapes only, because cmux types into an agent's shell:
    new-workspace --cwd <dir> --name <name> --command LAUNCH_COMMAND (each once, any order),
      with the LaunchToken of the `.volley/launch.sh` volleyd sealed in exactly <dir>
    send --workspace <ref> <text>   text: TYPED_TEXT only
    send-key --workspace <ref> Enter|Escape · read-screen --workspace <ref> [--lines <n>]
    list-workspaces · ping
  claude — volleyd starts claude only from `.volley/launch.sh` (renderLaunchScript), which the
    launch commands above run; its options are pinned (LAUNCH_SCRIPT_VARS), including
    `[--strict-mcp-config] --mcp-config=<worktree>/.volley/mcp.json -- <prompt>` (the flag is
    left out only under `agent_mcp: inherit`) — or from a
    sealed sign-in script (below). The one direct call: `claude auth status` (exactly; it prints
    a profile's login state and plan, never a credential)
  tmux (local: Claude account sign-in, src/claude/signin.ts) — sessions named
    `volley-signin-<acct>` only: new-session -d -s <it> -c <dir> 'bash signin.sh' with the
    SigninToken sealed for <dir> (`sealSigninScript`: exactly `renderSigninScript`, which runs
    `claude auth login` — never `setup-token`) · capture-pane -p -J -t <it> · has-session -t
    <it> · kill-session -t <it> (no consent: a sign-in session holds no agent's work)
  (agent logins are minted and deleted over volleyd's own Dynamic Security control
  connection, dynsec.ts: no `volley auth` command and no broker signal is involved)
  ps -axo pid=,command=   (exactly: lists processes for procs.ts, which stops a retired
    agent's claude by `process.kill`, never by a spawned `kill`)
  mosquitto -h   (exactly: it prints the binary's version, the fallback when the broker
    retains no $SYS/broker/version)
  volley auth list --json · rotate <agent_id> --json · revoke <agent_id>
  volley auth add <agent_id> --role ROLE [--kind KIND] --json
  volley auth signin-link --role steer|watch --label LABEL --ttl <seconds> --json
  volley auth redeem --label LABEL --json   (the token on stdin, never argv)
  volley auth token --json   (admin_token: the token sealed to the admin who asked)
    ROLE admin|steer|watch|supervisor|peer · KIND human|device|machine|service ·
    LABEL 1..64 printable characters, not starting with `-`
  volley peer doctor --json [--repo ABS]   (the supervisor's own machine's doctor report, SPEC
    §4.6.15: never --fix, which runs only on a box through ssh) · ABS the running wave's repo,
    an absolute path with no `.`/`..` segment and no control character
  launchctl bootstrap gui/<uid> $HOME/Library/LaunchAgents/systems.volley.volleyd.plist (that
    full path only) | bootout | kickstart [-k] [-p] | print — only for the
    systems.volley.volleyd service
  pressure samplers, exact argv only: sysctl -n kern.memorystatus_vm_pressure_level ·
    memory_pressure (no arguments: report only) · docker info --format {{json .}}

SCRIPT (allowed only with a ScriptToken naming exactly that path): the brief gate
  (`$VOLLEYD_HOME/brief-gate`), the one program volleyd runs by path.

SETUP (only with a SetupToken, `mintSetupToken`, and with one nothing else): the commands a
  `volley setup` step volleyd runs for the Desk (setup-ops.ts) may run: the terminal's own
  commands (volley-cli's `setupFence`) for the detected layout, minus those only a terminal
  may run:
    the layout's restart (brew layouts; never one starting with sudo) ·
    <ctrl> dynsec init <the layout's state file> dynsec-admin <password> (brew layouts) ·
    mosquitto -h
    launchctl print gui/<uid>/systems.volley.volleyd | gui/<uid>/systems.volley.desk ·
      bootout gui/<uid>/systems.volley.desk ·
      bootstrap gui/<uid> $HOME/Library/LaunchAgents/systems.volley.desk.plist
    systemctl --user daemon-reload | is-active volleyd.service |
      is-active | enable | restart volley-desk.service
    bash <repo>/packages/volley-hooks/scripts/install.sh [--dry-run]
    <bun> <repo>/packages/volleyd/src/cli.ts install --broker-url mqtt://… --dry-run (the
      plan's probe only) · <bun> run build in <repo>/packages/volley-desk
  Never volleyd's own service (installing or restarting it would stop the volleyd answering),
  sudo, or the keychain (the logged-in session's): those stay terminal-only.

TYPED_TEXT (cmux send, tmux send-keys -l: what is typed into an agent's terminal), each only
  with its token, checked by identity like consent tokens:
    LAUNCH_COMMAND   with a LaunchToken (`sealLaunchScript`: volleyd rendered that launch.sh)
    `/model <id>`    with the ModelSwitchToken naming exactly <id> (`mintModelSwitchToken`,
                     minted when an approved model_switch decision is acted on); <id> is a
                     MODEL_ID, the wave-file schema's `model` pattern

SSH (remote hosts, src/hosts/ssh-tmux.ts) — three forms only:
  ssh -T [-o <Opt>=<v>]… <target> bash -s   with a fenced RemoteScript (FenceOptions.remote):
    every step is checked against the REMOTE allow-list below and the script `exec` sends on
    stdin is `renderRemoteScript` of exactly those steps; a raw stdin script is refused, as is
    any `ssh <target> '<command>'` string (zsh login shells word-split it differently).
  ssh -N -R <port>:<host>:<port> [-o <Opt>=<v>]… <target>   the reverse broker tunnel.
  ssh -N -L 127.0.0.1:<p>:127.0.0.1:<p> -o BatchMode=yes -o ExitOnForwardFailure=yes
    -o ConnectTimeout=<s> <target>   a paired machine's Claude sign-in forward
    (src/claude/forward.ts), exactly that argv, only with the SigninForwardToken a remote
    sign-in minted for exactly (<target>, <p>): the same port on both ends, p in 1024..65535,
    never a broker tunnel's port (`mintSigninForwardToken`). Its bytes are never read.
  -o takes only BatchMode, ConnectTimeout, ServerAliveInterval, ServerAliveCountMax,
  ExitOnForwardFailure (never ProxyCommand, LocalCommand, …); a target never starts with '-'.

REMOTE (one step of a RemoteScript; the same DENY list applies first):
  git — the local git policy (worktree add | fetch | rev-parse | … ; worktree remove = CONSENT)
  gh issue view
  tmux new-session -d -s <name> -c <dir> 'bash .volley/launch.sh' (that command only, with
    the LaunchToken sealed for <dir>) | new-session -d -s volley-signin-<acct> -c <dir>
    'bash signin.sh' (exactly, with the remote SigninToken sealed for <dir>,
    `sealRemoteSigninScript`) | capture-pane | has-session |
    send-keys -t <t> Enter|Escape | send-keys -t <t> -l -- <TYPED_TEXT> |
    show-environment -g PATH | set-environment -g PATH <absolute dirs> (the box's own
    PATH, from printenv, then the server's own dirs) —
    kill-session -t volley-signin-<acct> (no consent: a sign-in session holds no agent's
    work) — any other kill-session = CONSENT; no other tmux global option
  mkdir -p <path>… · chmod <3 octal digits> <a file base64 -d may write>… ·
    nc -z 127.0.0.1 <port> · printenv PATH | HOME
  claude auth status (exactly: the box's login state and plan, never a credential; a login
    runs only from a sealed signin.sh)
  cat <path>… — only the files volleyd reads: `.claude.json`, a path ending in
    `/info/exclude`, `<dir>/.volley/<name>` for a VOLLEY_READS name, or a sign-in dir's `url`
  base64 -d — the only step that redirects to a file, from base64 text on stdin, under umask
    077, and only to the files volleyd writes: `<dir>/.volley/<name>` for a VOLLEY_WRITES name
    (agent.json, brief.md, launch.sh, mcp.json, review.md, findings.md, findings.json,
    rebase.md — spelled exactly, directly inside `.volley/`, so no write there is a git
    config, HEAD, gitfile or hook, or a case variant of launch.sh), an absolute path ending in
    `/ISSUE.md` or `/info/exclude`, or `~/.claude.json.volleyd.tmp`. A `.volley/launch.sh`
    (what the tmux session runs) is written whole, never appended, and its content must be
    exactly `renderLaunchScript` of valid values for that worktree (LAUNCH_SCRIPT_VARS); a
    `.volley/mcp.json` (the MCP server claude starts) likewise exactly `renderMcpConfig` of an
    absolute `…/packages/volley-mcp/src/index.ts` outside any `.volley/` (MCP_CONFIG); and
    a paired machine's sign-in dir `<abs>/.volley/signin/<acct>/` (src/claude/remote-signin.ts):
    `signin.sh` exactly `renderSigninScript` for that dir with no profile dir (`claude auth
    login`, never `setup-token`), `browser.sh` exactly `renderBrowserHelper`, `url` only empty
  command -v <claude|bun>… — the readiness PATH probe (RemoteHost.probePath)
  volley peer doctor --json [--fix --yes [--clone --origin <https URL>]] — the machine's doctor
    (RemoteHost.runDoctor, the `peer_doctor` op; the URL is `https://<host>/<path>`, no
    credentials or port, isCloneUrl); no other volley argv runs on a box
  the trust write (RemoteHost.recordTrust, on the owner's `trust` answer only):
    cmp -s - .claude.json (base64 of the file as read, on stdin) ·
    mv -f .claude.json.volleyd.tmp .claude.json
  Every other step's stdin is /dev/null, so no step can read the rest of the script.

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

volleyd never pushes and never touches infrastructure. It merges only under `merge: auto`, only
the gated PR at exactly its gated head, with the gate's MergeToken ([autopilot
merging](#autopilot-merging)); under `merge: manual` it stops at merge-ready and a human merges.

---

## Running as a service (launchd)

```sh
volleyd install               # writes the plist and (re)loads it; safe to rerun
volleyd install --dry-run     # print the plist instead
launchctl kickstart -k gui/$UID/systems.volley.volleyd   # restart
volleyd uninstall             # unload + remove the plist
```

A rerun with volleyd loaded boots it out, waits until launchd has let it go and bootstraps the
new plist (retrying launchd's EIO meanwhile); if the new plist will not load, the previous one is
put back and loaded again and `install` exits non-zero, so volleyd is never left down.

The plist (`launchd/systems.volley.volleyd.plist.tmpl`) runs `bun src/cli.ts daemon` with
`RunAtLoad` and `KeepAlive`, logs to `$VOLLEYD_HOME/volleyd.log`, and captures `VOLLEYD_HOME`,
`VOLLEY_BROKER_URL`, `VOLLEY_NAMESPACE` and, when set, `VOLLEY_AUTH_DIR` (the auth dir volleyd's
`volley auth` calls use) at install time. Its `PATH` is a stable list, never your shell's whole
`PATH` (a terminal's per-session entries, such as cmux's shim directory under the temp dir, would
make every rerun from another terminal a change): a fixed list of candidates, each kept when it
exists on this machine: `~/.volley/bin`, bun's directory, Homebrew's `bin` and `sbin`,
`/usr/local/bin`, the cmux app's `bin`, `~/.local/bin`, `~/.bun/bin`, `~/.claude/local`,
`~/.npm-global/bin`, `~/.volta/bin`, nix's and snap's `bin`, then `/usr/bin:/bin:/usr/sbin:/sbin`.
Nothing comes from your shell's `PATH`. Re-run `volleyd install` after changing any of them. `volley
setup` runs it for you on macOS, with `VOLLEY_AUTH_DIR` set to the auth dir it used (volleyd runs
`volley auth` by name to redeem the Desk's sign-in links); on Linux it writes the systemd user
unit `volleyd.service` instead, with the same PATH (`systemctl --user status volleyd.service`).

**cmux from a service.** cmux lets only programs it started use its socket by default, and the
service is not one, so every local spawn would be refused. `volley setup` (Services) checks this
the way the service runs cmux, explains where to set a socket password in cmux (Settings… →
Automation → Socket control mode → Password mode), asks for it hidden and stores it in
`$VOLLEYD_HOME/cmux.json` (mode 0600; and the keychain, service `volley-cmux`). volleyd reads the
file each time it runs cmux (spawns, screens, the `cmux ping` pressure sample) and passes it as
`CMUX_SOCKET_PASSWORD`, so a new password needs no restart; it never goes in the plist. A
`CMUX_SOCKET_PASSWORD` in volleyd's own environment wins. When cmux still refuses a spawn, the
`spawn_failed` decision says what to do in those words, then what cmux said (`(cmux said: …)`;
its full text stays in the journal).

---

## Exit codes

Same table as `volley`: `0` success · `1` error (validation failure, daemon not running, broker
down, request rejected) · `2` usage error · `124` the daemon did not answer in time.

---

## Testing: the clock contract

Every timer volleyd arms and every wall-clock read it makes goes through one `Clock`
(`src/clock.ts`: `now`, `mono`, `setTimeout` / `clearTimeout`, `setInterval` / `clearInterval`).
The daemon takes it as `DaemonOptions.clock` (default: `systemClock`, real timers) and hands it to
everything it runs: the admission tick, the spawn-refusal backoff, verification windows, reap
graces, steer ack waits, tunnel restarts and checks, screen captures and their read bounds, the
token-prune interval, sign-in polls, and the sleep/wake sampler. The times it stamps and compares
come from the same clock: journal events (wave and `_system`), decisions, config changes, worktree
locks and their staleness check, so a daemon on a fake clock journals fake time. `systemClock`
holds the only real timers in `src/`; `test/no-wall-clock.test.ts` fails on any `setTimeout`,
`setInterval`, `Date.now()`, `performance.now()` or `new Date()` elsewhere, and on any use of
`systemClock` (or a `globalThis` timer) not on a line commented `// real clock: <why>`. Those are
the defaults of an injectable clock and code that runs on the real one: a real child process
(`exec.ts`), the CLI's own timeouts, file mtimes, a hooks process's own stamps. In `daemon.ts`
`systemClock` appears only as the default of `DaemonOptions.clock`.

A test that depends on daemon timing never waits for real time to pass:

- **Drive the clock.** Pass `fakeClock()` (`test/helpers/fake-clock.ts`) as the daemon's `clock`.
  Its timers fire only on `advance(ms)` / `advanceTo(wall)` / `advanceToNext()`, in due order,
  with pending promise continuations flushed after each. Nothing global is faked: the MQTT client
  and the Aedes broker keep running on real I/O. `armed(ms)` resolves once the daemon has
  scheduled a timer of that length — the sync point between "it consumed the message" and "move
  past what it scheduled". It matches any armed timer of that length, intervals included and
  ones armed before the call, so on a daemon clock (whose watchdog interval is always armed) use
  a length only the awaited step schedules. `sleepHost(ms)` moves the wall clock only (a host sleep, for wake
  detection).
- **Await the event, never poll for it.** `journalWait(home, () => daemon)`
  (`test/helpers/journal-wait.ts`) resolves `event(wave, type | predicate, n)` from the append
  itself (`Daemon.onJournal`); events already in the journal count. `settled()` waits until the
  daemon is idle — its queue drained, no spawn launching, every append published — before a test
  reads the published state or asserts that nothing happened.
- **Broker round-trips only** may be re-checked: `eventually(pred)` (`test/helpers/broker-wait.ts`)
  has no deadline of its own (vitest's test timeout bounds it). To prove the daemon has read what
  was published before, prefer a control round-trip behind it on the daemon's connection
  (`SupervisedEnv.consumed()`). Any remaining real timer (a sleep, a race, a delayed start),
  deadline or elapsed-time bound in `test/` carries a `broker round-trip:` or `real process:`
  comment saying why, or the grep-guard fails.

```ts
const clock = fakeClock(T0);
const daemon = await env.start({ clock });
const waits = journalWait(env.home, () => daemon);
// … a spawn is refused: spawn_failed, retry in 30 s
await clock.advance(30_000);
await daemon.tick();
expect((await waits.event("w1", "spawn_failed", 2)).data).toMatchObject({ attempt: 2 });
```
