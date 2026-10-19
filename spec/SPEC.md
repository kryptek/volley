# Volley Protocol Specification

**Version:** 0.1 (pre-1.0; wire compatibility NOT guaranteed across 0.x minor versions)
**Status:** Draft
**License:** Apache 2.0
**Website:** https://volley.systems
**Repository:** https://github.com/kryptek/volley

---

## 1. Overview

Volley is a protocol for inter-agent coordination on a single machine, a single LAN, or across the internet. It defines:

- A topic hierarchy for addressing agents and channels
- A JSON payload envelope shared by all messages
- Lifecycle states agents publish on the `status` channel
- QoS and retention conventions per channel
- A registry for discovery
- A crash-detection mechanism via MQTT Last Will and Testament
- Conformance requirements (MUST / SHOULD / MAY)

Volley is **transport-agnostic**. The reference implementation uses MQTT v5; conforming implementations MAY use any transport that supports retained messages, wildcard subscriptions, QoS at-least-once delivery, and a Last Will and Testament equivalent.

Volley sits **adjacent to the Model Context Protocol (MCP), not in competition with it**: MCP is how an agent talks to tools; Volley is how agents talk to each other and to humans observing them.

### 1.1 Non-goals (v0.1)

- Agent-to-agent direct streaming (all routing through topics)
- Authentication or authorization (broker-level concern; spec MAY require)
- Message encryption (transport-level concern; spec MAY require `mqtts://`)
- Multi-broker federation (reserved namespace `volley/_system/federation/*` exists; not specified in v0.1)

### 1.2 Terminology

- **Agent** — any process that registers with the broker and publishes/subscribes to Volley topics.
- **Coordinator** — an agent whose primary role is to subscribe to wildcard topics and observe other agents. Not a special protocol-level role; just a usage pattern.
- **Broker** — an MQTT broker (mosquitto for the reference implementation).
- **Conforming implementation** — any client library, MCP server, or CLI that follows the requirements in §11.

### 1.3 Notification (informative)

*Notification is a client-side concern on top of the existing `status` channel. The protocol does not standardize notification semantics — when, where, or how an observer surfaces a state transition to a human is left to each implementation. The reference implementation ships two surfaces in v0.1.3 (`volley notify` CLI and a Settings popover in the web dashboard); both consume the status channel via the standard subscribe mechanism and introduce no new envelope fields, topics, or MCP tools. Conforming implementations MAY ship their own notification UIs against the same channel.*

---

## 2. Topic hierarchy

Topics follow this structure:

    volley/<namespace>/<agent_id>/<channel>

### 2.1 Namespace

`namespace` is a logical grouping (e.g. `example-dispatch`, `homelab`, `cursor-team`). Default value is `default`.

- MUST match `[a-z0-9][a-z0-9_-]{0,62}`
- Cross-team brokers SHOULD use per-team namespaces to prevent registry collisions

### 2.2 Agent ID

`agent_id` is a unique, stable identifier per agent.

- MUST match `[a-z0-9][a-z0-9_-]{0,62}`
- Recommended format: `<slug>-<4-char-random>` (e.g. `issue-42-fix-7a3f`)
- Stable across reconnects of the same logical agent within a session

#### Agent identity at runtime (informative)

A conforming Volley MCP server MUST produce a unique `agent_id` per
process start, unless an assigned identity (§6.5) is present. The
recommended mechanism is:

1. Read the `VOLLEY_AGENT_ID` environment variable as a **prefix** (not
   a literal agent_id). The prefix MUST match the SPEC §2.2 grammar
   restricted to length 1-58 (leaving 5 chars for the `-XXXX` suffix).
   If unset, the implementation MAY derive a per-process prefix from
   another source (e.g. the cwd basename — see `generateAgentId` in
   the volley-mcp reference implementation).

2. Append `-${random}` where `${random}` is a 4-character lowercase-
   alphanumeric value. Sourcing the randomness from a uniform RNG over
   `[a-z0-9]` (36 chars) gives ~20 bits of entropy per suffix, plenty
   for per-machine uniqueness.

3. The resulting `agent_id` MUST satisfy the full SPEC §2.2 grammar
   `[a-z0-9][a-z0-9_-]{0,62}`. A server MUST reject a prefix that would
   produce an out-of-grammar id.

**Why a prefix, not a literal?** Two MCP-server processes spawned from the
same user-scope MCP registration on one machine inherit the same env
block, so a literal `VOLLEY_AGENT_ID` would produce identical agent_ids
and the second to publish would overwrite the first's retained registry
entry. The auto-suffix makes the user-scope-MCP-shared-across-sessions
case correct by default.

**Discovering an agent_id.** Because the suffix is fresh per process,
the agent_id is not knowable ahead of time (unless an assigned identity
(§6.5) is present, in which case the supervisor that wrote it already
knows it). Discovery options:

- The MCP server's `vol_register` tool returns `{ agent_id, namespace }`
  so the calling Claude session learns its own id immediately.
- A peer Claude session calls `vol_list_agents` and finds the agent by
  `capabilities`, `parent_id`, or `cwd`.

**Examples:**

| `VOLLEY_AGENT_ID` env | resulting `agent_id`              |
|-----------------------|-----------------------------------|
| (unset)               | derived from cwd basename — see `generateAgentId` (existing behavior) |
| `coordinator`         | `coordinator-7b9c`                |
| `coordinator-base`    | `coordinator-base-2d8e`           |
| `issue-42-fix`   | `issue-42-fix-4ec0`          |
| `Foo` (uppercase)     | (rejected — fails grammar)        |
| `x` (single char)     | `x-0a3f` (1 + 1 + 4 = 6 chars OK) |

This is INFORMATIVE not NORMATIVE — the grammar at the top of §2.2 is
the only NORMATIVE constraint. A non-MCP Volley client (a CLI, a shell
publisher) MAY use any other mechanism to pick a grammar-conforming
`agent_id`.

**Assigned identity.** When a supervisor has written `.volley/agent.json`
into the agent's working directory, the MCP server uses the literal
`agent_id` from that file instead of the prefix + suffix mechanism above —
see §6.5.

### 2.3 Channel

`channel` is one of the reserved channel names listed in §4.1, OR a user-defined channel under the `_user/*` prefix, OR a supervisor channel defined in §4.6 (informative in 0.1).

### 2.4 Reserved namespaces

The following top-level namespace prefixes are reserved:

- `volley/_system/*` — protocol-level state (registry, broker health, federation config)
- `volley/_meta/*` — implementation tooling (debug taps, replay logs, capture files)
- `volley/_waves/*` — supervisor state: wave snapshots, decisions, journal events, effective supervisor config (§4.6)
- `volley-auth/*` — one-time token redemption (§4.6.10), outside the `volley/` root so a broker ACL can confine a token's login to its own two topics

Implementations MUST NOT publish user-space messages under these prefixes. One exception: any agent MAY publish lease requests to `volley/_system/leases/<pool>/requests` (§4.6.5). Every other topic under these prefixes is written only by the broker, the implementation's own tooling, or a supervisor (§4.6).

