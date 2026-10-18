# Broker authentication + ACLs

Volley's reference broker config (`examples/mosquitto-localhost.conf`) refuses anonymous
clients on both listeners and enforces the ACL in [`acl.conf`](acl.conf).

## Why localhost needs auth

Dispatched agents run with permission prompts skipped and act on their mailbox. A
localhost-only broker still has two ways in:

- **Any web page.** Browsers let a page open a WebSocket to `ws://127.0.0.1:9001`. Without
  auth, a page you visit could publish steering into an agent's mailbox or rewrite the
  retained supervisor config (`volley/_waves/_config`).
- **Any local process.** Anything running as any user on the machine can reach `127.0.0.1:1883`.

Authentication closes both. The ACL also stops one agent from steering another and keeps
agents out of supervisor state.

This setup is still **localhost-only**. Exposing the broker on a network additionally needs
TLS (`mqtts://`, `wss://`): passwords over plain MQTT are readable on the wire. That is out
of scope here.

## Setup

```sh
volley auth init      # or: bun packages/volley-cli/src/cli.ts auth init
```

This writes `passwd` (via `mosquitto_passwd`, mode 0600) and a copy of `acl.conf` into
`<mosquitto config dir>/volley/` (`--dir` or `VOLLEY_AUTH_DIR` to choose), prints each fixed
identity's password **once**, prints the three `mosquitto.conf` lines, and reloads the broker.
`examples/mosquitto-localhost.conf` already contains those lines for Apple Silicon Homebrew:

```
allow_anonymous false
password_file /opt/homebrew/etc/mosquitto/volley/passwd
acl_file /opt/homebrew/etc/mosquitto/volley/acl.conf
```

mosquitto refuses to start when `password_file` is missing, so run `volley auth init` before
installing the config. With the default `per_listener_settings false`, these settings cover
both the TCP and the WebSocket listener.

## Identities

| Username | Who | Reads | Writes |
|---|---|---|---|
| `volleyd` | the supervisor daemon | `volley/#` | `volley/#`, including `volley/_waves/*` and `_waves/_config` |
| `desk` | browser clients (`volley dash`, the Desk) | `volley/#` | any agent's `mailbox` (steering; `config_set` goes to the daemon's mailbox), lease requests |
| `coordinator` | coordinator Claude sessions | `volley/#` | any agent's `mailbox`; the standard channels (`status`, `progress`, `result`, `capability`, `control`, `_user/*`) and registry entry of **any** agent id; lease requests |
| `<agent_id>` | one dispatched agent, minted by `volley auth add-agent` | `volley/#` | its own standard channels and registry entry, lease requests |

Nobody but `volleyd` writes `volley/_waves/*`. An agent cannot write another agent's mailbox,
status or registry entry.

**Why `coordinator` is broad.** A coordinator session runs its own MCP server, whose agent id
carries a random suffix (`coordinator-ab12`), so the ACL cannot pin it with `%u`. Agents
dispatched without a minted identity (the legacy `/volley-issues` path) inherit the MCP server's
env and therefore also log in as `coordinator`. Treat the coordinator password as operator-level.

## Giving clients their credentials

| Client | Where credentials come from |
|---|---|
| `volley-mcp` (coordinator session) | `VOLLEY_AUTH_USERNAME=coordinator`, `VOLLEY_AUTH_PASSWORD=…` in the MCP registration's `env` block |
| `volley-mcp` / hooks in a dispatched agent | the `broker` block of `.volley/agent.json` in the agent's cwd (beats `VOLLEY_AUTH_*`), so the agent needs no env |
| `volley` CLI | `--username/--password`, then `.volley/agent.json` `broker`, then `VOLLEY_AUTH_*` |
| `volley dash` | sign-in form on first load (stored in the browser's localStorage) |
| `volleyd` | its own config file |

Code that connects with an agent's identity should resolve credentials with
`resolveBrokerAuth(env, cwd)` from `volley-mcp/config` (identity file, then env, then
anonymous) and pass `username`/`password` to `VolleyBroker.connect`. A refused CONNECT surfaces
as `AUTH_FAILED` (SPEC §9).

## Supervisor hook points (mint on spawn, revoke on retire)

A supervisor that writes `.volley/agent.json` for an agent (SPEC §6.5) mints its credentials
first and revokes them when the agent retires:

```sh
creds=$(volley auth add-agent "$AGENT_ID" --json)   # {"username":"<id>","password":"…"}
# write it as the "broker" key of <worktree>/.volley/agent.json, file mode 0600
...
volley auth rm-agent "$AGENT_ID"                    # on retire
```

`add-agent` prints nothing but the credentials on stdout (warnings go to stderr), and exits
non-zero without printing a password if `mosquitto_passwd` fails.

## Reloading

`mosquitto_passwd` only edits the file; the broker re-reads `password_file` and `acl_file` on
`SIGHUP`. `volley auth` sends it to every `mosquitto` process you own (`pkill -HUP -x
mosquitto`; this covers `brew services`). A root-owned systemd broker needs `sudo systemctl
reload mosquitto`; `volley auth` warns when it cannot signal. Pass `--no-reload` to skip it.

## Editing the ACL

Read the header of [`acl.conf`](acl.conf) first. In particular, mosquitto's `deny` also blocks
reads, so do not use it to fence off `_waves/*`; the per-agent rules enumerate channels instead.
A denied publish is dropped silently under MQTT 3.1.1, so check a change with a subscriber. The
CI job `test-integration-auth` runs `packages/volley-mcp/test/integration/mosquitto-auth.test.ts`
against this exact file.
