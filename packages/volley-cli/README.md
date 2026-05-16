# volley-cli

```
░▒▓ volley · the CLI for shell-script agents and CI ▓▒░
```

A small, fast CLI that lets shell scripts, cron jobs, CI runners, and any non-LLM process participate in Volley's coordination protocol — alongside Claude Code, Codex, and other MCP-driven agents.

If you can write a bash one-liner, you can be a Volley agent. The four subcommands cover everything: announce a status, watch for terminal states, subscribe to a stream, list who's around.

---

## Contents

- [Install](#install)
- [The five subcommands](#the-five-subcommands)
- [`volley dash`](#volley-dash)
- [Common patterns](#common-patterns)
  - [Be a one-shot agent in CI](#be-a-one-shot-agent-in-ci)
  - [Background-wait for an agent and react](#background-wait-for-an-agent-and-react)
  - [Pipe sub output through `jq`](#pipe-sub-output-through-jq)
- [Global flags](#global-flags)
- [Exit codes](#exit-codes)
- [Per-subcommand reference](#per-subcommand-reference)

---

## Install

The CLI ships as a Bun-runnable TypeScript file. From the repo root, after `bun install`:

```sh
# Run directly via bun:
bun run packages/volley-cli/src/cli.ts --help

# Or symlink for global access:
ln -s "$PWD/packages/volley-cli/src/cli.ts" /usr/local/bin/volley
volley --help
```

> Bun runs `.ts` natively — no build step. The shebang on `cli.ts` is `#!/usr/bin/env bun`, so the symlinked version invokes Bun automatically.

---

## The five subcommands

| Subcommand | Purpose |
|---|---|
| `volley pub`  | Publish one envelope to a channel. The publish-side primitive. |
| `volley sub`  | Subscribe to a wildcard topic pattern. JSONL output, one message per line. |
| `volley wait` | Block until a specific agent reaches a terminal status (`done`/`blocked`/`failed`/`reaped`). The "is it done?" primitive. |
| `volley list` | Enumerate agents in a namespace (or all namespaces). Human table by default; `--json` for tooling. |
| `volley dash` | Launch the browser dashboard (Vite dev server). See [`volley dash`](#volley-dash) below. |

Each has its own `--help`:

```sh
volley pub --help
volley sub --help
volley wait --help
volley list --help
volley dash --help
```

---

## `volley dash`

Launches the [`volley-dash`](../volley-dash/) browser dashboard — a live view of every registered agent (status grid + event feed + per-agent drawer) that subscribes directly to your mosquitto broker over WebSocket. No backend.

```sh
volley dash                          # dev server, opens browser at http://localhost:5173
volley dash --no-open                # dev server, don't open browser
volley dash --build                  # production build + preview
volley dash --broker-url ws://host:9001  # point at a non-default broker
```

**Prerequisite:** mosquitto must have a WebSocket listener on `:9001` — the bundled `examples/mosquitto-localhost.conf` configures it. If `lsof -nP -iTCP:9001 -sTCP:LISTEN` returns nothing, see the root [README §2](../../README.md) for the install + upgrade steps.

---

## Common patterns

### Be a one-shot agent in CI

A CI step that publishes its own status to the broker so a coordinator (or a dashboard) can react to it:

```sh
#!/usr/bin/env bash
set -euo pipefail

AGENT_ID="ci-$(uuidgen | tr '[:upper:]' '[:lower:]' | head -c 8)"
NAMESPACE="ci"

# Announce we're working
volley pub --agent-id "$AGENT_ID" --namespace "$NAMESPACE" \
  --channel status --type working \
  --payload "{\"job\": \"$GITHUB_JOB\", \"sha\": \"$GITHUB_SHA\"}"

# Do real work
if make test; then
  volley pub --agent-id "$AGENT_ID" --namespace "$NAMESPACE" \
    --channel status --type done \
    --payload '{"summary": "all green"}'
else
  volley pub --agent-id "$AGENT_ID" --namespace "$NAMESPACE" \
    --channel status --type failed \
    --payload '{"reason": "make test failed"}'
  exit 1
fi
```

A coordinator running `/volley list --namespace ci` now sees this CI run live, with status, summary, and last-seen time.

### Background-wait for an agent and react

Background a `wait` per dispatched agent. The shell exit fires when the agent reaches terminal — your script wakes up the moment it happens:

```sh
volley wait --agent-id worker-abcd --terminal-states done,failed --timeout 1800 &
WAIT_PID=$!

# ... do other things ...

wait "$WAIT_PID"
EXIT=$?

if [[ $EXIT -eq 0 ]]; then
  echo "worker-abcd finished — fetching its result"
  volley pub --agent-id coordinator-xxx --channel _user/notify --type ready \
    --payload "{\"watched\":\"worker-abcd\"}"
elif [[ $EXIT -eq 124 ]]; then
  echo "worker-abcd timed out — investigating"
fi
```

Exit code `124` is the standard Unix timeout convention; `0` means a terminal state was observed.

### Pipe `sub` output through `jq`

`sub` emits JSONL — one `{topic, envelope, raw}` object per line. Trivially `jq`-friendly:

```sh
# All terminal events on the prod namespace, formatted
volley sub --pattern 'volley/prod/+/status' --max-messages 50 --timeout 30 \
  | jq -r 'select(.envelope.type | IN("done","failed","reaped"))
           | "\(.envelope.wall_time)  \(.envelope.agent_id)  \(.envelope.type)"'

# Only progress events, just the milestone
volley sub --pattern 'volley/prod/+/progress' --max-messages 100 --timeout 60 \
  | jq -r '"\(.envelope.agent_id)  \(.envelope.type)"'
```

---

## Global flags

These work on every subcommand and respect env vars as fallbacks:

| Flag | Env | Default |
|---|---|---|
| `--broker-url <url>` | `VOLLEY_BROKER_URL` | `mqtt://localhost:1883` |
| `--namespace <ns>` | `VOLLEY_NAMESPACE` | `default` |
| `--help` | — | — |
| `--version` | — | prints version |

---

## Exit codes

Standardized across subcommands so shell scripts can branch cleanly:

| Code | Meaning |
|---|---|
| `0` | success — operation completed |
| `1` | broker error or unexpected runtime failure |
| `2` | invalid usage (bad flags, missing required args) |
| `124` | `wait`/`sub` timeout elapsed before the desired condition |

`124` matches GNU `timeout(1)`'s exit-code convention so `wait` composes naturally with shell tools that already know about it.

---

## Per-subcommand reference

### `volley pub`

```
Usage: volley pub --agent-id <id> --channel <name> --type <type> [options]

Required:
  --agent-id <id>        Agent identifier (the topic-segment id)
  --channel <name>       One of: status, progress, mailbox, control, result,
                         capability, _user/<name>
  --type <type>          Channel-specific event type (e.g. "done" on status,
                         "tests-green" on progress)

Optional:
  --payload <json>       JSON object literal (default: {})
  --parent-id <id>       Parent agent_id (for dispatch trees)
  --correlation-id <id>  UUID v4 to correlate request/response pairs
```

### `volley sub`

```
Usage: volley sub --pattern <mqtt-filter> [options]

Required:
  --pattern <filter>     MQTT topic filter, e.g. "volley/+/+/status"

Optional:
  --max-messages <n>     Stop after N messages (default: 100)
  --timeout <seconds>    Stop after N seconds (default: 30)

Output:
  One JSON line per message:
    {"topic": "...", "envelope": <parsed> | null, "raw": "<str>"}
```

### `volley wait`

```
Usage: volley wait --agent-id <id> [options]

Required:
  --agent-id <id>          The agent whose status channel to watch

Optional:
  --terminal-states <csv>  Comma-separated states that end the wait
                           (default: done,blocked,failed,reaped)
  --timeout <seconds>      Give up after N seconds (default: 3600)

Output:
  On terminal: one JSON line
    {"agent_id":"...","terminal_type":"...","wall_time":"..."}
```

### `volley list`

```
Usage: volley list [options]

Optional:
  --namespace <ns>        Filter to one namespace (default: default)
  --all-namespaces        Ignore namespace and list every registered agent
  --include-reaped        Include agents whose retained status is "reaped"
  --json                  Emit a JSON array instead of a human table
  --timeout <seconds>     Time to wait for retained entries to arrive (default: 2)
```

The default human table renders status as an emoji and `last_seen` as a relative duration:

```
AGENT_ID                NAMESPACE      STATUS        PARENT                  LAST_SEEN
coordinator-a3f1        default        🔄 working    -                       2m ago
worker-7b9c             default        ✅ done       coordinator-a3f1        14s ago
ci-abc12345             ci             🔄 working    -                       8s ago
```

### `volley dash`

```
Usage: volley dash [options]

Optional:
  --build                 Run vite build + preview the production bundle
  --port <N>              Override Vite's port (default: Vite's default 5173)
  --broker-url <url>      MQTT broker URL passed to the dashboard via
                          VITE_VOLLEY_BROKER_URL (default: ws://localhost:9001)
  --open / --no-open      Open the browser on start (default: --open in dev mode)
```

Spawns Vite as a child process; passes the broker URL through as a build-time env var so the bundled JS hardcodes it. The dashboard subscribes to `volley/_system/registry/+` (retained) plus the four status/progress/mailbox/result wildcards on connect, then renders state changes in ~1s.

---

## License

Apache 2.0. See [`../../LICENSE`](../../LICENSE).