---

## 3. Payload envelope

All Volley messages share a common JSON envelope:

```json
{
  "schema_version": "0.1",
  "agent_id": "issue-42-fix-7a3f",
  "parent_id": "coordinator-abcd",
  "wall_time": "2026-05-14T02:11:23.000Z",
  "channel": "status",
  "type": "done",
  "payload": { },
  "correlation_id": "0a4f3e7c-8b21-4f3a-9d2e-1c8f7a3e2b41"
}
```

### 3.1 Required fields

- **`schema_version`** (string) — semver of the Volley protocol. v0.1 implementations MUST emit `"0.1"` and MUST reject envelopes whose major version does not match a supported major. See §8.
- **`agent_id`** (string) — sender's agent ID, MUST match the grammar in §2.2.
- **`wall_time`** (string, ISO-8601 UTC with milliseconds) — sender's wall-clock at publish time. Receivers MUST NOT rely on this for ordering; it is informational.
- **`channel`** (string) — one of the reserved channels (§4.1), a `_user/*`-prefixed user channel, or a supervisor channel defined in §4.6.
- **`type`** (string) — channel-specific event type (e.g. `done` on the `status` channel, `tests-green` on `progress`).

### 3.2 Optional fields

- **`parent_id`** (string | null) — if the publishing agent was spawned by another Volley agent, the parent's `agent_id`. Used to build dispatch trees.
- **`payload`** (object) — channel-specific data; shape governed by the per-channel schema (§4).
- **`correlation_id`** (string | null) — UUID v4 linking related messages (e.g. mailbox request → mailbox response).

### 3.3 Unknown fields

Receivers MUST accept envelopes containing unknown fields and MUST NOT error on them. This permits forward-compatible spec extensions.

---

## 4. Channels

### 4.1 Reserved channels

| Channel | QoS | Retained? | Purpose |
|---|---|---|---|
| `status` | 1 | yes | Last-known lifecycle state of an agent (see §5). |
| `progress` | 0 | no | Streaming progress events (e.g. `tests-green`, `mvn-verify-done`). Fire-and-forget. |
| `mailbox` | 1 | no | Inbound requests / commands directed at this agent. Must-deliver. The topic's `<agent_id>` segment identifies the recipient; the envelope's `agent_id` (§3.1) identifies the sender. Not retained, so the broker only holds a message for a recipient with a persistent session (see §4.4); delivery is confirmed end-to-end by an `ack`, not by PUBACK. |
| `control` | 1 | no | Reserved for agent control (`kill`, `pause`, `resume`, `nudge`). Reserved in v0.1; semantics deferred to v0.2+. |
| `result` | 1 | yes | Final artifact pointer (PR URL, log path, deploy summary). |
| `capability` | 1 | yes | Tools / models this agent advertises. |

### 4.2 User-defined channels

User-defined channels MUST use the `_user/<name>` prefix. v0.1 does not constrain user-defined channel QoS or retention; that is a deployment concern.

### 4.3 Publishing requirements

Conforming agents MUST:

- Publish to the `status` channel with the correct lifecycle `type` (see §5) at the corresponding state transitions
- Use the QoS and retention values in §4.1 for reserved channels

Conforming agents SHOULD:

- Publish `progress` events at meaningful checkpoints
- When the agent can estimate a percent-complete, include `payload.progress` as a number in `[0, 100]` on `progress` and/or `status` envelopes — dashboards and coordinators use it to render determinate progress bars instead of indeterminate sweeps. Implementations MUST treat the field as advisory (an estimate from the agent itself) and MUST tolerate `null`, missing, or non-numeric values by falling back to the last seen value or to an indeterminate display.
- Publish a `result` retained message before terminal `status` so late-attaching tools can see the artifact pointer

**Hook activity events (informative).** The `status` state machine (§5.3) is linear, so non-terminal attention states are not status types. A harness hook (e.g. a Claude Code hook running beside the agent) reports them on the `progress` channel instead, with `payload.source: "harness-hook"`, a per-agent monotonic `payload.seq`, and the `payload.hook_event` that fired. The documented types are `heartbeat` (the agent is alive and doing something), `idle` (the turn ended; `payload.text` carries the last assistant line, and `payload.completed: true` says the harness reported the task completed), `awaiting_input` (the harness is waiting on a human; `payload.text` / `payload.notification_type` carry the notification, `payload.screen_tail` MAY carry the last terminal lines, and `payload.class` says why the harness is waiting when it is not a question, e.g. `credit` for a provider usage limit that the harness resumes from on its own; `payload.background_wait: true` says the session ended its turn without a question while a background task it started is still running, so it is waiting on that task's events, not on a human: a dashboard SHOULD NOT present it as needing a person. `background_wait` MAY also be set on the `idle` that ended such a turn, and is never set on a `permission_prompt` or on an `awaiting_input` that carries a question the turn ended on), `resumed` (the agent is working again; it clears any earlier `awaiting_input`) and `steering_applied` (reserved: a hook MAY publish it when it injects mailbox steering into the session; the reference hooks ack the mailbox message instead and do not publish it). For a coordinator session, `awaiting_input` additionally carries `payload.question` (what it is asking: the reference hooks send the question paragraph whole, or an excerpt of its end beyond 8192 characters; a supervisor's wave-state `coordinator.question`, §4.6.1, carries only its first one or two lines), `payload.session_url` and `payload.workspace` when known, so a dashboard can surface and link the waiting session; the coordinator's registry entry carries the same `session_url` / `workspace` when known. When the model itself has acted on a steering message it publishes `type: "steering_acked"` with `correlation_id` set to that mailbox message's id. A hook that re-publishes the registry entry with the harness-reported model sets `payload.model_source: "harness-hook"`, or `"unknown"` when the hook input carries no model. A registry entry without `model_source` (an agent's own `vol_register`, including the reference MCP server's auto-registration) carries a self-reported `model`, if any; the value `"self-reported"` is reserved for publishers that want to say so explicitly. The `type` field stays an open string; observers ignore progress types they do not recognise. A broker delivers one copy of a message per matching subscription, so an observer MAY treat byte-identical `progress` messages as one delivery; a publisher that can send the same content twice includes `seq` to keep them distinct. See `spec/schemas/progress.schema.json`.

### 4.4 Mailbox message types

The `mailbox` channel's `type` field is one of:

- `steering` — free-text guidance to redirect or inform the agent
- `cancel` — request the agent to abort its current task
- `nudge` — a lightweight prod to re-evaluate or report status
- `query` — a question expecting a response (typically correlated via `correlation_id`)
- `ack` — the recipient's confirmation that it received a mailbox message (see below)

This list matches the `type` enum in `spec/schemas/mailbox.schema.json`.

**Message ids.** A mailbox message's `correlation_id` is its message id. Senders SHOULD set it to a fresh UUID unless they are deliberately correlating with an earlier message (a `query` reply, an `ack`); a message without one cannot be acked. The reference `vol_send_mailbox` generates it when the caller omits it and returns it as `message_id`.

**Optional payload fields.** In addition to the required `text`:

