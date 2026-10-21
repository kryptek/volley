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

**Hook activity events (informative).** The `status` state machine (§5.3) is linear, so non-terminal attention states are not status types. A harness hook (e.g. a Claude Code hook running beside the agent) reports them on the `progress` channel instead, with `payload.source: "harness-hook"`, a per-agent monotonic `payload.seq`, and the `payload.hook_event` that fired. The documented types are `heartbeat` (the agent is alive and doing something), `idle` (the turn ended; `payload.text` carries the last assistant line, and `payload.completed: true` says the harness reported the task completed), `awaiting_input` (the harness is waiting on a human; `payload.text` / `payload.notification_type` carry the notification, `payload.screen_tail` MAY carry the last terminal lines, and `payload.class` says why the harness is waiting when it is not a question, e.g. `credit` for a provider usage limit that the harness resumes from on its own; `payload.background_wait: true` says the session ended its turn without a question while a background task it started is still running, so it is waiting on that task's events, not on a human: a dashboard SHOULD NOT present it as needing a person, and a supervisor SHOULD treat it as a wait on the agent's own work, not idleness (no "continue" nudge, no stall alarm, for a bounded time). `background_wait` MAY also be set on the `idle` that ended such a turn, and is never set on a `permission_prompt` or on an `awaiting_input` that carries a question the turn ended on), `resumed` (the agent is working again; it clears any earlier `awaiting_input`), `activity` (a work-log line: `payload.msg` is one line of at most 120 characters saying what the session just started, e.g. `Bash: gh pr checks 153` for a tool call with secrets redacted, or `prompt received` for a new prompt, whose text is never published; `payload.tool_calls` counts this session's tool calls so far (a new session, not a resumed or compacted one, starts again from zero); a hook publishes at most one per 5 s, and the newest line held back in a window is published at the next slot, so the last call of a burst is not lost; the `idle` that ends a turn carries `tool_calls` too), `picker_opened` (the harness put a question picker to its user, e.g. Claude Code's `AskUserQuestion`: `payload.tool_use_id` names the tool call and `payload.questions` is the tool input's `[{ question, header, options: [{ label, description }], multiSelect }]`, verbatim; a coordinator's also carries `session_url` / `workspace` when known), `picker_answered` (that picker was answered, wherever: `payload.tool_use_id` and `payload.answers`, the harness's question → answer map; several labels of a multi-select answer are joined with `, `) and `steering_applied` (reserved: a hook MAY publish it when it injects mailbox steering into the session; the reference hooks ack the mailbox message instead and do not publish it). For a coordinator session, `awaiting_input` additionally carries `payload.question` (what it is asking: the reference hooks send the question paragraph whole, or an excerpt of its end beyond 8192 characters; a supervisor's wave-state `coordinator.question`, §4.6.1, carries only its first one or two lines), `payload.session_url` and `payload.workspace` when known, so a dashboard can surface and link the waiting session; the coordinator's registry entry carries the same `session_url` / `workspace` when known, and `workspace_title`, the workspace's title in the terminal multiplexer, when the hook can read it. A registry entry whose `model_source` is one a hook sets (`harness-hook` or `unknown`; not `self-reported`) with no `parent_id` and no wave task is an interactive **session** rather than a dispatched agent: a dashboard SHOULD present it as one (its purpose from `workspace_title` and the basename of `cwd`; working or idle from these events, not from its `status`, which stays `working`). When the model itself has acted on a steering message it publishes `type: "steering_acked"` with `correlation_id` set to that mailbox message's id. A hook that re-publishes the registry entry with the harness-reported model sets `payload.model_source: "harness-hook"`, or `"unknown"` when the hook input carries no model. A registry entry without `model_source` (an agent's own `vol_register`, including the reference MCP server's auto-registration) carries a self-reported `model`, if any; the value `"self-reported"` is reserved for publishers that want to say so explicitly. The `type` field stays an open string; observers ignore progress types they do not recognise. A broker delivers one copy of a message per matching subscription, so an observer MAY treat byte-identical `progress` messages as one delivery; a publisher that can send the same content twice includes `seq` to keep them distinct. See `spec/schemas/progress.schema.json`.

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

**Acks.** A recipient acknowledges a message by publishing `type: "ack"` to the **sender's** mailbox (`volley/<ns>/<sender agent_id>/mailbox`) with `correlation_id` set to the acknowledged message id. `correlation_id` is REQUIRED on an `ack`. The payload SHOULD be `{ "text": "ACKED", "acked_type": "<type of the acknowledged message>" }`, plus `seq` when the acknowledged message carried one. A sender waiting for an ack MUST only accept one whose envelope `agent_id` is the recipient it addressed. An ack means *received*, not *obeyed*: acting on the message is reported through the agent's normal channels. Recipients MUST NOT ack an `ack`. A broker that enforces ACLs (§11.5) must let a recipient write each sender's mailbox for its ack to arrive: the reference roles (§4.6.13) let an agent login write the mailboxes of the fixed steering identities, `volleyd` and `desk`, and no other, with no per-agent grant; the broker silently drops any other ack. A coordinator session's agent id is random-suffixed (`coordinator-ab12`), which no static role can name, so an agent's ack to a coordinator is dropped and the coordinator's `wait_ack_ms` reports `acked: false`; steering that must be confirmed goes through the supervisor (whose mailbox every agent can ack) or the Desk.

**Delivery.** Because mailbox messages are not retained, the broker drops a message published while the recipient holds no subscription to its mailbox. An agent that honours its mailbox (§11.3) MUST therefore keep its mailbox subscription in a **persistent MQTT session** (a live subscription on a clean session still loses whatever arrives before it subscribes or while it reconnects): connect with `clean: false` (MQTT 3.1.1) or a non-zero session expiry interval (MQTT 5), with a stable clientId it owns exclusively, and subscribe at QoS 1. The broker then queues messages while the agent is offline and delivers them on its next connect. Two clients that connect with the same clientId kick each other off, so each persistent consumer of one agent (e.g. the MCP server and a hooks drain client) MUST use its own clientId, such as `volley-<agent_id>-mcp` vs `volley-<agent_id>-hooks`. A session expiry interval applies to new connections only: an existing persistent session keeps the expiry it was created with until the client reconnects. A sender that needs confirmation SHOULD wait for the `ack` rather than trust PUBACK, which only confirms receipt by the broker.

**No live recipient.** A supervisor asked to steer a task that has no live agent (its last agent retired, the next one not yet registered) MUST NOT publish to a retired agent's mailbox, which nobody drains; it SHOULD queue the message for the task's next agent, deliver it once that agent registers (with the id and `seq` it was queued with), and tell the sender it was queued rather than delivered.

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
| `volley/<ns>/<agent_id>/usage` | 1 | yes | `usage` / `usage` | `usage.schema.json` |
| `volley/_system/claude-accounts/<acct>` | 1 | yes | `_system/claude-accounts` / `claude_account` | `claude-account.schema.json` |
| `volley/_system/machines/<name>` | 1 | yes | `_system/machines` / `machine` | `machine.schema.json` |
| `volley/_system/machines/<name>/readiness` | 1 | yes | `_system/machines/readiness` / `readiness` | `readiness.schema.json` |
| `volley/_inbox/<id>` | 1 | yes, then cleared | `_inbox` / `inbox_item` \| `inbox_answered` | `inbox-item.schema.json` |

`_config` is not a valid wave id (wave ids start with `[a-z0-9]`), so the config topic cannot collide with a wave.

#### 4.6.1 Wave state

`volley/_waves/<wave>/state` holds the full current snapshot of one wave, re-published after every change. A late-attaching client needs nothing else to render the wave.

