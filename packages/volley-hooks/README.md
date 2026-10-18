# volley-hooks

Claude Code hooks that keep an agent's Volley state honest without relying on the agent's brief.
The harness runs them at fixed lifecycle points, so the bus still changes when the brief is skipped,
compacted away, or the agent is sitting at a prompt:

- the registry entry carries the **real model** the harness reports,
- **mailbox messages are drained, injected into the session and acked** at the next prompt or tool call,
- steering **survives compaction** (`.volley/STEERING.md`, re-injected on `SessionStart`),
- **idle / awaiting-input / resumed** are published from native hook events,
- every hook publishes a **heartbeat** (no heartbeat means the hooks are broken, not that the agent is idle).

Each hook is a small Bun script that reads the hook's JSON from stdin and exits fast. In agent mode
a directory without `.volley/agent.json` is a silent no-op that opens no socket. In coordinator
mode (what `install.sh` sets up globally) a directory with no coordinator costs one short registry
lookup a minute — misses and an unreachable broker are cached too — so the package can sit in a
global settings file cheaply.

---

## Contents

- [Install](#install)
- [Identity](#identity)
- [What each hook publishes](#what-each-hook-publishes)
- [Mailbox drain](#mailbox-drain)
- [Coordinator sessions](#coordinator-sessions)
- [Configuration](#configuration)
- [State files](#state-files)
- [Tests](#tests)
- [Harness findings](#harness-findings)

---

## Install

**Dispatched agents.** A supervisor passes the settings template for one session:

```sh
VOLLEY_HOOKS_DIR=/path/to/volley/packages/volley-hooks \
  claude --settings /path/to/volley/packages/volley-hooks/settings.volley-hooks.json ...
```

The template's commands are `bun run "$VOLLEY_HOOKS_DIR/src/hooks/<hook>.ts"`, so either export
`VOLLEY_HOOKS_DIR` for the session or substitute the path into a copy of the template. CI checks that
every command in the template resolves to a file (`bun run check:template`).

**Coordinator sessions** (your own interactive sessions):

```sh
packages/volley-hooks/scripts/install.sh              # merge into ~/.claude/settings.json
packages/volley-hooks/scripts/install.sh --dry-run    # print the result instead
packages/volley-hooks/scripts/install.sh --uninstall  # remove only the volley-hooks entries
```

`install.sh` substitutes the absolute package path, prefixes each command with
`VOLLEY_HOOKS_COORDINATOR=1`, keeps your other hooks, backs the file up first, and is idempotent.
`CLAUDE_SETTINGS` points it at a different file.

## Identity

| Mode | When | Speaks as | State directory |
|---|---|---|---|
| agent | `<project>/.volley/agent.json` exists (SPEC §6.5) | its `agent_id`, resolved exactly like the MCP server (file beats `VOLLEY_*` env) | `<project>/.volley/` |
| coordinator | no `agent.json` and `VOLLEY_HOOKS_COORDINATOR=1` | the newest retained registry entry whose `payload.cwd` is the project dir and whose retained status is not `done`/`failed`/`reaped` (the MCP server auto-registers at startup); looked up once a minute (a miss is cached the same way), refreshed on `SessionStart`. At startup an entry older than the session is a previous session's: the hook looks again a few times for this session's own entry and adopts none if it does not appear | `~/.volley/hooks/<hash of project dir>/` |
| none | neither | nothing: exit 0, empty stdout, no socket | — |

The project dir is `$CLAUDE_PROJECT_DIR`, falling back to the hook input's `cwd`. A malformed
`agent.json` is treated as absent (the MCP server reports it).

## What each hook publishes

All `progress` events carry `source: "harness-hook"`, a per-agent monotonic `seq` and the
`hook_event` that fired (SPEC §4.3). Every hook ends with `progress/heartbeat`.

| Hook | Publishes | Injects |
|---|---|---|
| `SessionStart` | registry entry (retained) with `model` from the input and `model_source: "harness-hook"`; without `model`, the last known model with `model_source: "unknown"`. Remembers the model in `model.json`. Flips a retained `spawning`/`registered` status to `working`. Bootstraps the persistent drain session and drains. | on `source` `compact` / `resume`: the live, already-delivered `steering` directives (newest 20), for context only; plus anything drained or never delivered |
| `PostModelSwitch` | registry entry with `to_model` (also remembered in `model.json`) | — |
| `UserPromptSubmit`, `PostToolUse` (all tools) | `resumed` if the last activity was `idle` / `awaiting_input`; `ack` per drained message; at most every 30 s, the registry entry again when the MCP server's own register (startup auto-register, the agent's `vol_register`) has replaced the harness model | drained mail |
| `Stop` | `idle` with `text` = `last_assistant_message` (first 500 chars). Coordinator whose turn ends in `?`: also `awaiting_input` with the whole `question`, taken from the unclipped message | — |
| `Notification` | `agent_needs_input` / `idle_prompt` / `permission_prompt` → `awaiting_input` (`notification_type`, `text`); `quota_auto_resume_*` → `awaiting_input` with `class: "credit"`; `agent_completed` → `idle` with `completed: true`; anything else → heartbeat only | — |
| `PreCompact` | — (copies STEERING.md to `.volley/steering.snapshot.md`) | — |

Hooks never publish `steering_applied` or `steering_acked`. **A hook ack is not compliance**: the
`ack` on the sender's mailbox means the message reached the session. The injected text asks the
model to reply `acknowledged: …` and publish `progress/steering_acked` with `correlation_id` set to
the message id once it has acted on it; that envelope is what a dashboard shows as "agent
acknowledged", and reviewers check the prose.

## Mailbox drain

`UserPromptSubmit`, `PostToolUse` and `SessionStart`:

1. take `.volley/drain.lock` (O_EXCL, with a per-holder token). If another hook holds it —
   parallel tool calls fire `PostToolUse` concurrently — skip the drain; the holder drains. The
   lock is taken **before** connecting, because two connects with one clientId kick each other
   off, and held until the hook's stdout is written. It counts as stale only after
   `VOLLEY_HOOKS_TIMEOUT_MS` + 5 s (the deadline kills a holder before then); a stale lock is
   moved aside atomically and checked, so a lock re-taken meanwhile is never removed, and a
   holder only ever releases its own lock.
2. connect the persistent session: clientId `volley-<agent_id>-hooks`, `cleanSession: false`,
   MQTT 5 with the session expiry below; `drainQueued(<mailbox>, { idleMs: 150 })`.
3. order by `payload.seq`; for each message append a block to `STEERING.md`, apply `supersedes`
   (same sender only), then publish `ack` to the sender's mailbox
   (`{ text: "ACKED", acked_type, seq? }`, `correlation_id` = the message id). A message already in
   `STEERING.md` is re-acked, not stored twice.
4. inject one block with every live directive not yet delivered — the new mail, plus any an
   earlier hook stored and acked but died before emitting (the sender saw the ack and will not
   retry, so the file is what guarantees delivery):

```
[volley steering] 2 message(s) from your Volley mailbox:

1. steering from coordinator-ab12 (id 4c1e…, seq 1):
first run the integration suite

2. ...

Reply with an explicit "acknowledged: …" line AND publish vol_publish(channel='progress', type='steering_acked', correlation_id=<id>) once you have acted on it.
```

5. once the hook's stdout is written, mark those blocks `delivered=1`, then release the lock. A
   hook killed before that re-injects them on the next drain (at least once, never zero).

`ack` messages addressed to this agent (acks of mail it sent) are reported as one line each and
never stored or acked. An urgent `cancel` is delivered like any message (labelled
`CANCEL (stop your current task)`); a supervisor that needs it to land mid-turn sends Escape first.

The broker only queues mail for a session that exists, so mail sent before the first hook run
(normally `SessionStart`) is lost; send after the agent has registered.

`STEERING.md` blocks look like this; set `state=done` by hand to stop a directive being
re-injected after a compaction. Text lines starting with `## ` or `\` are stored with one more
leading `\`, so the text reads back byte for byte:

```
## 1 steering 4c1e0f3a-…
<!-- volley from=coordinator-ab12 at=2026-10-18T10:00:00.000Z state=live delivered=1 -->
first run the integration suite
```

After a compaction or resume, `SessionStart` re-shows the live `steering` directives already
delivered under a "still in force … no new acknowledgement needed" heading. `cancel`, `nudge` and
`query` are one-shot and never re-shown, so an obeyed cancel cannot abort a later task.

## Coordinator sessions

With `install.sh`, an interactive session publishes what a dashboard needs to show "needs you":

- `Stop` ending in a question → `awaiting_input` with `question` = the last paragraph of the
  unclipped message, whole (the 500-char clip applies to `text` only), `session_url`, `workspace`.
  A question over 8 KB keeps its last 8 KB behind a `[… N earlier characters omitted; the full
  question is in the session]` marker.
- `idle_prompt` / `agent_needs_input` / `permission_prompt` → `awaiting_input`; `question` is the
  last `Stop`'s question when there was one (the idle notification's own message is generic),
  else the notification message.
- the next `UserPromptSubmit` / `PostToolUse` → `resumed`.
- `SessionStart` adds `session_url` / `workspace` to the registry entry.

`session_url` comes from `VOLLEY_SESSION_URL` (a hook cannot derive it, see below); `workspace` from
`VOLLEY_WORKSPACE`, else `cmux identify` (`caller.workspace_ref`) when running inside cmux. The
coordinator's own mailbox is drained too, so acks for messages it sent land in its context.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `VOLLEY_HOOKS_DIR` | — | Package path used by the settings template's commands. |
| `VOLLEY_HOOKS_COORDINATOR` | unset | `1` enables coordinator mode (set by `install.sh`). |
| `VOLLEY_HOOKS_DRAIN_MATCHER` | all tools | Regex on `tool_name`: which `PostToolUse` calls drain. |
| `VOLLEY_SESSION_EXPIRY_S` | 7 days | Drain-session expiry when `volley/_waves/_config` has no `mailbox.session_expiry_s`. |
| `VOLLEY_HOOKS_MQTT_VERSION` | `5` | `4` for a broker without MQTT 5 (expiry is then the broker's policy). |
| `VOLLEY_SESSION_URL` | — | Coordinator: the session's URL, published as `session_url`. |
| `VOLLEY_WORKSPACE` | `cmux identify` | Coordinator: the terminal workspace ref, published as `workspace`. |
| `VOLLEY_HOOKS_STATE_DIR` | `~/.volley/hooks` | Coordinator state root. |
| `VOLLEY_HOOKS_TIMEOUT_MS` | `10000` | Hard deadline per hook run. |
| `VOLLEY_HOOKS_DEBUG` | unset | `1` prints swallowed errors on stderr. |
| `VOLLEY_BROKER_URL`, `VOLLEY_NAMESPACE` | as volley-mcp | Used when `agent.json` does not set them. |

Session expiry: `mailbox.session_expiry_s` from the retained `volley/_waves/_config` (read once and
cached in `config.json` for 60 s), else `VOLLEY_SESSION_EXPIRY_S`, else 7 days. It applies to new
connections only (SPEC §4.4).

## State files

In the state directory: `seq` (fsync'd counter) + `seq.lock`, `drain.lock`, `STEERING.md`,
`steering.snapshot.md`, `activity.json` (last activity, so the next hook knows to publish
`resumed`), `config.json` (expiry cache), `model.json` (the harness-reported model) and, for
coordinators, `identity.json` (registry lookup cache, hit or miss). For agents this is `.volley/`, which supervisors keep out of commits (SPEC §6.5).

## Tests

`bun run test` runs every hook as a subprocess against an in-process Aedes broker (MQTT 3.1.1, so
the hooks run with `VOLLEY_HOOKS_MQTT_VERSION=4` there). `bun run test:integration` covers the
default MQTT 5 drain session against a disposable mosquitto; it needs `VOLLEY_BROKER_URL` set
explicitly and never falls back to a default broker.

## Harness findings

Observed with Claude Code 2.1 on 2026-10-18, hooks writing their stdin to files (`--settings`).

- **Hooks fire in a git worktree of an already-trusted repository**, in both interactive and `-p`
  sessions. The untrusted-repository case (hooks held back until the trust dialog is accepted, trust
  recorded against the repository root) was not re-tested here.
- **`SessionStart.model` is present in interactive sessions** (`"model": "claude-haiku-5-5"`) and
  **absent in `-p` sessions**, even with `--model`. Those register with `model_source: "unknown"`.
  `source` was `startup`. Inputs also carry `session_id`, `transcript_path`, `cwd`,
  `scratchpad_dir`, and on later events `prompt_id`, `permission_mode`, `effort`.
- **`/model` fires `PreModelSwitch` then, after the confirmation dialog, `PostModelSwitch`**, both
  with `from_model`, `to_model`, `requested_model`, `source: "command"`.
- **A plain-text question at the end of a turn does not fire `agent_needs_input`.** `Stop` fires
  at once with the question in `last_assistant_message`; about 60 s later `Notification` fires
  `idle_prompt` with the generic message `Claude is waiting for your input`. Hence coordinator
  `question` comes from the `Stop` text.
- **`AskUserQuestion` fires `Notification` `permission_prompt`** (`Claude needs your permission`),
  also in bypass-permissions mode. `agent_needs_input` was not observed; it is handled as documented.
- **Provider credit / usage prompts were not reproduced**, so whether they fire a notification is
  unverified; a supervisor still needs a screen-read fallback for them.
- **No session URL is available to a hook.** The input has `session_id` (also
  `$CLAUDE_CODE_SESSION_ID`), but nothing maps a local session to a web URL, so `session_url` comes
  from `VOLLEY_SESSION_URL`, set by whoever launches the session.
- **cmux workspace:** hook processes inherit `CMUX_WORKSPACE_ID` (a UUID) and `CMUX_SURFACE_ID`;
  `cmux identify` run from a session's child process reports `caller.workspace_ref`
  (`workspace:<n>`).