- `seq` — a non-negative integer, monotonic per sender, so a recipient can order messages and drop duplicates
- `supersedes` — the message id of an earlier message from the same sender that this one replaces; a recipient that has not yet acted on the earlier message SHOULD act on this one instead

**Acks.** A recipient acknowledges a message by publishing `type: "ack"` to the **sender's** mailbox (`volley/<ns>/<sender agent_id>/mailbox`) with `correlation_id` set to the acknowledged message id. `correlation_id` is REQUIRED on an `ack`. The payload SHOULD be `{ "text": "ACKED", "acked_type": "<type of the acknowledged message>" }`, plus `seq` when the acknowledged message carried one. A sender waiting for an ack MUST only accept one whose envelope `agent_id` is the recipient it addressed. An ack means *received*, not *obeyed*: acting on the message is reported through the agent's normal channels. Recipients MUST NOT ack an `ack`. A broker that enforces ACLs (§11.5) must let a recipient write each sender's mailbox for its ack to arrive: the reference ACL grants a per-agent identity write access only to the mailboxes named when it was minted (`volley auth add-agent <id> --ack-to <sender>`, typically its parent), and silently drops any other ack. `volley auth grant <id> --ack-to <sender>` adds a sender to an identity that is already minted (ACL only; its password is unchanged), e.g. when another coordinator claims the wave.

**Delivery.** Because mailbox messages are not retained, the broker drops a message published while the recipient holds no subscription to its mailbox. An agent that honours its mailbox (§11.3) MUST therefore keep its mailbox subscription in a **persistent MQTT session** (a live subscription on a clean session still loses whatever arrives before it subscribes or while it reconnects): connect with `clean: false` (MQTT 3.1.1) or a non-zero session expiry interval (MQTT 5), with a stable clientId it owns exclusively, and subscribe at QoS 1. The broker then queues messages while the agent is offline and delivers them on its next connect. Two clients that connect with the same clientId kick each other off, so each persistent consumer of one agent (e.g. the MCP server and a hooks drain client) MUST use its own clientId, such as `volley-<agent_id>-mcp` vs `volley-<agent_id>-hooks`. A session expiry interval applies to new connections only: an existing persistent session keeps the expiry it was created with until the client reconnects. A sender that needs confirmation SHOULD wait for the `ack` rather than trust PUBACK, which only confirms receipt by the broker.

### 4.5 Reserved

This section number is intentionally unused, so that references to §4.6 and its subsections stay stable.

### 4.6 Supervisor topics (informative in 0.1)

A **supervisor** (e.g. the `volleyd` daemon) is an agent that spawns other agents in *waves* — a set of tasks with dependencies, each driven through a review pipeline — and publishes their state for dashboards, panes and coordinators. Supervisor state lives under the reserved `volley/_waves/*` prefix and, for machine-global resources, under `volley/_system/leases/*` and `volley/_system/admission`. These topics are informative in 0.1: a deployment without a supervisor never sees them, and nothing in §11 requires them.

Every message on these topics is a standard envelope (§3) whose `agent_id` is the publisher; the field tables below describe `payload`. Clearing a retained topic means publishing a zero-length retained payload (the MQTT convention), which is not an envelope and is not schema-validated. Ids that appear as topic segments (`<wave>`, `<decision_id>`, `<pool>`) use the §2.1 grammar. Wave ids and lease-pool names MUST NOT be a reserved channel name (§4.1): ACLs that grant per-channel writes through a namespace wildcard (`volley/+/<agent>/status`) would otherwise also match `volley/_waves/<wave>/<channel>` or `volley/_system/leases/<channel>`. Task ids come from the wave file and are case-preserving (`[A-Za-z0-9][A-Za-z0-9_-]{0,62}`, e.g. `T1`).

| Topic | QoS | Retained? | `channel` / `type` | Schema |
|---|---|---|---|---|
| `volley/_waves/<wave>/state` | 1 | yes | `_waves/state` / `wave_state` | `wave-state.schema.json` |
| `volley/_waves/<wave>/decisions/<decision_id>` | 1 | yes, while open | `_waves/decisions` / `decision_opened` \| `decision_resolved` | `decision.schema.json` |
| `volley/_waves/<wave>/events` | 1 | no | `_waves/events` / journal event type | `wave-event.schema.json` |
| `volley/_waves/_config` | 1 | yes | `_waves/_config` / `config` | `config.schema.json` |
| `volley/_system/leases/<pool>` | 1 | yes | `_system/leases` / `lease_pool` | `lease-pool.schema.json` |
| `volley/_system/leases/<pool>/requests` | 1 | no | `_system/leases/requests` / `lease_request` | `lease-request.schema.json` |
| `volley/_system/admission` | 1 | yes | `_system/admission` / `admission` | `admission.schema.json` |
| `volley/<ns>/<agent_id>/screen` | 0 | yes | `screen` / `screen_tail` | `screen.schema.json` |
| `volley/_system/auth/ops/<username>` | 1 | no | `_system/auth` / `query` | `auth-request.schema.json` |
| `volley-auth/redeem/<token_id>` | 1 | no | `_system/auth` / `query` | `auth-request.schema.json` |
| `volley-auth/redeem/<token_id>/reply` | 1 | no | `_system/auth` / `ack` | — (§4.6.10) |
| `volley/_system/auth/replies/<correlation_id>` | 1 | no | `_system/auth` / `ack` | — (§4.6.10) |
| `volley/_system/claude/<acct>/signin` | 1 | no | `_system/claude` / `claude_signin_url` \| `claude_signin_done` \| `claude_signin_failed` | — (§4.6.11) |

`_config` is not a valid wave id (wave ids start with `[a-z0-9]`), so the config topic cannot collide with a wave.

#### 4.6.1 Wave state

`volley/_waves/<wave>/state` holds the full current snapshot of one wave, re-published after every change. A late-attaching client needs nothing else to render the wave.

