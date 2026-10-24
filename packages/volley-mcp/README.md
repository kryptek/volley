# volley-mcp

```
░▒▓ volley-mcp · the reference MCP server ▓▒░
```

A stdio MCP server that wraps an MQTT broker and exposes Volley's seven coordination tools to any MCP-compatible host (Claude Code today, others as the MCP ecosystem grows).

This is the **reference implementation** — meeting every MUST in [`spec/SPEC.md`](../../spec/SPEC.md) and serving as the conformance benchmark for any other Volley implementation.

---

## Contents

- [Install](#install)
- [The seven tools](#the-seven-tools)
- [Configuration (env vars)](#configuration-env-vars)
- [What happens at startup](#what-happens-at-startup)
- [Architecture](#architecture)
- [Development](#development)

---

## Install

The MCP server runs as a Bun subprocess that Claude Code spawns on demand. There is no separate install or daemon — you register it with Claude Code and it spawns when needed.

From the repo root, after `bun install`:

```sh
claude mcp add-json -s user volley '{
  "command": "bun",
  "args": ["run", "<absolute-path-to-this-repo>/packages/volley-mcp/src/index.ts"],
  "env": {
    "VOLLEY_AGENT_ID": "coordinator",
    "VOLLEY_NAMESPACE": "default"
  }
}'
```

Then quit Claude Code (Cmd-Q) and reopen. Verify with `claude mcp list` — you should see `volley: ... ✓ Connected`.

> **Why not `~/.claude/settings.json`?** Claude Code stores MCP servers separately from `settings.json` and rejects `mcpServers` as an unknown top-level field. Always use the `claude mcp` CLI.

---

## The seven tools

| Tool | Purpose |
|---|---|
| `vol_register` | Publish this agent's retained registry entry. Idempotent — call again to update capabilities/model/cwd/title/links. Optional `title` (one line, ≤ 120 characters): what the agent is working on, which the Desk shows as the agent window's name; optional `links` (`{ repo: "owner/name", issue, pr }`, each a number in `repo` or an http(s) URL), which the Desk renders as links. **Auto-fired on connect** with empty capabilities. |
| `vol_publish` | Publish one envelope to one of this agent's channels (`status`, `progress`, `result`, `_user/*`, etc.). |
| `vol_query` | Fetch the current retained value at an exact topic. |
| `vol_subscribe` | Block until N messages arrive on a topic pattern, or timeout. The synchronous wait primitive. |
| `vol_list_agents` | Enumerate registered agents from `volley/_system/registry/+`. Filterable by namespace; `reaped` agents excluded by default. Each entry carries the registered `title` (or `null`). |
| `vol_tap` | Wildcard subscription with debug-tuned defaults (longer timeout, larger collect cap). For "what's flying past on the broker?" introspection. |
| `vol_send_mailbox` | Deliver a `mailbox` message to another agent. Type one of `steering | cancel | nudge | query | ack`. Returns `message_id`, which is the envelope's `correlation_id` (generated unless you pass one; required for `ack`). Optional `payload.seq` / `payload.supersedes`. With `wait_ack_ms`, it also waits for the recipient's `ack` and returns `acked` / `acked_by`. `delivered` only means the broker sent PUBACK. |

All seven satisfy the SPEC §10 reserved-name list. Three more names (`vol_subscribe_async`, `vol_recv`, `vol_unsubscribe`) are reserved for v0.2+ async paths and **MUST NOT** be redefined by conforming v0.1 implementations.

For the full input schemas, see [`src/server.ts`](src/server.ts) (Zod-defined) or call `tools/list` over the MCP wire.

### Mailbox delivery

Mailbox messages are QoS 1 and **not retained**. The broker only holds one for a recipient that has a persistent session subscribed to its mailbox. The MCP server's own connection is a clean session with a random clientId suffix, and the server does not read its own mailbox, so a recipient needs a separate drain client. `VolleyBroker` supports one:

```ts
await broker.connect({
  url, agentId,
  clientId: `volley-${agentId}-hooks`, // required with cleanSession:false; used verbatim
  cleanSession: false,
  protocolVersion: 5,                   // 4 (default) also works; expiry is v5-only
  sessionExpirySeconds: 604800,         // default DEFAULT_SESSION_EXPIRY_S (7 days)
});
const queued = await broker.drainQueued(`volley/${ns}/${agentId}/mailbox`, { idleMs: 250 });
```

`drainQueued` subscribes at QoS 1, collects until no message has arrived for `idleMs`, and keeps the subscription, so the broker goes on queueing while the client is away. Each persistent consumer needs its own clientId, because a same-clientId connect kicks the older client off. Without a `clientId`, `cleanSession: false` throws `IMPL_CLIENT_ID_REQUIRED`. `VolleyBroker` itself only takes `sessionExpirySeconds`; the hooks drain client (forthcoming) will read it from the runtime tunable `mailbox.session_expiry_s`, with `VOLLEY_SESSION_EXPIRY_S` as the fallback. Dedicate a persistent `VolleyBroker` to draining: messages no other helper claims are buffered until drained, and another helper's release on a not-yet-drained filter would UNSUBSCRIBE the restored subscription. **A changed value applies to new connections only**: an existing session keeps the expiry it was created with until its client reconnects. See SPEC §4.4 for the ack protocol.

---

## Configuration (env vars)

All are optional; sensible defaults apply.

| Env var | Default | Purpose |
|---|---|---|
| `VOLLEY_AGENT_ID` | derived from `cwd` basename | **Prefix** for this MCP server's `agent_id`. The server appends a fresh `-XXXX` (4 chars from `[a-z0-9]`) suffix at every startup, so two MCP processes sharing one user-scope registration get distinct ids automatically. Must match `[a-z0-9][a-z0-9_-]{0,57}`. |
| `VOLLEY_NAMESPACE` | `default` | Logical grouping for the agent's topics. Two namespaces are isolated from each other (e.g. `prod` vs `staging`). Must match `[a-z0-9][a-z0-9_-]{0,62}`; cannot start with `_`. |
| `VOLLEY_BROKER_URL` | `mqtt://localhost:1883` | MQTT connection URL. Use `mqtts://` for TLS. |
| `VOLLEY_PARENT_ID` | `null` | If this agent was spawned by another Volley agent, the parent's `agent_id`. Used to build dispatch trees in `vol_list_agents` output. Subagents should embed this in their spawn brief; don't try to pass it via env when spawning, since Claude Code doesn't propagate parent-process env to MCP subprocesses (see below). |
| `VOLLEY_AUTH_USERNAME` | unset (anonymous) | Broker username (SPEC §11.5). The reference broker config requires one: use `coordinator` for a coordinator session (`volley auth init` prints its password). |
| `VOLLEY_AUTH_PASSWORD` | unset | Broker password for `VOLLEY_AUTH_USERNAME`. Setting it without a username is a startup error. A refused login fails startup with `AUTH_FAILED` and a `volley auth init` hint; the password is never echoed. |

> **Assigned identity (`.volley/agent.json`).** If the server's working directory contains `.volley/agent.json` (written by a supervisor before it starts the agent — SPEC §6.5), the server uses its `agent_id` **verbatim, with no random suffix**, and its `namespace`, `parent_id`, `broker_url` and `broker` credentials (`{ "username", "password" }`, minted per agent by `volley auth add-agent`) when present. Values in the file beat the env vars above; keys missing from the file fall back to env, then defaults. A malformed file or an out-of-grammar `agent_id` stops startup with an error naming the file path (`INVALID_AGENT_ID` for a bad id) instead of silently generating an id. Uniqueness of the assigned id is the supervisor's job (recommended form `<wave>-<task>-<role>-<attempt>`). Schema: [`spec/schemas/agent-identity.schema.json`](../../spec/schemas/agent-identity.schema.json).

> **Note on env propagation.** Claude Code's MCP launcher passes the *registration's* `env` block verbatim to spawned MCP subprocesses. Parent-process `export VAR=...` does **NOT** override that block. If you need to give a child agent a different `VOLLEY_AGENT_ID` prefix, embed the desired prefix in the spawn brief text, not the env. The auto-suffix on every MCP startup means same-prefix processes still get distinct ids, so this is a sharp edge to know about, not a footgun — unless `.volley/agent.json` is present (see above), in which case every process started in that directory uses the same assigned id.

---

## What happens at startup

When Claude Code spawns this MCP server, in order:

1. **`loadConfig()`** — reads env vars, validates against grammar, generates the auto-suffixed `agent_id`.
2. **Connect to broker** — opens an MQTT connection with the LWT pre-armed: if this process dies hard, the broker publishes `{type:"reaped", reason:"disconnect"}` to `volley/<ns>/<id>/status` (retained, QoS 1).
3. **Publish `spawning` status** — retained, QoS 1, on the same status topic.
4. **Auto-register** — publishes the registry entry at `volley/_system/registry/<id>` with `capabilities=[]` and `cwd=process.cwd()`, then flips the status topic to `registered`. This makes the server SPEC §6.3-compliant by default — nothing can publish on other channels until the registry entry exists.
5. **Bind MCP tools** — wires the seven tools onto an `McpServer` instance and connects to stdio transport.

After step 4 the agent is fully visible in `vol_list_agents` everywhere. No manual `vol_register` is required for casual use; call it later only when you want to update `capabilities`, `model`, `cwd`, `title` or `links`.

On clean shutdown (SIGINT/SIGTERM): publishes a terminal `done` status, then `DISCONNECT`s — which suppresses the LWT.

**Presence** (SPEC §7.5) is the retained status topic and nothing else. The agent is online from `spawning` / `registered` (published on connect) until its status is `reaped` (the broker fires the will when the connection drops), `done` or `failed`. Nothing periodic is sent: an idle connected server publishes nothing after `registered`, and the MQTT keepalive that detects a dead connection is the client library's (60 s, SPEC §7.3). `VOLLEY_HEARTBEAT_S`, which once set a `progress` heartbeat interval, is retired: it is ignored, with one line on stderr (#483).

---

## Architecture

Strictly layered, single I/O boundary:

```
src/
  index.ts              stdio entry point
  server.ts             McpServer wiring (binds the 7 tools)
  lifecycle.ts          startLifecycle + shutdownLifecycle
  state.ts              ServerState (config + broker + registered flag)
  config.ts             env parsing + agent_id generation
  broker.ts             ★ the only file that imports `mqtt`
  topics.ts             id/namespace grammar, topic builders, MQTT filter validation
  envelope.ts           envelope build/parse/version-check
  channels.ts           SPEC §4.1 QoS/retain map
  errors.ts             VolleyError + toToolError
  util.ts               randomSuffix, time helpers
  tools/                pure (state, input) => result functions, one per tool
```

**Why this shape:** every "I/O happens" file is `broker.ts`. Every other file is pure. Every tool is a `(state, input) => Promise<result>` function. That makes the unit tests trivial — no mocking the MQTT layer, just spin up an in-process Aedes broker and exercise the real `mqtt.js` client against real MQTT semantics (retained messages, QoS, LWT) without external dependencies.

The `tools/` files don't know about MCP — they take a `ServerState` and an input object, return a result, throw `VolleyError` on failure. `server.ts` is the only file that knows how to bind those into an MCP `McpServer` with Zod input schemas.

---

## Development

```sh
# from this directory:
bun run test                 # all unit tests against in-process Aedes broker
bun run test:integration     # opt-in — real mosquitto required (sets VOLLEY_INTEGRATION=1)
bun run typecheck            # tsc --noEmit
```

The integration test (`test/integration/mosquitto.test.ts`) is opt-in because it needs a real broker on `localhost:1883` (or `VOLLEY_BROKER_URL`). It also covers MQTT v5 persistent sessions, which the Aedes unit-test broker does not support. Locally: `brew services start mosquitto`. Without `VOLLEY_INTEGRATION=1` it self-skips.

To iterate on a single test:

```sh
bunx vitest run test/broker.test.ts                # one file
bunx vitest run test/broker.test.ts -t 'LWT'       # one test by name pattern
```

Cross-package consumers (e.g. `volley-cli`) import via the [`exports` map](package.json) — `volley-mcp/broker`, `volley-mcp/topics`, etc. **Don't reach into `src/` via relative paths**; the exports field is the contract.

---

## License

Apache 2.0. See [`../../LICENSE`](../../LICENSE).
