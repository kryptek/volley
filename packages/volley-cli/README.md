# volley-cli

```
░▒▓ volley · the CLI for shell-script agents and CI ▓▒░
```

A small, fast CLI that lets shell scripts, cron jobs, CI runners, and any non-LLM process participate in Volley's coordination protocol — alongside Claude Code, Codex, and other MCP-driven agents.

If you can write a bash one-liner, you can be a Volley agent. The subcommands cover everything: set the machine up (`volley setup`), announce a status, watch for terminal states, subscribe to a stream, list who's around, launch or serve the Desk, surface agent transitions as system notifications, manage broker credentials, and wait for a heavy-operation lease.

---

## Contents

- [Install](#install)
- [The subcommands](#the-subcommands)
- [`volley setup`](#volley-setup)
- [`volley desk serve`](#volley-desk-serve)
- [`volley dash`](#volley-dash)
- [`volley notify`](#volley-notify)
- [`volley auth`](#volley-auth)
- [`volley lease`](#volley-lease)
- [`volley peer`](#volley-peer)
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

## The subcommands

| Subcommand | Purpose |
|---|---|
| `volley pub`    | Publish one envelope to a channel. The publish-side primitive. |
| `volley sub`    | Subscribe to a wildcard topic pattern. JSONL output, one message per line. |
| `volley wait`   | Block until a specific agent reaches a terminal status (`done`/`blocked`/`failed`/`reaped`). The "is it done?" primitive. |
| `volley list`   | Enumerate agents in a namespace (or all namespaces). Human table by default; `--json` for tooling. |
| `volley dash`   | Launch the browser dashboard (Vite dev server). See [`volley dash`](#volley-dash) below. |
| `volley notify` | Long-lived subscriber that fires terminal bell, macOS desktop banners, and/or HTTP webhooks on matching agent transitions. See [`volley notify`](#volley-notify) below. |
| `volley auth`   | Broker logins on mosquitto 2.1 Dynamic Security: `init` / `migrate` the shared roles and fixed identities, agent logins, role accounts and one-time admin / sign-in tokens. See [`volley auth`](#volley-auth) below. |
| `volley lease`  | Wait for a heavy-operation lease from `volleyd` (`run`, `acquire`, `release`, `status`). See [`volley lease`](#volley-lease) below. |
| `volley peer`   | Pair a second machine with `volleyd`'s: `invite` (a one-time code) and `remove` (both admin ops: an admin account's login) and `list` on the supervisor's machine, `join <code> --to <host>` on the new one (doctor, account, tunnel service, trust check, host entry), `doctor` (check this machine, `--fix` the safe things), `run` (the service). See [`volley peer`](#volley-peer) below and the volleyd README's "Paired machines". |
| `volley setup`  | First-run / repair wizard: broker, accounts, services, phone sign-in QR. See [`volley setup`](#volley-setup) below. |
| `volley desk serve` | Serve the built Desk from a small static server (the service `volley setup` installs). See [`volley desk serve`](#volley-desk-serve) below. |

Each has its own `--help`:

```sh
volley pub --help
volley sub --help
volley wait --help
volley list --help
volley dash --help
volley notify --help
volley auth --help
volley setup --help
```

---

## `volley setup`

One idempotent command takes a machine from "mosquitto installed" to a phone-ready Desk. Five steps; each prints what it found and what it will change (config diffs included) **before** changing anything, then asks (`--yes` applies without asking):

```sh
volley setup            # interactive: confirm each step
volley setup --yes      # non-interactive (WebSocket listener kept on this machine: no phone step)
volley setup --yes --lan   # non-interactive, the broker's WebSocket listener open to your network
volley setup --repair   # check and fix only (no new admin token, no phone link)
volley setup --step services   # only the named step(s)
```

1. **Broker**: the install (`--layout`, detected as `volley auth` does), mosquitto's version (older than 2.1 is refused with the install hint), what the listeners on 1883 and 9001 do with an anonymous client, and how many agents are running (a retained status that has not ended).
2. **Security**: the Dynamic Security broker config `volley auth init` writes (the diff is shown; the old file is backed up to `<config>.volley-backup-<timestamp>`), the plugin's state file with its admin login (`<dir>/admin.json`, 0600), a restart with the layout's command, then a check that **both** listeners refuse anonymous clients. It also asks whether devices on your network may reach the WebSocket listener (port 9001), which the Desk on a phone needs: interactively the recommended answer is yes; `--lan` / `--no-lan` decide without asking, and `--yes` alone means no. With LAN access on, the config gets `listener 9001` (every interface) while `listener 1883 127.0.0.1` stays local, and the check also probes `ws://<desk host>:9001`, which must refuse anonymous clients (reachable, and logging in), not be unreachable. Logins are required either way, but LAN traffic is **not encrypted** until a TLS listener exists: open it only on a network you trust. A rerun keeps whichever choice the config already has.
3. **Accounts**: Volley's shared roles and the fixed identities `volleyd`, `desk`, `coordinator` (`volley auth init` underneath: existing logins keep their passwords, missing ones are created and their passwords printed once), their credential files (`<dir>/coordinator.json`, `$VOLLEYD_HOME/broker.json` and `dynsec-admin.json`; a login whose file is gone gets a new password), drifted roles (a grant this Volley added, such as the `usage` channel, missing from a broker set up earlier: publishes on it are dropped silently) with the `volley auth migrate --roles` change shown first, a copy of the coordinator's login in the macOS keychain (service `volley-broker`, written through `security -i` on stdin so the password is never on a command line; `coordinator.json` stays the file the hooks and the MCP env read, and elsewhere it is the only copy), and a **one-time admin token** for the Desk, printed in the terminal only.
4. **Services**: volleyd (`volleyd install` on macOS, a `systemd --user` unit on Linux), the Volley hooks for coordinator sessions (`packages/volley-hooks/scripts/install.sh`, which backs up `~/.claude/settings.json`), and the Desk: built (`vite build`), rebuilt whenever its sources or `bun.lock` changed since the build setup recorded in `dist/.volley-build` (so `--repair` after an update serves a matching Desk), and served by `volley desk serve` on `0.0.0.0:5199` as a service. Under sudo it is skipped (the later steps still run): run `volley setup --step services` as your user.
5. **Phone**: a one-time `steer` sign-in link for "Desk on phone" (10 minutes, single use), rendered as a QR code in the terminal with the URL `http://<this machine>:5199/#signin=<token>` (`--desk-host` names another address; the default is this machine's address on a physical interface, not a container or VPN bridge). When a phone cannot reach the broker's WebSocket listener at `ws://<desk host>:9001` (LAN access off), the step is skipped, no link is spent, and the run ends saying so instead of "Setup complete".

A rerun plans nothing for what is in place and reports each step as already done. The admin token and the phone's link count as in place while pending or once redeemed: after they expired unused (10 minutes), a rerun issues new ones. Every step is journaled to `$VOLLEYD_HOME/setup.log` (summaries only, never a password or token). Every external command (the broker restart, `launchctl` / `systemctl`, `security`, the hooks installer, the Desk build) runs without a shell, through a fence that allows exactly those commands and refuses any other. The Desk build is refused while `packages/volley-desk/.env*` sets `VITE_VOLLEY_BROKER_*` (Vite would build it into the page served to your network). `--broker-url` must be `mqtt://`: TLS is not supported by `volley setup` yet.

---

## `volley desk serve`

```sh
volley desk serve                       # http://127.0.0.1:5199, from packages/volley-desk/dist
volley desk serve --host 0.0.0.0        # for a phone on the LAN (what the setup service runs)
volley desk serve --port 8080 --root /path/to/dist
```

A small static server for the built Desk (`bun run --cwd packages/volley-desk build`): hashed assets are cached for good, the index never, every unknown path gets the index, and nothing outside the build directory is served. It holds no credentials: the page signs in to the broker itself (port 9001 on the host the page came from).

---

## `volley dash`

Launches the [Volley Desk](../volley-desk/) — an infinite canvas of live wave and agent windows (steering, settings, attention, arrange & fit) that subscribes directly to your mosquitto broker over WebSocket. No backend. It works at phone width, without WebGL and from the keyboard.

```sh
volley dash                          # dev server, opens browser at http://localhost:5174
volley dash --no-open                # dev server, don't open browser
volley dash --build                  # production build + preview (http://localhost:4173)
volley dash --broker-url ws://host:9001  # point at a non-default broker
volley dash --host 0.0.0.0           # serve on the LAN (a phone opens http://<LAN IP>:5174)
volley dash --legacy                 # the classic dashboard (packages/volley-dash, :5173)
```

On first load the Desk asks for broker credentials: sign in as the `desk` identity from `volley auth init`. With `--host` and no `--broker-url`, the Desk connects to port 9001 on the host it was loaded from, so a phone reaches this machine's broker, once mosquitto also has a WebSocket listener on the LAN address: the example conf binds `127.0.0.1` only. That listener exposes the broker to the LAN, so keep `allow_anonymous false` with the `volley auth` accounts, and note that `ws://` carries the password in cleartext. Open the page by IP, since Vite refuses other host names. See the Desk's [LAN use](../volley-desk/README.md#lan-use). `--build` drops `VITE_VOLLEY_BROKER_USERNAME` / `VITE_VOLLEY_BROKER_PASSWORD` from its environment, because Vite would inline them into the bundle.

`--legacy` launches the classic [`volley-dash`](../volley-dash/) dashboard (status grid + event feed + per-agent drawer) instead. It is deprecated and will be removed in a later release; every other flag works with it.

**Prerequisite:** mosquitto must have a WebSocket listener on `:9001` — the bundled `examples/mosquitto-localhost.conf` configures it. If `lsof -nP -iTCP:9001 -sTCP:LISTEN` returns nothing, see the root [README §2](../../README.md) for the install + upgrade steps.

---

## `volley notify`

Long-lived subscriber that bridges agent state transitions to the human-visible surfaces you're already paying attention to: the terminal bell in the shell you're in, macOS desktop banners, or arbitrary HTTP webhooks. Runs until SIGINT/SIGTERM. Default trigger set is `blocked,failed,reaped` (attention-needed only — `done` is expected and would create noise during dispatch loops).

```sh
# Bell-only, watch every status transition on the default namespace
volley notify --pattern 'volley/+/+/status'

# Webhook to ntfy.sh + macOS desktop banner + terminal bell
volley notify --pattern 'volley/+/+/status' \
  --surface bell,desktop,webhook \
  --webhook-url https://ntfy.sh/your-private-topic
```

The surfaces fire concurrently; one surface erroring (e.g. webhook returns non-2xx) never aborts the loop. Each fired notification emits one JSON line on stdout (`{topic, type, agent_id, surfaces}`) so you can pipe to `jq` for live-tail.

| Flag | Env | Default | Description |
|---|---|---|---|
| `--pattern <filter>` | — | (required) | MQTT topic filter, e.g. `volley/+/+/status` for a whole namespace |
| `--on <csv>` | `VOLLEY_NOTIFY_ON` | `blocked,failed,reaped` | Lifecycle types that fire (`spawning,working,done,blocked,failed,reaped,registered`) |
| `--surface <csv>` | `VOLLEY_NOTIFY_SURFACES` | `bell` | Comma-separated surfaces: `bell`, `desktop`, `webhook` |
| `--webhook-url <url>` | `VOLLEY_NOTIFY_WEBHOOK_URL` | — | Required only when `webhook ∈ --surface`. Must be `http(s)://` |
| `--namespace <ns>` | `VOLLEY_NAMESPACE` | `default` | Informational (the pattern already encodes the namespace) |
| `--username <user>` | `VOLLEY_AUTH_USERNAME` | anonymous | Broker username |
| `--password <pw>` | `VOLLEY_AUTH_PASSWORD` | none | Broker password (prefer the env var: argv is visible in `ps`) |
| `--broker-url <url>` | `VOLLEY_BROKER_URL` | `mqtt://localhost:1883` | MQTT broker |
| `--help` / `-h` | — | — | Print usage and exit |

**Desktop surface (macOS only)** shells out to [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) — install via `brew install terminal-notifier`. If absent, the desktop surface logs a one-time warning to stderr and degrades to no-op for the rest of the process; the other surfaces continue to fire. Sound configurable via `VOLLEY_NOTIFY_SOUND` (default `Glass`).

**Webhook surface** POSTs `{topic, envelope}` JSON with a 5s timeout. Non-2xx responses are logged but not retried — notification, not delivery.

Exit codes: `0` clean SIGINT/SIGTERM, `1` broker error, `2` invalid usage.

---

## `volley auth`

The reference broker ([`examples/mosquitto-auth/`](../../examples/mosquitto-auth/README.md)) is **mosquitto 2.1 or newer** with the Dynamic Security plugin: it refuses anonymous clients and authorises every login through eight shared roles. `volley auth` creates and deletes logins over the broker's control topic with the admin login in `<dir>/admin.json`; there is no password file, no ACL file and no reload. Every verb refuses a broker older than 2.1 (`BROKER_TOO_OLD`, with the brew / snap / container install instructions).

```sh
volley auth init                          # broker config (backed up) + state file + admin login, then,
                                          # once the broker runs it: the shared roles and the fixed
                                          # identities, printing their passwords ONCE. Rerunnable.
volley auth migrate                       # from password_file + acl_file: init, plus logins for the
                                          # agents' .volley/agent.json and the accounts. Rerunnable.
volley auth migrate --roles [--yes]       # show / apply role changes (disconnects their holders)
volley auth add-agent w1-t1-implementer-1 # an agent login (username = agent id); prints only the password
volley auth add-agent w1-t1-implementer-1 --json   # {"username","password"} for .volley/agent.json "broker"
volley auth rm-agent w1-t1-implementer-1  # delete it on retire (succeeds if already gone)
volley auth list-agents [--json]          # the agent logins

volley auth add phone --role steer        # an account with a role; prints its password ONCE
volley auth add build-box --role peer --json   # {"username","password","role"}
volley auth rotate phone                  # new password, printed once (its sessions disconnect)
volley auth revoke phone                  # the login and the account entry removed
volley auth list [--json]                 # the accounts (never their passwords)
volley auth token                         # one-time admin token for the Desk (10 min, single use)
volley auth signin-link --role steer --label "Owner's phone"   # one-time sign-in token
echo "$TOKEN" | volley auth redeem --label "Desk on mac" --json  # what volleyd runs on redemption
```

- **`init`** detects the install (`--layout brew-arm64|brew-intel|snap|etc|container`; the snap first on Linux) and writes its config: the plugin before any listener, `per_listener_settings false`, `allow_anonymous false`, `set_tcp_nodelay true`, `max_queued_messages 10000`, TCP 1883 and WebSocket 9001 on 127.0.0.1. It refuses an existing config with `per_listener_settings true` or the plugin loaded twice, naming the trap. `--no-config` leaves the config to you, `--config` / `--state-file` choose other paths, `--restart` runs the layout's restart command and carries on instead of asking you to restart and rerun.
- **Fixed identities** `volleyd`, `desk` and `coordinator` are created once; a rerun keeps their passwords, `--force` rotates them. `--coordinator-file` writes `<dir>/coordinator.json` (mode 0600; the coordinator's hooks read it when `VOLLEY_AUTH_*` is unset); `--volleyd-file` writes `$VOLLEYD_HOME/broker.json` and `$VOLLEYD_HOME/dynsec-admin.json` (0600), volleyd's login and the admin login it mints agents with; under sudo they go to the invoking user's home, owned by that user.
- **Agent logins** hold the `agent` role alone: their own channels and registry entry (`%u`), lease requests, and acks to `volleyd` and the Desk. Nothing is granted per agent, so there is no `--ack-to` and no `grant`: an agent's ack to a random-suffixed coordinator is dropped by the broker. `add-agent` refuses the fixed identities, the admin, 8-hex-digit ids (token logins) and ids the roles' namespace wildcard would carry into reserved topics (`registry`, `leases`, `health`, `federation`, `machines`, `auth`, and the channel names). `rm-agent` deletes only agent logins. Deleting a login disconnects the agent without its will: volleyd publishes its `reaped` status itself.
- **Roles** of accounts: `admin` (a coordinator's writes plus account ops on `volley/_system/auth/ops/<name>`), `steer` (write mailboxes), `watch` (no writes beyond the `account` role's own-identity ones), `supervisor` (read/write everything like `volleyd`, except the account-op and answer topics under `volley/_system/auth/`), `peer` (a paired machine: `volley/_system/machines/<name>[/#]`, which the `account` role already grants). Every account holds the shared `account` role (read `volley/#`; write its own `%u` channels, registry entry, lease requests and machine record) plus its role's. The registry is `accounts.json` (name, role, kind, created, label); `--kind` is `human` \| `device` \| `machine` \| `service` (default from the role).
- **One-time tokens** (`token`, `signin-link`) are stored only as a sha256 hash in `tokens.json`. Each is also the password of a temporary login named by the token id, holding the `token` role: it may only write `volley-auth/redeem/<id>` and read `volley-auth/redeem/<id>/reply`, so the Desk can redeem it through volleyd (SPEC §4.6.10) while the broker keeps refusing anonymous clients. `redeem` reads the token from stdin, burns it and creates an account with the token's role (refusing, token unburned, if that `<role>-<id>` name is taken; `add` reserves that shape). The login outlives the redemption by about a minute so the redeeming client, still connected as it, gets its answer; the next account command after that, or after the token expires, deletes it (volleyd runs `volley auth list` every minute for this). `accounts.json` and `tokens.json` are replaced by rename, never rewritten in place.

Files live in `--dir` (env `VOLLEY_AUTH_DIR`; default `<mosquitto config dir>/volley`, e.g. `/opt/homebrew/etc/mosquitto/volley`, or `/var/snap/mosquitto/common/volley` on a snap-only machine; the broker never reads it). `--broker-url` (env `VOLLEY_BROKER_URL`) names the broker. The admin password reaches `mosquitto_ctrl dynsec init` on its command line once, so it is briefly visible in `ps` while that child runs.

---

## `volley peer`

Pairs a second machine with `volleyd`'s, so waves can run agents there (SPEC §4.6.14; the volleyd
README's "Paired machines" has the whole walk-through). On the supervisor's machine, as an admin
account: `volley peer invite` (a one-time code), `volley peer invite --for <name>` (a code that
re-pairs the paired machine `<name>`), `volley peer list`, `volley peer remove <name>`. On the
machine to pair: `volley peer join <code> --to <user@supervisor> --repo <clone>` (add
`--name <name> --replace` with a `--for` code), then the `volley peer run` service it installs.

### `volley peer doctor`

The one command that says whether this machine can run an agent, and what to do if not:

```sh
volley peer doctor                       # one line per check: ✓ ok, ! warning, ✗ blocks agents
volley peer doctor --fix                 # print the plan, ask, apply the safe fixes, check again
volley peer doctor --fix --yes --clone --origin https://github.com/example-org/example-repo
volley peer doctor --json                # the machine record's doctor fields (SPEC §4.6.15)
```

| Check | Severity | What it looks at |
|---|---|---|
| `tool.<name>` | block (`gh`: warn) | `bun git gh tmux nc base64 cmp claude` installed (`command -v`), and their versions |
| `bun_on_path`, `claude_on_path` | block | the tool resolves on the non-interactive ssh `PATH` volleyd's `ssh <box> bash -s` gets (sshd's default `PATH` through your login shell's non-interactive startup) |
| `volley.installed` | block | the volley checkout (`--volley-dir`, default the one running) has `node_modules/.bin` and `bun install --frozen-lockfile --dry-run` is clean |
| `volley.version` | block | the checkout's version is the one the supervisor requires (its readiness verdict's `requirements.volley`, read through the tunnel when this machine is paired) |
| `repo.clone`, `repo.origin` | block | `--repo` (default `peer.json`'s) is a git clone whose `origin`, normalised to `<host>/<path>`, is `--origin`'s |
| `repo.fetch` | warn | `origin` (or `origin/<--release>`) answers `git ls-remote` with `GIT_TERMINAL_PROMPT=0` |
| `gh.auth` | warn | `gh auth status`, and `gh repo view <owner/repo> --json viewerPermission` is WRITE, MAINTAIN or ADMIN (`auth.gh`: `ok`, `no_write`, `unauthenticated`, `missing`) |
| `claude.signin` | warn | `claude auth status` (`auth.claude`: `signed_in` with the plan's label, `not_signed_in`, `missing`, `unknown`) |
| `claude.trust` | warn | `~/.claude.json` trusts the repo's folder or a parent (`auth.trust`) |
| `machine.memory`, `machine.disk` | warn | available memory (macOS: `memory_pressure`), free space where the worktrees go (`<repo>/../.volley-worktrees`) |

**Fixes.** `--fix` runs only what writes inside the volley checkout (`bun install
--frozen-lockfile`; with a known requirement, `git fetch origin --tags && git checkout --detach
v<version> && bun install --frozen-lockfile`) and, with `--clone` and `--origin`, one `git clone`
into an empty `--repo`. It prints its plan and asks first unless `--yes`, and a second run reports
each of those as "already done". Everything else is printed for you to run: installing a tool,
the `sudo ln -s ~/.local/bin/claude /usr/local/bin/claude` that puts Claude Code on the ssh
`PATH` (macOS: a line in `~/.zshenv`), `gh auth login && gh auth setup-git`, the Claude sign-in,
a wrong `origin` (explained, never changed). Exit status 1 while a `block` check fails.

**No secrets.** The doctor keeps states and plain labels only: exit codes of `gh auth status`,
the `loggedIn` and plan of `claude auth status`, an origin with any credentials stripped. Nothing
it prints or publishes carries a token (it also scrubs anything token-shaped), and `--origin`
refuses a URL with a password or token in it.

**Where it runs.** `volley peer join` runs it first and stops on a `block` check before the
pairing code is used, so the code stays valid while you fix things; `warn` checks are printed and
the join goes on. `volley peer run` runs it every `PEER_DEFAULTS.doctor_interval_s` (600 s) and
puts its last result (`versions`, `auth`, `repo`, `checks` without fix text, `doctor_at`) in
every heartbeat, with `kind: peer`, `memory`, `disk` and `uptime_s` read fresh each time.

---

## `volley lease`

Heavy operations (integration-test suites, builds, browsers) share machine-global **lease pools**
that `volleyd` hands out FIFO up to each pool's capacity (SPEC §4.6.5; pools are the daemon's
`lease_pools` config). Wrap a command and it waits its turn:

```sh
volley lease run --pool backend-it -- mvn -q verify
# volley lease: queued for a backend-it lease (queued: 3/3 backend-it leases held)
# volley lease: backend-it lease granted after 42 s
# ...mvn output...                   exit code = mvn's; the lease is released on exit or SIGINT/SIGTERM/SIGHUP

volley lease acquire --pool build --lease-id nightly-1     # {"pool":"build","lease_id":"nightly-1","holder":"lease-x1y2z3","waited_s":0}
volley lease release --pool build --lease-id nightly-1 --holder lease-x1y2z3   # default holder: a <holder>.<rand> id's prefix
volley lease status                                        # every pool: holders, queue, reasons
```

- **Holder** = `--holder`, else the `agent_id` in `<--project-dir or cwd>/.volley/agent.json`, else a
  random `lease-xxxxxx` (`acquire` prints it so `release` can name it). The supervisor only accepts
  requests whose holder is the sender, and frees a holder's leases when its `status` turns
  `reaped`/`done`/`failed`.
- `run` renews the lease at half its TTL while the command runs (after a dropped broker connection
  it reconnects and asks for the lease again), and forwards SIGINT/SIGTERM/SIGHUP to the command's
  whole process group. A signal during the wait cancels the queued request (exit `128 + signal`);
  `--timeout <s>` gives up with `124`.
- **A dead client frees its slot**: `run` and `acquire` connect with an MQTT will that releases
  their lease, so a client that is killed (SIGKILL, OOM, a closed terminal) or loses its network
  releases it at once instead of at TTL expiry. A killed `run` also takes its command down (SIGTERM
  to the command's process group), so the work does not carry on without the lease.
- **`run` fails open, and never waits on nobody**: with the broker unreachable, no live `volleyd`,
  or a pool that is not configured, it warns on stderr and runs the command unleased — a lease is
  a courtesy to the machine, never a reason an agent's build cannot run. While queued it checks
  every 30 s: if volleyd went away, the pool was removed (or dropped the request), or volleyd never
  queued the request after 3 re-sends, it prints a `WARNING` and runs the command unleased.
  `acquire` fails (exit `1`) instead. **A refused login is not an outage**: when the broker answers
  but rejects the credentials (`AUTH_FAILED`), `run` exits `1` without running the command, so a
  credentials mistake surfaces instead of silently defeating the pool.
- **Credentials**: `--username`/`--password`, else `<--project-dir or cwd>/.volley/agent.json`'s
  `broker` block, else `VOLLEY_AUTH_*`. With `--coordinator` (what the coordinator-mode hook passes)
  it resolves them as the coordinator hooks do: `VOLLEY_AUTH_*`, else
  `$VOLLEY_AUTH_DIR/coordinator.json` (from `volley auth init --coordinator-file`), and never reads
  an identity file. A malformed `coordinator.json` is an error, not an anonymous connect.
- The [volley-hooks](../volley-hooks/README.md) PreToolUse lease hook wraps matching `Bash`
  commands in `volley lease run` automatically.

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
| `--username <user>` | `VOLLEY_AUTH_USERNAME` | anonymous |
| `--password <pw>` | `VOLLEY_AUTH_PASSWORD` | none |
| `--help` | — | — |
| `--version` | — | prints version |

Credentials resolve as: flags, then the `broker` block of `./.volley/agent.json` (an agent's assigned identity), then `VOLLEY_AUTH_*`. `--username` without `--password` takes the password from `VOLLEY_AUTH_PASSWORD`. Prefer the env var over `--password`: argv is visible in `ps`.

**Shell sessions need the credentials too.** A Claude Code MCP registration's `env` block reaches only the MCP server, not the session's Bash tool. Export `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD` in your shell profile so `volley wait` / `volley sub` (and `mosquitto_pub -u … -P …`) can log in; otherwise they exit `1` with `AUTH_FAILED` immediately. A refused login exits `1` with `AUTH_FAILED` and a `volley auth init` hint.

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
  --legacy                Launch the old dashboard (packages/volley-dash) instead;
                          deprecated, removed in a later release
  --build                 Run vite build + preview the production bundle
  --port <N>              Override Vite's port (dev default: 5174, 5173 with --legacy;
                          --build: Vite preview's 4173)
  --host <addr>           Listen on <addr> (e.g. 0.0.0.0) for a phone or another
                          machine; see LAN use above
  --broker-url <url>      MQTT broker URL passed to the Desk via
                          VITE_VOLLEY_BROKER_URL (default: ws://localhost:9001)
  --open / --no-open      Open the browser on start (default: --open in dev mode)
```

Spawns Vite as a child process (`bun run dev`, or `build` then `preview`, in `packages/volley-desk`, or `packages/volley-dash` with `--legacy`); passes the broker URL through as a build-time env var so the bundled JS hardcodes it. The Desk's subscriptions are listed in [its README](../volley-desk/README.md#subscriptions). The legacy dashboard subscribes to `volley/_system/registry/+` (retained) plus the four status/progress/mailbox/result wildcards on connect, then renders state changes in ~1s.

### `volley notify`

```
Usage: volley notify --pattern <filter> [options]

Required:
  --pattern <filter>       MQTT topic filter, e.g. "volley/+/+/status"

Optional:
  --on <csv>               Lifecycle types that fire (default: blocked,failed,reaped)
  --surface <csv>          Surfaces to fire (default: bell)
                           Valid: bell, desktop, webhook
  --webhook-url <url>      Required when webhook ∈ --surface; must be http(s)://

Output:
  stdout: one JSON line per fired notification
    {"topic":"...","type":"...","agent_id":"...","surfaces":["bell","desktop"]}
  stderr: human warnings (surface unavailable, webhook non-2xx, etc.)

Exit:
  0    clean SIGINT/SIGTERM shutdown
  1    broker error
  2    invalid usage
```

See [`volley notify`](#volley-notify) above for the full usage examples and surface details.

---

## License

Apache 2.0. See [`../../LICENSE`](../../LICENSE).