| Field | Type | Meaning |
|---|---|---|
| `wave` | string | Wave id. |
| `version` | integer ≥ 1 | Wave file version (bumped by a versioned re-submission). |
| `owner` | agent id \| null | Coordinator that owns the wave; `null` when orphaned. |
| `repo`, `release_branch` | string | Where the wave's PRs land. |
| `status` | enum | `running` \| `paused` \| `awaiting_decision` \| `complete` \| `stopped`. |
| `tasks[]` | object | `{ id, issue, stage, agents, waiting_on?, why_waiting?, host?, pr?, evidence_path?, screen_stale?, last_error?, attempt?, next_retry_at?, reviews_skipped_by_plan? }`. |
| `tasks[].stage` | enum (closed) | `queued` \| `implement` \| `spec_review` \| `quality_review` \| `fixup` \| `merge_ready` \| `done` \| `blocked` \| `awaiting_decision` \| `cancelled`. |
| `tasks[].agents` | object | Current agent id per role: `implementer?`, `spec_reviewer?`, `quality_reviewer?`, `fixup?`, `rebase?`. |
| `tasks[].waiting_on`, `why_waiting` | string[], string | What the task is blocked on, and a human-readable reason (e.g. `tunnel down to <target>` while a remote host's broker tunnel is down). |
| `tasks[].host` | string | The remote host the task's agents run on (its name from the wave file or the `hosts` tunable); absent for the supervisor's own host. Per task: every agent of a task runs on the same host. |
| `tasks[].screen_stale` | boolean | `true` while the supervisor's screen capture for any of the task's agents is backed off (§4.6.6), so the retained `screen` topic may be out of date. Per task, not per agent; absent otherwise. |
| `tasks[].last_error`, `attempt`, `next_retry_at` | object, integer, date-time \| null | While a spawn of the task has failed and that role has not spawned since: `last_error` `{ code, message, at }`, `attempt` (failed attempts in a row) and `next_retry_at` (the supervisor's next automatic retry; `null` once it stopped retrying). Failures are counted per role (two roles of one step may fail at once); these fields show the most recent one. Absent otherwise. |
| `tasks[].pr` | object | `{ number, url, head_sha?, ci? }`; `ci` is `green` \| `red` \| `running` \| `none`. |
| `tasks[].reviews_skipped_by_plan` | boolean | `true` once the task reached `merge_ready` without reviews because its wave-file pipeline lists no review stage (§4.6.8); absent otherwise. |
| `open_decisions` | string[] | Ids of open decisions (§4.6.2). |
| `gates` | string[] | Task ids that are merge-ready and await a human merge. |
| `spec` | object | The submitted wave file: `{ version, release_branch?, model?, pipeline?, tasks: { <id>: { issue, title?, after[] } } }`; `pipeline` is an array of stage names where a nested array runs stages in parallel. |
| `coordinator` | object | `{ agent_id, state, question?, session_url?, workspace?, last_seen }`; `state` is `working` \| `awaiting_input` \| `gone`, maintained by the supervisor from the owner's `status` and `progress` topics (§4.3). |
| `effective_config` | object | The §4.6.4 tunables with this wave's overrides applied. |
| `brief_preface` | object \| null | `{ path, sha256, bytes }` of the brief preface the current plan version's agents get (§4.6.9), or `null` when the wave has none. Absent from a supervisor that predates it. |
| `updated_at` | date-time | Time of the last change. |

#### 4.6.2 Decisions

A decision is a question only a human (or the owning coordinator) can answer. It is published retained to `volley/_waves/<wave>/decisions/<decision_id>` while open, MAY be re-published once with `type: "decision_resolved"` and `resolved` set, and is then cleared.

| Field | Type | Meaning |
|---|---|---|
| `decision_id`, `wave` | string | Identity. |
| `task` | task id \| null | `null` for a wave-level decision. |
| `kind` | enum (closed) | `reviewers_disagree` \| `merge_conflict` \| `agent_blocked` \| `agent_question` \| `agent_stalled` \| `unknown_screen` \| `hooks_auth_failed` \| `mcp_not_registered` \| `spawn_failed` \| `model_switch` \| `repo_untrusted` \| `remote_repo_missing` \| `ci_failed` \| `wave_complete` \| `plan_change` \| `pr_closed` \| `pr_head_moved`. A `repo_untrusted` or `remote_repo_missing` decision carries `repo` (the repo path it is about) and, for a remote host, `host` and `target` (the ssh destination; `repo` is then a path on it); a `repo_untrusted` one is answered on that host (its own folder trust), never the supervisor's. A `plan_change` decision carries `change`: `removed` (the new wave version dropped the task) \| `issue` (it moved the task to another issue). A `pr_closed` decision asks about a gated PR closed without a merge whose head the release branch does not carry (`landed` \| `abandoned`); a `pr_head_moved` decision asks about a PR head that moved after a gate (`rereview` \| `fixup` \| `cancel`). |
| `question` | string | What needs answering. |
| `options` | string[] | Suggested answers (optional; free text is always allowed). |
| `pointers` | object | `{ diff?, transcript?, screen?, pr? }` — where the evidence lives. |
| `opened_at` | date-time | |
| `resolved` | object | `{ answer, by, at }`; required when `type` is `decision_resolved`. |

#### 4.6.3 Wave events

`volley/_waves/<wave>/events` is a non-retained live mirror of the supervisor's per-wave journal; the journal (not the broker) is the record, and consumers that need every event read it through the supervisor. The envelope `type` is the event type, from a closed enum in `wave-event.schema.json` (`wave_submitted`, `task_queued`, `agent_spawned`, `spawn_failed`, `spawn_recovered`, `stage_entered`, `decision_opened`, `lease_granted`, `config_changed`, …). `payload` is `{ wave, seq, at, task?, data? }`, where `seq` is monotonic per wave and `data` is event-specific. Global events use the pseudo-wave `_system`.

#### 4.6.4 Supervisor config

`volley/_waves/_config` holds the supervisor's current *effective* global config: every runtime tunable plus `version` (monotonic), `updated_at` and `updated_by`. The tunable model is `config.schema.json#/$defs/tunables` — every key has `minimum`/`maximum` (or length) bounds so a UI can render and validate it without hard-coding limits:

`hard_ceiling`, `spawn_budget_multiplier`, `lease_pools: { <pool>: { capacity, ttl_s?, match[]? } }`, `admission: { memory_pressure_max_level, cmux_ping_max_ms, container_max, api_overload_window_s, api_overload_max, ci_queue_max, hysteresis_samples }`, `claim_after_s`, `heartbeat_alarm_s`, `idle_grace_s`, `fallback_model` (string \| null), `mailbox: { session_expiry_s }`, `worktree_root`, `spawn_timeout_s`, `spawn_retry_max_s`, `spawn_retry_max`, `brief_preface_max_bytes`, `wake_grace_s`, `screen_tail_interval_s`, `stop_grace_s`, `claude: { default_account }` (string \| null: the Claude account an agent runs under when its task and wave name none, §4.6.11), `hosts: { <name>: { type?, target, repo, worktree_root?, volley_dir, tunnel?: { remote_port, supervise } } }` (remote SSH + tmux hosts a wave task names with `host:`; `<name>` is never `local`).

Per-wave overrides use the same shape with every key optional (a wave file's `config:` block) and appear in the wave state as `effective_config`. The exception is `lease_pools`: pools are machine-global (§4.6.5), so a supervisor rejects a wave file that overrides them rather than accept an override it cannot apply.

**Changing config.** A client sends a mailbox message (§4.4) to the supervisor with `type: "query"`, a fresh `correlation_id`, and `payload: { op: "config_set", patch, by, text }`, where `patch` is a partial tunables object (`config-set-request.schema.json`). Senders MUST include `text` (a one-line human summary), so the request is also a well-formed mailbox message (`mailbox.schema.json`), and MUST set a non-null `correlation_id` so they can match the acknowledgement. The supervisor answers with a mailbox acknowledgement correlated to the request carrying `{ applied, rejected: [{ path, reason }] }`; a patch with an unknown key or an out-of-bounds value is rejected as a whole. On success the supervisor re-publishes the retained `_config` topic with `version` incremented.

#### 4.6.5 Leases

Heavy operations (integration test suites, builds, browsers) are gated by machine-global lease pools. `volley/_system/leases/<pool>` holds the retained pool state `{ pool, capacity, held: [{ lease_id, holder, since, ttl_s }], queue: [{ lease_id, holder, since }], reasons[] }`; `queue` is FIFO and `reasons` explains the queue in human terms (e.g. `"queued: 3/3 backend-it leases held"`). Agents ask on `volley/_system/leases/<pool>/requests` with `payload: { op: "acquire" | "release" | "renew", lease_id, holder, ttl_s? }` (the one user-space publish §2.4 allows under a reserved prefix); the supervisor answers by re-publishing the pool state, and expires leases on TTL or when the holder's `status` turns terminal. The supervisor ignores a request whose `holder` differs from the envelope `agent_id`, so an agent can only acquire, renew or release its own leases. Requests are not retained, so one sent while the supervisor is down is lost: an agent that does not see its `lease_id` in `held` or `queue` within 30 seconds SHOULD re-send `acquire`, and the supervisor treats a repeated `acquire` for a `lease_id` it already holds or queues as a no-op. When a pool is removed from config, the supervisor keeps its holders (nothing is preempted) but drops its queued requests, adding `rejected <lease_id>: <why>` to the pool's `reasons` (or clearing the topic once the pool is empty); a client whose queued `lease_id` leaves the pool state without a grant SHOULD treat the request as rejected.

#### 4.6.6 Screen channel

`screen` is a reserved per-agent channel in addition to those in §4.1: QoS 0, **retained**, published by a supervisor *on the agent's behalf* (the envelope `agent_id` is the supervisor; the topic's `<agent_id>` segment names the agent). `payload: { lines (≤ 40 strings), captured_at, workspace, hash, source }` is the tail of the agent's terminal (`source` is the capture mechanism, a closed enum: `cmux` for the supervisor's own host, `tmux` for a remote SSH + tmux host); publishers SHOULD skip captures whose `hash` is unchanged. The supervisor clears the topic when the agent is retired. A supervisor whose capture is slow or failing SHOULD back off and set `tasks[].screen_stale` in the wave state (§4.6.1) until a capture succeeds in time. Agents MUST NOT publish their own `screen` channel.

#### 4.6.7 Spawn admission

A supervisor throttles *starts* (never running work) by measured machine load. `volley/_system/admission` holds its latest verdict, re-published after every pressure sample: `{ sampled_at, allow, throttled, reasons[], signals, waves? }`, where `allow` is how many more agents may start now (`null`: pressure sets no limit; the hard ceiling and per-wave spawn budget still apply), `reasons` has one human-readable line per signal holding starts back (e.g. `"memory pressure critical (level 4 > max 2)"`), and `signals.<name>` is `{ state, value?, max?, clean_samples?, error? }` for `memory_pressure`, `cmux_ping`, `containers`, `api_overload` and `ci_queue`, with `state` one of `clear` \| `over` \| `recovering` \| `unknown`. Thresholds and the hysteresis sample count are the §4.6.4 `admission.*` tunables: a signal over its threshold sets `allow` to 0, and must then be clear for `hysteresis_samples` consecutive samples (`recovering`) before the allowance rises again; a signal that cannot be measured is `unknown` and never trips; on a signal already tripped, an unmeasurable sample counts toward its clean samples (so a measurement tool that breaks cannot hold starts back forever), and the signal reports `recovering` with `clean_samples` and the `error` until the count is reached. A supervisor admits nothing before its first sample. `waves.<wave>` is the same verdict with that wave's overrides and its repository's CI queue applied; the supervisor also copies those reasons into `why_waiting` of the wave's ready-but-unstarted tasks (§4.6.1).

#### 4.6.8 Pipeline results and the merge-ready gate

A supervisor that reviews work before a human merges it MAY ask its review roles for a structured retained `result` (§4.1) published before their terminal `done`: `type: "review"` with `payload: { findings: [{ severity, file, line?, text }], verdict }`, where `severity` is `P1` (blocks the merge) \| `P2` \| `P3` and `verdict` is `approve` \| `changes_requested`, and `hygiene: { checked: true, findings: [...] }` — the reviewer's check of the diff, commit messages and PR text for person names, local usernames, machine paths, private hostnames or IPs, each hit a `P1` finding (a review without `hygiene.checked` is not a review result) — and `type: "fixup"` with `payload: { resolved: [{ finding, how }] }` (`review-result.schema.json`). A supervisor SHOULD treat an agent's `done` as a claim and verify it (pushed head, the PR for exactly that head branch, CI on exactly that head) before acting on it, and SHOULD re-check that the PR is still at the verified head before gating it; a task whose claims are verified enters stage `merge_ready`, is listed in `gates`, and carries `evidence_path`, a supervisor-local file describing that head. The supervisor does not merge: a task leaves `merge_ready` for `done` only when the supervisor observes that a human merged its PR.

A supervisor that runs review roles MUST NOT move a task to `merge_ready` unless every review role in that task's pipeline has a recorded review with a verdict that holds for the head being gated: a review of that head, or of a head it descends from only through fix-ups that ran after that review and rebases onto the release branch. A pipeline without review stages is honoured only when the wave file lists it explicitly; the supervisor then sets `tasks[].reviews_skipped_by_plan` (§4.6.1).

#### 4.6.9 Brief preface

A supervisor that writes briefs for the agents it spawns SHOULD let a repository set rules every one of them gets. The **brief preface** is a file — `<repo>/.volley/brief-preface.md` by default, or the path in the wave file's `brief_preface` key (relative to `repo`, or absolute) — whose bytes the supervisor puts verbatim (no placeholder expansion) at the top of every brief it writes for that wave, for every role, above the role's own text and separated from it by a rule. The file MUST be UTF-8; a supervisor refuses one that is not, rather than alter its bytes. A blank file (only whitespace) counts as no preface. A supervisor bounds its size (`brief_preface_max_bytes`, §4.6.4) and refuses a wave whose preface is larger. The wave state's `brief_preface` (§4.6.1) is `{ path, sha256, bytes }` of the file as read for the current plan version (`sha256` over its bytes), or `null` when there is none, so a client can show which rules the agents got.

#### 4.6.10 Accounts and one-time tokens

A deployment with broker authentication keeps **accounts**: broker usernames with a **role** that selects their ACL template. `admin` may do everything a coordinator may, plus the account ops below; `steer` reads everything and writes mailboxes (steering, control requests) and lease requests; `watch` only reads; `supervisor` (a volleyd) reads and writes everything except the account-op and answer topics below (its ACL denies `volley/_system/auth/ops/#` and `volley/_system/auth/replies/#`, so it can neither impersonate an admin nor forge an answer); `peer` (a paired machine) writes its own agent channels and `volley/_system/machines/<username>[/#]`. Every authenticated client also keeps the ACL's shared grants (read `volley/#`, its own channels and registry entry, lease requests). Per-agent identities minted for dispatched agents are not accounts. The registry is a file next to the broker's password file (`account.schema.json`: `{ name, role, kind, created, label? }`); it never holds a password. `account_list` adds `last_seen`: the newest of the account's retained registry entry, its retained `status` (where its LWT lands) and its last auth request to this supervisor process.

**Account ops.** An admin sends `payload: { op, ... }` (`auth-request.schema.json`) in an envelope with `channel: "_system/auth"`, `type: "query"` and a fresh `correlation_id` to `volley/_system/auth/ops/<username>`, where `<username>` is its own broker username. The broker ACL grants that topic only to admin accounts and only for their own username, so the topic names the sender; the supervisor MUST also check that the named account has the `admin` role and refuse any other sender with a reason. The mailbox is not used for these ops: anyone who may steer may write the supervisor's mailbox, so it cannot name the sender. Requests MUST NOT be retained; the supervisor clears a request topic's retained message so it is never replayed. Ops: `account_list`; `account_create { name, role, kind? }`; `account_rotate { name }` (refused for the sender's own account: the broker reload that applies a new password disconnects the client holding the old one before the answer arrives, so an admin rotates itself from a terminal or through another admin); `account_revoke { name }`; `signin_link { role, label, ttl_s?, desk_url? }`, where `role` is `steer` or `watch`; with `desk_url` its `result` carries `link_base` (the URL without a fragment) and the client builds the link `<link_base>#signin=<token>`. A supervisor journals each successful op in the `_system` journal (§4.6.3: `account_created`, `account_rotated`, `account_revoked`, `signin_link_issued`, each with `by`; `at` is the event's) and never writes a password itself: the account tool does.

**One-time tokens.** An operator's terminal prints a single-use token (`vly_admin_<id>_<secret>`, by default valid 10 minutes); `signin_link` yields a `vly_signin_<id>_<secret>` token for one device (a Desk link carries it as `<desk_url>#signin=<token>`). Only a hash of each token is stored. A token is also the password of a short-lived broker login `redeem-<id>`, so the broker can keep refusing anonymous clients (an anonymous client would inherit the ACL's shared grants, including read of the whole tree). That login may do exactly two things: write its own request topic `volley-auth/redeem/<id>` and read its own answer topic `volley-auth/redeem/<id>/reply`. It cannot read anything under `volley/`, nor another token's topics. These two topics are the one exception to the `volley/` root: the ACL's shared grants all live under `volley/` and a broker `deny` overrides every grant, so the token login's ACL denies `volley/#` and is granted topics that no shared grant reaches. Only the supervisor reads the request topics and writes the answer topics. The login is removed once the token has expired, or about a minute after it was redeemed, by the account tool's next run; the supervisor runs it periodically (`token_prune_ms`) so an unused token stops being a login soon after it expires. The client publishes `payload: { op: "token_redeem", token, label, reply_key }` on its request topic; the supervisor refuses a token whose id is not the topic's, burns the token and creates an account with the token's role (`admin` for an admin token) bound to `label`, journaled as `token_redeemed`. Redemption does not remove the token's login at once: the broker disconnects a client whose user leaves the password file when it reloads, and the redeeming client is still connected as that login, waiting for its answer. A used, expired or unknown token is refused. There is no other way to obtain an admin account from a browser.

