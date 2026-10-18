---
name: volley-wait
description: Block a Claude Code session event-driven on a Volley topic until a terminal status or matching message fires. Wraps `volley wait` (agent-id targets) and `volley sub` (topic-pattern targets) as a backgrounded bash process; the harness fires a task-notification on exit so the conversation resumes within ~1s of the event.
user_invocable: true
---

# /wait

Replaces the polling-loop pattern (ScheduleWakeup, `sleep N; check`, etc.) with an event-driven block on a single MQTT topic or topic pattern. The skill backgrounds a `volley wait` or `volley sub` process, then yields control. When that process exits — because a terminal status was published, a matching message arrived, the timeout elapsed, or the broker rejected the subscription — the Claude Code harness fires a task-notification and the skill resumes, prints a one-line summary, and returns.

## Usage

```
/wait <target> [options]
```

`<target>` is one of:

- **An agent_id** (e.g. `coordinator-7b9c`). The skill expands this to `volley/<ns>/<agent_id>/status` and waits for a terminal-type message. Matches the SPEC §2.2 grammar `[a-z0-9][a-z0-9_-]{0,62}` — no slashes.
- **An MQTT topic pattern** (e.g. `volley/+/+/status`, `volley/ci/+/status`, `volley/team/build-+/done`). Anything containing a `/` is treated as a pattern and waits for any matching message.

### Flags

| Flag | Default | Purpose |
|---|---|---|
| `--terminal-states <csv>` | `done,blocked,failed,reaped` | For agent_id targets: which envelope `type` values end the wait. Ignored for pattern targets. |
| `--max-messages <n>` | `1` | For pattern targets: stop after N matching messages. Ignored for agent_id targets. |
| `--timeout <seconds>` | `3600` | Give up after N seconds. |
| `--namespace <ns>` | `$VOLLEY_NAMESPACE` or `default` | Override namespace. Only used to build the topic for agent_id targets; ignored for pattern targets (the pattern is taken verbatim). |

## Prerequisites

Before invoking:

