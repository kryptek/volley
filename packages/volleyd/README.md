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

> **Status: foundation (pre-release).** This package has the wave file, journal, reducer,
> scheduler, fence, config store, daemon skeleton, CLI and launchd service, plus decisions,
> wave ownership, pause/stop and the kill switch, steering and overlap warnings. Spawning agents,
> leases and pressure-based admission, the pipeline stages and recovery come in later
> tasks of the volleyd epic. Until then a submitted wave is journaled and its first tasks are
> *admitted*, but nothing is spawned: tasks stay `queued` with `why_waiting: "admitted: awaiting spawn"`.

---

## Contents

- [Quick start](#quick-start)
- [The wave file](#the-wave-file)
- [CLI](#cli)
- [How it works](#how-it-works)
- [Topics and the control channel](#topics-and-the-control-channel)
- [Decisions](#decisions)
- [Ownership and claim](#ownership-and-claim)
- [Pause, stop and the kill switch](#pause-stop-and-the-kill-switch)
- [Steering](#steering)
- [Overlap warnings](#overlap-warnings)
- [Configuration](#configuration)
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
# config: { hard_ceiling: 4 }  # per-wave overrides of any tunable (see Configuration)
```

Per task: `issue` (required), `after`, `pipeline`, `model`, `title`, and `files` (a scheduling hint:
paths the task will touch; tasks overlapping active ones start later).

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
| `volleyd run <wave.yaml> [--owner <id>] [--json]` | Validate locally, then submit to the daemon. Returns once the wave is journaled. Prints the owner and any overlap warnings. |
| `volleyd validate <wave.yaml>` | Validate locally; exit 1 with path-qualified errors. |
| `volleyd status [wave] [--as <id>] [--json]` | Wave state from the daemon, with open decisions and `needs you: N` on waves the caller owns. `--json` prints the exact `wave_state` payload. |
| `volleyd decisions [wave] [--all]` | Open decisions (with `--all`, resolved ones too): question, options, evidence pointers. |
| `volleyd resolve <decision-id> <answer> [--rationale <why>] [--wave <w>]` | Answer a decision (owner only). |
| `volleyd claim <wave>` | Take over a wave whose owner is gone. |
| `volleyd pause <wave>` / `resume <wave>` | Stop / restart admissions (owner only); running agents carry on. |
| `volleyd stop <wave>` | Stop a wave (owner only): no admissions, `cancel` to every running agent. |
| `volleyd stop --all` / `resume --all` | Engage / release the kill switch (anyone). |
| `volleyd steer <wave> <task> <text> [--role <r>] [--wait-ack-ms <ms>]` | Mailbox steering to the task's agent; reports `acked` or `delivered`. |
| `volleyd events <wave> --cursor <name>` | Print (JSONL) every journal event after the named cursor. Does not move it. |
| `volleyd ack <wave> --cursor <name> --seq <N>` | Advance the cursor to `N`. Ack **after** acting, so a crash replays. |
| `volleyd config get [path] [--wave <id>] [--json]` | Effective config (or one dotted path), optionally with a wave's overrides. |
| `volleyd config set <path> <value> [--by <who>]` | Change a tunable at runtime (validated, journaled, hot-applied). `<value>` is YAML. |

The mutating commands (`resolve`, `pause`, `resume`, `stop`, `steer`, `claim`) act as the caller's
agent id: `--by <id>`, else `VOLLEY_AGENT_ID`, else the newest top-level session registered for the
current directory. `run` uses the same detection for the owner (`--owner` overrides it).

Commands that talk to the daemon fail fast with `volleyd not running` (exit 1, within ~1 s) when
the daemon's retained status is missing or terminal. `events`/`ack` read `$VOLLEYD_HOME` directly
and work while the daemon is down; use the wave `_system` for global events (`config_changed`).

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

**Control requests** go to the daemon's mailbox `volley/<ns>/volleyd/mailbox` as `type: "query"`
with a fresh `correlation_id` and `payload: { op, text, ... }`. The daemon answers on the sender's
own mailbox with `type: "ack"`, the same `correlation_id`, and
`payload: { text, acked_type: "query", op, ok, error?, result?, applied?, rejected? }`.

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
| `steer` | `wave`, `task`, `text`, `by`, `role?`, `wait_ack_ms?` | `{ agent_id, role, message_id, seq, supersedes?, delivery, acked, acked_by? }` |

`run` also takes `owner` and answers with `warnings: [...]` (overlap lines). `status` without a
wave adds `kill_switch: true` while the kill switch is engaged. `steer` answers once the ack
arrives or `wait_ack_ms` (default 30 s) passes — the wait never blocks other control requests.

---

## Decisions

A decision is a question only a human (or the owning coordinator) can answer — reviewers
disagree, a merge conflict, an agent blocked, a plan change. It is a journal event, not chat:

- **Open** (`daemon.openDecision(wave, { kind, task, question, pointers, options? })`, used by
  the pipeline and recovery subsystems): journals `decision_opened`, publishes the decision retained
  on `volley/_waves/<wave>/decisions/<id>` (ids look like `d-k3x9q2ab`), and parks the task in
  `awaiting_decision`. Its dependents wait with `why_waiting: "awaiting decision d-… (T2)"`;
  independent tasks keep running. A `task: null` decision is wave-level and parks nothing.
- **Notify bridge**: every open also publishes a `blocked`-typed progress envelope on the
  daemon's own topic, so an existing `volley notify` rings with no new surface:

  ```sh
  volley notify --pattern 'volley/+/volleyd/progress'      # default --on includes blocked
  ```

- **Resolve** (`volleyd resolve d-… "<answer>" --rationale "<why>"`, owner only): journals
  `decision_resolved { answer, by, at, rationale? }`, re-publishes the decision once with
  `resolved` set and clears the retained topic, and puts the task back in the stage it was in.
  The task's resolved decisions are written to `.volley/decisions.md` in its task directory
  (`$VOLLEYD_HOME/waves/<wave>/tasks/<task>/` unless the spawner points it at the worktree) for
  the next stage's brief. Resolving an unknown id is an error; resolving twice is a no-op.

Open decisions survive a restart (they are re-published from the journal).

## Ownership and claim

Every wave has one **owner**, the coordinator agent id that submitted it — the single writer. It
comes from `volleyd run --owner <id>`, else is auto-detected (`VOLLEY_AGENT_ID`, else the session
registered for the caller's directory; printed as `owner: … (auto)`), else `null` (unowned).
`resolve`, `pause`, `resume`, `stop`, `steer` and re-running the wave id require `by == owner`;
anyone else is refused with the owner's id. An unowned wave accepts anyone.

`volleyd claim <wave>` hands the wave to the caller when the owner is gone: its retained status
is `reaped`, `done` or `failed`, or nothing has been heard from it — registry entry, status,
progress/heartbeat events — for `claim_after_s` (config, read at claim time, so a
`volleyd config set claim_after_s …` applies to the next claim). Otherwise the claim is refused,
naming the owner. A claim is journaled as `owner_claimed { owner, previous, why }`.

## Pause, stop and the kill switch

- `pause <wave>`: no new admissions; running agents continue. Held tasks show
  `why_waiting: "wave paused"`. `resume <wave>` re-admits.
- `stop <wave>`: journals `wave_stopped` (no new admissions), then sends a mailbox `cancel`
  to every running agent of the wave (journaled as `steering_sent { type: "cancel" }`) and
  interrupts its session through the daemon's `interrupt` hook (the spawner wires it to cmux).
  A stopped wave can be resumed explicitly.
- `stop --all` is the **kill switch**: every wave stops, the switch is journaled in `_system`
  (so it survives restarts), and the daemon refuses `run` with `kill switch engaged` until
  `resume --all`. Anyone may pull it; releasing it leaves stopped waves stopped.

## Steering

`volleyd steer <wave> <task> "<text>"` sends a mailbox `steering` envelope to the task's current
agent (the current stage's role, else the implementer; `--role` picks one). Its `correlation_id`
is the message id; `payload.seq` counts steers to that task (1, 2, …) and `payload.supersedes`
names the previous steer, so the recipient can drop stale guidance. The steer is journaled as
`steering_sent`. The command reports `acked by <agent>` when the recipient's mailbox `ack`
(same `correlation_id`, sent to `volley/<ns>/volleyd/mailbox`) arrives within `--wait-ack-ms`
(default 30000), else `delivered`.

## Overlap warnings

At submit the daemon reads each task issue's `Files` section (`## Files` / `### Files` heading or
a `Files:` line; comma lists, brace expansion and package-relative entries are understood) via
`gh issue view`, merges it into the task's `files` hint, and compares it with the unfinished
tasks of every other running wave. Each shared path journals an `alarm_raised` event with
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

`volleyd config set` (or any client sending `config_set`) is validated against the schema — an
unknown key or out-of-bounds value rejects the whole patch — then written to `config.yaml`
atomically, journaled as `config_changed { by, patch, previous, version }` in the `_system`
journal, re-published with `version + 1`, and applied **without a restart**:

| Tunable | Takes effect | In-flight work |
|---|---|---|
| `hard_ceiling`, `spawn_budget_multiplier` | next admission tick (immediately after the change) | never preempted; a limit below current use only stops new admissions |
| `admission.*` | next admission tick | never preempted |
| `lease_pools` | next lease grant | a pool shrunk below its holders stops granting until holders release; no holder is preempted |
| `claim_after_s`, `heartbeat_alarm_s`, `wake_grace_s` | next monitor tick | — |
| `fallback_model` | decisions opened after the change | open decisions keep their offer |
| `mailbox.session_expiry_s` | new connections only | existing sessions keep their expiry until they reconnect |
| `worktree_root` | spawns after the change | existing worktrees untouched |
| `spawn_timeout_s` | spawns after the change | — |

This foundation consumes `hard_ceiling` and `spawn_budget_multiplier`; the other rows describe
the contract the subsystems that read them (leases, monitors, decisions, spawning) follow.

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

ALLOW:
  git [-C <dir>] [--no-pager] worktree add | fetch | rev-parse | log | diff | status |
    branch --list | merge-base | show   (diff/show without --output / --ext-diff)
  gh issue view · gh pr view | list | checks · gh run list | view | watch · gh api (GET only)
  cmux new-workspace | list-workspaces | send | send-key | read-screen | ping
  claude (any arguments)
  launchctl bootstrap | bootout | kickstart | print — only for the systems.volley.volleyd service
```

Anything else is denied — including shells (`bash -c`, `sh -c`), `env`/`sudo` wrappers, and git
global options other than `-C`/`--no-pager` (git config such as `-c alias.x=!…` can turn any
subcommand into an arbitrary command). `gh api` counts as a write when it sends fields (`-f`,
`-F`, `--input`) without an explicit `-X GET`.

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