**Answers.** The supervisor answers an account op on `volley/_system/auth/replies/<correlation_id>` and a `token_redeem` on `volley-auth/redeem/<id>/reply` (QoS 1, not retained) with `type: "ack"`, the request's `correlation_id`, and `payload: { text: "ACKED", acked_type: "query", op, ok, error?, result?, sealed? }`. Every account may read the account-op answer topics, so a secret (a password, a sign-in token and link) MUST NOT appear in clear text: it is in `sealed`, the base64url RSA-OAEP (SHA-256) encryption of `{ username, password }` or `{ token }` to the request's `reply_key`, an RSA public JWK of at least 2048 bits whose private half only the requester holds. A request whose answer would carry a secret and that has no usable `reply_key` is refused before anything is created. Clients MUST accept an answer only from `agent_id: "volleyd"` (§4.4); the broker ACL lets no account but the fixed `volleyd` identity write the answer topics.

**Owner decisions (2026-10-18).** The redemption path uses per-token broker logins, not an anonymous redeem topic; account ops use the dedicated `volley/_system/auth/ops/<username>` topic, not the supervisor's mailbox; every request whose answer carries a secret MUST carry `reply_key`; a token login reaches only its own two topics.


#### 4.6.11 Claude account profiles

A supervisor that launches Claude Code agents MAY run them under several Claude accounts. Each account is a separate Claude Code profile: its own configuration directory, passed to the agent as `CLAUDE_CONFIG_DIR` (one canonical absolute path with no trailing slash; Claude Code keys the profile's login to that exact string). `primary` names the user's own default profile (no `CLAUDE_CONFIG_DIR`). A profile is signed in only through Claude Code's own sign-in flow. A supervisor MUST NOT collect, store, forward or relay a Claude credential, session token or authorization code: it never reads a profile's credential store, never uses a flow that prints a bearer token, never sets a credential variable (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) in an agent's environment, and never offers a field that would pass a code to the sign-in process.

**Selection.** An agent runs under its task's `account` (wave file), else the wave's `account`, else the `claude.default_account` tunable (§4.6.4), else `primary`. `most_headroom` asks the supervisor for the account with the most usage left; a supervisor without usage data resolves it to `primary`. A spawn under an unknown account, or one whose sign-in has not finished, is refused with a reason. The agent's `.volley/agent.json` and its registry entry carry `claude_account` (§6.2, §6.5). Folder trust is per profile, so a `repo_untrusted` decision (§4.6.2) for such an agent carries `claude_config_dir` and is answered in that profile.

**Sign-in.** `claude_account_add { label, machine?, by }` creates the profile and starts Claude Code's sign-in for it in the background; `claude_signin { acct }` restarts it for an existing profile. The supervisor publishes the authorize URL Claude Code produced, as `claude_signin_url { acct, url, flow, attach }`, on `volley/_system/claude/<acct>/signin`, then `claude_signin_done { acct, plan? }` or `claude_signin_failed { acct, reason }` there. The topic is not retained: whoever opens the URL first chooses the account bound to the profile. Not retaining it does not confine it: every client that may read the topic while the sign-in runs sees the URL, and under the example broker ACL every authenticated client, agents included, may read all of `volley/#`. A deployment that must keep the URL from its agents restricts reads of `volley/_system/claude/#` to the owner's clients in its broker ACL. `flow` is `browser_callback` (the URL redirects to Claude Code's own listener on the supervisor's machine, so it must be opened in a browser there) or `manual_code` (the page shows a code the user pastes into the sign-in terminal named by `attach`, never into a Volley client). The URL is not journaled; while a sign-in waits, `claude_accounts` returns it, so a client that attached late can still show it.

**Ops.** Mailbox control queries (§4.6.4's request/acknowledgement shape): `claude_accounts` (the registry: `{ id, label, machine, created, plan?, signed_in_at?, dir, signin: { state, url?, flow?, attach? } }`, plus the sharing modes); `claude_account_add`; `claude_signin`; `claude_sync { acct? }`; `agent_move_account { agent, acct }`. A move is never silent: the supervisor journals `agent_account_moved { agent_id, role, from, to, by }` first, cancels the agent (§4.4), and only once it has stopped retires it and respawns its role under the other account, as a new attempt in the same working directory with a resume note in its brief. An agent that does not stop is not respawned.

**Sharing.** What a profile shares with the primary is chosen per item (`settings.json`, `CLAUDE.md`, `skills`, `agents`, `commands`, `plugins`, `mcp`): `linked` (a symbolic link to the primary's; Claude Code writes through it), `copy` (copied once) or `own`. `mcp` is the `mcpServers` section of the profile's `.claude.json`, copied from the primary's and re-synced by `claude_sync` and before each spawn; it is never linked. The profile's `.claude.json` holds its own account and is never linked or copied whole. MCP server entries can hold third-party secrets, so a supervisor never publishes or journals them.

The `_system` journal (§4.6.3) records `claude_account_added`, `claude_signin_started`, `claude_signin_done`, `claude_signin_failed` and `claude_profile_synced`; a move is journaled in its wave.
---

## 5. Lifecycle states

Agents publish lifecycle state transitions on the `status` channel. The retained value at `volley/<ns>/<id>/status` always reflects the agent's current state.

### 5.1 State diagram

    spawning → registered → working → ( done | blocked | failed ) → reaped

### 5.2 State definitions

- **`spawning`** — agent process started; broker connection in progress. Published by the MCP/CLI on connect, before `vol_register` returns.
- **`registered`** — agent has called `vol_register`; registry entry exists at `_system/registry/<id>`.
- **`working`** — agent has begun task execution. First user-controlled state.
- **`done`** — agent completed its task successfully. Terminal state.
- **`blocked`** — agent cannot proceed without external input. Terminal state, but agent process MAY remain alive awaiting mailbox guidance.
- **`failed`** — agent encountered an unrecoverable error. Terminal state.
- **`reaped`** — agent's broker connection terminated (clean shutdown OR crash detected via LWT). Terminal state, published by the broker (via LWT) or by the agent itself.

### 5.3 Transition rules

- Transitions MUST be linear; agents MUST NOT publish a `working` after a terminal state in the same session.
- Because `status` is a retained channel (§4.1), all status publishes — including terminal states — are retained and visible to late-attaching observers.
- An agent MAY skip `working` if it terminates immediately after registering.
- An agent's LWT MUST be configured to publish `{type:"reaped", reason:"disconnect"}` so crash detection works without agent cooperation.

---

## 6. Registry (discovery)

Agents register themselves on a reserved retained topic so observers can enumerate the live agent set.

### 6.1 Topic

    volley/_system/registry/<agent_id>

### 6.2 Payload

```json
{
  "schema_version": "0.1",
  "agent_id": "issue-42-fix-7a3f",
  "namespace": "example-dispatch",
  "parent_id": "coordinator-abcd",
  "wall_time": "2026-05-14T02:11:23.000Z",
  "channel": "_system/registry",
  "type": "registered",
  "payload": {
    "capabilities": ["implements-issue", "writes-tests", "runs-mvn-verify"],
    "cwd": "/private/tmp/example-issue-42",
    "model": "claude-opus-4-7",
    "started_at": "2026-05-14T02:11:23.000Z"
  }
}
```

An agent a supervisor launched under a Claude account profile (§4.6.11) adds `claude_account` (the account id, or `primary`), from its assigned identity (§6.5).

### 6.3 Requirements

- Conforming agents MUST publish a registry entry retained, QoS 1, before publishing any channel other than the initial `spawning` status.
- The registry entry MUST be re-published on any change to `capabilities`, `cwd`, or `model`.
- When the LWT fires, the broker publishes `reaped` to the agent's `status` topic but does NOT clear the registry topic — that allows tools to inspect the agent's last-known state after death. Observers SHOULD filter out reaped agents in default views.

### 6.4 Enumeration

To enumerate all registered agents, subscribe to:

    volley/_system/registry/+

The broker delivers all retained registry entries; filter by namespace on the `payload.namespace` field.

### 6.5 Assigned identity

A supervisor that spawns an agent usually needs to know the agent's id *before* the agent registers (to wait on its status, address its mailbox, or render it). The §2.2 prefix + random-suffix mechanism makes that impossible, so a supervisor MAY pre-assign a literal id by writing `.volley/agent.json` into the agent's working directory before starting it (`spec/schemas/agent-identity.schema.json`):

```json
{
  "agent_id": "w1-t1-implementer-1",
  "namespace": "dispatch",
  "parent_id": "coordinator-ab12",
  "wave": "w1",
  "task": "T1",
  "role": "implementer",
  "broker_url": "mqtt://localhost:1883"
}
```

- Only `agent_id` is required. A conforming MCP server that finds this file in its working directory MUST use `agent_id` verbatim (no suffix) and MUST use `namespace`, `parent_id` and `broker_url` when present.
- Values in the file take precedence over the corresponding environment variables (`VOLLEY_AGENT_ID`, `VOLLEY_NAMESPACE`, `VOLLEY_PARENT_ID`, `VOLLEY_BROKER_URL`); keys absent from the file fall back to the environment, then to defaults.
- `agent_id`, `namespace` and `parent_id` MUST satisfy the §2 grammar. A server MUST refuse to start on an out-of-grammar `agent_id` (`INVALID_AGENT_ID`) or on a malformed file, naming the file path in the error, rather than fall back silently to a generated id.
- Uniqueness is the supervisor's responsibility. The RECOMMENDED form is `<wave>-<task>-<role>-<attempt>`, lowercased (e.g. `w1-t1-implementer-1`); a supervisor retry increments `<attempt>` so a dead agent's retained topics are never overwritten by its successor.
- An assigned identity is the one exception to §2.2's unique-id-per-process-start rule. A restart of the MCP server in the same working directory (a harness reconnect, a crash and restart) reuses the assigned id and starts a new session in the §5.3 sense; supervisors MUST tolerate a fresh `spawning` after a terminal status on an assigned id. The file pins one id to one working directory, so do not run two agent sessions there at once.
- Supervisors SHOULD keep the file out of commits by adding `.volley/` to the repository's `info/exclude` (`git rev-parse --git-path info/exclude`) when the working directory is a git worktree.
- `broker` (`{ "username", "password" }`, both strings) carries broker credentials minted for this agent by the supervisor, conventionally with `username` equal to `agent_id` so an ACL can pin the agent to its own topics (§11.5). Every client that runs with the identity (MCP server, CLI, hooks) MUST prefer it over `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD`. The file then holds a secret: supervisors SHOULD create it mode `0600` and revoke the credentials when the agent retires.
- `wave`, `task` and `role` are informational for tools that read the file (hooks, the supervisor itself); the MCP server does not interpret them.
- `claude_account` names the Claude account profile the supervisor launched the agent under (§4.6.11; `primary` for the default profile). A conforming MCP server that finds it copies it into its registry entry (§6.2).

---

## 7. Last Will and Testament

MQTT's Last Will and Testament (LWT) mechanism provides crash detection without agent cooperation.

### 7.1 Requirements

Conforming agents MUST configure an LWT on broker connect with:

- **Topic:** `volley/<ns>/<agent_id>/status`
- **Retain:** true
- **QoS:** 1
- **Payload:** a valid `status` envelope with `type: "reaped"` and `payload.reason: "disconnect"`

### 7.2 Behavior

When the broker observes the agent's TCP connection drop without a clean DISCONNECT (timeout, kill -9, network partition), it publishes the LWT message to the will topic. The retained `status` topic flips to `reaped`, and any observer subscribed to `volley/+/+/status` receives the transition.

### 7.3 Keep-alive

Agents SHOULD use an MQTT keepalive of 60 seconds (the default). Longer keepalives delay crash detection; shorter keepalives increase broker load.

### 7.4 Clean shutdown

On clean shutdown, agents MUST publish a terminal `status` (`done`, `blocked`, or `failed`) before calling MQTT DISCONNECT. A clean DISCONNECT suppresses the LWT.

---

## 8. Versioning

### 8.1 Semantic versioning

The Volley protocol follows semantic versioning on its `schema_version` field:

- **0.x** (pre-1.0): wire compatibility NOT guaranteed across minor versions. Tooling SHOULD pin to an exact minor.
- **1.0+**: wire format is frozen on the major. Breaking changes require a major bump (2.0, 3.0, ...).

### 8.2 Major version handling

Implementations MUST reject envelopes whose `schema_version` major version is unrecognized. The error code is `SCHEMA_VERSION_MISMATCH` (§9).

A v0.x implementation MAY refuse minor versions it does not recognize (e.g. v0.1 implementation refusing v0.2 messages). v1.0+ implementations MUST NOT refuse later minors of the same major.

### 8.3 Forward compatibility

Per §3.3, receivers MUST accept envelopes containing unknown fields and MUST NOT error on them. This permits adding new optional fields to the envelope or to per-channel payloads without a major version bump.

---

## 9. Error codes

Conforming implementations MUST return one of the following error codes on failure paths. Implementations MAY define additional codes under the `IMPL_*` prefix.

| Code | Meaning |
|---|---|
| `BROKER_DOWN` | Broker unreachable or refused connection. |
| `INVALID_TOPIC` | Topic does not match the grammar in §2. |
| `INVALID_AGENT_ID` | `agent_id` does not match the grammar in §2.2. |
| `TIMEOUT` | A blocking call (subscribe, query) exceeded its timeout without receiving messages. |
| `SCHEMA_VERSION_MISMATCH` | Envelope `schema_version` major version is unsupported. |
| `NOT_REGISTERED` | An operation requiring prior registration was attempted before `vol_register`. |
| `RESERVED_TOPIC_WRITE` | Attempt to publish to a reserved namespace from user space. |
| `AUTH_FAILED` | Broker refused the connection's credentials, or anonymous access (MQTT CONNACK 4/5, MQTT 5 reason 0x86/0x87). Distinct from `BROKER_DOWN` so a client can tell "fix your credentials" from "start your broker". |

---

## 10. Reserved tool names (forward compatibility)

Volley v0.1 ships these MCP tools (defined in detail in implementation docs):

`vol_register`, `vol_publish`, `vol_query`, `vol_subscribe`, `vol_list_agents`, `vol_tap`, `vol_send_mailbox`

The following tool names are **reserved** for v0.2+ async-subscription paths and MUST NOT be redefined by conforming v0.1 implementations:

- `vol_subscribe_async`
- `vol_recv`
- `vol_unsubscribe`

Adding these in v0.2+ MUST NOT break v0.1 sync clients.

---

## 11. Conformance

A conforming Volley implementation MUST satisfy all MUST-level requirements in this document. The following is a non-exhaustive summary cross-referencing earlier sections:

### 11.1 Conforming agents MUST

- Register on startup before publishing any channel other than the initial `spawning` status (§6.3)
- Publish a terminal `status` (`done` | `blocked` | `failed`) before clean exit (§5.3)
- Configure an MQTT LWT for crash detection (§7.1)
- Reject unknown `schema_version` major versions (§8.2)
- Use the QoS and retention values in §4.1 for reserved channels (§4.3)
- Match `agent_id` and `namespace` against the grammar in §2 (§2.2)

### 11.2 Conforming agents SHOULD

- Publish `progress` milestones at meaningful checkpoints (§4.3)
- Include `parent_id` if spawned by another Volley agent (§3.2)
- Use a 60-second MQTT keepalive unless deployment requirements dictate otherwise (§7.3)
- Publish a retained `result` before terminal `status` (§4.3)

### 11.3 Conforming agents MAY

- Subscribe to their own `mailbox` and respond to steering messages (§4.1). An agent that does MUST keep a persistent subscription or drain on a stable clientId, and SHOULD `ack` each message it receives (§4.4)
- Spawn sub-agents with `parent_id` set to their own `agent_id` (§3.2)
- Define user channels under `_user/*` (§4.2)

### 11.4 Conforming brokers MUST

- Be an MQTT v3.1.1 or v5 broker, or equivalent (transport-agnostic — see §1)
- Support retained messages, wildcard subscriptions (`+`, `#`), QoS 1, and LWT
- Support username/password authentication in CONNECT (it MAY also admit anonymous clients, §11.5)

The reference localhost deployment (non-normative) requires authentication on every listener (`examples/mosquitto-auth/`), because any local process and any web page (through a WebSocket listener) can reach a localhost broker.

### 11.5 Conforming brokers MAY

- Require username/password or mTLS authentication. Clients MUST honor `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD` when set, and the `broker` block of an assigned identity (§6.5), which takes precedence over them. A refused CONNECT is `AUTH_FAILED` (§9) and MUST NOT echo the password
- Enforce ACLs on reserved namespaces and per-agent channels. The reference ACL (`examples/mosquitto-auth/acl.conf`) lets a **per-agent** identity (username = agent id) write only its own channels and registry entry, lease requests, and the mailboxes of the senders it was minted to ack (§4.4); lets steering clients write any mailbox; treats the `coordinator` identity as operator-level (it may also write any agent's standard channels and registry entry, because a coordinator's agent id is random-suffixed); and keeps every topic §4.6 defines under `volley/_waves/*` (including `_waves/_config`) writable by the supervisor only. Because mosquitto's `+` also matches the `_waves` and `_system` levels, that protection covers the topics §4.6 defines, not arbitrary topics under those prefixes. A denied publish is dropped silently by MQTT 3.1.1 brokers, so a client cannot rely on a publish error to detect it

---

## 12. References

- [MQTT v5 specification (OASIS)](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/schema)
- [CloudEvents specification](https://github.com/cloudevents/spec) (analogous thin-spec-on-existing-transport pattern)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) (adjacent protocol; Volley is the inter-agent layer, MCP is the agent-to-tool layer)

---

*End of Volley v0.1 specification.*