| Field | Type | Meaning |
|---|---|---|
| `wave` | string | Wave id. |
| `version` | integer ≥ 1 | Wave file version (bumped by a versioned re-submission). |
| `owner` | agent id \| null | Coordinator that owns the wave; `null` when orphaned. Either an agent id or a coordinator name (§6.2, in the same grammar): a name is bound to the newest live registry entry carrying it, and that agent acts for the owner (below). |
| `repo`, `release_branch` | string | Where the wave's PRs land. |
| `status` | enum | `running` \| `paused` \| `awaiting_decision` \| `releasing` \| `complete` \| `stopped`. `releasing`: every task is settled and the wave's release train runs (§4.6.19); the wave is `complete` once the owner answers `release_go` `go`. |
| `tasks[]` | object | `{ id, issue, stage, agents, waiting_on?, why_waiting?, host?, host_down?, placement?, base_sha?, pr?, evidence_path?, screen_stale?, queued_steers?, last_error?, attempt?, next_retry_at?, reviews_skipped_by_plan?, stage_label?, stage_group?, alarms?, remediation? }`. |
| `tasks[].stage` | enum (closed) | `queued` \| `implement` \| `spec_review` \| `quality_review` \| `fixup` \| `merge_ready` \| `done` \| `blocked` \| `awaiting_decision` \| `cancelled`. |
| `tasks[].agents` | object | Current agent id per role: `implementer?`, `spec_reviewer?`, `quality_reviewer?`, `fixup?`, `rebase?`. |
| `tasks[].waiting_on`, `why_waiting` | string[], string | What the task is blocked on, and a human-readable reason (e.g. `tunnel down to <target>` while a remote host's broker tunnel is down). |
| `tasks[].host` | string | The remote host the task's agents run on (its name from the wave file, the `hosts` tunable or placement, §4.6.15); absent for the supervisor's own host. Per task: every agent of a task runs on the same host. |
| `tasks[].host_down` | string | While the task's host is a paired machine that is down (§4.6.14): why (`disconnected`, `no heartbeat for 90 s`). Set on every unfinished task on that host, running ones included; absent otherwise. |
| `tasks[].placement` | object | Where the task was placed and why (§4.6.15): `{ host, by, score, decided_at, candidates[] }`, `by` being `auto` \| `wave_file` \| `decision` and `score` a number in 0..1 (`null` when the host was not scored). `candidates` lists every machine considered, best first, each `{ host, score, line }` (`score` `null` when not eligible); the supervisor writes every `line` (why the machine scored as it did, or why it was not eligible), and a client shows the lines and never computes its own. `host` is a machine name, so the supervisor's own machine appears under its `fleet.local_name` (§4.6.4) while `tasks[].host` stays absent for it. Absent until the task is placed. |
| `tasks[].base_sha` | string | The release-branch commit the task's current worktree was cut from (§4.6.15). |
| `tasks[].screen_stale` | boolean | `true` while the supervisor's screen capture for any of the task's agents is backed off (§4.6.6), so the retained `screen` topic may be out of date. Per task, not per agent; absent otherwise. |
| `tasks[].queued_steers` | integer | Steering messages held for the task's next agent because none was live when they were sent (§4.4); absent when none are held. |
| `tasks[].last_error`, `attempt`, `next_retry_at` | object, integer, date-time \| null | While a spawn of the task has failed and that role has not spawned since: `last_error` `{ code, message, at }`, `attempt` (failed attempts in a row) and `next_retry_at` (the supervisor's next automatic retry; `null` once it stopped retrying). Failures are counted per role (two roles of one step may fail at once); these fields show the most recent one. Absent otherwise. |
| `tasks[].pr` | object | `{ number, url, head_sha?, ci?, checks? }`; `ci` is `green` \| `red` \| `running` \| `none`. While the supervisor holds the task for CI on `head_sha`, `ci` is `running` and `checks` is `{ done, total }` (its CI runs completed, and all of them); `why_waiting` then reads e.g. `CI pending on <sha7> (2/5 checks)`. While it holds a red head for an infra incident (§4.6.16), `ci` is `red` and `why_waiting` reads `CI infra incident: <what>; re-checking`. |
| `tasks[].reviews_skipped_by_plan` | boolean | `true` once the task reached `merge_ready` without reviews because its wave-file pipeline lists no review stage (§4.6.8); absent otherwise. |
| `tasks[].stage_label`, `stage_group` | string, object[] | While a parallel stage group runs (e.g. both reviews at once): its label (e.g. `review (spec + quality)`) and one `{ role, agent_id?, state }` per role, `state` being `pending` \| `running` \| `done` \| `retired`. `stage` stays the group's first stage (the enum is unchanged). Absent otherwise. |
| `tasks[].alarms` | object[] | Alarms on the task that still hold, each `{ alarm, message }` with a human-readable `message` — e.g. `merged_unverified_head` (`merged with an unverified head: gated <sha7>, merged <sha7>`), whose message is also the task's `why_waiting`. Absent when none holds. |
| `tasks[].remediation` | object | `{ kind, test, since }`: a remediation requested for the task's red head that still holds (§4.6.16); `kind` is `fix_flake` (a failing test the PR does not touch, awaiting its dedicated fixer), and `why_waiting` reads `CI flake in <test>: fixer pending`. Gone once the head is verified, a new step starts, or the task is cancelled. |
| `open_decisions` | string[] | Ids of open decisions (§4.6.2). |
| `gates` | string[] | Task ids that are merge-ready and await a human merge. |
| `spec` | object | The submitted wave file: `{ version, release_branch?, model?, pipeline?, tasks: { <id>: { issue, title?, after[] } } }`; `pipeline` is an array of stage names where a nested array runs stages in parallel. |
| `coordinator` | object | `{ agent_id, state, question?, session_url?, workspace?, last_seen }`; `state` is `working` \| `awaiting_input` \| `reconnecting` \| `gone`, maintained by the supervisor from the owner's `status` and `progress` topics (§4.3). For a coordinator-name owner, `agent_id` is the agent bound to the name, and `reconnecting` means that agent's status turned terminal (or its LWT fired) less than `autopilot.reconnect_grace_s` ago (default 900) with no other agent bound since; then `gone`. |
| `effective_config` | object | The §4.6.4 tunables with this wave's overrides applied. |
| `brief_preface` | object \| null | `{ path, sha256, bytes }` of the brief preface the current plan version's agents get (§4.6.9), or `null` when the wave has none. Absent from a supervisor that predates it. |
| `repo_visibility` | enum \| null | `public` \| `private` \| `internal` \| `unknown`: the repository's visibility as read for the current plan version (§4.6.8), or `null` when `public_hygiene` is `on` or `off` and nothing was read. Absent from a supervisor that predates it. |
| `hygiene_level` | enum | `p1` \| `p3` \| `off`: how the review roles treat public hygiene for the current plan version (§4.6.8). Absent from a supervisor that predates it, which is read as `p1`. |
| `autopilot` | object | `{ enabled, auto_resolved, escalated, budgets }` (§4.6.16): whether autopilot is on for the wave (its effective `autopilot.enabled`), how many decisions the supervisor answered itself and how many it left for the owner, and each remediation budget it answered under, `{ <key>: { used, max } }`. Absent from a supervisor that predates it. |
| `merge_queue` | object[] | The merge queue (§4.6.17), in merge order: `{ task, state, since }` per queued task, `state` being `merging` (its merge is running) \| `updating` (it is being brought up to date with the release branch before its merge) \| `queued` \| `refused` (GitHub refused its last merge), `since` when it entered the queue. Absent while the queue is empty. |
| `release` | object | `{ stage, stages[] }` (§4.6.19), from `release_started` on: `stage` is the playbook stage running or awaiting its go (`null` when none is), and `stages` lists every stage in playbook order as `{ name, state }`, `state` being `pending` \| `awaiting_go` \| `running` \| `verified` \| `failed`. Absent for a wave without a release train. |
| `updated_at` | date-time | Time of the last change. |

**Coordinator names.** A wave's `owner` MAY be a coordinator name (§6.2) rather than an agent id, so the session that owns it keeps it across restarts of its MCP server (each of which gives it a new agent id). The supervisor binds the name to the newest registry entry whose `coordinator` is the name and whose status is not terminal. The bound agent may do whatever the owner may (resolve, pause, resume, stop, steer); any other agent id is refused, naming the owner. When a new agent binds to a name that owns waves, the supervisor journals `owner_reconnected { owner, agent_id, previous_agent_id }` in each of them and re-publishes their state; ownership does not change and nothing is claimed. A claim (`claim_after_s`) measures the name's newest binding, never an agent id the name has left, and a terminal status of the bound agent does not free the wave until `claim_after_s` passes: the session may reconnect.

#### 4.6.2 Decisions

A decision is a question only a human (or the owning coordinator) can answer. It is published retained to `volley/_waves/<wave>/decisions/<decision_id>` while open, MAY be re-published once with `type: "decision_resolved"` and `resolved` set, and is then cleared.

| Field | Type | Meaning |
|---|---|---|
| `decision_id`, `wave` | string | Identity. |
| `task` | task id \| null | `null` for a wave-level decision. |
| `kind` | enum (closed) | `reviewers_disagree` \| `merge_conflict` \| `agent_blocked` \| `agent_question` \| `agent_stalled` \| `unknown_screen` \| `hooks_auth_failed` \| `mcp_not_registered` \| `spawn_failed` \| `model_switch` \| `repo_untrusted` \| `remote_repo_missing` \| `ci_failed` \| `wave_complete` \| `plan_change` \| `pr_closed` \| `pr_head_moved` \| `spawn_budget_exhausted` \| `account_limit` \| `machine_down` \| `merge_refused` (§4.6.17) \| `release_go` \| `stage_go` (§4.6.19). A `repo_untrusted` or `remote_repo_missing` decision carries `repo` (the repo path it is about) and, for a remote host, `host` and `target` (the ssh destination; `repo` is then a path on it); a `repo_untrusted` one is answered on that host (its own folder trust), never the supervisor's. A `plan_change` decision carries `change`: `removed` (the new wave version dropped the task) \| `issue` (it moved the task to another issue). A `pr_closed` decision asks about a gated PR closed without a merge whose head the release branch does not carry (`landed` \| `abandoned`); a `pr_head_moved` decision asks about a PR head that moved after a gate (`rereview` \| `fixup` \| `accept` \| `cancel`; `accept` is offered only when CI on the new head is green and the move is a merge of the release branch only: the new head is a merge commit whose parents are the old head and a commit on the release branch, and every file the move changed is one the release branch changed since the PR branched from it); a `ci_failed` decision about CI red on the head a pipeline role pushed offers `fixup` (a fixup agent at that head, the CI result as its only directive) \| `re-verify` \| `cancel` and carries `failed_jobs`, `failing_tests` and `log` (the tail of the failed runs' logs); an `agent_stalled` decision offers `nudge again` \| `respawn` (the stalled agent is stopped and its role spawned again; an implementer continues its pushed branch; offered only where the supervisor can spawn the role) \| `stop task`; a `spawn_budget_exhausted` decision asks about a spawn the wave's spawn budget holds (`raise by <n>` \| `cancel`). A `merge_conflict` decision (§4.6.17) asks about a task the merge queue could not bring up to date with the release branch (`respawn` \| `manual` \| `cancel`). An `account_limit` decision (§4.6.12) carries `acct`, `pct`, `resets_at` and `suggested`. A `machine_down` decision (§4.6.15) is wave-level and carries `host`, `down_since`, `tasks` (the wave's unfinished tasks on that host) and optionally `machine` (`down`, the default, \| `draining` \| `removing` \| `removed`), with the options `wait`, `re-place queued tasks` and `cancel` (no `wait` for `removing` and `removed`). A `release_go` decision (§4.6.19) is wave-level, offers `go` and `hold`, and carries `stages` (each playbook stage as `{ name, evidence? }`, `evidence` being where its evidence lives); a `stage_go` decision is wave-level, offers `go` and `hold`, and carries `stage` (the owner-gated stage it asks about). A decision that offers `respawn` for an agent whose host is down or not eligible (§4.6.15) also offers `respawn on <best>`, `<best>` being the best eligible machine when it opened; on a host closed to new agents it offers `respawn on <best>` instead of `respawn`. |
| `question` | string | What needs answering. |
| `options` | string[] | Suggested answers (optional; free text is always allowed). |
| `pointers` | object | `{ diff?, transcript?, screen?, pr? }` — where the evidence lives. |
| `opened_at` | date-time | |
| `resolved` | object | `{ answer, by, at }`; required when `type` is `decision_resolved`. |

#### 4.6.3 Wave events

`volley/_waves/<wave>/events` is a non-retained live mirror of the supervisor's per-wave journal; the journal (not the broker) is the record, and consumers that need every event read it through the supervisor. The envelope `type` is the event type, from a closed enum in `wave-event.schema.json` (`wave_submitted`, `task_queued`, `agent_spawned`, `spawn_failed`, `spawn_recovered`, `stage_entered`, `decision_opened`, `lease_granted`, `steering_sent`, `steering_queued`, `steering_dropped`, `config_changed`, …). `payload` is `{ wave, seq, at, task?, data? }`, where `seq` is monotonic per wave and `data` is event-specific. Global events use the pseudo-wave `_system`. The schema fixes `data` for the Fleet events (§4.6.15): `task_placed { task, host, score, candidates, by, from?, local? }` (`local: true` marks the supervisor's own machine, whose agents' `tasks[].host` stays absent, so a replay needs no config and survives a `fleet.local_name` rename), `machine_readiness_changed { name, ready, reasons }` (in `_system`) and `merge_nudge_sent { task, agent_id, merged_pr, files }` and `owner_reconnected { owner, agent_id, previous_agent_id }` (§4.6.1). It also fixes `data` for autopilot's two events (§4.6.16): `decision_auto_resolved { decision_id, kind, policy, answer, rationale, evidence, budget? }` and `decision_escalated { decision_id, kind, why, budget? }`, `budget` being `{ key, used, max }`, and the needs-you inbox's answer (§4.6.18): `inbox_answered { id, kind, answer, by, where, version }`, and self-healing CI's request (§4.6.16): `remediation_requested { kind, test, test_file, head, run_urls, for, tests?, role?, release_ci? }`. The release train's events (§4.6.19) carry `release_started { done, cancelled, playbook: { path, sha256, stages } }`, `release_stage_entered { stage }`, `release_stage_verified { stage, evidence? }`, `release_stage_failed { stage, reason? }` and `release_done { by, decision_id }`. Every other event's `data` is free-form.

#### 4.6.4 Supervisor config

`volley/_waves/_config` holds the supervisor's current *effective* global config: every runtime tunable plus `version` (monotonic), `updated_at` and `updated_by`. The tunable model is `config.schema.json#/$defs/tunables` — every key has `minimum`/`maximum` (or length) bounds so a UI can render and validate it without hard-coding limits:

`hard_ceiling`, `spawn_budget_multiplier`, `lease_pools: { <pool>: { capacity, per_machine?, per_machine_overrides?, ttl_s?, match[]? } }`, `admission: { memory_pressure_max_level, cmux_ping_max_ms, container_max, api_overload_window_s, api_overload_max, ci_queue_max, hysteresis_samples }`, `claim_after_s`, `heartbeat_alarm_s`, `idle_grace_s`, `background_wait_max_s` (default 7200: how long an idle agent's own work, its `background_wait`, §4.3, or other evidence, holds off the idle nudge), `stall_backoff_max_s` (default 1800: the cap on the doubling gap between stall decisions of one idle), `fallback_model` (string \| null), `mailbox: { session_expiry_s }`, `worktree_root`, `spawn_timeout_s`, `spawn_retry_max_s`, `spawn_retry_max`, `brief_preface_max_bytes`, `wake_grace_s`, `screen_tail_interval_s`, `stop_grace_s`, `dynsec_batch_ms`, `credential_sweep_interval_s` (§4.6.13), `claude: { default_account, warn_at_pct }` (`default_account`, string \| null: the Claude account an agent runs under when its task and wave name none, §4.6.11; `warn_at_pct`, default 90: the 5-hour usage that opens an `account_limit` decision, §4.6.12), `branch_update` (`rebase` \| `merge`, default `rebase`: below), `agent_mcp` (`strict` \| `inherit`, default `strict`: below), `public_hygiene` (`auto` \| `on` \| `off`, default `auto`: what review roles flag as public hygiene, §4.6.8), `retire_close_session` (boolean, default `true`: retiring an agent also ends its session, below), `hosts: { <name>: { type?, target, repo, worktree_root?, volley_dir, tunnel?: { remote_port, supervise }, max_agents?, drain? } }` (remote SSH + tmux hosts a wave task names with `host:`, or placement chooses; `<name>` is never `local` or `auto`), and the Fleet tunables of §4.6.15: `require_fresh_base` (boolean, default `true`), `placement: { load_per_core_max, mem_available_min_pct, disk_free_min_gb, down_decision_after_s, weights: { cpu, slots, mem, usage }, nudge_on_merge }` and `fleet: { local_name, local_agents, fallback: { max_agents, per_machine } }`, and autopilot's (§4.6.16): `autopilot: { enabled, owner_only[], relaunch_max, nudge_max, respawn_max, rereview_max, ci_fixup_max, question_max, budget_raise_max, inbox_answered_ttl_s }` (`inbox_answered_ttl_s`, default 600: how long an answered needs-you inbox item stays retained, §4.6.18), and autopilot merging's (§4.6.17): `autopilot: { merge, merge_retry_max, delete_branch }` (`delete_branch`, default `false`: a merge also deletes the PR's head branch), and `autopilot: { reconnect_grace_s }` (default 900, 60..86400: how long a coordinator name's waves read `reconnecting`, §4.6.1), and `autopilot: { incident_wait_max_s }` (default 14400, 60..86400: how long a red head classified as an infra incident is held before its `ci_failed` decision, §4.6.16). A boolean has no bounds; an enum (`nudge_on_merge`) is bounded by its values.

**Branch updates and agent MCP servers.** `branch_update` is how a supervisor's pipeline brings a PR branch up to date when the release branch moved before the gate. Under `rebase` the agent rebases onto the release branch and publishes with a lease-guarded force-push. Under `merge` it merges the release branch into the PR branch and publishes with a normal push: the supervisor MUST NOT instruct any force-push, and accepts the new head only if it descends from the head the update started at. The mode is fixed when the update starts (a supervisor records it with the step), so a change applies to later updates only. `agent_mcp` is which MCP servers a supervisor-launched agent loads. Under `strict` it loads only the supervisor's own Volley server. Under `inherit` it also loads the user's own servers (plugins, connectors). The supervisor MUST name its own Volley server `volley`, so that it takes over a user-scope entry of the same name (such as a coordinator's), and every Volley server in the session carries the agent's identity from `.volley/agent.json` (§6.5), never a coordinator's. A user entry under another name that runs a Volley server still starts, a second Volley server in the session: at spawn under `inherit` the supervisor SHOULD warn (journal and log) when the profile's `~/.claude.json` `mcpServers` or the worktree's `.mcp.json` has such an entry. `strict` gives a minimal, reproducible agent; `inherit` gives it more tools, at the cost of depending on the machine it runs on.

