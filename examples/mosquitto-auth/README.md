# Broker authentication: mosquitto 2.1 Dynamic Security

Volley's reference broker refuses anonymous clients on both listeners and authorises every
client through mosquitto's **Dynamic Security** plugin, with eight shared roles
([`roles.json`](roles.json)). Logins are created and deleted at runtime over the broker's control
topic (`$CONTROL/dynamic-security/v1`): there is no password file, no ACL file and no reload
signal. `volley auth` and volleyd do it; you never edit the plugin's state file.

**mosquitto 2.1 or newer is required.** The roles scope per-identity grants with `%u` (the
client's username), and mosquitto substitutes `%u` in Dynamic Security ACLs only from 2.1 on; on
2.0.x the same role would silently deny every agent. `volley auth` and volleyd read the running
broker's version (`$SYS/broker/version`, else `mosquitto -h`) and refuse an older one
(`BROKER_TOO_OLD`).

## Why localhost needs auth

Dispatched agents run with permission prompts skipped and act on their mailbox. A localhost-only
broker still has two ways in:

- **Any web page.** Browsers let a page open a WebSocket to `ws://127.0.0.1:9001`. Without auth, a
  page you visit could publish steering into an agent's mailbox or rewrite the retained supervisor
  config (`volley/_waves/_config`).
- **Any local process.** Anything running as any user on the machine can reach `127.0.0.1:1883`.

Authentication closes both, and the roles stop one agent from steering another and keep agents out
of supervisor state. This is still **localhost-only**: a broker exposed on a network additionally
needs TLS (`mqtts://`, `wss://`), since passwords over plain MQTT are readable on the wire.

## Install mosquitto 2.1

The one command (the root README's [Quickstart](../../README.md#quickstart)) installs it (Homebrew
on macOS, the snap on Ubuntu/Debian when snapd runs) and `volley setup` configures it as below;
`volley setup --check` reports the Broker and Security rows. By hand:

| Platform | Install | Config | Plugin | State file |
|---|---|---|---|---|
| macOS (Homebrew) | `brew install mosquitto` | `/opt/homebrew/etc/mosquitto/mosquitto.conf` (Intel: `/usr/local/…`) | `/opt/homebrew/opt/mosquitto/lib/mosquitto_dynamic_security.so` | `/opt/homebrew/var/mosquitto/dynamic-security.json` |
| Linux (snap) | `sudo snap install mosquitto` | `/var/snap/mosquitto/common/mosquitto.conf` | `/snap/mosquitto/current/usr/lib/<arch>/mosquitto_dynamic_security.so` | `/var/snap/mosquitto/common/dynamic-security.json` |
| Container | `docker run eclipse-mosquitto:2.1-alpine` | `/mosquitto/config/mosquitto.conf` ([`mosquitto-dynsec.conf`](mosquitto-dynsec.conf)) | `/usr/lib/mosquitto_dynamic_security.so` | `/mosquitto/data/dynamic-security.json` |

- **Distribution packages** (`apt install mosquitto` and similar) may still ship 2.0.x: use the
  snap, which is 2.1. With both installed, make sure the running broker is the snap's
  (`/snap/bin/mosquitto -h`), and that the distro service is stopped.
- **Snap confinement:** the snap's broker may write only under `/var/snap/mosquitto/common/`, so
  its state file must live there (`volley auth init` puts it there).
- **Container:** map the listeners to the host's loopback only, e.g.
  `-p 127.0.0.1:1883:1883 -p 127.0.0.1:9001:9001`.
- **A self-built 2.1 under a distro AppArmor profile** (Ubuntu's profile for
  `/usr/sbin/mosquitto` lets the broker write only `/var/lib/mosquitto/mosquitto.db`): the plugin
  cannot write its state file until a local rule allows it, e.g. in
  `/etc/apparmor.d/local/mosquitto`:

  ```
  /var/lib/mosquitto/dynamic-security.json rw,
  /var/lib/mosquitto/dynamic-security.json.new rw,
  ```

  then `sudo apparmor_parser -r /etc/apparmor.d/usr.sbin.mosquitto`. Volley does not manage
  AppArmor.

## Setup

```sh
volley auth init --coordinator-file --volleyd-file   # or: bun packages/volley-cli/src/cli.ts auth init …
# restart the broker as it says (brew services restart mosquitto / sudo snap restart mosquitto)
volley auth init                                     # rerun: creates the roles and identities
```

`init` is idempotent and does what is still missing, in this order:

1. Refuses a broker older than 2.1 before changing anything.
2. Writes the broker config for your install ([`mosquitto-localhost.conf`](../mosquitto-localhost.conf)
   is its output for Apple Silicon Homebrew), atomically and with a backup of the old one
   (`<config>.volley-backup-<time>`). It refuses a config with one of the **traps** below.
   `--no-config` leaves your config alone; `--layout` and `--config` pick another install.
3. Creates the plugin's state file with its first admin login (`mosquitto_ctrl dynsec init`) and
   stores that login in `<auth dir>/admin.json` (mode 0600). Only `volley auth` and volleyd use it.
4. Once the broker runs the plugin (restart it, or pass `--restart`), creates the eight shared
   roles and the fixed identities `volleyd`, `desk` and `coordinator`, printing their new passwords
   **once**. `--coordinator-file` writes the coordinator's to `<auth dir>/coordinator.json`;
   `--volleyd-file` writes volleyd's to `$VOLLEYD_HOME/broker.json` and a copy of the admin login to
   `$VOLLEYD_HOME/dynsec-admin.json` (both 0600), which volleyd mints agents with.

A rerun keeps every existing password; `init --force` rotates the fixed identities (their
sessions are disconnected and sign in again).

### The config, and its traps

The generated config puts the plugin and its state file **before any listener**, sets
`per_listener_settings false`, `allow_anonymous false`, `set_tcp_nodelay true` and
`max_queued_messages 10000`, and opens the TCP (1883) and WebSocket (9001) listeners on
127.0.0.1. `init` refuses an existing config that has:

- **`per_listener_settings true`**: the plugin options then sit before the first listener, which
  makes mosquitto add an implicit default listener on port 1883; and repeating the plugin under each
  listener instead is refused by 2.1.
- **the plugin loaded twice** (also through an `include_dir` file): 2.1 refuses to start
  ("Dynamic security plugin can currently only be loaded once").

`set_tcp_nodelay true` matters: with mosquitto's default, every control request/response round trip
took about 41 ms. `max_queued_messages` is raised from mosquitto's default of 1000 because the
Desk's subscriber to the whole tree overflowed it while agents were being created and deleted.

### Why the sweep matters

The plugin rewrites its **whole** state file after every change (once per control message on 2.1),
so the file size, about 300 bytes per login, drives the cost of every mint. No login ever expires.
volleyd therefore batches simultaneous changes into one message (`dynsec_batch_ms`) and **sweeps**:
at start and every `credential_sweep_interval_s` it deletes the logins of agents that are no longer
live, so the file holds only live agents, the fixed identities and the accounts (SPEC §4.6.13).

## Roles and identities

| Role (broker name) | Held by | Writes |
|---|---|---|
| `agent` (`volley-agent`) | each dispatched agent (username = agent id) | its own `status`, `progress`, `result`, `capability`, `usage`, `control`, `_user/*` and registry entry (`%u`), lease requests, and the mailboxes of `volleyd` and `desk` (acks) |
| `account` | the Desk, coordinators, every account | its own channels, registry entry and machine record `volley/_system/machines/%u` (nothing under it, so no account writes a machine's readiness verdict), lease requests |
| `desk` | the Desk, `steer` accounts | any agent's `mailbox` (steering; control requests to the daemon); its own `volley/_system/auth/ops/%u` (Needs-you answers, where the broker names the sender); reads `volley/_system/desk-probe/%c` (the Desk's resume probe, its own client id) |
| `coordinator` | coordinator sessions | any agent's `mailbox`, standard channels and registry entry |
| `admin` | `admin` accounts | what `coordinator` may, plus `volley/_system/auth/ops/%u` |
| `supervisor` | `supervisor` accounts (another volleyd) | the whole tree except the account-op and answer topics |
| `volleyd` | the supervisor daemon | the whole tree (`_waves/*`, `_waves/_config`, screens) and `volley-auth/#` |
| `token` | a one-time token's login (username = token id) | `volley-auth/redeem/%u`; it may read only `volley-auth/redeem/%u/reply` |

Every role except `token` reads the whole `volley/` tree. The roles carry a `volley-` prefix in
the broker because `mosquitto_ctrl dynsec init` already creates a role named `admin` that may
administer the plugin. **Roles are never edited while clients hold them**: an ACL change on a role
disconnects every client holding it. After upgrading Volley, `init` reports a role that differs
from this version's; `volley auth migrate --roles` shows the change and `--roles --yes` applies it
(its holders reconnect). On a broker initialised before v0.2.0's `usage` channel, rerun
`volley auth init`; if it reports a drifted role, run `volley auth migrate --roles --yes`, or the
old `volley-agent` role drops every agent's `usage` samples without an error (volleyd warns at start).
On a broker initialised before the Fleet (v0.4.0), `volley-account` still grants
`volley/_system/machines/%u/#`, which lets a paired machine write its own readiness verdict (SPEC
§4.6.15): run `volley auth migrate --roles --yes`. That grant is narrowed rather than refused because
a login's roles are checked in the order it holds them and the first matching ACL decides: a deny in
`volley-account` would also bind a `supervisor` account, which holds `volley-account` first.

Nobody but `volleyd` writes the supervisor topics SPEC §4.6 defines under `volley/_waves/*`. An
agent login cannot write another agent's mailbox, status or registry entry; that guarantee does not
cover the operator-level `coordinator` identity.

**Acks.** SPEC §4.4 has a recipient ack by publishing to the sender's mailbox. The agent role lets
an agent ack `volleyd` and the Desk, with nothing granted per agent. A coordinator session's agent id
is random-suffixed (`coordinator-ab12`), which no static role can name, so an agent's ack to a
coordinator is dropped by the broker (`vol_send_mailbox` with `wait_ack_ms` reports
`acked: false`; the steer itself is delivered). Steering that must be confirmed goes through volleyd
(`volleyd steer`) or the Desk.

**Limits of the `+` wildcard.** mosquitto's `+` also matches the reserved `_waves`, `_system` and
`_meta` levels, and a role cannot exclude them: `volley/+/%u/status` also matches
`volley/_waves/<agent id>/status`. No topic SPEC defines there ends in a channel name, so this is safe
as long as wave ids, lease-pool names and agent ids are not channel names: SPEC §4.6 forbids it for
waves and pools, and `volley auth add-agent` refuses such agent ids (and `registry`, `leases`,
`health`, `federation`, `machines`, `auth`).

**A denied publish is dropped silently** for MQTT 3.1.1 clients (they still get a PUBACK); check a
change with a subscriber. A denied subscription is refused outright.

## Accounts and one-time tokens

`volley auth add <name> --role <admin|steer|watch|supervisor|peer>` creates an account: a login that
holds `account` plus its role's (`admin` → `admin`, `steer` → `desk`, `supervisor` → `supervisor`;
`watch` and `peer` only `account`). The registry is `accounts.json` in the auth directory (never a
password). `rotate` sets a new password (the account's sessions are disconnected), `revoke` deletes
the login and the entry, `list` shows the registry.

`volley auth token` prints a single-use admin token (`vly_admin_<id>_…`, 10 minutes; only its hash is
stored in `tokens.json`); volleyd's `signin_link` op makes a `steer` or `watch` one for a device. The
token is also the password of a login named `<id>` holding the `token` role, which reaches only its
own request and answer topics under `volley-auth/redeem/<id>`. Redeeming burns the token but keeps
the login for about a minute (the redeeming client is still connected as it, waiting for its
answer); the next account command after that, or after the token expires, deletes it, and volleyd
runs `volley auth list` every minute (`token_prune_ms`) for this.

## Giving clients their credentials

| Client | Where credentials come from |
|---|---|
| `volley-mcp` (coordinator session) | `VOLLEY_AUTH_USERNAME=coordinator`, `VOLLEY_AUTH_PASSWORD=…` in the MCP registration's `env` block |
| the coordinator's **shell** (`volley wait` / `volley sub`, `mosquitto_pub`) | the same two variables exported in your shell profile |
| GitHub Actions bridge (`examples/bridges/github-actions/`) | `VOLLEY_AUTH_*` from repo secrets |
| volley-hooks in a coordinator session | `VOLLEY_AUTH_*`, else `$VOLLEY_AUTH_DIR/coordinator.json` (`init --coordinator-file`) |
| `volley-mcp` / hooks in a dispatched agent | the `broker` block of `.volley/agent.json` in the agent's cwd, written by volleyd at spawn |
| `volley` CLI | `--username/--password`, then `.volley/agent.json` `broker`, then `VOLLEY_AUTH_*` |
| `volley dash` / the Desk | sign-in form on first load (stored in the browser) |
| `volleyd` | `$VOLLEYD_HOME/broker.json` (its login) and `$VOLLEYD_HOME/dynsec-admin.json` (agent logins) |

A refused CONNECT surfaces as `AUTH_FAILED` (SPEC §9).

## Agent logins (a supervisor's hook points)

volleyd mints and deletes agent logins itself over one long-lived admin control connection. A
supervisor of your own can use the CLI:

```sh
creds=$(volley auth add-agent "$AGENT_ID" --json)   # {"username":"<id>","password":"…"}
# write it as the "broker" key of <worktree>/.volley/agent.json, file mode 0600
...
volley auth rm-agent "$AGENT_ID"                    # on retire (safe to retry)
volley auth list-agents                             # what is left
```

`rm-agent` deletes only agent logins. Deleting a login disconnects the agent **without its will**,
so publish its retained `reaped` status yourself before deleting it (volleyd does, SPEC §4.6.13).
volleyd's sweep deletes any agent login with no live agent behind it, including ones another tool
minted, once it has seen it for `spawn_timeout_s`.

## Migrating from `password_file` + `acl_file`

```sh
volley auth migrate --coordinator-file --volleyd-file   # then restart the broker and rerun it
```

`migrate` is `init` plus: new passwords for the fixed identities, written to the credential files
their clients already read (`coordinator.json`, volleyd's `broker.json`; Desk users sign in again
once); a login for every agent with a minted `.volley/agent.json` under the worktree roots (`~/.volley/worktrees`,
`$VOLLEYD_HOME/worktrees`, or the `--worktrees` you name; under sudo, the invoking user's home), created
with the password the file already holds, so running agents keep working after the restart (a file
without one gets a new password and its agent must be restarted); and a login for every account in
`accounts.json` (new passwords, printed once). Any other user in `passwd` is named as not migrated:
give it a login with `volley auth add` or `add-agent`. One-time tokens that were still pending cannot
be migrated (only their hash is stored): issue new ones. Rerunning it changes nothing. Rollback: copy
the config backup it names back and restart.

[`acl.conf`](acl.conf) is the file-based ACL of earlier Volley versions, kept for reference while
migrating; the broker no longer reads it.

## Tests

`packages/volley-cli/test/integration/mosquitto-dynsec.test.ts` proves the roles against a real
2.1 broker (the `%u` scoping, the Desk, supervisor and token rules, anonymous refused on TCP and
WebSocket, no LWT on delete); the CI job `test-integration-dynsec` runs it, and the volley-mcp,
volley-hooks and volleyd auth suites, against the `eclipse-mosquitto:2.1-alpine` container bootstrapped by
`test/integration/dynsec-fixture.ts`.
