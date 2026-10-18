# Spike: Claude Code accounts per `CLAUDE_CONFIG_DIR` (issue #68)

Findings for the Onboarding epic (#67): profiles per `CLAUDE_CONFIG_DIR`, headless
sign-in, the `.claude.json` split, and the `statusLine` usage fields. No production code
came out of this spike. Every result below either has the command that produced it or is
marked **could not verify**, with what was tried.

- **Tested:** Claude Code `2.1.303` (native install, `~/.local/share/claude/versions/2.1.303`),
  macOS 26 (Darwin 25.6.0, arm64), Claude Max subscription, 2026-10-18.
- **Docs read:**
  - <https://code.claude.com/docs/en/authentication> (multiple accounts, credential management, `setup-token`)
  - <https://code.claude.com/docs/en/env-vars> (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`)
  - <https://code.claude.com/docs/en/statusline> (triggers, JSON fields, absent/null fields)
  - <https://code.claude.com/docs/en/legal-and-compliance> (authentication and credential use)
- **Redactions:** e-mail addresses, org/account UUIDs, OAuth `state` and `code_challenge`
  values. No token, authorization code or Keychain secret was printed, read or stored at
  any point. Keychain inspection used metadata-only commands (no `-w` / `-g`).

## Summary: go / no-go

| Item | Verdict | One line |
| --- | --- | --- |
| (a) Profiles | **GO** (one step still to confirm by the owner) | Each `CLAUDE_CONFIG_DIR` gets its own `.claude.json` and its own Keychain item `Claude Code-credentials-<sha256(dir)[:8]>`. `--model`, `/model` and `--settings` work normally. Two real sign-ins were not run. |
| (b) Headless sign-in | **GO** via `claude auth login` + `$BROWSER` hook; **NO-GO** for `setup-token` | `auth login` hands the localhost-callback URL to `$BROWSER` and prints a manual-code URL. The callback path keeps Volley out of the credential flow entirely. `setup-token` prints a 1-year token that Volley would then have to carry. |
| (c) `.claude.json` split | **GO**, with caveats | Login metadata (`oauthAccount`, `userID`) sits next to `mcpServers` and `projects` in one file. Outside edits made with an atomic rename survived a running session. Every listed path can be a symlink, and Claude Code **writes through** it (settings.json gains `model` from `/model`). |
| (d) statusLine | **GO** | `rate_limits.five_hour` / `seven_day` (`used_percentage`, `resets_at`), `context_window.used_percentage` / `context_window_size`, `model`, `cost`. Fires at session start, after each assistant message (300 ms debounce), and on model / permission-mode change. |

**Credential rule check.** The legal page says developers "may not collect, store, or
intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must
complete through Anthropic's own flow". The only path that satisfies that by construction
is (b)'s `claude auth login` with the browser redirected to Claude Code's own localhost
callback. Volley only ever sees the authorize URL, never the code or the token.

## Probe environment

All probes ran in scratch directories, never against `~/.claude`. Two traps showed up:

- **Call the real binary.** Under cmux, `claude` on `PATH` is a shim
  (`$TMPDIR/cmux-cli-shims/.../claude` → `cmux-claude-wrapper`). `claude -p` through the
  shim hung with no output until the 150 s timeout. `~/.local/bin/claude -p` returned in
  about 5 s. Volley should spawn the resolved binary, or at least not rely on the shim for
  headless runs.
- **Run as a separate process.** Unset `CLAUDECODE` (`env -u CLAUDECODE`) when probing
  from inside a Claude Code session.

To run authenticated probes in a scratch profile **without** a second sign-in, I used
`CLAUDE_SECURESTORAGE_CONFIG_DIR=` (empty). This is an undocumented variable, found in
the bundle (see (a)), that makes the Keychain lookup ignore `CLAUDE_CONFIG_DIR`. Claude
Code then read the default Keychain item itself. **This is a probe device only.** It
shares one account's credential across directories, which defeats the point of profiles.
Volley must not set it.

## (a) Profiles per `CLAUDE_CONFIG_DIR`

### Observed

A fresh directory is a separate, signed-out profile:

```sh
$ mkdir -p "$S/profA"
$ CLAUDE_CONFIG_DIR="$S/profA" claude auth status        # exit 1
{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty",
  "analyticsDisabled": false,
  "projectsDirectory": "<scratch>/profA/projects",
  "configDirectory": "<scratch>/profA"
}
$ ls -A "$S/profA"
.claude.json  .claude.json.lock/  backups/
```

So `.claude.json` lives **inside** the config dir (`<dir>/.claude.json`), not at
`~/.claude.json` as it does for the default profile. Claude Code creates it on first run,
together with a `.claude.json.lock/` directory and `backups/`.

Keychain items today (default profile only), using a metadata-only dump:

```sh
$ security dump-keychain | grep -E '"svce"|"acct"' | grep -i -B1 -A1 claude
    "acct"<blob>="kryptek"
    "svce"<blob>="Claude Code-credentials"
```

So the default profile's item is: service `Claude Code-credentials`, account `$USER`.

How the service name is built, read from the 2.1.303 bundle (de-minified for clarity):

```js
function keychainService(suffix = "") {
  const override = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  const isDefault = override !== undefined ? !override : !process.env.CLAUDE_CONFIG_DIR;
  const dir = override !== undefined ? override.normalize("NFC") : configDir();
  const hash = isDefault ? "" : `-${sha256(dir).hex().substring(0, 8)}`;
  return `Claude Code${OAUTH_FILE_SUFFIX /* "" in prod */}${suffix /* "-credentials" */}${hash}`;
}
// account: process.env.USER || os.userInfo().username, or "claude-code-user" if not [a-zA-Z0-9._-]+
```

So a profile at `~/.volley/claude/<acct>` stores its login in Keychain item
`Claude Code-credentials-<first 8 hex of sha256("<absolute dir>")>`, account `$USER`. The
authentication docs say the same in prose: Claude Code "keys the macOS Keychain entry to
that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different
entry". The hash covers the **exact string** of the directory. `~/.volley/claude/a` and
`/Users/x/.volley/claude/a/` are different profiles to Claude Code. Volley must always
pass one canonical absolute path with no trailing slash.

Account metadata is split from the secret. With the default Keychain item but an empty
config dir, Claude Code is logged in yet doesn't know who the user is until its first real
request fills `oauthAccount` into that dir's `.claude.json`:

```sh
$ CLAUDE_CONFIG_DIR="$S/profS" CLAUDE_SECURESTORAGE_CONFIG_DIR= claude auth status
{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty", ...,
 "email":null,"orgId":null,"orgName":null,"subscriptionType":"max"}
```

`claude auth status` (JSON by default, exit 1 when logged out) is the safe probe for the
Desk to show "signed in as …". It prints e-mail and org, never a token.

A spawned headless run under a profile honours `--model` and `--settings`, and loads the
profile's `CLAUDE.md`, skills, agents and commands (here all symlinked, see (c)):

```sh
$ cd "$S/work" && env -u CLAUDECODE CLAUDE_CONFIG_DIR="$S/profS" CLAUDE_SECURESTORAGE_CONFIG_DIR= \
    ~/.local/bin/claude -p --model claude-haiku-5-5 \
    --settings '{"env":{"SPIKE68":"settings-flag-works"}}' --output-format json '…' </dev/null
→ result: "1) PELICAN  …  3) Skills: hello, spikecmd. Agent type: spikeagent.  4) claude-haiku-5-5"
→ modelUsage keys: ["claude-haiku-5-5"]
```

(`--settings` was accepted. The `env` check inside the prompt was blocked by the Bash
permission classifier, not by settings handling.) In the interactive session,
`/model claude-sonnet-5-5` switched the model after a confirm dialog and **persisted
`"model": "claude-sonnet-5-5"` into the profile's `settings.json`**. That matters for (c).

`--bare` skips OAuth and the Keychain completely ("OAuth and keychain are never read"), so
bare mode cannot use a profile's subscription login.

### Could not verify

- **Two real sign-ins producing two Keychain items.** That needs the owner to finish two
  browser sign-ins, which an agent must not do on their behalf. The naming above comes
  from the shipped bundle and matches the docs. To confirm (metadata only, prints no
  secret):

  ```sh
  D="$HOME/.volley/claude/work"; mkdir -p "$D"
  CLAUDE_CONFIG_DIR="$D" claude auth login            # owner signs in in the browser
  H=$(printf %s "$D" | shasum -a 256 | cut -c1-8)
  security find-generic-password -s "Claude Code-credentials-$H" -a "$USER" >/dev/null && echo found
  CLAUDE_CONFIG_DIR="$D" claude auth status --text    # expect the work account's e-mail
  ```

- **When the Keychain is locked** (an SSH session), Claude Code falls back to
  `<config dir>/.credentials.json`, mode 0600, per the authentication docs. Not exercised
  here. Consequence: Volley must never back up, copy, symlink or sync a profile directory
  wholesale, because `.credentials.json` may be inside it.

## (b) Headless sign-in

### `claude auth login` without a TTY

Options: `--claudeai` (default), `--console`, `--email <email>`, `--sso`.

With stdin closed and stdout piped (no TTY), in a fresh profile:

```sh
$ CLAUDE_CONFIG_DIR="$S/profB" BROWSER=true claude auth login </dev/null > out 2>&1
Opening browser to sign in…
If the browser didn't open, visit: <OSC-8 hyperlink>https://claude.com/cai/oauth/authorize?code=true
  &client_id=<claude-code-client-id>&response_type=code
  &redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback
  &scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code
        +user%3Amcp_servers+user%3Afile_upload+user%3Aplugins
  &code_challenge=<redacted>&code_challenge_method=S256&state=<redacted>
Paste code here if prompted >
```

The process keeps running and waits for the browser or a pasted code. It does not exit on
EOF, so the probe killed it after 12 s. On piped stdout the printed link is wrapped in an
OSC-8 escape (`ESC]8;;<url>ESC\`), so the URL appears twice in the raw bytes and the
escapes need stripping. Inside tmux (`tmux new-session -d … "claude auth login"` then
`capture-pane -p -J`) the same text appears without the escapes. `script -q` with stdin
from `/dev/null` exited at once with an empty transcript, so tmux is the usable PTY
harness.

While it waits, the process listens on a random loopback port:

```sh
$ lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN
2.1.303 <pid> … TCP 127.0.0.1:50957 (LISTEN)
```

It **honours `$BROWSER`**. With `BROWSER=<script that writes "$@" to a file>`, the URL it
tries to open is the **localhost-callback** variant, not the one it prints:

```text
https://claude.com/cai/oauth/authorize?code=true&client_id=<claude-code-client-id>&response_type=code
  &redirect_uri=http%3A%2F%2Flocalhost%3A51051%2Fcallback&scope=…&code_challenge=<redacted>
  &code_challenge_method=S256&state=<redacted>
```

So there are two flows, and they differ in who carries the authorization code:

| URL | Redirect | Who carries the code |
| --- | --- | --- |
| Passed to `$BROWSER` | `http://localhost:<port>/callback` | The browser delivers it straight to the `claude` process. Nobody else sees it. |
| Printed to stdout | `https://platform.claude.com/oauth/code/callback` | The page shows a code that must be **pasted into the CLI's stdin**. |

On success the docs say the terminal shows `Login successful` (the interactive flow then
asks for Enter). Not observed here, because no sign-in was completed (see (a)). The
on-disk result is the profile's Keychain item plus `oauthAccount` in its `.claude.json`.

### `claude setup-token`

The same headless run in tmux, fresh profile:

```text
This will guide you through long-lived (1-year) auth token setup for your Claude account.
Claude subscription required.
Browser didn't open? Use the url below to sign in (c to copy)
https://claude.com/cai/oauth/authorize?…&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback
  &scope=user%3Ainference&code_challenge=<redacted>&code_challenge_method=S256&state=<redacted>
Paste code here if prompted >
```

It also honours `$BROWSER`, again with a localhost callback, scope `user:inference` only.
On success (from the bundle; docs agree) it **prints the token to the terminal**: "✓
Long-lived authentication token created successfully! Your OAuth token (valid for …):
<token> … Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>". The docs say
it "does not save the token anywhere". The profile dir held only `.claude.json` and
`backups/` afterwards. The token can only make model requests: no Remote Control, no
claude.ai connectors.

### Decision: which path keeps Volley out of the credential flow

- **Use:** spawn `claude auth login` under
  `CLAUDE_CONFIG_DIR=~/.volley/claude/<acct>` with `BROWSER` set to a tiny Volley helper.
  The helper publishes the URL it receives so the Desk can show it, or simply runs `open`
  on it. The user signs in in a browser on **the same machine**. The redirect lands on
  Claude Code's own `127.0.0.1` listener, and Claude Code writes its own Keychain item.
  Volley handles an authorize URL, which is not a credential (PKCE: the verifier never
  leaves the `claude` process). Then poll `claude auth status` for `loggedIn: true`.
- **Fallback for a remote browser:** show the printed URL and tell the user to paste the
  code **into a terminal running the command themselves**
  (`CLAUDE_CONFIG_DIR=… claude auth login`). The Desk must not offer a text box that
  relays the code to the process, because that would mean Volley intermediating it.
- **Do not use `setup-token`.** It produces a bearer token that Volley would have to store
  and inject as `CLAUDE_CODE_OAUTH_TOKEN`. That is exactly the "collect, store, or
  intermediate" the legal page forbids. It also ranks above Keychain logins in the auth
  precedence, so a stray variable in an agent's env would silently pick the wrong account.
- Never set `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` in a spawned agent's env. Arguably strip them, so the
  profile's own login is what gets used.

## (c) `.claude.json` split and symlinks

### Key map (top-level keys of the default `~/.claude.json`, values not shown)

| Group | Keys |
| --- | --- |
| Login / account identity | `oauthAccount` (`accountUuid`, `emailAddress`, `organizationUuid`, `organizationName`, `organizationRole`, `billingType`, `seatTier`, `userRateLimitTier`, `displayName`, …), `userID`, `claudeCodeFirstTokenDate` |
| Account-scoped caches | `modelAccessCache`, `orgModelDefaultCache`, `passesEligibilityCache`, `groveConfigCache`, `cachedExtraUsageDisabledReason`, `additionalModel*Cache` |
| MCP servers (user scope) | `mcpServers` |
| Per-project state | `projects["<abs path>"]`: `hasTrustDialogAccepted`, `allowedTools`, `mcpServers` (local scope), `enabledMcpjsonServers` / `disabledMcpjsonServers`, `hasClaudeMdExternalIncludesApproved`, `lastSessionId`, `last*` usage stats |
| Install / onboarding / UI | `hasCompletedOnboarding`, `numStartups`, `installMethod`, `autoUpdates`, `firstStartTime`, `machineID`, `tips*`, `*SeenCount`, `cachedGrowthBookFeatures`, `skillUsage`, `pluginUsage`, … |

No secret is in `.claude.json`: the OAuth tokens are in the Keychain. The file still
identifies the account, so it must stay per profile. A fresh profile's file after the
first authenticated run had `oauthAccount`, `userID` and the account caches, but no
`hasCompletedOnboarding`. An interactive start showed onboarding until I pre-seeded
`hasCompletedOnboarding: true` and `projects["<dir>"].hasTrustDialogAccepted: true`.

### Copy-then-edit while Claude Code is running

The test: an interactive session ran in the profile (tmux). While it was running, I added
`mcpServers.spikeExternal` with jq to a temp file and `mv`'d it over `.claude.json`
(atomic rename). I then sent a prompt, ran `/model`, and `/exit`ed. The session rewrote
the file (new `projects["<dir>"].lastSessionId`), **and `spikeExternal` was still
there**. Claude Code re-reads and merges under its `.claude.json.lock/` directory rather
than writing back a stale in-memory copy. `claude mcp add -s user …` /
`claude mcp remove -s user …` under the same `CLAUDE_CONFIG_DIR` edited the same file
("File modified: <dir>/.claude.json").

Recommendation: edit MCP config through `CLAUDE_CONFIG_DIR=… claude mcp add|remove -s user`,
which takes Claude Code's own lock. If Volley must write the file directly, do a
read → modify only `mcpServers` → write temp → `rename` cycle, and accept a small race
window. One run doesn't prove there is no race.

### Symlinks

In the profile I symlinked `settings.json`, `CLAUDE.md`, `skills/`, `agents/`,
`commands/` and `plugins/` to a shared directory, plus `.claude.json` in a second profile.

| Path | Read through the link | Written through the link | Link survives |
| --- | --- | --- | --- |
| `CLAUDE.md` | yes (answered the codeword) | not written | yes |
| `skills/` | yes (`hello` listed) | **yes**: Claude Code created `skills/synced/<orgId>_<accountUuid>/` | yes |
| `agents/` | yes (`spikeagent` listed) | not written | yes |
| `commands/` | yes (`spikecmd` listed, now shown as a skill) | not written | yes |
| `plugins/` | yes | **yes**: `known_marketplaces.json`, `marketplaces/claude-plugins-official`, `plugin-directory-cache-v2.json`, `synced/<orgId>_<accountUuid>/` | yes |
| `settings.json` | yes (statusLine ran) | **yes**: `/model` added `"model"` to the shared target | yes |
| `.claude.json` | yes | yes (`claude mcp add` wrote the target) | yes |

So Claude Code doesn't replace any of these links with a regular file, but **it writes
through them**. That makes sharing a choice about which writes you accept:

- `CLAUDE.md`, `agents/`, `commands/`: **safe to share** (read-only in practice).
- `skills/`, `plugins/`: **shareable with care**. The account-synced content lands in
  per-account buckets keyed `<orgId>_<accountUuid>`, so the accounts don't collide, but
  the shared tree holds every account's synced plugins and skills. Plugin installs and
  marketplace updates from any profile affect all of them.
- `settings.json`: **don't share as-is**. `/model` (and presumably other `/config`
  writes) in one profile changes every profile. Use a per-profile `settings.json`; layer
  shared policy through `--settings <file>` at spawn time, or regenerate it.
- `.claude.json`: **never share**. It holds per-account `oauthAccount` and caches.
- Never link or copy `.credentials.json` (see (a)).

## (d) statusLine fields and cadence

Setup: the profile's `settings.json` had
`{"statusLine":{"type":"command","command":"<scratch>/bin/dump-statusline","padding":0}}`,
where the script is `cat > dumps/$(date +%H%M%S)-$$.json; echo "spike68 statusline"`. I ran
an interactive session in tmux, sent one prompt that made two `ls` tool calls, then ran
`/model`.

### Cadence observed

| Time | Event | Dumps |
| --- | --- | --- |
| 18:47:32 | session start | 1 (no `rate_limits`, `current_usage: null`, `used_percentage: null`) |
| 18:49:28 / 18:49:30 | one 4 s turn with 2 tool calls | 2 (one per assistant message, not one per tool call) |
| 18:50:30 | `/model` switch | 1 |
| idle | none | 0 |

That matches the documented triggers: session start/resume, new assistant message,
`/compact`, permission-mode change, vim toggle, `command` change, the optional
`refreshInterval` timer, a `rate_limits.*.resets_at` passing, and a warm prompt cache's
`expires_at` passing. Updates are debounced by 300 ms, and an in-flight script is cancelled
when a new update fires. **The docs warn that triggers go quiet while the session is
idle.** A Desk usage meter fed from statusLine needs `refreshInterval` or must accept
staleness between turns.

### Sample (after the first turn, paths shortened)

```json
{
  "context_window": {
    "context_window_size": 1000000,
    "current_usage": { "cache_creation_input_tokens": 38425, "cache_read_input_tokens": 0,
                       "input_tokens": 2, "output_tokens": 152 },
    "remaining_percentage": 96,
    "total_input_tokens": 38427,
    "total_output_tokens": 152,
    "used_percentage": 4
  },
  "cost": { "total_api_duration_ms": 3428, "total_cost_usd": 0.0078887, "total_duration_ms": 117048,
            "total_lines_added": 0, "total_lines_removed": 0 },
  "cwd": "<scratch>/work",
  "effort": { "level": "medium" },
  "exceeds_200k_tokens": false,
  "fast_mode": false,
  "model": { "display_name": "Haiku 5.5", "id": "claude-haiku-5-5" },
  "output_style": { "name": "default" },
  "prompt_cache": { "cache_write_tokens": 38425, "caching_observed": true, "expected_rebuilds": 0,
                    "expires_at": 1792367367, "hit_ratio": 0, "last_miss_at": null,
                    "last_miss_cause": null, "miss_causes": {}, "miss_recache_tokens": 0,
                    "misses": 0, "recache_tokens_if_cold": 38427, "requests": 1,
                    "ttl": "1h", "warm": true },
  "prompt_id": "<uuid>",
  "rate_limits": {
    "five_hour": { "resets_at": 1792375800, "used_percentage": 11 },
    "seven_day": { "resets_at": 1792371600, "used_percentage": 43 }
  },
  "scratchpad_dir": "…",
  "session_id": "<uuid>",
  "session_name": "Directory listing with ls",
  "thinking": { "enabled": true },
  "transcript_path": "<scratch>/profS/projects/<project>/<session>.jsonl",
  "version": "2.1.303",
  "workspace": { "added_dirs": [], "current_dir": "<scratch>/work", "project_dir": "<scratch>/work" }
}
```

How this maps to the issue's questions:

- **Rate limits: yes.** `rate_limits.five_hour.used_percentage` and
  `rate_limits.seven_day.used_percentage` are 0–100. `resets_at` is Unix epoch
  **seconds**.
- **Context window: partly.** The fields are `context_window.used_percentage`,
  `remaining_percentage`, `context_window_size` (not `size`) and `total_input_tokens` /
  `total_output_tokens`. There is no `used` field; derive it from `current_usage` or the
  totals.
- **Model and cost: yes.** `model.id`, `model.display_name`, `cost.total_cost_usd`.
  `transcript_path` sits under the profile's `projects/`.

Fields the docs mark as conditional (no field is labelled "unstable"):

- `rate_limits` appears **only for Pro/Max subscribers** (or behind a gateway with a
  spend limit) and **only after the first API response**. Each window may be absent on
  its own, and a window is dropped once its `resets_at` passes.
- `context_window.current_usage` is `null` before the first API call and again just after
  `/compact`. `used_percentage` and `remaining_percentage` may be `null` early in the
  session.
- `prompt_cache`, `prompt_id` and `session_name` are absent until first response or input.
- `effort` is absent for models without effort. `pr`, `worktree` and
  `workspace.git_worktree` / `repo` are absent outside those contexts.
- `rate_limits.spend_limit.*` is gateway-only (v2.1.251+). `used_usd`, `limit_usd` and
  `period` are optional even when present.

Implication for O9: statusLine is the only first-party source of the 5-hour / weekly
percentages, but it runs inside the user's interactive session. Headless `-p` runs never
fire it. A Volley usage view built on it would capture these JSON payloads from sessions
Volley spawns (statusLine set per profile) and show the last value seen per account, with
its age.