**Ending a retired agent's session.** When a supervisor retires an agent it first writes `<worktree>/.volley/retired.json` = `{ "agent_id", "status", "at" }` beside the agent's `agent.json` (§6.5), then deletes its login (§4.6.13). An agent's hooks that find a marker naming their own `agent_id` SHOULD end quietly (exit 0, nothing printed, no broker connection): the refused login is the intended outcome, not an auth failure. A marker naming another `agent_id` (a reused worktree) is ignored. With `retire_close_session` on, the supervisor then ends the agent's session: it closes its workspace (bounded by a timeout) and, on its own machine, stops the agent's `claude` process (SIGTERM, a grace, SIGKILL), journaling `agent_session_closed { agent_id, workspace, how, pids }` before `agent_retired` (`how`: `close-workspace`, `kill-session`, `signal` when only a process was stopped, or `none`). Off, finished sessions stay open for inspection.

Per-wave overrides use the same shape with every key optional (a wave file's `config:` block) and appear in the wave state as `effective_config`. The exception is `lease_pools`: pools are machine-global (§4.6.5), so a supervisor rejects a wave file that overrides them rather than accept an override it cannot apply.

**Changing config.** A client sends a mailbox message (§4.4) to the supervisor with `type: "query"`, a fresh `correlation_id`, and `payload: { op: "config_set", patch, by, text }`, where `patch` is a partial tunables object (`config-set-request.schema.json`). Senders MUST include `text` (a one-line human summary), so the request is also a well-formed mailbox message (`mailbox.schema.json`), and MUST set a non-null `correlation_id` so they can match the acknowledgement. The supervisor answers with a mailbox acknowledgement correlated to the request carrying `{ applied, rejected: [{ path, reason }] }`; a patch with an unknown key or an out-of-bounds value is rejected as a whole. On success the supervisor re-publishes the retained `_config` topic with `version` incremented.

#### 4.6.5 Leases

Heavy operations (integration test suites, builds, browsers) are gated by machine-global lease pools. `volley/_system/leases/<pool>` holds the retained pool state `{ pool, capacity, per_machine?, held: [{ lease_id, holder, host?, since, ttl_s }], queue: [{ lease_id, holder, host?, since }], reasons[] }`; `queue` is FIFO and `reasons` explains the queue in human terms (e.g. `"queued: 3/3 backend-it leases held"`). `host` is the machine the holder runs on (§4.6.15: a host name, the supervisor's own machine under its `fleet.local_name`), or `null` for a holder the supervisor did not spawn (a hand-run agent, whose machine it does not know); a supervisor that predates it omits it. A pool whose config sets `per_machine` (1 to `capacity`; unset means `capacity`) also caps the leases that holders on one machine hold at once, and publishes it in the pool state: a grant needs a free slot under both caps (a `null`-host holder counts toward `capacity` only), the supervisor grants the earliest queued request that both caps admit (so a request its own machine's cap holds back does not block one from another machine), and the `reasons` line for a held-back request names the cap that holds it (e.g. `"queued l-004: 1/1 backend-it leases held on box-a (per machine)"`). A pool's `per_machine_overrides: { <machine>: n }` (0 to 64, at most `capacity`, which the supervisor checks on `config_set` and at load, naming the path: `lease_pools.js-suite.per_machine_overrides.box-a: 5 is over capacity 3`) caps a named machine's holders in place of `per_machine`, so a laptop and a large server can take different shares of one pool; 0 lets no holder on that machine hold one. `<machine>` is a `hosts.<name>` key, the supervisor's `fleet.local_name`, or `local`, an alias for the supervisor's own machine that the effective config resolves to its name (when the name is set too, it is the one in force). An override alone (no `per_machine`) caps only the machine it names. The pool state carries `per_machine_overrides` when the config sets any, so a client shows the cap in force on each machine (`on box-a 2/3, on laptop 1/1`). Agents ask on `volley/_system/leases/<pool>/requests` with `payload: { op: "acquire" | "release" | "renew", lease_id, holder, ttl_s? }` (the one user-space publish §2.4 allows under a reserved prefix); the supervisor answers by re-publishing the pool state, and expires leases on TTL or when the holder's `status` turns terminal. The supervisor ignores a request whose `holder` differs from the envelope `agent_id`, so an agent can only acquire, renew or release its own leases. Requests are not retained, so one sent while the supervisor is down is lost: an agent that does not see its `lease_id` in `held` or `queue` within 30 seconds SHOULD re-send `acquire`, and the supervisor treats a repeated `acquire` for a `lease_id` it already holds or queues as a no-op. When a pool is removed from config, the supervisor keeps its holders (nothing is preempted) but drops its queued requests, adding `rejected <lease_id>: <why>` to the pool's `reasons` (or clearing the topic once the pool is empty); a client whose queued `lease_id` leaves the pool state without a grant SHOULD treat the request as rejected.

#### 4.6.6 Screen channel

`screen` is a reserved per-agent channel in addition to those in §4.1: QoS 0, **retained**, published by a supervisor *on the agent's behalf* (the envelope `agent_id` is the supervisor; the topic's `<agent_id>` segment names the agent). `payload: { lines (≤ 40 strings), captured_at, workspace, hash, source }` is the tail of the agent's terminal (`source` is the capture mechanism, a closed enum: `cmux` for the supervisor's own host, `tmux` for a remote SSH + tmux host); publishers SHOULD skip captures whose `hash` is unchanged. The supervisor clears the topic when the agent is retired. A supervisor whose capture is slow or failing SHOULD back off and set `tasks[].screen_stale` in the wave state (§4.6.1) until a capture succeeds in time. Agents MUST NOT publish their own `screen` channel.

#### 4.6.7 Spawn admission

A supervisor throttles *starts* (never running work) by measured machine load. `volley/_system/admission` holds its latest verdict, re-published after every pressure sample: `{ sampled_at, allow, throttled, reasons[], signals, waves? }`, where `allow` is how many more agents may start now (`null`: pressure sets no limit; the hard ceiling and per-wave spawn budget still apply), `reasons` has one human-readable line per signal holding starts back (e.g. `"memory pressure critical (level 4 > max 2)"`), and `signals.<name>` is `{ state, value?, max?, clean_samples?, error? }` for `memory_pressure`, `cmux_ping`, `containers`, `api_overload` and `ci_queue`, with `state` one of `clear` \| `over` \| `recovering` \| `unknown`. Thresholds and the hysteresis sample count are the §4.6.4 `admission.*` tunables: a signal over its threshold sets `allow` to 0, and must then be clear for `hysteresis_samples` consecutive samples (`recovering`) before the allowance rises again; a signal that cannot be measured is `unknown` and never trips; on a signal already tripped, an unmeasurable sample counts toward its clean samples (so a measurement tool that breaks cannot hold starts back forever), and the signal reports `recovering` with `clean_samples` and the `error` until the count is reached. A supervisor admits nothing before its first sample. `waves.<wave>` is the same verdict with that wave's overrides and its repository's CI queue applied; the supervisor also copies those reasons into `why_waiting` of the wave's ready-but-unstarted tasks (§4.6.1). This verdict is the supervisor's own machine plus the global signals (`api_overload`, `ci_queue`). In a wave that places its tasks (§4.6.15), a task placed on a peer is admitted instead by that peer's own signals, read from its machine record at each new heartbeat (a record whose `last_seen` is not newer is the same heartbeat and is not counted again): memory available under `placement.mem_available_min_pct` or load per core (the higher of the 1- and 5-minute load averages) over `placement.load_per_core_max` (the wave's effective values) holds starts there, with the same `hysteresis_samples`, plus the global signals; its reasons name the host (`"box-a: load 2.00 per core (max 1.5)"`). So in such a wave agents may start on peers while `allow` is 0 for a signal of the supervisor's own machine (its memory pressure, cmux ping or containers); a peer's hysteresis shows in its readiness verdict instead (§4.6.15).

#### 4.6.8 Pipeline results and the merge-ready gate

A supervisor that reviews work before a human merges it MAY ask its review roles for a structured retained `result` (§4.1) published before their terminal `done`: `type: "review"` with `payload: { findings: [{ severity, file, line?, text }], verdict }`, where `severity` is `P1` (blocks the merge) \| `P2` \| `P3` and `verdict` is `approve` \| `changes_requested`, and `hygiene: { checked: true, findings: [...] }` — the reviewer's check of the diff, commit messages and PR text for person names, local usernames, machine paths, private hostnames or IPs. When the supervisor's `public_hygiene` setting (§4.6.4) resolves to public — `on`, or `auto` for a public repository or one whose visibility the supervisor could not read — the block is required and each hit is a `P1` finding (a review without `hygiene.checked` is not a review result); for a private repository a supervisor MAY ask for the check at `P3` (the block optional, hits never blocking the merge) or not at all (`off`). A supervisor that reads the visibility SHOULD do so once per wave version, journal it (`repo_visibility_detected`) and show it on the wave state (`repo_visibility`, `hygiene_level`). A fix-up role publishes `type: "fixup"` with `payload: { resolved: [{ finding, how }] }`; both result types are in `review-result.schema.json`. A supervisor SHOULD treat an agent's `done` as a claim and verify it (pushed head, the PR for exactly that head branch, CI on exactly that head) before acting on it, and SHOULD re-check that the PR is still at the verified head before gating it. CI on exactly that head means the latest run per workflow and trigger event: a run superseded by a newer run of the same workflow for the same head is not that head's CI; a task whose claims are verified enters stage `merge_ready`, is listed in `gates`, and carries `evidence_path`, a supervisor-local file describing that head. The supervisor does not merge unless §4.6.17 autopilot merging is on for the wave; then it merges only a gated head, exactly that head, and journals it. Otherwise a task becomes `done` only when the supervisor observes that a human merged its PR. It SHOULD look for that merge in every stage short of `done` and `cancelled` while the task has a PR, not only at `merge_ready`; a merge it observes before the gate, or at a head other than the gated one, is recorded as such (`merged_unverified_head`). Before the task becomes `done` the supervisor resolves the task's open decisions as `superseded_by_merge`.

A supervisor that runs review roles MUST NOT move a task to `merge_ready` unless every review role in that task's pipeline has a recorded review with a verdict that holds for the head being gated: a review of that head, or of a head it descends from only through fix-ups that ran after that review, branch updates from the release branch (a rebase onto it or, under `branch_update: merge`, a merge of it, §4.6.4), and heads pushed outside the pipeline that the owner explicitly accepted without a re-review (a `pr_head_moved` decision answered `fixup`, or answered `accept` for a merge of the release branch only, §4.6.2), each such acceptance recorded, with who gave it, in the gated head's evidence. Any other push to the PR after a review voids that review. A pipeline without review stages is honoured only when the wave file lists it explicitly; the supervisor then sets `tasks[].reviews_skipped_by_plan` (§4.6.1).

#### 4.6.9 Brief preface

A supervisor that writes briefs for the agents it spawns SHOULD let a repository set rules every one of them gets. The **brief preface** is a file — `<repo>/.volley/brief-preface.md` by default, or the path in the wave file's `brief_preface` key (relative to `repo`, or absolute) — whose bytes the supervisor puts verbatim (no placeholder expansion) at the top of every brief it writes for that wave, for every role, above the role's own text and separated from it by a rule. The file MUST be UTF-8; a supervisor refuses one that is not, rather than alter its bytes. A blank file (only whitespace) counts as no preface. A supervisor bounds its size (`brief_preface_max_bytes`, §4.6.4) and refuses a wave whose preface is larger. The wave state's `brief_preface` (§4.6.1) is `{ path, sha256, bytes }` of the file as read for the current plan version (`sha256` over its bytes), or `null` when there is none, so a client can show which rules the agents got.

#### 4.6.10 Accounts and one-time tokens

A deployment with broker authentication keeps **accounts**: broker logins with a **role** that selects the shared broker roles they hold (§4.6.13). `admin` may do everything a coordinator may, plus the account ops below; `steer` reads everything and writes mailboxes (steering, control requests) and lease requests; `watch` adds no writes of its own; `supervisor` (a volleyd) reads and writes everything except the account-op and answer topics below (its role denies publishing to `volley/_system/auth/ops/#` and `volley/_system/auth/replies/#`, so it can neither impersonate an admin nor forge an answer); `peer` (a paired machine) writes its own agent channels and its machine record `volley/_system/machines/<username>`, which is exactly what the shared `account` role grants, so it adds nothing beyond it. Every account holds that `account` role (read `volley/#`; write its own channels and registry entry, lease requests and its own machine record `volley/_system/machines/<username>`, the record topic only: never a topic under it, such as the readiness verdict of §4.6.15), so even a `watch` account may write its own identity's records. Agent logins minted for dispatched agents are not accounts. The registry is a file kept by the account tool (`account.schema.json`: `{ name, role, kind, created, label? }`); it never holds a password. `account_list` adds `last_seen`: the newest of the account's retained registry entry, its retained `status` (where its LWT lands) and its last auth request to this supervisor process. Auth requests are kept only in that process's memory, so the `result` also carries `seen_since`, when the process started: a `last_seen` before it, or none, says nothing about the time since. A client that flags idle accounts SHOULD measure idleness from the later of `last_seen` (else `created`) and `seen_since`.

