# Volley Protocol Specification

**Version:** 0.1 (pre-1.0; wire compatibility NOT guaranteed across 0.x minor versions)
**Status:** Draft
**License:** Apache 2.0
**Website:** https://volley.systems
**Repository:** https://github.com/<TBD-at-launch>/volley

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
process start. The recommended mechanism is:

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
the agent_id is not knowable ahead of time. Discovery options:

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

### 2.3 Channel

`channel` is one of the reserved channel names listed in §4.1, OR a user-defined channel under the `_user/*` prefix.

### 2.4 Reserved namespaces

The following top-level namespace prefixes are reserved:

- `volley/_system/*` — protocol-level state (registry, broker health, federation config)
- `volley/_meta/*` — implementation tooling (debug taps, replay logs, capture files)

Implementations MUST NOT publish user-space messages under these prefixes.

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
- **`channel`** (string) — one of the reserved channels (§4.1) or a `_user/*`-prefixed user channel.
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
| `mailbox` | 1 | no | Inbound requests / commands directed at this agent. Must-deliver. The topic's `<agent_id>` segment identifies the recipient; the envelope's `agent_id` (§3.1) identifies the sender. |
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
- Publish a `result` retained message before terminal `status` so late-attaching tools can see the artifact pointer

### 4.4 Mailbox message types

The `mailbox` channel's `type` field is one of:

- `steering` — free-text guidance to redirect or inform the agent
- `cancel` — request the agent to abort its current task
- `nudge` — a lightweight prod to re-evaluate or report status
- `query` — a question expecting a response (typically correlated via `correlation_id`)

This list matches the `type` enum in `spec/schemas/mailbox.schema.json`.

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

### 6.3 Requirements

- Conforming agents MUST publish a registry entry retained, QoS 1, before publishing any channel other than the initial `spawning` status.
- The registry entry MUST be re-published on any change to `capabilities`, `cwd`, or `model`.
- When the LWT fires, the broker publishes `reaped` to the agent's `status` topic but does NOT clear the registry topic — that allows tools to inspect the agent's last-known state after death. Observers SHOULD filter out reaped agents in default views.

### 6.4 Enumeration

To enumerate all registered agents, subscribe to:

    volley/_system/registry/+

The broker delivers all retained registry entries; filter by namespace on the `payload.namespace` field.

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

- Subscribe to their own `mailbox` and respond to steering messages (§4.1)
- Spawn sub-agents with `parent_id` set to their own `agent_id` (§3.2)
- Define user channels under `_user/*` (§4.2)

### 11.4 Conforming brokers MUST

- Be an MQTT v3.1.1 or v5 broker, or equivalent (transport-agnostic — see §1)
- Support retained messages, wildcard subscriptions (`+`, `#`), QoS 1, and LWT
- Permit anonymous localhost connections (deployment MAY require auth elsewhere)

### 11.5 Conforming brokers MAY

- Require username/password or mTLS authentication (clients MUST honor `VOLLEY_AUTH_*` env vars when set)
- Enforce ACLs on reserved namespaces

---

## 12. References

- [MQTT v5 specification (OASIS)](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)
- [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/schema)
- [CloudEvents specification](https://github.com/cloudevents/spec) (analogous thin-spec-on-existing-transport pattern)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) (adjacent protocol; Volley is the inter-agent layer, MCP is the agent-to-tool layer)

---

*End of Volley v0.1 specification.*
