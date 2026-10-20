# volley-hooks

Claude Code hooks that keep an agent's Volley state honest without relying on the agent's brief.
The harness runs them at fixed lifecycle points, so the bus still changes when the brief is skipped,
compacted away, or the agent is sitting at a prompt:

- the registry entry carries the **real model** the harness reports,
- **mailbox messages are drained, injected into the session and acked** at the next prompt or tool call,
- steering **survives compaction** (`.volley/STEERING.md`, re-injected on `SessionStart`),
- **idle / awaiting-input / resumed** are published from native hook events,
- every hook publishes a **heartbeat** (no heartbeat means the hooks are broken, not that the agent is idle),
- a **work log**: a rate-limited one-line `activity` tick per tool call or prompt, so a session that publishes nothing itself still shows what it is doing,
- the **statusLine publisher** reports the session's context fill and its Claude account's 5-hour and weekly usage.

Each hook is a small Bun script that reads the hook's JSON from stdin and exits fast. In agent mode
a directory without `.volley/agent.json` is a silent no-op that opens no socket. In coordinator
mode (what `install.sh` sets up globally) a directory with no coordinator costs one short registry
lookup a minute — misses and an unreachable broker are cached too — so the package can sit in a
global settings file cheaply. On a broker that requires authentication the hooks need credentials
(see [Broker credentials](#broker-credentials)); without them they fail loudly, not silently.

---

## Contents

- [Install](#install)
- [Identity](#identity)
- [Broker credentials](#broker-credentials)
- [What each hook publishes](#what-each-hook-publishes)
- [Work log (activity ticks)](#work-log-activity-ticks)
- [Usage statusLine](#usage-statusline)
- [Mailbox drain](#mailbox-drain)
- [Coordinator sessions](#coordinator-sessions)
- [Heavy-operation leases](#heavy-operation-leases)
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
every command in the template resolves to a file (`bun run check:template`). `PreToolUse` has two
entries: the lease hook (matcher `Bash`) and the work-log hook `pre-tool-use.ts` (matcher `""`,
every tool); `PostToolUse` runs on every tool.

**Coordinator sessions** (your own interactive sessions):

```sh
packages/volley-hooks/scripts/install.sh              # merge into ~/.claude/settings.json
packages/volley-hooks/scripts/install.sh --dry-run    # print the result instead
packages/volley-hooks/scripts/install.sh --uninstall  # remove only the volley-hooks entries
packages/volley-hooks/scripts/install.sh --broker-url mqtt://127.0.0.1:21883 --namespace team-a
```

`install.sh` substitutes the absolute package path, prefixes each command with
`VOLLEY_HOOKS_COORDINATOR=1`, keeps your other hooks, backs the file up first, and is idempotent.
It also installs the [usage statusLine](#usage-statusline); a `statusLine` you already had is
saved to `<state root>/statusline-chain.json` and keeps drawing your status line, and
`--uninstall` puts it back. `CLAUDE_SETTINGS` points it at a different file.

`--broker-url <url>` and `--namespace <ns>` add `VOLLEY_BROKER_URL=<url>` and
`VOLLEY_NAMESPACE=<ns>` to every command's prefix (after `VOLLEY_HOOKS_COORDINATOR=1`), so the
hooks use that broker and namespace from every session on the machine: a prefix assignment
overrides the session's own environment. `volley peer doctor --fix` passes them for a paired
machine (its tunnel's URL; the namespace when it is not `default`). Without the flags nothing is
added and the hooks read both from each session's environment at run time, as before: the
installer never takes them from its own environment, so an exported `VOLLEY_BROKER_URL` is not
baked in (`volley setup` runs it that way). The URL must be a plain `mqtt://`, `mqtts://`,
`tcp://`, `ws://` or `wss://` URL with no login: a login goes in `VOLLEY_AUTH_USERNAME` /
`VOLLEY_AUTH_PASSWORD` or `coordinator.json` ([Broker credentials](#broker-credentials)), and the
installer refuses a URL that carries one.

## Identity

| Mode | When | Speaks as | State directory |
|---|---|---|---|
| agent | `<project>/.volley/agent.json` exists (SPEC §6.5) | its `agent_id`, resolved exactly like the MCP server (file beats `VOLLEY_*` env) | `<project>/.volley/` |
| coordinator | no `agent.json` and `VOLLEY_HOOKS_COORDINATOR=1` | the newest retained registry entry whose `payload.cwd` is the project dir and whose retained status is not `done`/`failed`/`reaped` (the MCP server auto-registers at startup); looked up once a minute (a miss is cached the same way), refreshed on `SessionStart`. At startup an entry older than the session is a previous session's: the hook looks again a few times for this session's own entry and adopts none if it does not appear | `~/.volley/hooks/<hash of project dir>/` |
| none | neither | nothing: exit 0, empty stdout, no socket | — |

The project dir is `$CLAUDE_PROJECT_DIR`, falling back to the hook input's `cwd`. An
`agent.json` that exists but is unreadable or malformed is **not** treated as absent (and never
falls back to coordinator mode): it holds the agent's credentials, so the hook fails loudly, as
below, with the error file in `<project>/.volley/`.

## Broker credentials

Every broker connection a hook opens (the persistent drain session, the clean sessions, the
coordinator's registry lookup, the config and lease-pool reads) carries the same credentials,
resolved per mode (`src/lib/auth.ts`):

| Mode | Credentials, first match wins |
|---|---|
| agent | the `broker` block of `.volley/agent.json` (minted by the supervisor), then `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD` — exactly as the MCP server in the same worktree resolves them |
| coordinator | `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD`, then `$VOLLEY_AUTH_DIR/coordinator.json` (`{ "username", "password" }`, mode 0600) |

Neither: the hooks connect anonymously, which only an open broker accepts. Write the coordinator
file with `volley setup` or `volley auth init --coordinator-file` (`--force` rotates the login and the file), so an
`install.sh` setup keeps no password in `settings.json`. Without `VOLLEY_AUTH_DIR` the file is
looked for where `volley auth` keeps its files by default (`<mosquitto etc dir>/volley/`). A
`volley auth init` run as root hands that directory to the broker's user; point
`VOLLEY_AUTH_DIR` at a copy you can read, or use `VOLLEY_AUTH_*`.

In coordinator mode the directory's `agent.json` is never read for credentials.

**A refused CONNECT is loud, and so are unusable credentials.** Every other error is swallowed
(a hook never fails the session), but when the broker refuses the credentials, or the hook
cannot even send any — an unreadable or malformed `agent.json` or `coordinator.json`, or
`VOLLEY_AUTH_PASSWORD` without `VOLLEY_AUTH_USERNAME` — the hook (code `AUTH_FAILED` either way):

- writes one stderr line: `volley-hooks <event>: AUTH_FAILED for <username|anonymous> at <broker url> — <hint>`,
  or, for unusable credentials, `volley-hooks <event>: AUTH_FAILED — <file and reason> — <hint>`,
- writes `<state dir>/hooks-error.json` `{ "code": "AUTH_FAILED", "at", "hook_event", "username" }`
  (`username` is null for unusable credentials, which also add `detail`: the reason)
  (volleyd reads it at a spawn's registration timeout and opens a `hooks_auth_failed` decision
  instead of classifying the screen),
- never caches the failure as "no coordinator here": the next hook tries (and fails loudly) again,
- exits **1**: a non-blocking error, so Claude Code shows the stderr line to the operator. Never 2
  (that would block the tool call) and never 0 (that would look like success).

The next successful connect removes `hooks-error.json`. The lease wrapper (`volley lease run`)
resolves its own credentials the same way: agent mode passes `--project-dir` (the identity file,
then `VOLLEY_AUTH_*`), coordinator mode passes `--coordinator` (`VOLLEY_AUTH_*`, then
`coordinator.json`). A broker that refuses them makes the wrapped command fail (exit 1); it never
runs unleased on an auth error.

## What each hook publishes

All `progress` events carry `source: "harness-hook"`, a per-agent monotonic `seq` and the
`hook_event` that fired (SPEC §4.3). Every hook except the two `PreToolUse` hooks ends with
`progress/heartbeat` (`PostToolUse` heartbeats after every tool call anyway).

| Hook | Publishes | Injects |
|---|---|---|
| `SessionStart` | registry entry (retained) with `model` from the input and `model_source: "harness-hook"`; without `model`, the last known model with `model_source: "unknown"`. Every other field of the entry (`title`, `links`, …) is kept. A coordinator's entry also gets `session_url`, `workspace` and `workspace_title` (see [Coordinator sessions](#coordinator-sessions)). Remembers the model in `model.json` and the coordinator fields in `registry-fields.json`. Flips a retained `spawning`/`registered` status to `working`. Bootstraps the persistent drain session and drains. | on `source` `compact` / `resume`: the live, already-delivered `steering` directives (newest 20), for context only; plus anything drained or never delivered |
| `PostModelSwitch` | registry entry with `to_model` (also remembered in `model.json`) | — |
| `UserPromptSubmit` | as `PostToolUse`, then an `activity` tick `prompt received` ([work log](#work-log-activity-ticks)), after the drained mail is stored and acked; never any of the prompt text | drained mail |
| `PostToolUse` (all tools) | `resumed` if the last activity was `idle` / `awaiting_input`; `ack` per drained message; at most every 30 s, the registry entry again when the MCP server's own register (startup auto-register, the agent's `vol_register`) has replaced the harness model or dropped a field SessionStart remembered (`session_url`, `workspace`, `workspace_title`); the [work log](#work-log-activity-ticks)'s held-back tick once its 5 s window is over | drained mail |
| `Stop` | `idle` with `text` = `last_assistant_message` (first 500 chars) and `tool_calls` (this session's [work log](#work-log-activity-ticks) count; its pending tick is dropped). Coordinator whose turn ends in `?`: also `awaiting_input` with the whole `question`, taken from the unclipped message. When the input's `background_tasks` lists a task still running and the turn did not end in a question, `idle` carries `background_wait: true` and `activity.json` records it | — |
| `Notification` | `agent_needs_input` / `idle_prompt` / `permission_prompt` → `awaiting_input` (`notification_type`, `text`); `quota_auto_resume_*` → `awaiting_input` with `class: "credit"`; `agent_completed` → `idle` with `completed: true`; anything else → heartbeat only | — |
| `PreCompact` | — (copies STEERING.md to `.volley/steering.snapshot.md`) | — |
| `PreToolUse` (all tools) | `activity` tick with a one-line summary of the call and `tool_calls`, at most once per 5 s per session; the newest line in a window is published at the next slot ([work log](#work-log-activity-ticks)) | — |
| `PreToolUse` (`Bash`) | — (rewrites the command: see [Heavy-operation leases](#heavy-operation-leases)) | `command queued for a <pool> lease` when it wraps |

Hooks never publish `steering_applied` or `steering_acked`. **A hook ack is not compliance**: the
`ack` on the sender's mailbox means the message reached the session. The injected text asks the
model to reply `acknowledged: …` and publish `progress/steering_acked` with `correlation_id` set to
the message id once it has acted on it; that envelope is what a dashboard shows as "agent
acknowledged", and reviewers check the prose.

## Work log (activity ticks)

Interactive sessions (and agents that publish little progress of their own) would otherwise show
on a dashboard as registered and `working` for hours with nothing else. The hooks publish a
work log for them: `progress/activity` (SPEC §4.3; qos 0, not retained, with the usual
`source`, `seq` and `hook_event`):

```json
{ "msg": "Bash: gh pr checks 153", "tool_calls": 42, "source": "harness-hook", "seq": 311, "hook_event": "PreToolUse" }
```

- **`msg`** is one line of at most 120 characters (cut with `…`). `PreToolUse`
  (`src/hooks/pre-tool-use.ts`, matcher `""`) summarises the call: `Bash: <first line of the
  command>`, `Edit:` / `MultiEdit:` / `Write:` / `Read: <file_path>` (relative to the project dir
  when inside it, `~/…` when under `$HOME` outside it, so the home directory and the user name
  in it are never published; a `$HOME/…` path inside a command is written `~/…` too),
  `NotebookEdit: <notebook_path>`, `Task: <description>` (also for `Agent`),
  `Grep:` / `Glob: <pattern>`, `WebFetch: <host>`, `WebSearch: <query>`; any other tool is its
  name, an MCP tool `mcp__<server>__<tool>` just `<tool>`. `UserPromptSubmit` publishes exactly
  `prompt received`: **no prompt text is ever published**.
- **`tool_calls`** counts every `PreToolUse` of the Claude Code session, rate-limited ones
  included. The state directory is shared by every session run in the same directory
  (coordinator) or worktree (agent), so the count is keyed by the hook input's `session_id`
  (the agent id when absent): a new session starts at 0 and gets a fresh rate-limit window;
  `compact` and `resume` keep the session id, and the count. Each session has its own entry, so
  two sessions running at once in the same state directory keep separate counts and windows;
  entries untouched for a week are dropped (at most 16 are kept).
- **Redaction.** Before publishing, the summary is masked (`***`, `redactSecrets` in
  `src/lib/work-log.ts`; one test case per rule in `test/work-log.test.ts`):
  - token shapes, wherever they appear: AWS access key ids (`AKIA…`, `ASIA…`), GitHub tokens
    (`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_…`, `github_pat_…`), `sk-…` API keys (`sk-ant-…`,
    `sk-proj-…`), Slack tokens (`xoxb-…`), JWTs (`eyJ….….…`) and PEM private keys (from
    `-----BEGIN … PRIVATE KEY-----` to its footer, or the end of the line);
  - the value of a credential flag, as `--flag value` or `--flag=value`: one whose last part is
    `password`, `passwd`, `token`, `secret` or `key` (`--password`, `--token`, `--secret`,
    `--api-key`, `--client-secret`, `--access-token`); mysql / mariadb's glued `-pSECRET`; and
    mosquitto_pub / mosquitto_sub's `-P value`. `-p` / `-P` anywhere else is left alone
    (`mkdir -p`, `git log -p`, `cp -p`, `ssh -p 22`, `docker run -p 8080:80`, `rsync -P`);
  - the password of curl's `-u` / `--user user:pass` (`-u admin:***`);
  - credential headers and keys: `Authorization: …` and `Bearer …` (an auth scheme word such as
    `Basic` is kept), `Cookie: …` (the whole value), and any `name: value` whose name's last `-` / `_`
    part is `key`, `token`, `secret`, `password` or `authorization` (`X-Api-Key: …`,
    `X-Auth-Token: …`, `"api_key": "…"`; never a suffix match: `monkey: x`, `hotkey: x` and
    `Author: x` are left alone);
  - assignments and query parameters whose name's last part is `token`, `password`, `secret`,
    `key` or `apikey` (`GH_TOKEN=… cmd`, `PASSWORD=…`, `api_key=…`, `?token=…`; not
    `monkey=…`);
  - a credential name and its value after `set` / `config` / `configure`
    (`aws configure set aws_secret_access_key …`, `git config user.signingkey …`);
  - URL userinfo (`https://user:pass@host` → `https://***@host`).

  Ordinary commands stay readable: `mkdir -p dir`, `git log -p`, `ssh -p 22 host`,
  `git commit -m "fix key handling"` and `ls ~/.ssh` are published as they are. Only the first line
  of a command is considered at all.
- **Rate limit.** At most one `activity` publish per 5 s per session; the newest line in a
  window is published at the next slot. `work-log.json` in the state directory holds
  `{ "sessions": { "<session_id>": { "tool_calls", "last_published_at" (epoch ms), "pending"?,
  "touched_at" } } }`, updated under
  `work-log.lock` so parallel tool calls count correctly. A tick inside the window opens no
  connection: it only records its summary as `pending` (newest wins). The next slot publishes it:
  a later `PreToolUse` / `UserPromptSubmit` tick allowed to publish publishes its own (newer)
  summary instead, and `PostToolUse`, which already has a broker session open for its
  heartbeat, publishes the pending summary with the current `tool_calls` once the window is
  over, then clears it and restarts the window. `Stop` drops it and reports the count on
  `idle` as `tool_calls`.
- **Fail soft.** The work log is cosmetic: a failure in it (say `work-log.lock` held by a hook
  that died) is ignored. It never changes a hook's exit status or its other output; on
  `UserPromptSubmit` the tick runs only after the drained mail is in `STEERING.md` and acked,
  so it can never cost a steering message. `Stop` then reads the count without the lock.

## Usage statusLine

The template's `statusLine` is `src/statusline/publish.ts`. Claude Code runs it with its
statusLine JSON after each assistant message (and at session start, on permission-mode changes, …;
it goes quiet while the session is idle). It publishes a retained `usage` envelope on
`volley/<ns>/<agent>/usage` (SPEC §4.6.12, `usage.schema.json`):

| Field | From the statusLine JSON |
|---|---|
| `account` | `claude_account` in `.volley/agent.json`; else `primary` without `CLAUDE_CONFIG_DIR`; else `null`, with `config_dir` set to it |
| `model` | `model.id` |
| `context_window` | `used_percentage`; `used` = `current_usage` input + cache-creation + cache-read tokens (null before the first request); `size` = `context_window_size` |
| `rate_limits.five_hour`, `.weekly` | `rate_limits.five_hour` / `.seven_day`: `pct` = `used_percentage`, `resets_at` from epoch seconds; absent until Claude Code reports them |

It publishes at most once per 15 s, unless the account, model or a reset time changed or a
percentage moved by more than a point (`usage.json` in the state directory remembers the last
attempt, written before connecting, so a down broker is retried only on that schedule). The
publisher exits within 3 s (or `VOLLEY_HOOKS_TIMEOUT_MS`, if lower), since Claude Code takes the
status line when the command exits. What the status line shows is printed first, before any connect: the output of the
`statusLine` command `install.sh` saved (`<state root>/statusline-chain.json`, run with the same
input under a 2 s timeout), else a minimal `<model> · ctx 4% · 5h 11% · 7d 43%`. A `--settings`
statusLine replaces the profile's own, so a spawned agent's status line is the chained command or
the minimal line too. Like the hooks, it never fails the session: a refused CONNECT is recorded in
`hooks-error.json` and anything else is swallowed.

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
- **Background waits.** A coordinator that ends its turn with a background task still running
  (a `volley wait` armed in the background: Stop's `background_tasks` input) is idle, waiting on
  the wave's events, not on the owner. Its `Stop` `idle` and the `idle_prompt` that follows
  carry `background_wait: true` (SPEC §4.3), and the Desk shows `idle — waiting on wave events`
  instead of "needs you". A turn that ends in a question is a question, background task or
  not: neither its `awaiting_input` nor the idle prompt that repeats it carries the flag. A
  `permission_prompt` or `agent_needs_input` never carries it. Only the documented
  `background_tasks` shape counts: a list of task objects, one whose `status` is over
  (`completed`, `failed`, `killed`, …) not counting.
- the next `UserPromptSubmit` / `PostToolUse` → `resumed` (and clears the background wait).
- `SessionStart` adds `session_url` / `workspace` to the registry entry, and `workspace_title`:
  `VOLLEY_WORKSPACE_TITLE` when set and non-empty, else (inside cmux, `CMUX_WORKSPACE_ID` set) the
  `title` of this session's workspace from `cmux list-workspaces --json` (matched on its `ref`
  or on `CMUX_WORKSPACE_ID`; same binary and 1 s timeout as `cmux identify`), trimmed and cut to
  120 characters. Any failure leaves it out. It is on the registry entry only, never on
  `awaiting_input`, and never in agent mode.
- The MCP server's own register (startup auto-register, `vol_register`) replaces the whole
  registry entry. SessionStart remembers `session_url`, `workspace` and `workspace_title` in
  `registry-fields.json`; at most every 30 s a drain hook (`UserPromptSubmit` / `PostToolUse`)
  re-publishes the entry when it lacks the harness model or any of them, keeping the rest of
  the MCP server's entry.

`session_url` comes from `VOLLEY_SESSION_URL` (a hook cannot derive it, see below); `workspace` from
`VOLLEY_WORKSPACE`, else `cmux identify` (`caller.workspace_ref`) when running inside cmux. The
coordinator's own mailbox is drained too, so acks for messages it sent land in its context.

**Coordinator id.** The hooks take no id of their own: they publish as the newest live registry
entry whose `cwd` is the session's directory, which is the id the session's MCP server
registered. That server builds it from `VOLLEY_AGENT_ID` (a prefix, plus a fresh `-xxxx`), so
the user-scope registration must set `"VOLLEY_AGENT_ID": "coordinator"` in its `env` (the full
`claude mcp add-json` line is in the
[root README](../../README.md#4-register-the-mcp-server-with-claude-code)).
Without it the id is named after the working directory (`<repo>-xxxx`), and the "needs you"
items above land on an id that reads as an ordinary agent; the wave `--owner`, the Desk's
owner chip and `★ yours`, and the v0.2 owner smoke all expect `coordinator-xxxx`. A separate
registry (a smoke run) is a different `VOLLEY_NAMESPACE`, not a different prefix.

## Heavy-operation leases

`pre-tool-use-lease.ts` (PreToolUse, matcher `Bash`) keeps heavy commands inside volleyd's lease
pools. When `tool_input.command` matches one of a pool's `match` regexes (the `lease_pools` of the
retained `volley/_waves/_config`, read once a minute and cached in `lease-pools.json`), the hook
returns `hookSpecificOutput.updatedInput` with the command wrapped:

```
cd x && mvn -q verify
  → bun '<repo>/packages/volley-cli/src/cli.ts' lease run --pool 'backend-it' --holder '<agent id>' \
      --broker-url '<url>' --project-dir '<project>' -- "${SHELL:-/bin/sh}" -c 'cd x && mvn -q verify'
```

In coordinator mode the wrapper carries `--coordinator` instead of `--project-dir`, so the CLI
uses the coordinator's credentials (see [Broker credentials](#broker-credentials)), never an identity
file in whatever directory the session happens to be in.

plus `additionalContext` "command queued for a backend-it lease". `volley lease run` waits for the
lease *inside* the Bash tool call — the agent sees the wait (`queued … granted after 42 s`), and no
hook timeout is involved — then runs the original command and releases the lease when it exits. It
fails open: with no live volleyd, an unreachable broker or an unconfigured pool it runs the
command unleased (but not when the broker refuses the credentials). Pool names
come from a retained broker topic, so a name that is not a valid pool id is ignored, and every
value spliced into the wrapped command is shell-quoted. A command
that is already wrapped, matches no pool, or arrives while no pools are configured passes through
untouched (empty output). The hook never changes the permission decision. Because the original
runs in a child shell, a `cd` inside it does not carry over to the next Bash call.

**Known gap.** Matching is on the command text, so an agent can run a heavy operation the
regexes do not see — from a script file (`./run-it.sh`), through an alias or a wrapper
(`./mvnw`), or by building the command at runtime. The wrapper is a courtesy, not a sandbox: the
backstop is volleyd's pressure-based spawn admission (memory pressure, multiplexer latency,
containers, provider overload, CI queue), which stops new agents from starting while the machine
is loaded. Write `match` patterns for the forms your agents actually use.

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
| `VOLLEY_WORKSPACE_TITLE` | `cmux list-workspaces --json` | Coordinator: the workspace's title, published as `workspace_title` on the registry entry. |
| `VOLLEY_HOOKS_STATE_DIR` | `~/.volley/hooks` | Coordinator state root; also where `statusline-chain.json` lives. |
| `VOLLEY_HOOKS_TIMEOUT_MS` | `10000` | Hard deadline per hook run. |
| `VOLLEY_HOOKS_DEBUG` | unset | `1` prints swallowed errors on stderr. |
| `VOLLEY_LEASE_CLI` | this repo's `volley-cli`, else `volley` | Shell fragment the lease hook uses to invoke the CLI. |
| `VOLLEY_BROKER_URL`, `VOLLEY_NAMESPACE` | as volley-mcp | Used when `agent.json` does not set them. `install.sh --broker-url` / `--namespace` put them in every command's prefix, which overrides the session's own value. |
| `VOLLEY_AUTH_USERNAME`, `VOLLEY_AUTH_PASSWORD` | — | Broker credentials ([Broker credentials](#broker-credentials)). |
| `VOLLEY_AUTH_DIR` | `<mosquitto etc dir>/volley` | Coordinator: where `coordinator.json` lives. |

Session expiry: `mailbox.session_expiry_s` from the retained `volley/_waves/_config` (read once and
cached in `config.json` for 60 s), else `VOLLEY_SESSION_EXPIRY_S`, else 7 days. It applies to new
connections only (SPEC §4.4).

## State files

In the state directory: `seq` (fsync'd counter) + `seq.lock`, `drain.lock`, `STEERING.md`,
`steering.snapshot.md`, `activity.json` (last activity, so the next hook knows to publish
`resumed`), `config.json` (expiry cache), `lease-pools.json` (lease-pool cache), `model.json` (the harness-reported model), `registry-fields.json` (`{ "fields": { "session_url"?, "workspace"?, "workspace_title"? }, "checked_at"? }`: SessionStart's registry fields and the drain hooks' last registry check),
`hooks-error.json` (the last refused CONNECT or unusable credentials, until the next successful connect), `usage.json` (the last usage published),
`work-log.json` + `work-log.lock` (the [work log](#work-log-activity-ticks)'s session, tool-call count and rate limit) and, for
coordinators, `identity.json` (registry lookup cache, hit or miss). For agents this is `.volley/`, which supervisors keep out of commits (SPEC §6.5).

## Tests

`bun run test` runs every hook as a subprocess against an in-process Aedes broker (MQTT 3.1.1, so
the hooks run with `VOLLEY_HOOKS_MQTT_VERSION=4` there). `bun run test:integration` covers the
default MQTT 5 drain session against a disposable mosquitto; it needs `VOLLEY_BROKER_URL` set
explicitly and never falls back to a default broker. Subprocess hooks get an empty temp
`VOLLEY_AUTH_DIR` by default, so no test reads the host's real `coordinator.json`.

`test/integration/mosquitto-acl.test.ts` (also opt-in) starts no broker: it needs
`VOLLEY_INTEGRATION=1` and `VOLLEY_AUTH_BROKER_URL` pointing at a PRIVATE mosquitto 2.1 (never the
live 1883/9001) bootstrapped with Volley's shared Dynamic Security roles by volley-cli's
`test/integration/dynsec-fixture.ts`, and runs the hooks as an agent login against it. CI's
`test-integration-dynsec` job runs it against the `eclipse-mosquitto:2.1-alpine` container; locally:

```sh
# from the repo root
P=$((20000 + RANDOM % 20000)); d=$(mktemp -d); chmod 777 "$d"
docker run -d --name vly-dynsec -p 127.0.0.1:$P:1883 \
  -v "$PWD/examples/mosquitto-auth/mosquitto-dynsec.conf:/mosquitto/config/mosquitto.conf:ro" \
  -v "$d:/mosquitto/data" eclipse-mosquitto:2.1-alpine sh -c \
  'mosquitto_ctrl dynsec init /mosquitto/data/dynamic-security.json dynsec-admin it-pw >/dev/null &&
   chown -R mosquitto: /mosquitto/data && exec mosquitto -c /mosquitto/config/mosquitto.conf'
VOLLEY_DYNSEC_BROKER_URL=mqtt://127.0.0.1:$P VOLLEY_DYNSEC_ADMIN_PASSWORD=it-pw \
  bun packages/volley-cli/test/integration/dynsec-fixture.ts
cd packages/volley-hooks && VOLLEY_INTEGRATION=1 VOLLEY_AUTH_BROKER_URL=mqtt://127.0.0.1:$P \
  bun x vitest run test/integration/mosquitto-acl.test.ts
docker rm -f vly-dynsec
```

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
  (`workspace:<n>`). `cmux list-workspaces --json` was observed on a Mac
  (`test/fixtures/cmux-list-workspaces.json` holds that shape, values replaced):
  `{ window_ref, workspaces: [{ ref, id, index, title, custom_title, current_directory,
  selected, latest_submitted_message, latest_conversation_message, … }] }`. The hook matches the
  workspace on `ref` (or `id` = `CMUX_WORKSPACE_ID`) and reads only `title`: the
  `latest_submitted_message` / `latest_conversation_message` fields (the session's prompt and
  reply text) are never read or published.