**Account ops.** An admin sends `payload: { op, ... }` (`auth-request.schema.json`) in an envelope with `channel: "_system/auth"`, `type: "query"` and a fresh `correlation_id` to `volley/_system/auth/ops/<username>`, where `<username>` is its own broker username. The broker ACL grants that topic only to admin accounts and only for their own username, so the topic names the sender; the supervisor MUST also check that the named account has the `admin` role and refuse any other sender with a reason. The mailbox is not used for these ops: anyone who may steer may write the supervisor's mailbox, so it cannot name the sender. Requests MUST NOT be retained; the supervisor clears a request topic's retained message so it is never replayed. Ops: `account_list`; `account_create { name, role, kind? }`; `account_rotate { name }` (refused for the sender's own account: setting a new password disconnects the client holding the old one before the answer arrives, so an admin rotates itself from a terminal or through another admin); `account_revoke { name }`; `signin_link { role, label, ttl_s?, desk_url? }`, where `role` is `steer` or `watch`; with `desk_url` its `result` carries `link_base` (the URL without a fragment) and the client builds the link `<link_base>#signin=<token>`. A supervisor journals each successful op in the `_system` journal (§4.6.3: `account_created`, `account_rotated`, `account_revoked`, `signin_link_issued`, each with `by`; `at` is the event's) and never writes a password itself: the account tool does.

**Setup ops.** The same topic, admin check and answers carry the setup ops, which run the account tool's own first-run setup (`volley setup`: the steps `detect`, `security`, `accounts`, `services`, `phone`, in that order) for a client such as the Desk; the supervisor runs the same planners and steps, never a second implementation. `setup_plan { lan?, repair? }` plans every step fresh (never cached) and answers `result: { steps: [{ step, title, found, notes?, changes: [{ summary, detail?, terminal? }], blocked?, skipped?, plan_id, lan? }], last_setup?, broker? }` (`setup-result.schema.json`, `$defs/plan`): what each step found, what the supervisor notes but cannot check itself (`notes`, such as the macOS keychain, which only the logged-in session reads: neither a check that passed nor a change), the changes it would make, why it cannot run (`blocked`, which also stops every later step) or is left out (`skipped`), and `plan_id`, which names that plan of the step (a digest of its changes). `lan` feeds the security step's plan exactly as the terminal's `--lan` / `--no-lan` (omitted: what the broker config has), and that step reports the choice it planned for as `lan: { planned, current }`, `current` being what the config has now (`null` when it is not Volley's), so the plan a client shows is the plan it applies. `repair` is `--repair`: no new admin token, no phone link. `broker: { accounts_required, listeners: [{ port, anonymous }] }` carries the detect step's probes as data (`anonymous` is `refused`, `accepted` or `unreachable`), so a client never parses `found`, which is display text. `setup_apply { step, plan_id, lan?, repair?, reply_key }` plans that step again and applies it only when the fresh plan's `plan_id` is the one sent, else refuses with an error that starts with `plan changed` before anything changes; it also refuses while an earlier step is `blocked` or another `setup_apply` runs. It answers `result: { step, lines, problems, terminal?, restarting? }` (`$defs/applied`): what each change reported and what the step's checks found afterwards. A change only a terminal can make (one that needs `sudo`, or that would stop the supervisor answering) carries `terminal: { reason, command }` in the plan and is never applied by `setup_apply`, which applies the step's other changes and lists the rest in `terminal`. A broker restart is applied last, after the answer is published, which says so with `restarting: true`; the restart drops every client's connection, an answer is not retained, so a client re-plans once it has reconnected rather than assuming the step failed. Over this topic the accounts step's one-time admin token is in `sealed: { token }` only, never in `result`, a log or the journal; the phone step's link is not made by `setup_apply` (a client asks `signin_link`). `admin_token { reply_key }` issues a one-time admin token to an admin: `result: { token_id, expires_at }`, the token in `sealed: { token }`. Sealing it to an admin adds no privilege (an admin may already create an admin account). Over this topic a new identity's password is never shown: the supervisor's and the coordinator's go to their credential files, and the shared `desk` login (which no file keeps) gets one only through `desk_password { reply_key }`, which gives it a new password and answers `result: { username: "desk" }` with `sealed: { username, password }`; it signs out whatever used the old one. The `_system` journal records `setup_step_applied { by, step, summaries }` for a `setup_apply` that applied (or, for a restart, scheduled) at least one change, `admin_token_issued { by, token_id, expires_at }`, never the token, and `desk_password_issued { by }`, never the password. A supervisor that does not implement an op answers `unknown op '<op>'`.

**One-time tokens.** An operator's terminal prints a single-use token (`vly_admin_<id>_<secret>`, by default valid 10 minutes), or an admin asks for one with `admin_token` and receives it sealed; `signin_link` yields a `vly_signin_<id>_<secret>` token for one device (a Desk link carries it as `<desk_url>#signin=<token>`). Only a hash of each token is stored. A token is also the password of a short-lived broker login whose username is the token id `<id>`, so the broker can keep refusing anonymous clients. That login holds only the `token` role (§4.6.13), which grants exactly two things through `%u`: write its own request topic `volley-auth/redeem/<id>` and read its own answer topic `volley-auth/redeem/<id>/reply`. It cannot read anything under `volley/` (the broker refuses the subscription), nor another token's topics. These two topics are the one exception to the `volley/` root, so that no grant any other role holds under `volley/` reaches them. Only the supervisor reads the request topics and writes the answer topics. The login is removed once the token has expired, or about a minute after it was redeemed, by the account tool's next run; the supervisor runs it periodically (`token_prune_ms`) so an unused token stops being a login soon after it expires. The client publishes `payload: { op: "token_redeem", token, label, reply_key }` on its request topic; the supervisor refuses a token whose id is not the topic's, burns the token and creates an account with the token's role (`admin` for an admin token) bound to `label`, journaled as `token_redeemed`. Redemption does not remove the token's login at once: deleting a login disconnects the client using it, and the redeeming client is still connected as that login, waiting for its answer. A used, expired or unknown token is refused. There is no other way to obtain an admin account from a browser.

**Answers.** The supervisor answers an account op on `volley/_system/auth/replies/<correlation_id>` and a `token_redeem` on `volley-auth/redeem/<id>/reply` (QoS 1, not retained) with `type: "ack"`, the request's `correlation_id`, and `payload: { text: "ACKED", acked_type: "query", op, ok, error?, result?, sealed? }`. Every account may read the account-op answer topics, so a secret (a password, a sign-in token and link) MUST NOT appear in clear text: it is in `sealed`, the base64url RSA-OAEP (SHA-256) encryption of `{ username, password }` or `{ token }` to the request's `reply_key`, an RSA public JWK of at least 2048 bits whose private half only the requester holds. A request whose answer would carry a secret and that has no usable `reply_key` is refused before anything is created. Clients MUST accept an answer only from `agent_id: "volleyd"` (§4.4); the broker ACL lets no account but the fixed `volleyd` identity write the answer topics.

**Owner decisions (2026-10-18).** The redemption path uses per-token broker logins, not an anonymous redeem topic; account ops use the dedicated `volley/_system/auth/ops/<username>` topic, not the supervisor's mailbox; every request whose answer carries a secret MUST carry `reply_key`; a token login reaches only its own two topics.


#### 4.6.11 Claude account profiles

A supervisor that launches Claude Code agents MAY run them under several Claude accounts. Each account is a separate Claude Code profile: its own configuration directory, passed to the agent as `CLAUDE_CONFIG_DIR` (one canonical absolute path with no trailing slash; Claude Code keys the profile's login to that exact string). `primary` names the user's own default profile (no `CLAUDE_CONFIG_DIR`). A profile is signed in only through Claude Code's own sign-in flow. A supervisor MUST NOT read, store, log, parse, forward or otherwise handle a Claude credential, session token or authorization code: it never reads a profile's credential store, never uses a flow that prints a bearer token, never sets a credential variable in an agent's environment, and never offers a field that would pass a code to the sign-in process. A supervisor MAY open a fenced, transient ssh port forward that carries the browser's redirect to Claude Code's own loopback listener on the machine signing in: the forward is an opaque encrypted pipe (like the broker tunnel), is bound to that one sign-in's port and target, and is torn down when the sign-in ends or times out. (The credential variables are `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`.)

**Selection.** An agent runs under its task's `account` (wave file), else the wave's `account`, else the `claude.default_account` tunable (§4.6.4), else `primary`. `most_headroom` asks the supervisor for the account with the most usage left (§4.6.12); a supervisor without usage data resolves it to `primary`. A spawn under an unknown account, or one whose sign-in has not finished, is refused with a reason. The agent's `.volley/agent.json` and its registry entry carry `claude_account` (§6.2, §6.5). Folder trust is per profile, so a `repo_untrusted` decision (§4.6.2) for such an agent carries `claude_config_dir` and is answered in that profile.

**Sign-in.** `claude_account_add { label, machine?, by }` creates the profile and starts Claude Code's sign-in for it in the background; `claude_signin { acct }` restarts it for an existing profile. The supervisor publishes the authorize URL Claude Code produced, as `claude_signin_url { acct, url, flow, attach, manual_url? }`, on `volley/_system/claude/<acct>/signin`, then `claude_signin_done { acct, plan? }` or `claude_signin_failed { acct, reason }` there. The topic is not retained: whoever opens the URL first chooses the account bound to the profile. Not retaining it does not confine it: every client that may read the topic while the sign-in runs sees the URL, and under the example broker ACL every authenticated client, agents included, may read all of `volley/#`. A deployment that must keep the URL from its agents restricts reads of `volley/_system/claude/#` to the owner's clients in its broker ACL. `flow` is `browser_callback` (the URL redirects to Claude Code's own listener on the machine signing in, so it must be opened in a browser on the supervisor's machine: for the supervisor's own profiles that listener is local, and for a paired machine the supervisor holds the forward above from the same port on its own loopback to the machine's) or `manual_code` (the page shows a code the user pastes into the sign-in terminal named by `attach`, never into a Volley client). `attach` is the one-line command that reaches that terminal; for a remote machine it is prefixed with ssh (`ssh <target> -t tmux attach -t volley-signin-primary`). `manual_url`, when Claude Code printed one, is the `manual_code` URL of the same sign-in, for a device that cannot open the forwarded URL (a phone): its page shows the code to type into the terminal `attach` reaches. A paired machine's own default profile is the account `primary@<name>` (the §4.6.12 naming of a remote host's account). The URL is not journaled; while a sign-in waits, `claude_accounts` returns it, so a client that attached late can still show it.

A remote machine's `claude_signin_url` (the URLs shortened; `redirect_uri` decoded for reading):

```json
{
  "acct": "primary@box-a",
  "url": "https://claude.ai/oauth/authorize?code=true&client_id=…&redirect_uri=http://localhost:51051/callback&state=…",
  "flow": "browser_callback",
  "attach": "ssh dev@box-a -t tmux attach -t volley-signin-primary",
  "manual_url": "https://claude.ai/oauth/authorize?code=true&client_id=…&redirect_uri=https://platform.claude.com/oauth/code/callback&state=…"
}
```

While it waits the supervisor holds `ssh -N -L 127.0.0.1:51051:127.0.0.1:51051 dev@box-a`, and drops it when the sign-in ends or times out. The forward binds the very port in `redirect_uri` on the supervisor's loopback, never another: when that port is taken there, the supervisor holds no forward, and `flow` is `manual_code` with the URL the machine printed for it (`manual_url` when Claude Code printed both), or the sign-in fails with `claude_signin_failed { reason }` naming the port.

