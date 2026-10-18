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
> config store, daemon, CLI and launchd service, and spawns each admitted task's implementer
> (worktree, identity, cmux launch, hook-signal verification, per-worktree lock, retire). Leases
> and pressure-based admission, the reviewer/fixup pipeline stages, decisions handling and
> recovery come in later tasks of the volleyd epic.

---

## Contents

- [Quick start](#quick-start)
- [The wave file](#the-wave-file)
- [CLI](#cli)
- [How it works](#how-it-works)
- [Topics and the control channel](#topics-and-the-control-channel)
- [Configuration](#configuration)
- [Spawning agents](#spawning-agents)
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
| `volleyd run <wave.yaml> [--json]` | Validate locally, then submit to the daemon. Returns once the wave is journaled. |
| `volleyd validate <wave.yaml>` | Validate locally; exit 1 with path-qualified errors. |
| `volleyd status [wave] [--json]` | Wave state from the daemon. `--json` prints the exact `wave_state` payload. |
| `volleyd events <wave> --cursor <name>` | Print (JSONL) every journal event after the named cursor. Does not move it. |
| `volleyd ack <wave> --cursor <name> --seq <N>` | Advance the cursor to `N`. Ack **after** acting, so a crash replays. |
| `volleyd config get [path] [--wave <id>] [--json]` | Effective config (or one dotted path), optionally with a wave's overrides. |
| `volleyd config set <path> <value> [--by <who>]` | Change a tunable at runtime (validated, journaled, hot-applied). `<value>` is YAML. |
| `volleyd spawn <wave> <task> [--role <role>] [--json]` | Spawn one agent now, outside admission. Returns once it is launched or refused (`SPAWN_LOCKED`, …); the daemon then verifies it. |
| `volleyd cleanup <wave> [--yes] [--force]` | Remove retired agents' cmux workspaces and worktrees. Without `--yes` only prints the plan. Branches are kept. |

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
- **One daemon per home**: `$VOLLEYD_HOME/volleyd.lock` (holding the pid) is taken before any
  journal is opened; a lock whose pid is gone is replaced. A second daemon is also refused while
  the broker shows a live `volleyd` status in the namespace.
- **Broker loss is fatal**: if the broker connection drops, `volleyd daemon` exits 1 and launchd's
  `KeepAlive` restarts it, which resumes the persistent session and restores every wave.

---

## Topics and the control channel

| Topic | Retained | What |
|---|---|---|
| `volley/<ns>/volleyd/status` | yes | The daemon's lifecycle status; LWT flips it to `reaped` on a crash. |
| `volley/_system/registry/volleyd` | yes | Registry entry (`capabilities: ["supervisor"]`). |
| `volley/_waves/<wave>/state` | yes | Full `wave_state` snapshot (with `effective_config`), after every change. |
| `volley/_waves/<wave>/events` | no | Live mirror of each journal event. The journal is the record. |
| `volley/_waves/_config` | yes | Effective global config + `version` / `updated_at` / `updated_by`. |

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

Later tasks add `pause`, `resume`, `stop`, `steer`, `resolve` and `claim`.

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
| `claim_after_s`, `heartbeat_alarm_s`, `wake_grace_s` | next monitor tick | — |
| `fallback_model` | decisions opened after the change | open decisions keep their offer |
| `mailbox.session_expiry_s` | new connections only | existing sessions keep their expiry until they reconnect |
| `worktree_root` | spawns after the change | existing worktrees untouched |
| `spawn_timeout_s` | spawns after the change | — |

This foundation consumes `hard_ceiling` and `spawn_budget_multiplier`; the other rows describe
the contract the subsystems that read them (leases, monitors, decisions, spawning) follow.

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
The gate runs before credentials are minted, so a rejected brief costs nothing to undo.

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
from prompts that eat the first character; nothing else is ever typed into the pane, and the
brief never appears in an argv.

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
| retained status `done` / `failed` / `reaped` | stale → reclaimed |
| no status, but a registry entry, or the writing process is another live pid | live |
| no status, no registry entry, no heartbeat (and no lock write) for longer than `heartbeat_alarm_s` | stale → reclaimed |

The one relaunch after an update prompt keeps the lock and rewrites its holder (attempt + 1).
Retiring the agent releases it.

### Verification signals

Before launching, the daemon subscribes to `volley/_system/registry/<id>`,
`volley/<ns>/<id>/status` and `volley/<ns>/<id>/progress`. The expected sequence from the hooks
(`packages/volley-hooks`) is: MCP auto-registration (no `model_source`) → the SessionStart hook's
registry re-publish with `model_source` and `model` → status flipped to `working` → a
`progress` `heartbeat` with `hook_event: "SessionStart"`. A spawn is verified when **both** the
SessionStart heartbeat and a registry entry with `model_source` `harness-hook` or `unknown`
arrive within `spawn_timeout_s`; it is journaled as `agent_registered { model, model_source,
model_verified }`.

- `model_source: "harness-hook"`: the model is compared with the task's (a dated id or `[1m]`
  suffix still matches); a mismatch opens decision `model_switch` and leaves the agent running.
- `model_source: "unknown"` (the hook input had no model): the terminal's status line is read
  once as the model source; unreadable → `model_verified: false`.

### Pre-hook screen table

Screens are read only in the window before the hooks run (afterwards the hooks are the source of
truth). When no SessionStart heartbeat arrived in time, the screen is captured to
`$VOLLEYD_HOME/waves/<wave>/screens/` and classified:

| Screen | Action |
|---|---|
| `trust_dialog` (folder-trust prompt) | decision `repo_untrusted` — never answered automatically |
| `update_prompt` (e.g. a shell's `update? [Y/n]`) | press Enter, then relaunch once (attempt + 1: new id and credentials, same lock and worktree; journaled as `agent_spawned { recovered_from, recovery: "update_prompt" }`) |
| `login`, `working` (Claude up, hooks silent), `empty`, `unknown` | decision `unknown_screen`, pointing at the capture |

A second update prompt after the relaunch is `unknown_screen`.

### Journal mapping

The journal's event types are the closed `wave-event` enum, so the steps use it as follows:
refusals → `alarm_raised { code, … }`; a launch → `agent_spawned { agent_id, role, attempt,
host, workspace, worktree, branch, issue, credentials, lock }` (plus `stage_entered implement`
for an implementer's first attempt); verification → `agent_registered`; trust, model and screen
questions → `decision_opened { decision_id, kind, question, options, pointers }`; trust accepted
in the dialog later → `decision_resolved { answer: "trusted" }`; retire → `agent_retired`.

### Retire and cleanup

When a supervised agent's terminal status (`done`, `failed`, `reaped`) arrives, the daemon
retires it: `volley auth rm-agent <id>`, empty retained payloads on its `registry`, `status`,
`result`, `capability` and `screen` topics, the lock released, `agent_retired` journaled. Only
the wave's own agents, only terminal ones. Nothing on disk is deleted: `volleyd cleanup <wave>
--yes` closes the retired agents' workspaces and runs `git worktree remove` with the fence's
consent token (`--force` for dirty worktrees); worktrees of agents not yet retired are skipped,
and branches are never deleted.

Answering a `repo_untrusted` decision with `trust` records exactly
`projects[<root>].hasTrustDialogAccepted: true` (`recordRepoTrust`); accepting the dialog in any
worktree of the repo works too, and the next tick resumes the parked spawns.

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