1. **`volley` CLI on `$PATH`.** The skill shells out to `volley wait` and `volley sub`. Verify with `which volley`; if missing, install via the volley-cli workspace package (see `packages/volley-cli/README.md`).
2. **A reachable MQTT broker.** Default is `mqtt://localhost:1883`. Override with `$VOLLEY_BROKER_URL`. If the broker is unreachable, the backgrounded `volley` process exits non-zero within ~1s with a `BROKER_DOWN` stderr line; the skill surfaces that as a broker-error result.
   **Credentials:** the reference broker config requires a login. The CLI reads `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD` (or `./.volley/agent.json`'s `broker` block) — export them in your shell profile, because a Claude Code MCP registration's `env` block does not reach the Bash tool. Without them the process exits `1` with `AUTH_FAILED` within ~1s, which the skill also surfaces as a broker-error result (never as a wake).
3. **The `volley-wait` skill installed.** Run `bash packages/volley-wait/scripts/install.sh` from the repo root once; this symlinks the package into `~/.claude/skills/volley-wait/`. Then quit Claude Code (Cmd-Q) and reopen — skills are discovered at startup.

This skill does **not** require the `volley-mcp` MCP server to be registered. The CLI talks to MQTT directly.

## What You Must Do When Invoked

The user types `/wait <target> [options]`. Follow these steps exactly.

### 1. Parse arguments

The first positional argument is `<target>`. Anything starting with `--` is a flag. If `<target>` is missing or equals `--help`/`-h`, print the Usage block above and stop.

Recognise these flags only: `--terminal-states`, `--max-messages`, `--timeout`, `--namespace`. Any other flag is a usage error — print `unknown flag: <flag>` and the Usage block, then stop.

### 2. Resolve the namespace

1. If `--namespace <ns>` was passed, use it.
2. Else, read `$VOLLEY_NAMESPACE` from the environment (use the Bash tool: `echo "${VOLLEY_NAMESPACE:-}"`).
3. Else, use `default`.

Validate the resolved namespace against `^[a-z0-9][a-z0-9_-]{0,62}$` (SPEC §2.1). If invalid, refuse with `namespace "<ns>" does not match [a-z0-9][a-z0-9_-]{0,62}` and stop.

### 3. Detect target shape

- If `<target>` contains a `/`, treat it as an **MQTT topic pattern**. Skip to step 4b.
- Else, validate it against `^[a-z0-9][a-z0-9_-]{0,62}$` (the agent_id grammar). If it matches, treat it as an **agent_id** and continue to step 4a. If it does not match, refuse with `target "<target>" is neither a valid agent_id nor a topic pattern (contains no '/')` and stop.

### 4a. agent_id target — background `volley wait`

Build the command:

```sh
volley wait --agent-id <target> --namespace <ns> --terminal-states <csv> --timeout <seconds>
```

Where:
- `<csv>` is the value of `--terminal-states` if set, else `done,blocked,failed,reaped`.
- `<seconds>` is `--timeout` if set, else `3600`.

Use the Bash tool's `run_in_background: true` parameter to launch it. **Do not** wait for the bash call to return synchronously — that defeats the entire purpose of the skill. The Bash tool returns a shell ID immediately; the harness fires a notification when the process exits.

Record the shell ID. Tell the user (one line) something like: `Waiting for <target> to reach one of [<terminal-types>] (timeout: <seconds>s)...`. Then return control to the user. The conversation can continue with unrelated work.

### 4b. pattern target — background `volley sub`

Build the command:

```sh
volley sub --pattern <target> --max-messages <n> --timeout <seconds>
```

Where:
- `<n>` is `--max-messages` if set, else `1`.
- `<seconds>` is `--timeout` if set, else `3600`.

Note: `volley sub` does **not** take a namespace flag — the pattern is the complete topic filter. The skill never injects the namespace into a pattern target; the user is responsible for writing the filter they want.

Launch with `run_in_background: true` exactly as in step 4a. Tell the user: `Waiting for messages matching <pattern> (max: <n>, timeout: <seconds>s)...`. Return control.

### 5. Resume on notification

When the backgrounded bash exits, the harness fires a task-notification. On resume, read the shell's exit code and final stdout/stderr (use the Bash tool with `BashOutput`-style access to the shell ID you recorded).

Map the result and print exactly one summary line:

| Exit code | stdout / stderr signal | Print |
|---|---|---|
| `0` | `volley wait`: stdout contains JSON `{"agent_id":"...","terminal_type":"<type>",...}` | `✅ <target> reached <type>` |
| `0` | `volley sub`: collected `--max-messages` messages (each one is a JSON line on stdout) | `✅ <target> received <n> matching message(s)` |
| `124` | exit 124 alone (`volley wait` additionally emits `timeout after <n>s` on stderr; `volley sub` does not — rely on the exit code, not the stderr text) | `⏰ timeout after <n>s — no matching message` |
| `1` | stderr typically starts with `volley: cannot connect to broker at <url>: ...` or includes `Hint: install mosquitto` | `❌ broker error: <first line of stderr>` — and append `  → brew services start mosquitto` if the stderr mentions `cannot connect to broker` or `Hint: install mosquitto` |
| `2` | usage error from the CLI (should not happen if the skill validated args properly) | `❌ usage error from volley CLI: <first line of stderr>` |
| anything else | unknown | `❌ unexpected exit (<code>): <first line of stderr>` |

Use the `--terminal-states` CSV value and the wait-target literal verbatim in the summary line.

Then stop. The wait is complete.

### 6. Exit conditions (summary)

| Exit shape | Cause |
|---|---|
| terminal-type observed | Per `--terminal-states` for agent_id, or first `--max-messages` matches for patterns |
| timeout | `--timeout` elapsed before any matching event |
| broker error | Mosquitto unreachable, malformed pattern, or `volley` CLI not installed |

## Examples

**Wait for a coordinator to reach done:**

```
/wait coordinator-7b9c
```

Blocks until `volley/default/coordinator-7b9c/status` carries an envelope with `type ∈ {done, blocked, failed, reaped}`. Default 1h timeout.

**Wait only for success or failure (not blocked/reaped):**

```
/wait coordinator-7b9c --terminal-states done,failed --timeout 600
```

**Wait for 3 status events from any agent in the `ci` namespace:**

```
/wait volley/ci/+/status --max-messages 3 --timeout 1800
```

**Wait for a GitHub Actions bridge to publish:**

Pair with `examples/bridges/github-actions/publish-status.sh`. The bridge publishes to `volley/ci/gh-<owner>-<repo>-<run-id>/status`; the developer's Claude Code session does:

```
/wait gh-kryptek-volley-7891234567 --namespace ci
```

## Notes

- **No polling.** This skill exists specifically to replace the `sleep N; check status; sleep N; check status` loop pattern. If you find yourself adding `sleep` calls around it, you're using it wrong.
- **One wait per `/wait` invocation.** If you need to wait for multiple independent events in parallel, invoke `/wait` once per event in separate Claude Code conversations; the backgrounded shells are per-conversation.
- **The skill does not register an agent.** It only subscribes. No retained data is written; the wait is purely observational.
- **Output is one line.** The wait result is always a single emoji-prefixed summary line — keeping it terse so a sequence of waits stays scannable in the transcript.