**Ops.** Mailbox control queries (§4.6.4's request/acknowledgement shape): `claude_accounts` (the registry: `{ id, label, machine, created, plan?, signed_in_at?, dir, signin: { state, url?, flow?, attach?, manual_url? } }`, plus the sharing modes and `primary: { plan? }`, the plan of Claude Code's default profile on the supervisor's machine as `claude auth status` reports it when asked, absent when it is not known, and `remote_signins: [{ acct, state, url?, flow?, attach?, manual_url? }]`, the paired machines' sign-ins still waiting); `claude_account_add`; `claude_signin` (`acct` a registry account or `primary@<name>`, a paired machine's own profile); `claude_sync { acct? }`; `agent_move_account { agent, acct }`. A move is never silent: the supervisor journals `agent_account_moved { agent_id, role, from, to, by }` first, cancels the agent (§4.4), and only once it has stopped retires it and respawns its role under the other account, as a new attempt in the same working directory with a resume note in its brief. An agent that does not stop is not respawned.

**Sharing.** What a profile shares with the primary is chosen per item (`settings.json`, `CLAUDE.md`, `skills`, `agents`, `commands`, `plugins`, `mcp`): `linked` (a symbolic link to the primary's; Claude Code writes through it), `copy` (copied once) or `own`. `mcp` is the `mcpServers` section of the profile's `.claude.json`, copied from the primary's and re-synced by `claude_sync` and before each spawn; it is never linked. The profile's `.claude.json` holds its own account and is never linked or copied whole. MCP server entries can hold third-party secrets, so a supervisor never publishes or journals them.

The `_system` journal (§4.6.3) records `claude_account_added`, `claude_signin_started`, `claude_signin_done`, `claude_signin_failed` and `claude_profile_synced`; a move is journaled in its wave.

#### 4.6.12 Usage metering

`usage` is a reserved per-agent channel in addition to those in §4.1: QoS 1, **retained**, published by the agent's own harness (the reference publisher is a Claude Code `statusLine` command in the hooks' settings, so Claude Code hands it the session's usage after each assistant message). `payload: { account, config_dir?, model, context_window: { used_percentage, used, size }, rate_limits: { five_hour?, weekly? }, captured_at }` (`usage.schema.json`), where each window is `{ pct, resets_at }` (`resets_at` a date-time or `null`). `account` is the Claude account the session runs under (§4.6.11: the `claude_account` of its identity, `primary` for a session without `CLAUDE_CONFIG_DIR`); when the publisher cannot tell, it is `null` and `config_dir` carries the session's `CLAUDE_CONFIG_DIR`, which the supervisor maps to its profile. A window is absent until the harness reports it (subscriptions only, after the first response). A publisher SHOULD throttle: the reference one publishes at most once per 15 seconds unless a percentage moved by more than one point (or the account, model or a reset time changed). A supervisor clears the topic when it retires the agent. Under an ACL that grants per-channel writes through a namespace wildcard, agent ids MUST NOT be `usage` or `claude-accounts`, for the same reason wave ids must not be channel names (§4.6).

**Per account.** The rate-limit windows belong to the account, not to the agent. A supervisor folds every agent's samples into one retained record per account on `volley/_system/claude-accounts/<acct>` (`claude-account.schema.json`): `{ account, label?, plan?, five_hour, weekly, agents, waves, sampled_at, sampled_by? }`, where each window is the one from the newest sample that carried it (`null` while none has), `agents` are the agents whose latest sample is on the account and `waves` the waves they belong to. The record outlives its agents: an account's windows stay known when nothing runs on it, and across a supervisor restart (the reference supervisor keeps them in a state file, not on the broker). An agent's wave is the one its spawn was journaled in, so its retained sample is attributed (and can open a decision) as soon as the supervisor reads it, before the agent is supervised again. A remote host's agent (`tasks[].host`, §4.6.1) runs under that host's own Claude login, which is not the supervisor's account of the same name: its samples are folded into a record of their own, `<acct>@<host>`, never into a local account. `most_headroom` (§4.6.11) resolves to the signed-in local account (or `primary`) with the lowest 5-hour percentage, then the lowest weekly; a window whose reset has passed counts as empty, and an account without usage data is not ranked.

**Threshold.** When an account's 5-hour window reaches `claude.warn_at_pct` (§4.6.4; a wave's own override applies to that wave), the supervisor opens a wave-level `account_limit` decision (§4.6.2) for each wave with agents on that account, carrying `acct`, `pct`, `resets_at` and `suggested` (the account with the most headroom among those under the threshold in both windows; failing that, a signed-in account that has no 5-hour usage data yet, which counts as available and is labelled "no usage yet" in the question and in a client's picker ("no 5-hour usage yet" when it has reported weekly usage), a signed-in profile before `primary` (interactive sessions use the owner's own login without reporting usage, so its lack of data says least about its headroom); or `null`, when only `not now` is offered), with the options `move wave <wave> to <suggested>` and `not now`. It does not open another for the same wave and account while one is open, nor after one was answered for the same window (`resets_at`). The weekly window is informational: it opens no decision, and so is a remote host's record (a wave move cannot reach its agents). **Nothing switches on its own.** Only the answer `move wave <wave> to <acct>` moves the wave: the supervisor checks that a spawn could use the account (an unknown or not signed-in account is refused and the decision stays open), journals `wave_account_moved { from, to, by, decision_id }` in the wave, and from then on starts the wave's new agents that would have run under `from` under `to`. Running agents finish where they are; an agent moved on its own (`agent_move_account`) keeps its own move.

#### 4.6.13 Broker logins

The reference deployment authenticates every client with mosquitto's Dynamic Security plugin and therefore requires **mosquitto 2.1 or newer**: its roles scope per-identity grants with `%u` (the client's username), which mosquitto substitutes in Dynamic Security ACLs only from 2.1 on. Tools that manage logins (the account tool, the supervisor) read the broker's version from the retained `$SYS/broker/version`, else from the local `mosquitto -h`, and refuse an older or unknown broker (`BROKER_TOO_OLD`, `BROKER_VERSION_UNKNOWN`) before changing anything.

**Shared roles.** Eight roles are created once and are never edited while clients hold them, because an ACL change on a role disconnects every client holding it: `agent` (read `volley/#`; write its own channels `volley/+/%u/{status,progress,result,capability,usage,control,_user/#}`, its registry entry `volley/_system/registry/%u`, lease requests, and the mailboxes of `volleyd` and `desk` for its acks, §4.4), `account` (the same reads and own-identity writes, plus its machine record `volley/_system/machines/%u` and nothing under it, so no account writes a readiness verdict, §4.6.15), `desk` (write any mailbox; read `volley/_system/desk-probe/%c`, `%c` the client id, for a browser client's resume probe), `coordinator` (operator-level: any mailbox and any agent's standard channels and registry entry), `admin` (`coordinator` plus its own `volley/_system/auth/ops/%u`), `supervisor` (the whole tree except the account-op and answer topics), `volleyd` (the whole tree and `volley-auth/#`) and `token` (its own two `volley-auth/redeem/%u` topics). The fixed identities hold `volleyd`, `account` + `desk`, and `account` + `coordinator`; accounts hold `account` plus their role's (§4.6.10). A login's roles are checked in the order it holds them and the first ACL whose topic matches decides, so a `supervisor` account is bound by any deny in `account`: a topic only the supervisors may write is left ungranted in `account`, never refused there. Changing a role is an explicit, announced operation that reconnects its holders: a broker set up before a change reports the role as drifted, and `volley auth migrate --roles` applies it (the readiness change of §4.6.15 is one such change).

**One login per agent.** A supervisor mints each agent's login as one client (username = agent id, password random, role `agent`) and gives it to the agent in its identity file (§6.5). Logins created or deleted at the same moment (a wave's parallel spawns, a sweep) go to the broker as one control message: mosquitto rewrites its whole state file per message, so the batch window (`dynsec_batch_ms`, §4.6.4) turns N rewrites into one, and each command's answer is matched to its own agent (one failed element fails only that spawn).

**Deleting a login.** Deleting (or disabling) a client disconnects it without publishing its will, so no LWT reports the agent gone. Whenever a supervisor deletes an agent's login (retiring the agent, stopping its wave, a sweep) it first publishes the agent's retained `status` as `reaped` with `payload.reason: "credentials_deleted"`, then clears the agent's retained records (registry entry, `status`, `progress`, `result`, `capability`, `screen`, `usage`), then deletes the login, and journals `agent_reaped_by_supervisor` and `credentials_revoked`. Stopping a wave deletes the logins of all its agents that have not ended by the end of its grace (`stop_grace_s`) at once.

**Sweep.** Logins never expire, and every change costs a rewrite of a file that grows with the number of logins, so a supervisor sweeps: at start and every `credential_sweep_interval_s` it lists the logins holding only the `agent` role and deletes, through the sequence above, each one with no live agent behind it (none of its tasks' agents running in a wave that is neither stopped nor complete, no worktree lock, no non-terminal retained status) that it did not mint within `spawn_timeout_s`; journaled `credentials_swept { agent_ids }` in the `_system` journal. It never touches a login holding any other role.

#### 4.6.14 Machines and pairing

A supervisor MAY run agents on other machines (§4.6.1 `tasks[].host`). **Pairing** turns a machine into such a host with one code: the operator asks the supervisor for a pairing code, and one command on the new machine uses it.

**Who may call them.** `peer_invite` and `peer_remove` create and revoke broker accounts' access, and `peer_doctor` runs commands on a paired machine, so they are admin ops: an admin sends them exactly like an account op (§4.6.10: `payload: { op, ... }` on `volley/_system/auth/ops/<username>`, answered on `volley/_system/auth/replies/<correlation_id>`), and the supervisor applies the same admin-role check. It refuses them on its mailbox, which does not name the sender. `peer_join` and `peers` are mailbox control queries (§4.6.4's request/acknowledgement shape): a join's credential is its code.

