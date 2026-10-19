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

> **Status: pre-release (v0.2.0).** This package has the wave file, journal, reducer, scheduler,
> fence, config store, daemon, CLI and launchd service, plus decisions, wave ownership, pause/stop
> and the kill switch, steering and overlap warnings, heavy-operation leases and load-aware spawn
> admission. It spawns each admitted task's agents (worktree, identity, cmux launch, hook-signal
> verification, per-worktree lock, retire), drives them through the review pipeline to a
> merge-ready gate and notices the merge, recovers stalled agents, applies mid-wave plan changes,
> publishes screen tails, and can run agents on a second machine over ssh + tmux.

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
- [Ownership and claim](#ownership-and-claim)
- [Pause, stop and the kill switch](#pause-stop-and-the-kill-switch)
- [Steering](#steering)
- [Overlap warnings](#overlap-warnings)
- [Configuration](#configuration)
- [Spawning agents](#spawning-agents)
- [Recovery](#recovery)
- [Plan changes (versioned wave files)](#plan-changes-versioned-wave-files)
- [The pipeline and the merge-ready gate](#the-pipeline-and-the-merge-ready-gate)
- [The authority fence](#the-authority-fence)
- [Running as a service (launchd)](#running-as-a-service-launchd)
- [Exit codes](#exit-codes)
- [Testing: the clock contract](#testing-the-clock-contract)

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
# brief_preface: .volley/brief-preface.md  # the default; relative to repo, or absolute (see Brief preface)
# account: work              # the Claude account its agents run under (see Claude accounts)
```

Per task: `issue` (required), `after`, `pipeline`, `model`, `title`, `host` (where its agents run;
default `local`), `account` (overrides the wave's; see [Claude accounts](#claude-accounts)), and
`files` (a scheduling hint: paths the task will touch; tasks overlapping active ones start later).

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
| `volleyd status [wave] [--by <id>] [--json]` | Wave state from the daemon, with open decisions, `needs you: N` on waves the caller owns and `alarms: N` (tasks whose spawn failed and has not recovered). `--json` prints the exact `wave_state` payload. |
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
| `claude_accounts` | — | `{ root, accounts: [{ id, label, machine, created, plan?, signed_in_at?, dir, signin: { state, url?, flow?, attach? } }], sharing }` |
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

The Desk manages broker accounts through the daemon, never by writing the password file itself
(SPEC §4.6.10). The daemon in turn only runs `volley auth` through the [fence](#the-authority-fence):
`volley auth` owns `passwd`, `acl.conf`, `accounts.json` and `tokens.json` in `$VOLLEY_AUTH_DIR`.

**Account ops** are not mailbox ops: anyone who may steer can write the daemon's mailbox, so the
mailbox cannot say who sent a request (the daemon refuses them there with a pointer). An admin
publishes `{ op, ..., reply_key }` (envelope `channel: "_system/auth"`, `type: "query"`, a fresh
`correlation_id`) on `volley/_system/auth/ops/<its username>`. The broker ACL grants that topic only
to admin accounts and only for their own username, so the topic names the sender; the daemon
then checks that account's role with `volley auth list --json` and refuses anything but `admin`.
`account_list`'s `last_seen` is the newest of the account's last auth request to this daemon
process and the `wall_time` of a retained registry entry or retained `status` (where the LWT lands)
under its name. Requests are never retained: the daemon clears a request topic's retained message
after each request, so a restart cannot replay one. `account_rotate` of the sender's own account is
refused: the reload that applies the new password disconnects the client holding the old one
before the answer arrives (rotate yourself with `volley auth rotate` or through another admin).

| `op` | Fields | `result` | `sealed` (decrypts to) | Journal (`_system`) |
|---|---|---|---|---|
| `account_list` | — | `{ accounts: [{ name, role, kind, created, label?, last_seen? }] }` | — | — |
| `account_create` | `name`, `role` (`admin` \| `steer` \| `watch` \| `supervisor` \| `peer`), `kind?` | `{ name, role }` | `{ username, password }` | `account_created { by, name, role, kind? }` |
| `account_rotate` | `name` | `{ name, role }` | `{ username, password }` | `account_rotated { by, name }` |
| `account_revoke` | `name` | `{ name }` | — | `account_revoked { by, name }` |
| `signin_link` | `role` (`steer` \| `watch`), `label`, `ttl_s?` (default 600), `desk_url?` | `{ role, label, expires_at, link_base? }` | `{ token }`; the link is `<link_base>#signin=<token>` (sealing the link too could exceed what RSA-OAEP fits) | `signin_link_issued { by, role, label, token_id, expires_at }` |

**Token redemption.** `volley auth token` prints a one-time admin token in the operator's
terminal; `signin_link` makes one for a phone. Each token is also the password of a short-lived
broker login `redeem-<id>`, so the broker keeps `allow_anonymous false` (an anonymous client would
inherit the ACL's read of the whole tree). That login may only write `volley-auth/redeem/<id>` and
read `volley-auth/redeem/<id>/reply`: its ACL block denies `volley/#` (where every shared grant
lives), so it sees nothing of the tree and nothing of other tokens. The client connects as that
login, subscribes to the reply topic and publishes `{ op: "token_redeem", token, label, reply_key }`
on the request topic; the daemon refuses a token whose id is not the topic's, then pipes the token to `volley auth redeem --label <label> --json` on **stdin** (never argv),
which burns it and creates an account with the token's role (`admin-<id>` / `steer-<id>`),
journaled as `token_redeemed { by, name, role, label }`. A used, expired or unknown token is
refused. The token's login is not removed during redemption (mosquitto would disconnect the client
on the reload before it hears the answer): `volley auth` drops it about a minute after redemption
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

**Selection.** An agent runs under its task's `account:`, else the wave's, else
`claude.default_account` (a tunable; `null` = primary), else the primary. `most_headroom` falls
back to the primary until usage metering can rank accounts. A spawn under an unknown account, one
not signed in yet, or one on another machine is refused (`CLAUDE_ACCOUNT_UNAVAILABLE`, through the
usual spawn-failure retries). `launch.sh` then exports `CLAUDE_CONFIG_DIR` and unsets
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and
`CLAUDE_SECURESTORAGE_CONFIG_DIR`, so the profile's own login is the one claude uses;
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
| `spawn_retry_max_s`, `spawn_retry_max` | the next failed spawn | a retry already scheduled keeps its time |
| `brief_preface_max_bytes` | the next `run` and the next spawn | briefs already written untouched |
| `screen_tail_interval_s` | each agent's next screen capture | — |
| `hosts` | spawns after the change (and the next tunnel check) | running agents and their tunnels untouched |
| `claude.default_account` | spawns after the change | running agents keep their account (move one with `agent_move_account`) |

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
| 2 | **Worktree** `git -C <repo> worktree add <worktree_root>/<wave>/<task>-<role> -b <wave>/<task>-<role>-<attempt> <base>`, `<base>` the release branch as origin has it ([base ref](#base-ref)); `.volley/` and `/ISSUE.md` appended to the repo's `info/exclude` once | `worktree.ts` | `RELEASE_BRANCH_MISSING`, `WORKTREE_FAILED` |
| 3 | **ISSUE.md** from `gh issue view <n> --json number,title,body,url`, `<n>` from the wave file only | `issue.ts` | `ISSUE_MISMATCH`, `ISSUE_FETCH_FAILED` |
| 4 | **Brief** the [brief preface](#brief-preface), then `briefs/<role>.md.tmpl` → `.volley/brief.md`, then the brief gate | `brief.ts` | `BRIEF_PREFACE_TOO_LARGE`, `SPAWN_BRIEF_REJECTED` |
| 5 | **Identity** `volley auth add-agent <id> --ack-to <parent> --ack-to volleyd --json` → `.volley/agent.json` (mode 0600) | `identity.ts` | `CREDENTIALS_FAILED` |
| 6 | **Launch** `.volley/mcp.json` + `.volley/launch.sh`, then `cmux new-workspace --cwd <worktree> --name "<wave> <task> <role>" --command "  bash .volley/launch.sh"` | `launch.ts`, `hosts/local-cmux.ts` | `LAUNCH_FAILED` |
| 7 | **Verify** through the hook signals (below) | `verify.ts`, `screens.ts` | decisions, not refusals |

A refusal releases the lock, revokes credentials minted for the attempt and never launches.
The gate runs before credentials are minted, so a rejected brief costs nothing to undo. A
refused spawn is never silent ([failures and retries](#spawn-failures-and-retries)); `volleyd
spawn` retries at once. While the kill switch is engaged nothing is spawned.

### Base ref

An agent's branch is cut from the wave's release branch **as origin has it**: the branch is
often pushed from another clone (`git push -u` in a batch setup), so the daemon's clone may
know it only as `origin/<release_branch>`, or have a stale local copy. Before `worktree add`,
volleyd runs `git -C <repo> fetch origin <release_branch>` (a failed fetch — offline, no remote
— leaves what the repo has), then picks the base:

| The repo has | Base |
|---|---|
| only `origin/<b>` | `git branch --track <b> origin/<b>`, then `<b>` (`origin/<b>` if that fails) |
| both, the local `<b>` behind `origin/<b>`, or diverged from it (origin has commits the local one lacks) | `origin/<b>` |
| the local `<b>`, level with or ahead of origin's (or never pushed) | `<b>` |
| neither | refused: `RELEASE_BRANCH_MISSING: <repo> has neither <b> nor origin/<b> — push it first` |

`git fetch` is bounded (30 s) and never prompts for credentials; a timeout counts as a failed
fetch. When a task of the wave runs on the local host, `volleyd validate` checks the same
(locally or `origin/<b>`, offline — it says to fetch a branch pushed from another clone) when
the wave's repo is on its machine, and the daemon fetches, then refuses `run` with
`RELEASE_BRANCH_MISSING` before any task is admitted (`<repo> is not a git repository` for a
directory that is not one). A pipeline role cut from a start commit
(reviewers, fixups) uses that commit as given. A remote host fetches and cuts from
`origin/<b>` on the box.

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

**Identity.** The agent id is `<wave>-<task>-<role>-<attempt>`, lowercased (a long wave id is
shortened with a hash). `.volley/agent.json` carries `agent_id`, `namespace`, `parent_id` (the
wave owner, else `volleyd`), `wave`, `task`, `role`, `broker_url` and the minted `broker`
block; the MCP server and the hooks both read it, so no flag or env carries identity.
`volleyd daemon --no-mint` skips minting for an anonymous broker (no `broker` block).

**Launch script.** `launch.sh` runs under bash (`#!/usr/bin/env bash`; login shells may be zsh),
exports `VOLLEY_HOOKS_DIR=<checkout>/packages/volley-hooks` and execs
`claude --dangerously-skip-permissions --model <model> --settings <hooks settings template> --strict-mcp-config --mcp-config=<worktree>/.volley/mcp.json --name <id> -- "$(cat .volley/brief.md)"`.
The hooks come in through `--settings`.

**MCP wiring.** The agent's `volley` MCP server is volleyd's, not the user's: volleyd writes
`.volley/mcp.json` = `{ "mcpServers": { "volley": { "command": "bun", "args": ["run",
"<checkout>/packages/volley-mcp/src/index.ts"] } } }` — the **same release's** volley-mcp (a
remote host's: its `volley_dir` checkout), which reads the broker URL, identity and minted
credentials from `.volley/agent.json` in its cwd, so nothing secret is in either file.
`--strict-mcp-config` keeps the user's own MCP servers (an everyday `volley` on another broker,
an older install) out of the session. `--mcp-config` is variadic, so it is passed in the `=`
form (exactly one value) and `--` ends option parsing before the prompt, which is last: the
prompt can never be swallowed as a config path. The fence pins this exact form, the path inside
the sealed worktree, and (remote hosts) the `mcp.json` content. The cmux command starts with two spaces, which keeps it out of shell history and away
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

### Unattended coordinator starts

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

When a supervised agent's `failed` status arrives, the daemon retires it; a `done` is first
handed to the pipeline, which verifies the claim and retires the agent once it is checked (see
[the pipeline](#the-pipeline-and-the-merge-ready-gate)). `reaped` (its
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

- `claude` must be on the `PATH` of a non-interactive ssh session (`ssh <target> bash -s` reads
  no `~/.bashrc` or `~/.zshrc`), because the tmux session that runs `launch.sh` takes the
  environment of the ssh session that created it. Claude Code's installer puts it in
  `~/.local/bin`, which sshd's default `PATH` lacks: link it into `/usr/local/bin`, or set
  `PATH` for ssh sessions (`SetEnv` in sshd_config, or `~/.ssh/environment` with
  `PermitUserEnvironment`).
- The agent's MCP server is the box's `volley_dir` checkout (`.volley/mcp.json` runs its
  `packages/volley-mcp/src/index.ts` with `bun`), so `bun` must be on the non-interactive ssh
  `PATH` too, and that checkout must be this release with `bun install` run. User-scope MCP
  servers on the box are not loaded (`--strict-mcp-config`). The
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
| (rebase) | `rebase` | its own branch from the head; lease-guarded push | artifacts verified |
| `merge_ready` | — | — | evidence written; the task is a gate |

**Artifact verification** (`src/artifacts.ts`, read-only verbs only): the role's local HEAD
equals `origin/<PR branch>` after a `git fetch`; `gh pr list --head <branch>` has an open PR whose
`headRefName` *equals* the branch (the CLI has returned another branch's PR) and whose base is the
release branch; CI on exactly that head (`gh run list --commit <sha>`) is green. A missing
artifact is journaled (`alarm_raised { alarm: "artifact_missing", missing: push|pr|base }`), the
agent is steered once ("push + open PR, then publish done again") and re-waited; still missing →
an `agent_blocked` decision. Success journals `artifact_verified { role, head_sha, pr, ci_runs }`.
The steer names what the role publishes: the implementer its branch and PR, the fixup its
`git push origin HEAD:<PR branch>`, the rebase its lease-guarded push.

**CI** is never re-run. Red on the head → a `ci_failed` decision with the run URLs and failed
job names; an infra-shaped failure (cancelled, runner lost, checkout or network steps) adds
"check the hosting provider's status page first". Pending CI is re-checked every
`ci_poll_ms` (the agent is retired meanwhile); a head with no CI run at all for
`ci_none_grace_ms` asks the owner (`accept` / `cancel`).

**Reviews.** Reviewers publish `vol_publish(channel="result", type="review", payload={ findings:
[{ severity: P1|P2|P3, file, line?, text }], verdict, hygiene: { checked: true, findings } })`
(`review-result.schema.json`). Both reviewer briefs carry a fixed public-hygiene line, whatever
the repo's preface says: "flag as P1 any person name, local username, machine path (home
directories, temp paths), private hostname or IP in the diff, commit messages or PR text".
`hygiene.findings` lists those hits; volleyd folds them into the review's findings, so the
fixup gets them. A result without `hygiene.checked` is not a parseable result. A `done`
without a parseable result is steered once, then `agent_blocked` (`respawn` / `skip`). The
spec reviewer gets `ISSUE.md` and the diff; the quality reviewer gets the diff only (no
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

**The merge_ready invariant.** The review stage is load-bearing, so the transition into the gate
goes through a pure guard (`mergeReadyCheck`): every reviewer role in the task's pipeline must
have a stored review with a verdict that holds for the **current head** — a review of that
head, or of one it descends from only through fixups that ran after that review (they worked
from its round or a later one) and rebases. A head pushed outside the pipeline (`pr_head_moved`,
re-verified) was reviewed by nobody, so reviews of the heads before it no longer count. A
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
with release branch: yes/no (behind by N)". A P1 the owner ruled not a blocker is listed as a P3
with the ruling (`owner: not a blocker (<who>)`), not as an unresolved P1. Just before gating, the
PR's head is read again (`gh pr view --json headRefOid`): if someone pushed after the
verification, `alarm_raised { alarm: "pr_head_moved", expected, actual }` re-opens that role's
verification on the PR branch's new head (CI must be green on it), and the evidence lists the
push under "Pushes outside the pipeline" (the reviews keep the heads they name). Then
`artifact_verified { role: "gate",
evidence_path }` and `stage_entered merge_ready`: the task appears in the wave state's `gates`
with its `evidence_path`.

**volleyd never merges.** A human merges the PR. The pipeline polls the gated PR read-only
(`gh pr view <n> --json state,mergedAt,mergeCommit,baseRefName,headRefOid`, every `ci_poll_ms`);
once it is `MERGED` into the release branch it journals `artifact_verified { role: "merged",
head_sha, merged_head_sha, merge_sha }` and `stage_entered done`, which releases the task's
dependents. Merged at another head than the gated one → also `alarm_raised { alarm:
"merged_unverified_head", gated, merged }`. A PR closed unmerged raises one
`pr_closed_unmerged` alarm and stays at the gate. The fence denies `gh pr merge`, `git merge`,
`git push` and `gh workflow run` anyway; `test/no-merge.test.ts` also holds the source and a full
pipeline run (on an unfenced fake exec) to never build one.

Role spawns go through the same lock, launch and verification as the implementer's, under T5's
admission verdict, within the wave's spawn budget and only while the wave is running
(`roleSpawnHold`); a held spawn is retried on the next tick.

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
    branch --list | branch --track <b> <remote>/<b> | merge-base | show
    worktree add needs -b <new branch> or --detach (never checks out an existing branch), or
    -B only to re-create an agent branch (`<wave>/<task>-<role>-<n>`, worktree.ts
    AGENT_BRANCH — never a release or any other branch); the new branch is never main/master
    (in any case); fetch takes a remote name or a
    network URL (https, ssh, git, user@host:path — never a local path) and its refspecs only
    write refs/remotes/…
  gh issue view · gh pr view | list | checks · gh run list | view | watch ·
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
    `--strict-mcp-config --mcp-config=<worktree>/.volley/mcp.json -- <prompt>` — or from a
    sealed sign-in script (below). The one direct call: `claude auth status` (exactly; it prints
    a profile's login state and plan, never a credential)
  tmux (local: Claude account sign-in, src/claude/signin.ts) — sessions named
    `volley-signin-<acct>` only: new-session -d -s <it> -c <dir> 'bash signin.sh' with the
    SigninToken sealed for <dir> (`sealSigninScript`: exactly `renderSigninScript`, which runs
    `claude auth login` — never `setup-token`) · capture-pane -p -J -t <it> · has-session -t
    <it> · kill-session -t <it> (no consent: a sign-in session holds no agent's work)
  volley auth add-agent <agent_id> [--ack-to <agent_id>]… [--json] [--no-reload]
  volley auth grant <agent_id> --ack-to <agent_id>… [--no-reload]
  volley auth rm-agent <agent_id> [--no-reload]
  volley auth list --json · rotate <agent_id> --json · revoke <agent_id>
  volley auth add <agent_id> --role ROLE [--kind KIND] --json
  volley auth signin-link --role steer|watch --label LABEL --ttl <seconds> --json
  volley auth redeem --label LABEL --json   (the token on stdin, never argv)
    ROLE admin|steer|watch|supervisor|peer · KIND human|device|machine|service ·
    LABEL 1..64 printable characters, not starting with `-`
  launchctl bootstrap gui/<uid> $HOME/Library/LaunchAgents/systems.volley.volleyd.plist (that
    full path only) | bootout | kickstart [-k] [-p] | print — only for the
    systems.volley.volleyd service
  pressure samplers, exact argv only: sysctl -n kern.memorystatus_vm_pressure_level ·
    memory_pressure (no arguments: report only) · docker info --format {{json .}}

SCRIPT (allowed only with a ScriptToken naming exactly that path): the brief gate
  (`$VOLLEYD_HOME/brief-gate`), the one program volleyd runs by path.

TYPED_TEXT (cmux send, tmux send-keys -l: what is typed into an agent's terminal), each only
  with its token, checked by identity like consent tokens:
    LAUNCH_COMMAND   with a LaunchToken (`sealLaunchScript`: volleyd rendered that launch.sh)
    `/model <id>`    with the ModelSwitchToken naming exactly <id> (`mintModelSwitchToken`,
                     minted when an approved model_switch decision is acted on); <id> is a
                     MODEL_ID, the wave-file schema's `model` pattern

SSH (remote hosts, src/hosts/ssh-tmux.ts) — two forms only:
  ssh -T [-o <Opt>=<v>]… <target> bash -s   with a fenced RemoteScript (FenceOptions.remote):
    every step is checked against the REMOTE allow-list below and the script `exec` sends on
    stdin is `renderRemoteScript` of exactly those steps; a raw stdin script is refused, as is
    any `ssh <target> '<command>'` string (zsh login shells word-split it differently).
  ssh -N -R <port>:<host>:<port> [-o <Opt>=<v>]… <target>   the reverse broker tunnel.
  -o takes only BatchMode, ConnectTimeout, ServerAliveInterval, ServerAliveCountMax,
  ExitOnForwardFailure (never ProxyCommand, LocalCommand, …); a target never starts with '-'.

REMOTE (one step of a RemoteScript; the same DENY list applies first):
  git — the local git policy (worktree add | fetch | rev-parse | … ; worktree remove = CONSENT)
  gh issue view
  tmux new-session -d -s <name> -c <dir> 'bash .volley/launch.sh' (that command only, with
    the LaunchToken sealed for <dir>) | capture-pane | has-session |
    send-keys -t <t> Enter|Escape | send-keys -t <t> -l -- <TYPED_TEXT> —
    kill-session = CONSENT; no tmux global options
  mkdir -p <path>… · chmod <3 octal digits> <a file base64 -d may write>… ·
    nc -z 127.0.0.1 <port>
  cat <path>… — only the files volleyd reads: `.claude.json`, a path ending in
    `/info/exclude`, or `<dir>/.volley/<name>` for a VOLLEY_READS name
  base64 -d — the only step that redirects to a file, from base64 text on stdin, under umask
    077, and only to the files volleyd writes: `<dir>/.volley/<name>` for a VOLLEY_WRITES name
    (agent.json, brief.md, launch.sh, mcp.json, review.md, findings.md, findings.json,
    rebase.md — spelled exactly, directly inside `.volley/`, so no write there is a git
    config, HEAD, gitfile or hook, or a case variant of launch.sh), an absolute path ending in
    `/ISSUE.md` or `/info/exclude`, or `~/.claude.json.volleyd.tmp`. A `.volley/launch.sh`
    (what the tmux session runs) is written whole, never appended, and its content must be
    exactly `renderLaunchScript` of valid values for that worktree (LAUNCH_SCRIPT_VARS); a
    `.volley/mcp.json` (the MCP server claude starts) likewise exactly `renderMcpConfig` of an
    absolute `…/packages/volley-mcp/src/index.ts` outside any `.volley/` (MCP_CONFIG)
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
