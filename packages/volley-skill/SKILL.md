---
name: volley
description: Inspect and steer Volley agents running on your local MQTT broker. Five subcommands wrap the volley-mcp tools — /volley list to see who's working, watch to live-tail one, msg to nudge them, inspect to peek at a topic, tap to debug-stream any wildcard.
user_invocable: true
---

# /volley

The Volley protocol's Claude Code interface. The volley-mcp server (see `packages/volley-mcp/`) gives this session seven tools for talking to an MQTT broker; this slash exposes them with human-friendly formatting and agent-handling commands.

## Usage

```
/volley list                              # one-screen overview of all agents in this namespace
/volley list --all-namespaces             # ignore namespace filter
/volley list --include-reaped             # show terminal agents too
/volley list --json                       # machine-readable JSON for tooling
/volley watch <id>                        # live tail one agent's status + progress
/volley watch                             # live tail every active agent
/volley msg <id> <text>                    # send a steering mailbox message
/volley msg <id> --file path.txt          # send the contents of a file
/volley msg <id> --type cancel|nudge|query <text>  # change the mailbox type
/volley inspect <topic|id>                # pull the retained value at a topic (or an agent's status)
/volley tap <pattern>                     # live wildcard subscribe (MQTT filter syntax)
```

## Prerequisites

Before running any subcommand:

1. Confirm the `volley-mcp` server is registered in this Claude Code session. If `vol_list_agents`, `vol_query`, etc. don't appear in the tool list, the user needs to register the MCP server. Claude Code stores MCP servers separately from `settings.json` — they are managed via the `claude mcp` CLI (`mcpServers` is NOT a valid top-level `settings.json` field; the schema validator rejects it). Tell them to run, substituting `<volley-repo>` with their absolute path to the Volley repo (e.g. `~/repos/volley`):

   ```sh
   claude mcp add-json -s user volley '{
     "command": "bun",
     "args": ["run", "<volley-repo>/packages/volley-mcp/src/index.ts"],
     "env": {
       "VOLLEY_AGENT_ID": "coordinator",
       "VOLLEY_NAMESPACE": "default",
       "VOLLEY_AUTH_USERNAME": "coordinator",
       "VOLLEY_AUTH_PASSWORD": "<coordinator password from `volley auth init`>"
     }
   }'
   ```

   `-s user` registers at user scope (available across all projects). Then quit Claude Code completely (Cmd-Q) and reopen — registration is read at startup. Verify with `claude mcp list`; you should see `volley` and "✓ Connected". In a new Claude Code conversation, the seven `vol_*` tools should appear.

   The `env` block sets this MCP server's agent_id **prefix**.
   `vol_register` reads `VOLLEY_AGENT_ID` from env at startup and appends a
   fresh `-XXXX` (4 lowercase-alphanumeric chars from `[a-z0-9]`) suffix — so this Claude Code session's
   agent_id is `coordinator-XXXX` (the suffix changes on each MCP restart).
   Two Claude Code sessions on this machine sharing one user-scope MCP
   registration get DIFFERENT agent_ids (each MCP server picks its own
   suffix), so two coordinators no longer collide. To discover the
   auto-generated id, call `vol_register` (its response includes
   `agent_id`) or `vol_list_agents` and look for the entry whose
   `capabilities` include `coordinator`.

   If `~/.claude/skills/volley/SKILL.md` exists but the MCP isn't registered, also try running `bash <volley-repo>/packages/volley-skill/scripts/install.sh` — the installer prints a ready-to-paste `claude mcp add-json` command with the path already filled in.

2. Confirm the broker is reachable. If any tool call returns `{ code: "BROKER_DOWN" }`, stop and tell the user to start mosquitto: `brew services start mosquitto`. Do NOT retry the tool call until they confirm.

## What You Must Do When Invoked

The user types `/volley <subcommand> [args]`. Parse the first positional as the subcommand. If it doesn't match one of `list`, `watch`, `msg`, `inspect`, `tap`, print the Usage block above and stop. Otherwise, dispatch to the matching section below.