**Ops.** `peer_invite { reply_key, ttl_s?, for? }` answers with a single-use code `XXXX-XXXX` (by default valid 10 minutes, at most that), sealed in `sealed` to `reply_key` as `{ code }` exactly like an account op's secret (§4.6.10), since every account may read the answers; `result` carries only `{ expires_at, ttl_s, for? }`. The supervisor keeps only a salted hash of each code. `for` makes a re-pairing code: it names a machine this supervisor paired (a §2.1 name, else `for must be a machine name ([a-z0-9][a-z0-9_-]{0,62})`; one it did not pair is refused, `no paired machine named "<for>" to re-pair`), and the binding is kept in the code's hashed entry, so the code joins only as that name. `peer_join { code, name, target, volley_dir, repo?, worktree_root?, port?, os?, cores?, replace?, reply_key }` burns the code, creates an account `name` with role `peer` and kind `machine` (§4.6.10), adds `hosts.<name>` to its configuration (§4.6.4) with `target`, `repo`, `worktree_root`, `volley_dir` and `tunnel: { remote_port: <port>, supervise: false }`, and answers `result: { name, namespace, broker: { host, port }, remote_port }` with the new account's `{ username, password }` in `sealed`. `name` uses the §2.1 grammar and is never `local`, `auto` (both reserved by a wave file's `host:`, §4.6.15) or a fixed identity (`volleyd`, `desk`, `coordinator`); a name that is already a configured host, or the supervisor's own machine name (§4.6.15), is refused, except by a re-pairing (below). A code bound to another name is refused (`this pairing code re-pairs <for> only`), and so is a configured name joined with an unbound code or without `replace: true`, or an existing account of that name whose role is not `peer` (`"<name>" is a <role> account, not a peer: not replaced`). These refusals come before the code is burned. **Re-pairing**: `replace: true` with a code bound to `name` re-pairs an already paired machine (a new ssh target, a lost credential, a fresh install) without removing it first: the supervisor rotates the existing `peer` account's password instead of creating an account (or creates it if it is gone), merge-patches `hosts.<name>` with the join's fields (so a hand-set `max_agents` or `drain` stays), and answers as a join does, the new password in `sealed`. An unknown, used or expired code is refused (`invalid or expired pairing code`); after `peer_join_max_failures` wrong codes every outstanding code is revoked, so a code cannot be guessed. The supervisor remembers the names it paired. `peer_remove { name }` revokes the account (refused for an account whose role is not `peer`), removes `hosts.<name>` and clears the machine's retained record; it is refused for a name that is neither a paired machine nor a `peer` account, so a host configured by hand is never removed. `peer_remove { name, drain: true }` on a machine with live agents (supervised, launched and not yet verified, or spawns in flight there) does not remove it at once: it sets `hosts.<name>.drain: true` (nothing new is placed or spawned there, §4.6.15), answers at once with `result: { name, removing: "drain", agents, revoked: false, host_removed: false }` and journals `peer_drain_started`, and the supervisor removes the machine as above once no agent runs there (journaling `peer_removed`). `{ name, now: true }` does the same but also stops those agents: each is sent a mailbox `cancel` (at once, or, for one that comes up later, once it is supervised), and one still live `stop_grace_s` after its own `cancel` is force-retired (`agent_force_retired { reason: peer_remove }`): its role ends as stopped and opens its respawn decision, which offers `respawn on <best>` (§4.6.15). A `done` an agent publishes before that is verified as any `done` is. A machine being removed stays closed to new agents until the removal finishes; a removal is not called off. `drain` and `now` are booleans and exclude each other; on a machine with no live agent either removes at once; a second removal of a machine being removed is refused (`"<name>" is being removed already`). A pending removal survives a restart. `peers` lists the paired machines' names (`hosts`) and their records (`machines`). `peer_doctor { name, fix?, clone? }` (a Desk's Repair) runs the machine's doctor on the configured host `name` over ssh: the supervisor runs `volley peer doctor --json`, plus `--fix --yes` when `fix` is `true` and `--clone --origin <url>` when `clone` is `true`, in the host's `volley_dir` as one step of the same `ssh -T <target> bash -s` that launches agents there, and runs no other `volley` command on a machine. `fix` and `clone` are booleans (default `false`), and `clone` needs `fix` (`clone needs fix: true`). `<url>` is the wave repo the machine clones: the running wave's origin as the supervisor's own clone reports it (§4.6.15), as `https://<host>/<path>`, never with credentials or a port; while none is known (no wave runs, or its origin has a port) `clone` is refused (`the wave repo's origin is not known …`). An unknown name is refused (`no configured host named "<name>"`), and so is a second `peer_doctor` for a host whose run has not ended (`a doctor run on "<name>" is already in progress`), so two fixes never overlap on one machine; these refusals come before anything runs. The answer is `result: { name, fix, checks, versions?, auth?, repo?, memory?, disk?, doctor_at, plan? }`: the doctor's report (each check `{ id, ok, severity, detail, fix? }`), and, when `fix` is `false`, `plan`, the failing checks that carry a fix as `{ id, severity, detail, fix }` in the doctor's order, so a client shows what a fix would do before anyone runs it. When ssh fails, or the doctor prints no report, the answer is `ok: false` with the reason. A run can take minutes (a fix may check out and install volley), so the supervisor answers it when it ends and handles every other request meanwhile. The `_system` journal records `peer_invited { by, expires_at, for? }` (never the code), `peer_joined { by, name, target, os?, cores?, replaced? }` (`replaced: true` on a re-pairing), `peer_drain_started { by, name, mode, agents }` (`mode`: `drain` or `now`; `agents`: the live agents it waits for), `peer_removed { by, name, revoked, host_removed }` and `peer_doctor_run { by, name, fix, clone, ok }`; the configuration change is a `config_changed` as usual (a removal's patch reads `{ hosts: { <name>: null } }`).

**The tunnel.** A paired machine keeps its own way to the broker: a service on the machine (the reference one runs `volley peer run` under systemd or launchd) holds `ssh -N -L 127.0.0.1:<remote_port>:<broker host>:<broker port> <supervisor's machine>`, so its `127.0.0.1:<remote_port>` is the broker, as a supervised reverse tunnel would make it (§4.6.1, `supervise: false`: the supervisor only checks it). Every remote step of the join runs on the supervisor's machine as a script on stdin to `ssh <host> bash -s`; the code travels in that script, never on a command line.

**Machine records.** `volley/_system/machines/<name>` (QoS 1, retained, `machine.schema.json`) holds `{ name, os, arch?, cores, tunnel, reason?, load, agents, remote_port?, last_seen }`, where `load` is the 1, 5 and 15 minute load averages, `agents` the machine's agent sessions and `tunnel` `up` or `down`, plus the optional Fleet fields of §4.6.15 (`kind`, `memory`, `disk`, `uptime_s`, `versions`, `auth`, `repo`, `checks`, `doctor_at`). The machine publishes it as itself (`agent_id` = `name`; the shared `account` role grants `volley/_system/machines/%u`, §4.6.13) through its tunnel every `machine_heartbeat_ms` (30 s), so a record that arrives means the tunnel works; its LWT is the same record with `tunnel: "down"` and `reason: "disconnect"`, retained. An LWT is set when the machine connects, so its `last_seen`, `load` and `agents` are the connection's; a supervisor keeps the values of the last `up` record it received when an LWT arrives. Only records for a configured host count (every account may publish its own). A supervisor folds the records in on its own clock (a machine's clock may be skewed) and marks a machine whose record has not arrived for `machine_down_after_ms` (90 s) down: it republishes the record as itself with `tunnel: "down"` and `reason: "heartbeat_timeout"`. While a machine is down, new spawns on its host park (`why_waiting: "tunnel down to <name>: no heartbeat for 90 s"` or `...: disconnected`) and each wave with unfinished tasks there journals `alarm_raised { code: MACHINE_DOWN, host, reason, last_seen, tasks }`; the next record with `tunnel: "up"` resumes them. Running agents are never touched, but the wave state shows them: every unfinished task on the host carries `tasks[].host_down` (§4.6.1) until the machine is back. A machine whose account is revoked stops its tunnel service when the broker next refuses it.

#### 4.6.15 Fleet

The Fleet turns paired machines (§4.6.14) into places the supervisor can put work without being told: each machine reports its health, the supervisor judges whether it can run an agent, and a wave that opts in has its tasks placed by load with every choice explained. Everything here is optional on the wire: a machine record without the fields below, a wave file without `placement` and a config without the Fleet tunables stay valid, and a wave that does not opt in runs exactly as before.

**The machine record.** A machine whose doctor has run (`volley peer doctor`, by hand, by `peer join`, by its heartbeat or by a Desk's Repair) adds to its record (`machine.schema.json`): `kind` (`peer`, the default, or `supervisor`); `memory { total_mb, available_pct }`, where `available_pct` has one definition on every machine so that placement can compare them: memory the kernel can hand out without paging anything active out, over total memory (Linux: `MemAvailable`; macOS: `vm_stat`'s free, inactive, speculative and purgeable pages times the page size, never the free pages alone, which a healthy Mac keeps in single digits; a machine that cannot measure it omits `memory`); `disk { path, free_gb, free_pct }` for the filesystem that holds its worktrees; `uptime_s`; `versions { peer, volley, bun, node?, git, gh?, tmux?, claude? }`, each a string or `null` (missing) as the machine's doctor finds it (for `bun` and `claude`, the copy on the non-interactive ssh PATH when one resolves there); `auth { gh, claude, trust, claude_plan? }` with `gh` `ok` \| `unauthenticated` \| `missing` \| `no_write`, `claude` `signed_in` \| `not_signed_in` \| `missing` \| `unknown` (its default Claude profile) and `trust` `ok` \| `missing` \| `unknown` (that profile's trust of the wave repo's folder); `repo { path, exists, origin?, release_branch?, fetched_at? }`, with `origin` normalised to `<host>/<path>` (no scheme, user, credentials or `.git`); `checks[]` (at most 32), each `{ id, ok, severity, detail }` with `severity` `block` (a failing check makes the machine not ready) or `warn` (a doctor's own estimate of the non-interactive ssh PATH, such as the reference doctor's `bun_on_path` and `claude_on_path`, is a `warn`: the supervisor's `path_ok` probe of the real one decides); and `doctor_at`. The record carries states only, never a secret, and never a fix's text: the doctor that reads a record supplies its own. The record stays closed (`additionalProperties: false`), so a field outside this list is invalid.

**The supervisor's own record.** The supervisor publishes a record for its own machine as itself, with `kind: "supervisor"` and `tunnel: "local"` (valid only with that kind), on `volley/_system/machines/<local_name>`, where `<local_name>` is the `fleet.local_name` tunable (§4.6.4). When it is `null` the supervisor derives the name from its host name: the first DNS label, lowercased, every character outside `[a-z0-9_-]` replaced by `-`, leading characters that are not `[a-z0-9]` dropped, cut to 63 characters; a result that is empty, `local`, `auto` or a fixed identity (`volleyd`, `desk`, `coordinator`) becomes `supervisor` (so `MacBook-Pro.local` is `macbook-pro`). The name is never `local` or `auto`, which a wave file's `host:` reserves. It is never a configured host either: the supervisor refuses a configuration (`config_set` or `config.yaml`) in which `fleet.local_name` equals a `hosts.<name>` key, or a `hosts.<name>` equals the resolved name, and `peer_join` refuses it as a name (§4.6.14), so two machines never write one record topic. The retained effective config (`volley/_waves/_config`) carries the resolved name in `fleet.local_name`, never `null`: a client recognises the supervisor's machine by that name, which only the supervisor publishes, not by a record's `kind`, which a machine states about itself. The supervisor likewise treats a configured host's record as a peer whatever its `kind`. The supervisor's machine is a placement candidate like any other; in placement and lease state it appears under that name, while `tasks[].host` stays absent for it (§4.6.1).

The supervisor is its own machine's doctor: it runs the same checks locally when it starts, every `machine_heartbeat_ms` after and whenever the running wave's repo changes, and fills its own record's Fleet fields (`checks`, `doctor_at`, `versions`, `auth`, `repo` and the rest) with the results, so its machine is ready on the same terms as a peer. It is no peer and has no peer configuration, so the clone it checks is the running wave's repo (the first by wave id when several run), given to the doctor as `--repo`; that repo's origin is the one a peer's clone is compared with. While no wave runs it checks no clone: the `repo.*` checks of that run, which then say only that no repo was given, do not count against its own machine, and no origin is compared. There is no ssh hop to itself: its `path_ok` says whether `claude` and `bun` resolve in the environment the supervisor gives its own agent sessions, and it is probed there. Until that first local run completes, its own machine is not ready like any other machine without a doctor report.

**Readiness.** `volley/_system/machines/<name>/readiness` (QoS 1, retained, `readiness.schema.json`) holds the supervisor's verdict on each machine, its own included: `{ name, ready, reasons[], drain, max_agents, placed, path_ok: { claude, bun }, requirements: { volley, bun?, sharing? }, heavy: { <pool>: { held, per_machine } }, usage: { account, five_hour_pct }, eligible, ineligible_reason?, local_agents?, checked_at }`. `ready` is `true` when nothing blocks an agent there (the tunnel is up or local, no `block` check fails, `claude` and `bun` resolve on the PATH an agent's session gets, which the supervisor probes itself (`path_ok`: the non-interactive ssh PATH on a peer, its own agent environment on its own machine), the machine's volley matches `requirements.volley`, GitHub may push and Claude is signed in); `reasons` has one line per blocker and is empty when ready. A record without a doctor report is not ready (`no doctor report: run volley peer doctor`). `requirements` is what the supervisor asks of the machine (its own volley version, its lowest accepted bun, and its per-item sharing modes, §4.6.11, which the machine's doctor applies to its own Claude profile); `placed` counts the machine's live supervised agents plus the placements reserved for it that have not spawned; `heavy` has the machine's holders' leases in each pool that sets `per_machine` or a `per_machine_overrides` entry for the machine, with the cap in force there (§4.6.5); `usage` is the account its agents run under and its 5-hour percentage (§4.6.12; `null` while unknown). `eligible` says whether placement may put a new task there now, and when it is `false`, `ineligible_reason` says why in one line: it is placement's own machine filter (below), everything but a heavy task's slots, under the supervisor's config (a wave's own `placement` overrides apply to its tasks), and `ineligible_reason` is the same text as that machine's placement candidate line without its `ineligible: ` prefix, so a client never shows `eligible` next to a placement that skips the machine. The supervisor re-computes the verdict whenever it folds in a record, a config change or a placement, re-publishes it when anything but `checked_at` changed and otherwise at least once every `machine_down_after_ms`, so `checked_at` says when the verdict was last computed, clears it when the host is removed, and journals `machine_readiness_changed { name, ready, reasons }` in `_system` when `ready` or `reasons` change. A verdict waits for its inputs: after the supervisor starts, it neither publishes nor journals a machine's verdict until that machine's record has arrived and its first PATH probe has finished (no probe runs while its tunnel is not up), or, for its own machine, its first local doctor run has finished, and at most `machine_down_after_ms`. So a restart leaves the last retained verdict in place instead of a verdict computed from nothing, and the first verdict with its inputs is compared with the last journaled one (with none, it is the baseline and journals nothing). Only the supervisor publishes readiness. The record is the machine's statement about itself; the verdict needs the supervisor's config and version, and two writers on one retained topic would interleave, so the verdict has a topic of its own. The broker ACL lets no account write a readiness topic, its own machine's included: the `account` role grants the record topic `volley/_system/machines/%u` and nothing under it (§4.6.13), so only the supervisor's identities (`volleyd`, `supervisor`) may publish there. A client MUST accept readiness only from the supervisor's `agent_id` as a sanity check (the envelope's `agent_id` is written by the publisher, so the ACL is what makes the verdict trustworthy), and the supervisor never reads a verdict back (placement uses the one it computed). A client shows a verdict as stale while the supervisor's own `status` is not live, or when its `checked_at` is older than twice `machine_down_after_ms`. A client that shows machines subscribes `volley/_system/machines/#` and gets both.

**Caps and drain.** `hosts.<name>.max_agents` (1 to 100, default 4) caps the supervised agents a host runs at once; the supervisor's own machine is capped by `hard_ceiling`, which also still caps the total, so its verdict's `max_agents` is `hard_ceiling` and its `placed` counts every live supervised agent, wherever it runs. `hosts.<name>.drain: true` takes a host out of placement: nothing new is placed or spawned there, and its running agents finish. A spawn for a task already placed on a host closed to new agents (draining, being removed, or removed) parks with a plain `why_waiting` (`<name> is draining: nothing new starts there; re-place or cancel <task> (its machine_down decision)`) until the owner answers that host's `machine_down` decision (below).