Throughout: respect the `VOLLEY_NAMESPACE` environment variable (read with the Bash tool if needed: `echo $VOLLEY_NAMESPACE`), but allow `--namespace <ns>` to override it. Default namespace is `default`.

### `list` — enumerate agents

The user typed `/volley list [flags]`. Parse these optional flags:

- `--all-namespaces` — boolean. When set, do not filter by namespace.
- `--include-reaped` — boolean. When unset (default), filter out agents whose retained status is `reaped`.
- `--namespace <ns>` — overrides `VOLLEY_NAMESPACE`. Ignored if `--all-namespaces` is set.
- `--json` — emit raw JSON (the tool's response, pretty-printed); skip the human table rendering.

Call the MCP tool:

```
vol_list_agents({
  namespace: <resolved namespace or omit if --all-namespaces>,
  include_reaped: <true if --include-reaped, else false>
})
```

The tool returns `{ agents: AgentSummary[] }` where each `AgentSummary` is:

```json
{
  "agent_id": "issue-42-fix-7a3f",
  "namespace": "example-dispatch",
  "status": "working",
  "parent_id": "coordinator-abcd",
  "cwd": "/private/tmp/example-issue-42",
  "model": "claude-opus-4-7",
  "capabilities": ["implements-issue", "writes-tests"],
  "last_seen": "2026-05-14T02:11:23.000Z"
}
```

`status`, `parent_id`, `cwd`, and `model` may be `null` (the registry entry exists but the field wasn't populated, or no retained status exists yet). Render `null` as `-` in the table.

**If `--json` is set:** print `JSON.stringify(result.agents, null, 2)` and stop. (Unwrap the `agents` field; downstream consumers expect a top-level array.)

**Otherwise**, render a fixed-column table with these columns (skip a column if every row's value is empty):

```
AGENT_ID                NAMESPACE      STATUS        PARENT                  CWD                            LAST_SEEN
issue-42-fix-7a3f      example-dispatch   🔄 working    coordinator-abcd     /private/tmp/example-issue-42     2m ago
volley-cli-spec-aaaa    default        ✅ done       -                       /Users/x/repos/volley           14s ago
```

Status emoji map (apply to the `status` column):

| Status | Emoji |
|---|---|
| `working` | 🔄 |
| `done` | ✅ |
| `blocked` | ⛔ |
| `failed` | ❌ |
| `reaped` | 💀 |
| `spawning` / `registered` | ⏳ |

`last_seen` should be rendered as a relative duration ("14s ago", "2m ago", "1h ago") based on the difference between `last_seen` and the current wall clock. Compute it in your head or via a Bash one-liner — do not invent values when `last_seen` is missing; print `-` instead.

Empty registry: print `(no agents registered)` and stop. Don't render an empty table.

BROKER_DOWN: if `vol_list_agents` returns `{ code: "BROKER_DOWN" }`, the broker was unreachable at the moment the tool was called — there is no separate pre-flight check. Print the friendly error message and the install hint (`brew services start mosquitto`) and stop; do NOT retry.

### `watch` — live tail

The user typed `/volley watch [<id>]`. The argument is optional:

- **With `<id>`**: live-tail a single agent's `status` + `progress` channels.
- **Without `<id>`**: live-tail every active agent in the namespace.

Resolve the namespace (env or `--namespace` flag, default `default`). Optional flags:

- `--namespace <ns>` — overrides `VOLLEY_NAMESPACE`.
- `--max-messages <n>` — cap the number of messages to surface (default: 100).
- `--timeout <seconds>` — give up after N seconds (default: 3600 = 1 hour).

Call the MCP tool with a topic pattern derived from the args:

| Args | Topic pattern |
|---|---|
| `/volley watch agent-xyz-aaaa` | `volley/<ns>/agent-xyz-aaaa/+` (both status and progress) |
| `/volley watch` (no id) | `volley/<ns>/+/status` (status of every agent — progress would be too chatty) |

```
vol_subscribe({
  topic_pattern: "<pattern>",
  max_messages: <flag value or 100>,
  timeout_ms: <flag value × 1000 or 3600000>
})
```

The tool returns `{ messages: CollectedMessage[] }` where each message is `{ topic, envelope, raw }` — `envelope` is the parsed envelope object (or `null` on malformed payload); `raw` is the original payload string. For each record:

- Color-code the line by `envelope.type` matching the status emoji map from `list`.
- Format as: `[wall_time] <emoji> <agent_id> <channel> <type>  <short payload summary>`.
- For `progress` events, render `payload.msg` (the narration string the volley-dash card binds to) alongside `payload.progress` (the percent). The field is literally `msg` — `message` and `milestone` are NOT read by the dashboard (`volley-dash/src/state/envelope-to-actions.ts`).
- **If `envelope` is null** (malformed payload): derive `<agent_id>` and `<channel>` from the topic — `volley/<ns>/<agent_id>/<channel>` is the grammar, so the 3rd and 4th `/`-segments are what you want. Render as `[now] ❓ <agent_id> <channel> (unparseable)  <raw>` and continue. A null envelope is NOT a terminal status, even if the topic is `<id>/status` — keep watching.

Example output for a single-agent watch:

```
[02:11:23] ⏳ issue-42-fix-7a3f  status  spawning
[02:11:24] 📋 issue-42-fix-7a3f  status  registered
[02:11:25] 🔄 issue-42-fix-7a3f  status  working
[02:13:01] 📡 issue-42-fix-7a3f  progress  tests-green
[02:13:42] 📡 issue-42-fix-7a3f  progress  mvn-verify-done
[02:14:12] ✅ issue-42-fix-7a3f  status  done
```

Use 📋 for `registered` and 📡 for `progress`.

**Exit conditions** (the tool returns when ANY of these fires; report which one to the user before stopping):

- A terminal `status` (`done`, `blocked`, `failed`, `reaped`) is observed for the watched agent. Single-agent case only.
- `--max-messages` reached.
- `--timeout` elapsed.

In the multi-agent case (no `id`), the tool just stops at the message/timeout cap — there's no single terminal to wait for.

BROKER_DOWN: same handling as `list`.

### `msg` — send a mailbox message

The user typed `/volley msg <id> [body|flags]`. Required positional: the agent id. Then ONE of:

- A free-text body (the rest of the line after `<id>`), used as `payload.text`.
- `--file <path>` — read the file and use its content as `payload.text`.

Optional flags:

- `--type steering|cancel|nudge|query` — mailbox `type` (default: `steering`).
- `--correlation-id <uuid>` — if you want the agent's response correlated.
- `--namespace <ns>` — overrides `VOLLEY_NAMESPACE`.

The mailbox channel's `type` enum is one of `steering | cancel | nudge | query` per SPEC §4.4. Reject any other `--type` value with a usage error and stop.

If both a free-text body AND `--file` are provided, prefer `--file`. Print `(note: free-text body was ignored; using --file)` on its own line BEFORE the success confirmation. Don't ask the user to choose — pick `--file` and tell them what you did.

Resolve the namespace from env / `--namespace` (default `default`).

Call the MCP tool. Note the field name is `to_agent_id` (the recipient — the topic addresses them); the *sender* is implicit from the MCP session's registered agent_id, you don't pass it.

```
vol_send_mailbox({
  to_agent_id: "<id>",
  type: <resolved type or "steering">,
  payload: { text: <body or file contents> },
  correlation_id: <flag value or null>
})
```

On success, the tool returns `{ message_id: "<uuid>", delivered: true }`. Build a confirmation line by computing the topic locally and recording the wall clock:

```
sent to volley/<ns>/<id>/mailbox  (type: <type>, body: <first 60 chars + …>, message_id: <uuid>)
```

**Confirm with the user before sending a `cancel` mailbox** — type:cancel is destructive (asks the agent to abort). Skip the confirmation for steering / nudge / query.

For `--type cancel`, BEFORE invoking the tool, print exactly:

```
About to send a cancel mailbox to <id>:
  topic:   volley/<ns>/<id>/mailbox
  type:    cancel
  body:    <first 200 chars of the body, then "…" if truncated>

This asks the agent to abort its current task. Type "yes" to confirm; anything else cancels.
```

Then wait for the user's next message. If their reply, lowercased and trimmed, equals exactly `yes`, proceed with the `vol_send_mailbox` call. For any other response (including empty), print `Cancelled.` and stop without invoking the tool.

INVALID_AGENT_ID: if the id doesn't match the grammar, fail before the tool call with `agent_id "..." does not match [a-z0-9][a-z0-9_-]{0,62}`.

NOT_REGISTERED: if `vol_send_mailbox` returns `{ code: "NOT_REGISTERED" }`, the MCP session has no registered agent — `vol_register` hasn't been called yet. Tell the user what happened. Then call `vol_register({ capabilities: [] })` directly via the MCP tool (the empty-capabilities call is fine for ad-hoc sessions; `vol_register` reads `agent_id` and `namespace` from the MCP server's env vars, not from arguments). Retry the `msg` once registration succeeds. Do not auto-retry without registering; surface the gap so the user understands the session state.

BROKER_DOWN: same handling as `list`.

### `inspect` — read a retained topic

The user typed `/volley inspect <target>`. The single positional `<target>` is interpreted in this order:

1. **If it contains `/`**, it's a full topic — pass through to `vol_query` unchanged.
2. **Otherwise it's an agent id** — expand to `volley/<ns>/<target>/status`.

Resolve the namespace from env / `--namespace` (default `default`).

Call:

```
vol_query({ topic: "<resolved topic>" })
```

The tool returns `{ topic, payload, last_seen }`. `payload` is `unknown` typed — it's either the parsed envelope object (when the retained payload was valid envelope JSON), the original payload string (when the retained value was not envelope-shaped — e.g. someone wrote raw text), or `null` (no retained value at this topic).

**If `payload` is null**: print `(no retained value at <topic>)` and stop.

**If `payload` is a string** (non-envelope retained value): print the topic on one line, then `[unparseable retained payload]` then the string verbatim. No `last_seen` line (it's null when payload is a non-envelope string).

**If `payload` is an object** (parsed envelope):

1. Print the topic on the first line.
2. Pretty-print the envelope with 2-space indent (`JSON.stringify(payload, null, 2)`). The tool already parsed it; do not re-parse.
3. Compute a relative "X ago" duration from `last_seen` and print it as a final line: `last seen: 2m ago`.

Example output:

```
volley/default/issue-42-fix-7a3f/status
{
  "schema_version": "0.1",
  "agent_id": "issue-42-fix-7a3f",
  "wall_time": "2026-05-14T02:11:23.000Z",
  "channel": "status",
  "type": "working",
  "payload": { "started_at": "2026-05-14T02:11:23.000Z" }
}
last seen: 4m ago
```

**Reserved-namespace targets**: `vol_query` does not refuse reads of reserved topics (read is safe; only write is restricted by SPEC §2.4). If the user explicitly inspects `volley/_system/registry/<id>`, render the registry envelope normally. This is the canonical way to confirm "did this agent ever register?".

BROKER_DOWN: same handling as `list`.

### `tap` — wildcard debug stream

The user typed `/volley tap <pattern> [flags]`. The single positional `<pattern>` is an MQTT topic filter (e.g. `volley/+/+/status`, `volley/example-dispatch/#`). Validate the filter format BEFORE invoking the tool:

- Must be non-empty and contain no spaces.
- `#` may only appear at the end of the filter.
- `+` and `#` must be single-segment (no `+abc` or `abc#`).

If the filter is malformed, print `invalid topic filter "..."` and stop. (Don't invent a sanitised version.)

Optional flags:

- `--max-messages <n>` — default 100.
- `--timeout <seconds>` — default 60 (taps are debug tools; a long timeout encourages people to use `watch` instead).

Call:

```
vol_tap({
  topic_pattern: "<filter>",
  max_messages: <flag or 100>,
  timeout_ms: <flag × 1000 or 60000>
})
```

The tool returns `{ messages: TapMessage[] }` where each `TapMessage` is `{ topic, envelope, raw }` — `envelope` is the parsed envelope object (or `null` if the payload wasn't valid envelope JSON); `raw` is the original payload string. For each record:

- Print the topic, then a tab, then `JSON.stringify(envelope)` if it parsed (i.e. `envelope !== null`), else `[unparseable] <raw payload as string>`.
- One record per line; the goal is `jq` / `grep` -friendliness, so emit JSONL-shaped output rather than pretty-printed indentation.

Example output:

```
volley/default/issue-42-fix-7a3f/status	{"schema_version":"0.1","agent_id":"issue-42-fix-7a3f","type":"working",...}
volley/default/issue-42-fix-7a3f/progress	{"schema_version":"0.1","agent_id":"issue-42-fix-7a3f","type":"tests-green",...}
volley/_meta/cli/cli-r4mq9wpe/will	[unparseable] (empty payload)
```

After the listing, print a summary line: `(<n> messages; exited on <max-messages|timeout>)`.

**Do not auto-pretty-print**: `tap` is a debug tool, not a UX tool — keep the output greppable. If the user wants pretty-printing, they can pipe through `jq`.

BROKER_DOWN: same handling as `list`.

## Cross-cutting rules

These apply across every subcommand. When in doubt, follow the rule.

**Status emoji map** (use these consistently across `list`, `watch`, `inspect`):

| Status | Emoji | Meaning |
|---|---|---|
| `spawning` | ⏳ | Broker connection in flight; LWT armed |
| `registered` | 📋 | Registry entry exists; not yet `working` |
| `working` | 🔄 | First user-controlled state |
| `done` | ✅ | Terminal: success |
| `blocked` | ⛔ | Terminal: needs external input |
| `failed` | ❌ | Terminal: unrecoverable error |
| `reaped` | 💀 | Broker observed disconnect (LWT or graceful) |
| `progress` (any) | 📡 | Streaming progress event |

(`list` collapses `spawning` and `registered` to ⏳ in its summary table to keep the STATUS column narrow; `watch` and `inspect` use the per-state emoji above. `progress` 📡 only appears in live-tail output, not in `list`.)

**Namespace resolution** (every subcommand that touches a namespace):

1. If the user passed `--all-namespaces`, omit the namespace from the tool call (where the tool supports it).
2. Else, if the user passed `--namespace <ns>`, use that.
3. Else, if `$VOLLEY_NAMESPACE` is set in the environment, use that.
4. Else, use `default`.

Validate the resolved namespace against `^[a-z0-9][a-z0-9_-]{0,62}$` per SPEC §2.1. If invalid, refuse with `namespace "..." does not match [a-z0-9][a-z0-9_-]{0,62}` before calling any tool.

**Exact agent id matching only.** Never prefix-expand. If the user types `/volley watch issue-929` and the real agent is `issue-42-fix-7a3f`, that's a typo on their end. Don't be helpful — make them type the right id. (Rationale: prefix expansion bites when two agents share a prefix.)

**BROKER_DOWN handling.** Any tool call may return `{ code: "BROKER_DOWN" }`. When you see it:

1. Print: `volley: cannot reach broker — make sure mosquitto is running.`
2. Print: `  → brew services start mosquitto`
3. Stop. Do NOT retry, do NOT auto-start the broker yourself.

**Reserved-namespace writes refused** (`pub`-style writes are not in this skill, but `msg` writes to mailboxes). If a write tool returns `{ code: "RESERVED_TOPIC_WRITE" }`, that's a bug in this skill — surface the error verbatim and link the user to the SKILL.md.

**Schema-version mismatch.** If an incoming envelope's `schema_version` major is not `0`, surface a single line: `(envelope schema_version "<v>" not understood — Volley v0.1 implementation)` and continue with the next message. Don't silently swallow. (Applies to `watch`, `tap`, `inspect` — the subcommands that surface raw envelopes; `list` and `msg` don't show envelope payloads.)

**Output limits.** Long lists / streams should be truncated at ~50 lines per subcommand call. After truncation, print: `... (<n> more rows; use --max-messages or --json to widen)`. The 50-line cap is a *rendering* limit applied AFTER the tool returns — it does not change the `--max-messages` argument sent to the tool. To constrain the tool call itself (saving broker work + bandwidth), pass an explicit `--max-messages` smaller than the default.

**Color in terminals**: Claude Code's terminal supports emoji; the status emoji map above is the entire colour story for v0.1. Don't use ANSI escapes.