**The supervisor's own machine as a fallback.** `fleet.local_agents` sets how the supervisor's own machine takes auto-placed tasks: `always` (a candidate like any peer), `fallback` or `never`. `null`, the default, resolves to `fallback` when any `hosts.<name>` is configured and to `always` otherwise; the retained effective config carries the resolved value, and a change that flips it (the first host added, the last removed) is journaled as `config_changed` for `fleet.local_agents` with `by: volleyd-defaults`. Under `never` the own machine is never a candidate for an auto-placed task (its line: `ineligible: local_agents: never`); a task that names `host: local` still runs there, because the wave file is explicit (`volleyd validate` warns about it). Under `fallback` the own machine takes an auto-placed task only while no paired machine is eligible (below); while one is, its line is `ineligible: fallback: <peer> is eligible`. A peer that is down counts as ineligible only once it has been down for `placement.down_decision_after_s` (the `machine_down` grace, below): until then the own machine stays closed (`ineligible: fallback: box-a may be back (down 40 s, grace 300 s)`, which a waiting task's `why_waiting` names), so a tunnel blip never pulls work onto it. A peer the task is being moved off counts as ineligible. "Eligible" here is the peer's task-agnostic readiness verdict (its `eligible`), so readiness and placement agree: a peer that takes work but has no free heavy slot still keeps the own machine closed, and a heavy task waits for a slot there rather than falling back. With no peer eligible, the own machine is eligible under the fallback profile: at most `fleet.fallback.max_agents` (1 to 100, default 3) of the agents on it alone (its live agents and reservations, not every supervised agent; `hard_ceiling` still caps the total), with the line `<n>/<max> agents (fallback max_agents)` when full, and in each heavy pool at most `fleet.fallback.per_machine.<pool>` slots (0 to 64; a pool it does not name gets 1 when the pool has a per-machine cap there; never more than that cap; 0 keeps heavy tasks off it). Its candidate line, when it is chosen, starts `local (fallback: no peer eligible: <closest peer>: <its first reason>)`. When a peer becomes eligible again, the next placement goes to it; nothing running is moved, and a task already placed on the own machine stays placed there for every role. Under `always` nothing changes. The own machine's readiness verdict carries `local_agents: { mode, active, why? }`: its mode, whether the fallback profile is in force now (`fallback` and no peer eligible), and `why`, the closest peer's reason while active, else the eligible peer (`box-a eligible`) or the one that may be back; a peer's verdict never carries it, and the verdict's `eligible` is the same filter. `volleyd status` prints `local agents: fallback (idle: box-a eligible)`, `local agents: fallback (active: box-a: tunnel down …)`, `local agents: always` or `local agents: never` in its header while a paired machine is configured.

**Placement.** Placement is opt-in. A wave file's `placement: auto` (the default is `local`) places every task that does not name a host; a task's `host: auto` places that task under either setting; every other task runs where its `host:` says, as before. A task is placed once, when the scheduler first admits it, and every agent of the task then runs on that host (§4.6.1). The candidates are the supervisor's own machine and every configured host with a machine record. A machine is eligible when its readiness is `ready`, it is not draining, `placed` is under its `max_agents`, its load per core (the higher of its 1- and 5-minute load averages) is at most `placement.load_per_core_max`, its available memory is at least `placement.mem_available_min_pct` and its free disk at least `placement.disk_free_min_gb`, its account's 5-hour usage is under `claude.warn_at_pct` (unknown usage passes), and, for a task marked `heavy: true`, every pool in the wave's `heavy_pools` that sets `per_machine` has a free slot there. Each eligible machine scores, in 0..1, the weighted mean of its headrooms: CPU (`1 - load per core / load_per_core_max`, floored at 0), free slots (`(max_agents - placed) / max_agents`), memory (`available_pct / 100`) and usage (`1 - five_hour_pct / 100`), weighted by `placement.weights` (relative weights, default CPU 40, slots 30, memory 15, usage 15; they need not sum to 100, and a configuration with all four at 0 is refused); a headroom that is unknown is left out and the remaining weights renormalised. When the weights of the known headrooms sum to 0, the machine scores 0 and its `line` says that no weighted headroom is known. Eligible machines in the wave's `placement_prefer` rank first, those in `placement_avoid` are used only when no other machine is eligible, and ties go to the machine with fewer placed agents, then the name. The best machine is reserved at once (it counts in `placed` until the task's agent is supervised, and a heavy task also counts in `heavy.<pool>.held` of each of its pools there), so concurrent placements spread and heavy tasks do not stack on one slot. When no machine is eligible, the task stays queued with a `why_waiting` that names the closest machine's reason, and is placed again on the next sample. The supervisor journals `task_placed { task, host, score, candidates, by, from?, local? }` and shows the same in the task's `placement` (§4.6.1): every candidate with its score and a one-line `line` the supervisor writes, an ineligible one with `score: null` and its reason. Under `placement: auto` a task whose host the wave file names is recorded `by: "wave_file"` with that one candidate. Nothing running is ever moved: placement decides where a task starts, never where it continues.

**Fresh base.** Before cutting an agent's worktree on any host, the supervisor fetches the release branch there. With `require_fresh_base: true` (the default, on every host), a fetch that fails fails the spawn as a spawn failure (§4.6.1 `last_error`) rather than cut the worktree from the host's last copy. The commit the worktree was cut from is the task's `base_sha` in the wave state, the `base_sha` of its `agent_spawned` event's `data`, and part of the gated head's evidence (§4.6.8).

**Merge nudge.** When a wave's PR merges, the supervisor sends one `steering` mailbox message (§4.4) to each running implementer of that wave whose task's `files` overlap the merged PR's changed files (`placement.nudge_on_merge: files`, the default), or to every running implementer (`all`), asking it to bring the release branch in before it pushes again; `off` sends none. Each nudge is journaled as `merge_nudge_sent { task, agent_id, merged_pr, files }` (`files`: the overlap; empty under `all`), at most one per agent and merged PR.

**A machine that stays down.** While a machine is down, its spawns park as §4.6.14 says. When it has been down for `placement.down_decision_after_s` (default 300) and a wave has unfinished tasks on it, the supervisor opens one wave-level `machine_down` decision (§4.6.2) per wave and machine, carrying `host`, `down_since` and `tasks`, with the options `wait`, `re-place queued tasks` (pre-filled: the question names where they would go) and `cancel`. A task is running while an agent of it is live (supervised, launched and being verified, or spawning); any other unfinished task there (queued, between roles, or waiting on its respawn decision) is waiting. It never re-places a task without an answer: `re-place queued tasks` places each waiting task of the list again (`by: "decision"`, `from` the down host) and leaves running ones where they are; one with no eligible machine stays (`alarm_raised { code: NOT_REPLACED }`) and is placed as soon as a machine is eligible; `wait` keeps everything parked until the machine is back; `cancel` cancels the listed tasks that have not finished (a running agent is told to stop). A host closed to new agents (draining, being removed, removed) with a waiting task of a wave gets the wave's `machine_down` decision at once, with `machine` set and `wait` offered only while it is draining; an open `machine_down` whose host's trouble changed resolves itself (`superseded` by the supervisor, or `wait` when the host takes new agents again). A decision offering `respawn` for an agent whose host is down or not eligible also offers `respawn on <best>`, which respawns the role on the best eligible machine and re-places the task there; on a closed host it offers `respawn on <best>` instead of `respawn`. The machine is checked again when the answer arrives: one that cannot take the task by then refuses it (the answer is journaled with `(refused: <why>)`) and the question is asked again. An implementer respawn continues the branch its earlier attempt pushed (the same name, cut from origin's copy; its brief names the branch and its open PR), so it never opens a second PR; a branch never pushed is started afresh.

**Credentials.** Every Fleet payload carries states (`signed_in`, `no_write`, …), never a credential, token, code or password. Each machine keeps its own sign-ins: its broker login is its peer account, GitHub is its own `gh`, and Claude is its own default profile. A paired machine's Claude sign-in runs Claude Code's own flow on that machine, through the one forward §4.6.11 permits.

**Owner decisions (2026-10-19).** Placement is opt-in (`placement: auto` per wave or `host: auto` per task). Heavy work is held by a `per_machine` cap per lease pool and by heavy-aware placement. The supervisor computes readiness, on its own retained topic, and publishes its own machine record. `require_fresh_base` defaults to `true` on every host. A machine that stays down parks its work and, after five minutes, asks; nothing is re-placed without an answer. A peer's default `max_agents` is 4. A paired machine's Claude sign-in is run from the supervisor's browser through one fenced, transient ssh forward, or typed into the sign-in terminal on the machine itself, never into a Volley field.

#### 4.6.16 Autopilot

A supervisor MAY answer a decision (§4.6.2) itself, from a policy table it publishes for review (the reference supervisor prints it with `volleyd policy`), within remediation budgets. It is governed by the `autopilot` tunables (§4.6.4), globally and per wave: `enabled` (default `true`), `owner_only` (the decision kinds it never answers; default `plan_change`, `repo_untrusted`, `model_switch`, `release_go`, `stage_go`) and the per-wave budgets `relaunch_max`, `nudge_max`, `respawn_max`, `rereview_max`, `ci_fixup_max`, `question_max` (integers 0..10, each counting automatic answers under one budget key, such as `relaunch_max:<task>/<role>`) and `budget_raise_max` (a multiplier, 1..10: automatic `raise by <n>` answers to `spawn_budget_exhausted` may take the spawn budget to this multiple of the wave's derived budget). A change applies from the next decision on.

**What it MAY answer.** A decision whose kind and facts match a rule of its table, whose kind is not in `owner_only`, and whose budget (if the rule has one) is not spent. Every automatic answer MUST be one of the decision's own `options` (any answer, for a decision that offers none); a rule whose answer the decision does not offer escalates instead. It MUST NOT answer a decision whose kind is in `owner_only`.

**What it MUST journal.** An automatic answer is journaled as `decision_auto_resolved { decision_id, kind, policy, answer, rationale, evidence, budget? }` immediately before the ordinary `decision_resolved` with `by` set to the supervisor's agent id; the retained decision topic is published resolved and cleared like any other resolution, and the supervisor does not publish its attention envelope for it (the `blocked` envelope on its own `progress` topic that a decision opening rings, which `volley notify` watches). A decision it does not answer (no rule matches, its kind is owner-only, its budget is spent, or the answer could not be applied unattended) stays open and is journaled as `decision_escalated { decision_id, kind, why, budget? }`, `why` being `owner_only` \| `no_policy` \| `budget_exhausted` \| `unattended_safety`; only then does the supervisor publish that attention envelope, and the retained decision's `question` starts with `Autopilot could not resolve this (<why>): `. An escalated decision is never left as a silent wait. With autopilot disabled neither event is journaled and every decision waits for its answer. The wave state's `autopilot` (§4.6.1) counts both and carries each budget used.

**Self-healing CI.** Before a red head (a CI failure on a head the pipeline verifies) is put to anyone, the supervisor classifies it from the failing tests (from the failed runs' logs), the PR's changed files, the release branch's latest CI (the latest run per workflow among its recent runs, with the tests failing there) and, for a GitHub repository, GitHub's status page:

| Classification | When | Remedy |
|---|---|---|
| `infra_incident` | the failure is infra-shaped (a run never started; every failed job failed in a runner, checkout or network step; a run was cancelled and nothing replaced it), or no failing test's file is among the PR's files and the status page reports an Actions or API component that is not operational | a CI hold: the task stays in its stage with `why_waiting: "CI infra incident: <what>; re-checking"` and is re-verified at the CI poll interval; once `autopilot.incident_wait_max_s` (default 14400) has passed since the hold started, a `ci_failed` decision opens with `classification: infra_incident`, which autopilot escalates `budget_exhausted` |
| `own_change` | a failing test's file is among the PR's changed files (this wins over a status-page incident), or the failing tests name no file and the release branch's latest CI is not red, or no failing test can be named at all (neither the PR's run nor the release branch's) | `ci_failed` with `fixup` first: a fixup agent at the red head with the CI result as its directive |
| `flake` | otherwise: no failing test's file is in the PR's changes (whether or not the same test fails on the release branch), or the tests name no file and the release branch is red | `remediation_requested { kind: fix_flake, test, test_file, head, run_urls, for }` is journaled (once per head and test), then `ci_failed` offering `fix flake` first; that answer leaves the task parked (`tasks[].remediation`, `why_waiting: "CI flake in <test>: fixer pending"`) for a dedicated fixer |

The `ci_failed` decision carries `classification` and `evidence: { failing_tests, test_files, pr_files, release_ci, status_page }`. An unreadable status page is unknown and never an incident; unreadable PR files never make a flake. A supervised agent's `blocked` status whose reason is about a failing test or CI, while its task's PR head is red, is classified the same way: its `agent_blocked` decision carries the classification and the evidence, `pipeline.on` is `agent_blocked_ci`, and it offers `fixup` (own change: the blocked agent is stopped and a CI fixup starts at the red head) or `fix flake` (a flake) beside `continue`, `respawn` and `cancel`; the policy table answers an own change or a flake as it answers `ci_failed`, and leaves an infra incident to the owner. A supervisor MUST NOT re-run a failed run as a remedy for any classification, and never re-runs one at all: a flake is fixed, an incident waited out.

#### 4.6.17 Autopilot merging

A supervisor MAY merge a gated PR itself, so that an unattended wave does not stall at the gate. A wave file's `merge: auto | manual` chooses; without the key, the supervisor's `autopilot.merge` tunable (§4.6.4, default `auto`) does. Under `manual` the supervisor never merges and everything in §4.6.8 holds unchanged. Under `auto`:

- The supervisor merges only a task at `merge_ready`, only at the head the task was gated at (the head its evidence package describes), and only into the release branch the PR targets. It squash-merges with GitHub's head guard (`gh pr merge <n> --squash --match-head-commit <head>`, optionally `--delete-branch`), so GitHub refuses the merge when the PR's head moved since the gate. It never forces a merge (no administrator override, no auto-merge, no other strategy) and never merges, pushes or rebases anything else. A reference supervisor holds this in its authority fence: the merge command is allowed only with a token the gate mints after writing the evidence package, for exactly that PR and head.
- A merge is journaled `merged_by_supervisor { task, pr, head, merge_sha, by }` (`merge_sha` `null` when the merge commit could not be read back), followed by the same merge record a human's merge gets (`artifact_verified { role: "merged", via: "supervisor" }`) and `stage_entered done`; the task's open decisions are resolved first, as for any merge (§4.6.8).
- A merge GitHub refuses (the head moved, required checks, branch protection) is journaled `alarm_raised { alarm: "merge_refused", pr, head, stderr, attempt }`, and the PR is read again at once, as at any gate: someone else may have merged it, or its head moved (a moved head invalidates the gate, §4.6.8). The merge is retried no more often than the CI re-check interval. After `autopilot.merge_retry_max` (default 2) refusals at one gated head the task leaves the gate (`blocked`) and decision `merge_refused` (§4.6.2) asks `retry` (one more attempt), `manual` (a human merges this task; the supervisor waits at the gate as under `manual`) or `cancel`. A new gated head starts the count again.
- The evidence package says who merges: under `auto`, that the supervisor merges the PR itself at exactly that head and journals it as `merged_by_supervisor`.

**The merge queue.** A supervisor decides *when* each gated task is merged through a merge queue:

- A task enters the queue when it is gated under `auto` (journaled `merge_queued { task, position }`, `position` 1-based) and leaves it when it merged (by the supervisor or anyone else), was cancelled, or went to a human (`merge_dequeued { task, why }`, `why` being `merged` \| `cancelled` \| `manual`). The wave state shows it as `merge_queue` (§4.6.1).
- The queue is ordered by dependency, then readiness: a task more tasks name in their `after` goes first, and a task never goes ahead of a queued task it comes after; then the task queued earliest. A task whose last merge GitHub refused goes after the tasks still waiting.
- There MUST be at most one merge in flight per release branch, across every wave the supervisor runs on that repository and branch. The task at the front holds the branch until it merged, its merge was refused, it waits for an answer, or the supervisor's checks at its turn keep failing (then it is passed over, with the tasks that come after it, while another queued task can take the turn); its merge is journaled `merge_started { task, pr, head }` before it runs, and a merge that ends without an outcome (it timed out, could not run, or a supervisor restart interrupted it) is journaled `merge_ended { task, why }` (`why` being `timed_out` \| `failed` \| `interrupted`), after which the task can take the turn again. Across waves sharing a branch, the lock goes to whichever wave's front task asks for it first.
- Before the front task is merged, the supervisor checks it against the release branch. If the branch moved since its gate (a merge before it landed), the task MUST be updated first: a rebase or merge agent brings it up to date per `branch_update` (§4.6.4; `merge` never force-pushes, so it is the mode to choose for an unattended wave), CI runs on the new head, the gate checks it again (§4.6.8), and only then is it merged. A queued task is updated only after the merge before it landed, and only at its turn: never every queued PR at once, so N merges cost at most N−1 updates, one at a time; the tasks behind it keep their gates and evidence meanwhile.
- A rebase or merge agent that cannot bring the branch up to date (it publishes `blocked`, or fails) opens decision `merge_conflict` (§4.6.2) with the options `respawn` (a fresh agent), `manual` (the task leaves the queue and waits at the gate for a human) and `cancel`.
- `merge: manual` on a wave keeps its tasks out of the queue. The owner MAY merge one gated task at once through the same verb, under `manual` too and on a paused or stopped wave (the reference supervisor's `volleyd merge <wave> <task>`, the `merge` control op, owner only); it is refused while another task holds the release branch.

#### 4.6.18 Needs-you inbox

A supervisor MAY keep one record per thing waiting for a person on `volley/_inbox/<id>`, retained, QoS 1, published by the supervisor only (`inbox-item.schema.json`, envelope `channel: "_inbox"`, `type: "inbox_item"` while open and `"inbox_answered"` once answered). It is how every client (a dashboard on a laptop or a phone, a terminal, a CLI) sees the same list, and how two of them never answer the same thing twice.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | By kind: `d-<wave>-<decision_id>`, `p-<agent_id>-<tool_use_id>`, `h-<agent_id>-<seq>`, `r-<wave>-<stage\|go>`. Ids are `[dphr]-[A-Za-z0-9_-]{1,200}` (a tool use id is mixed-case), not the §2.1 grammar. |
| `kind` | enum | `decision` (mirrors a §4.6.2 decision) \| `picker` (a question a harness put to its user) \| `handoff` (a turn that ended on a question) \| `release` (a release stage, or its go/no-go). |
| `version` | integer ≥ 1 | Bumped by every accepted change; an answer names the version it answers. |
| `owner_only` | boolean | Only the owner answers it: autopilot (§4.6.16) never does, and a client SHOULD notify the owner. For a decision, whether its kind is in `autopilot.owner_only`. |
| `wave`, `task` | ids | Optional: what it is about. |
| `agent_id` | agent id | The agent it is about (the supervisor's own id for a wave-level decision). |
| `title`, `question` | string | A short title, and what needs answering. |
| `options` | `[{ label, description? }]` | Suggested answers (optional). `allow_other` (a free-text answer is accepted too) and `multi` (several options may be chosen) are optional booleans. |
| `pointers` | object | Where the evidence lives (`diff`, `transcript`, `screen`, `pr`, …). |
| `opened_at` | date-time | |
| `source` | object | What it mirrors (for a decision, `{ decision_id, decision_kind }`). |
| `answered` | object | `{ answer, by, where, at }`; present exactly when `type` is `inbox_answered`. `where` is `{ kind: desk \| terminal \| cli \| autopilot, device?, machine? }`. |

**The supervisor is the referee.** An answer is a control request on the supervisor's mailbox, `op: "inbox_answer"` with `{ id, version, answer, where }`; any login that may write the supervisor's mailbox (a `steer` account, an admin) may send one. The supervisor MUST accept it only when `version` equals the item's current version (compare-and-set) and the item has no `answered`. The first accepted answer bumps `version`, sets `answered`, is journaled as `inbox_answered { id, kind, answer, by, where, version }` (in the item's wave, else `_system`, §4.6.3) and is acted on; the record is re-published with `type: "inbox_answered"`. A later answer MUST be refused with `already answered on <where>`, `<where>` written `desk·<device>`, `<machine>·terminal`, `cli` or `autopilot`, and a stale version of an open item is refused too. Only the supervisor answers with `where.kind: "autopilot"`. Every way an item is answered closes it through the same referee, so every answer is journaled: a decision resolved by any path (its own resolve request, autopilot, a client's `inbox_answer`) answers its item, and an `inbox_answer` on a decision item resolves the decision. The `inbox` op lists the open items.

**Pickers and handoffs.** A supervisor that opens these items opens a `picker` item `p-<agent_id>-<tool_use_id>` for a `picker_opened` (§4.3) from any session, and a `handoff` item `h-<agent_id>-<seq>` for an `awaiting_input` carrying a `question` (`seq` is that event's) that the Stop hook published (`hook_event: "Stop"`), from a session it does not supervise (a coordinator turn that ended on a question; a Notification's `awaiting_input` repeats it or asks for a permission, and opens nothing); `source` records the `workspace` the item can be answered on, when known. A `picker_answered`, a session's next prompt (its `activity` `prompt received`, or that prompt's `resumed`), the end of the turn (the Stop hook's `idle`; a Notification's `idle` closes nothing) for a picker still open, and the session's terminal status (`done`, `failed`, `reaped`) close the session's open items with `where: { kind: "terminal", machine }`, unless the inbox answered them first. A coordinator session's own items are `owner_only`: the supervisor MUST refuse an `inbox_answer` to one whose `by` is neither the session's agent id nor the coordinator name (§6.2) bound to it. An `inbox_answer` to such an item is carried out in the session before it is accepted: the supervisor reads the session's screen and MUST refuse the answer, leaving the item open, unless the screen shows that same picker (its question's first line and every option label, in order; `picker not on screen`) or, for a handoff, an idle empty prompt (`prompt not idle`) with the item's question above it (`the question is not on screen`); a handoff reply that is not one line of plain text (a second line, a slash command or shell line) is refused before the screen is read; only then does it select the answer by keystroke or type the reply and submit it. A picker with more than one question, and a session whose screen the supervisor cannot read, are answered in its terminal.

**Lifetime.** An answered record stays retained, with `answered`, for `autopilot.inbox_answered_ttl_s` (§4.6.4; default 600 s) so a client that was offline sees what happened, and is then cleared (a zero-length retained payload). The journal is the record: a restarted supervisor rebuilds the inbox from its `inbox_opened` and `inbox_answered` events and re-publishes it.

**Who may read and write.** Every account reads `volley/_inbox/+`; only the supervisor writes it (in the reference roles: `volleyd` and `supervisor`). A client MUST NOT trust an item whose envelope `agent_id` is not the supervisor's.

#### 4.6.19 Release train

A repository MAY ship a **release playbook** at `<repo>/.volley/release.yaml` (`release-playbook.schema.json`): what turns its merged release branch into a release, as named stages a supervisor runs in order. A wave file's `playbook: <path>` (relative to `repo`, or absolute) points elsewhere; `playbook: none` opts the wave out. The playbook is `{ version: 1, stages[] }`, 1..32 stages with unique names, each `{ name, brief, run?, gate?, verify?, timeout_s?, heavy? }`: `brief` is what the stage's agent does; `run` lists the commands it runs, each an argv array (never a shell line), shown in its brief verbatim; `gate` is `auto` (the default) or `owner`; `verify` lists facts the supervisor checks once the stage reports done (`commits_on_release: true`, a `tag` glob at the release branch's head, `files` that must exist on the release branch, `result` fields the stage's result must carry); `heavy` names a lease pool (§4.6.5) the stage holds while it runs. The schema is generic hooks: it names no tool, host or environment.

- **Validation.** A supervisor validates the playbook when the wave is submitted: an invalid one, or a configured path that does not exist, refuses the wave with `RELEASE_PLAYBOOK_INVALID` and path-qualified errors (`stages[1].name: duplicate stage 'smoke'`). No file at the default path means no train, and so does a repo that is not on the supervisor's machine (its playbook cannot be read, at submit or at settle). A reference supervisor's `validate` and `run` print `release playbook: <path> (N stages, M owner-gated)` or `release playbook: none`.
- **Start.** When every task of a running wave is done or cancelled and the wave has a playbook, a supervisor whose autopilot (§4.6.16) is on for the wave journals `release_started { done, cancelled, playbook: { path, sha256, stages } }` (the stages as read, so the train runs exactly what was journaled) in place of `wave_complete`; the wave's `status` becomes `releasing` and its state carries `release` (§4.6.1). No `wave_complete` decision is opened for it. A releasing wave admits no tasks and accepts no new version; it MAY be paused (it resumes `releasing`) or stopped. Without a playbook, or with autopilot off, the wave completes as before.
- **Stages.** Each stage is entered (`release_stage_entered`), then verified (`release_stage_verified`, only once every `verify` fact holds) or failed (`release_stage_failed`). Before a `gate: owner` stage the supervisor opens `stage_go` and runs the stage only on `go`; that stage is `awaiting_go` meanwhile. Stages run with the same evidence and authority-fence rules as pipeline stages (§4.6.8).
- **The end.** Once every stage is `verified`, the supervisor opens `release_go` (§4.6.2). `release_go` and `stage_go` are owner-only: a supervisor MUST NOT answer either itself, whatever its policy table says (`autopilot.owner_only` names both by default). `go` journals `release_done { by, decision_id }` and the wave becomes `complete`; `hold` (or any other answer) leaves it `releasing` and asks `release_go` again, as a new decision.
- **Production is the owner's.** A supervisor MUST NOT deploy to production as part of a train's automatic run. A deploy-shaped stage asks first with `gate: owner`; nothing after `release_go` runs at all.

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
- **`reaped`** — agent's broker connection terminated (clean shutdown OR crash detected via LWT). Terminal state, published by the broker (via LWT), by the agent itself, or by a supervisor that deletes the agent's login (§4.6.13, no LWT follows a delete). In the last case the supervisor then clears the agent's retained `status`, so only live subscribers and its journal see the `reaped`.

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
    "title": "#42 fix the login redirect loop — implementer",
    "links": { "repo": "example-org/example-repo", "issue": 42 },
    "started_at": "2026-05-14T02:11:23.000Z"
  }
}
```

An agent a supervisor launched under a Claude account profile (§4.6.11) adds `claude_account` (the account id, or `primary`), from its assigned identity (§6.5).

A coordinator session MAY add `coordinator`: a stable name in the agent-id grammar (§2.2), chosen by the person once (the reference MCP server reads it from `VOLLEY_COORDINATOR` and returns it from `vol_register` beside `agent_id`). The agent id of an MCP server changes at every restart; the name does not, so a supervisor lets a wave's `owner` (§4.6.1) be the name and binds it to the newest live registry entry carrying it (§4.6.1). An agent launched with a supervisor-assigned identity (§6.5) never carries one, whatever its environment holds.

An agent MAY add `title`: one line (1 to 120 characters, no line break) saying what it is working on, such as the task or issue it was dispatched for (`#42 T3 fix the login redirect loop — spec review`). It MAY add `links`, references for that purpose: `{ repo?, issue?, pr? }`, where `repo` is `owner/name` and `issue` / `pr` is a number (an issue or pull request in `repo`) or an `http(s)` URL. Both are OPTIONAL; an entry without them is conforming. An agent id says nothing about purpose (a dispatched agent's id is often just its prefix and a random suffix), so a dashboard SHOULD show a wave task's own title (§4.6.1 `spec.tasks.<id>.title`) when the agent has one, else this `title`, as the agent's purpose, with the agent id as a secondary detail. The reference MCP server takes both as `vol_register` arguments.

### 6.3 Requirements

- Conforming agents MUST publish a registry entry retained, QoS 1, before publishing any channel other than the initial `spawning` status.
- The registry entry MUST be re-published on any change to `capabilities`, `cwd`, `model`, `title`, or `links`.
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
- Enforce ACLs on reserved namespaces and per-agent channels. The reference roles (`examples/mosquitto-auth/roles.json`, §4.6.13) let an **agent login** (username = agent id) write only its own channels and registry entry, lease requests, and the mailboxes of the fixed steering identities it acks (§4.4); let steering clients write any mailbox; treats the `coordinator` identity as operator-level (it may also write any agent's standard channels and registry entry, because a coordinator's agent id is random-suffixed); and keeps every topic §4.6 defines under `volley/_waves/*` (including `_waves/_config`) writable by the supervisor only. Because mosquitto's `+` also matches the `_waves` and `_system` levels, that protection covers the topics §4.6 defines, not arbitrary topics under those prefixes. A denied publish is dropped silently by MQTT 3.1.1 brokers, so a client cannot rely on a publish error to detect it

---

## 12. References

- [MQTT v5 specification (OASIS)](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/schema)
- [CloudEvents specification](https://github.com/cloudevents/spec) (analogous thin-spec-on-existing-transport pattern)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) (adjacent protocol; Volley is the inter-agent layer, MCP is the agent-to-tool layer)

---

*End of Volley v0.1 specification.*
