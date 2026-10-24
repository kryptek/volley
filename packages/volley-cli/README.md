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
- [`volley deploy`](#volley-deploy)
- [`volley dash`](#volley-dash)
- [`volley notify`](#volley-notify)
- [`volley auth`](#volley-auth)
- [`volley lease`](#volley-lease)
- [`volley machine add`](#volley-machine-add)
- [`volley peer`](#volley-peer)
- [`volley repo`](#volley-repo)
- [Common patterns](#common-patterns)
  - [Be a one-shot agent in CI](#be-a-one-shot-agent-in-ci)
  - [Background-wait for an agent and react](#background-wait-for-an-agent-and-react)
  - [Pipe sub output through `jq`](#pipe-sub-output-through-jq)
- [Global flags](#global-flags)
- [Exit codes](#exit-codes)
- [Per-subcommand reference](#per-subcommand-reference)

---

## Install

The one command installs it, with everything else (the root README's [Quickstart](../../README.md#quickstart); [`docs/INSTALL.md`](../../docs/INSTALL.md) has every flag):

```sh
curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh
```

`volley setup --check` then says what is missing, without changing anything. The CLI itself ships as a Bun-runnable TypeScript file. From a clone, after `bun install`:

```sh
# Run directly via bun:
bun run packages/volley-cli/src/cli.ts --help

# Or symlink for global access:
ln -s "$PWD/packages/volley-cli/src/cli.ts" /usr/local/bin/volley
volley --help
```

`volley setup` installs `volley` and `volleyd` in `~/.volley/bin` for you: small scripts that run this checkout with the full path of your `bun`, so they also work where `bun` is not on the `PATH` (a non-interactive ssh session). Its services run with that directory first on their `PATH`; add it to your shell's to type `volley` yourself: `export PATH="$HOME/.volley/bin:$PATH"`.

> Bun runs `.ts` natively — no build step. The shebang on `cli.ts` is `#!/usr/bin/env bun`, so the symlinked version invokes Bun automatically (when `bun` is on the `PATH`).

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
| `volley claude` | Claude account profiles on volleyd: `add <label>` (a profile and its sign-in URL), `signin`, `list` (one block per account, by e-mail: masked unless `--show-email`, its machines, the ones it is `not on:`, and freshest usage; `--json` for the raw answer), `list` also marks `next pick` on each login volleyd's next spawn would run under, `sync` (sharing + MCP servers), `balance [--model <m>] [--machine <name>]` (per machine, the signed-in accounts ranked by headroom with their 5-hour, 7-day and Fable figures and agents, an arrow `← fable, opus` on each family's next pick; e-mails masked unless `--show-email`, `--json` for volleyd's answer), `move <agent-id> <acct>` (restart an agent under another account with a resume note). See the volleyd README's "Claude accounts". |
| `volley peer`   | Pair a second machine with `volleyd`'s: `invite` (a one-time code) and `remove` (both admin ops: an admin account's login) and `list` on the supervisor's machine, `join <code> --to <host>` on the new one (doctor, account, tunnel service, trust check, host entry), `doctor` (check this machine, `--fix` the safe things), `run` (the service). See [`volley peer`](#volley-peer) below and the volleyd README's "Paired machines". |
| `volley machine` | `add <user@host>`: make a bare box a ready paired machine from the supervisor's, over ssh (install in peer mode, pair, sign in, doctor). See [`volley machine add`](#volley-machine-add) below. |
| `volley repo`   | The repositories volleyd's machines work on: `add <owner/name>` (each paired machine clones it, or adopts `--path`, and trusts it; `--wait` follows them), `remove` (clones kept), `list`, `status`. See [`volley repo`](#volley-repo) below. |
| `volley setup`  | First-run / repair wizard: broker, accounts, services, phone sign-in QR. See [`volley setup`](#volley-setup) below. |
| `volley desk serve` | Serve the built Desk from a small static server (the service `volley setup` installs); `volley desk install`, `uninstall` and `check` install it as a service on its own. See [`volley desk serve`](#volley-desk-serve) below. |
| `volley broker` | A broker move's machine-side steps (volleyd runs them over ssh): `receive <bundle>` (set this machine's mosquitto up with the moved broker's logins), `probe`, `tunnel` (the supervisor's own tunnel to it). See [Moving the broker](#moving-the-broker-volley-broker) below. |
| `volley deploy` | Take this machine's volleyd and Desk services to a release tag: build the Desk, restart, health-check, roll back on failure; then every paired machine. See [`volley deploy`](#volley-deploy) below. |

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

One idempotent command takes a machine from "mosquitto installed" to a phone-ready Desk. Eight steps; each prints what it found and what it will change (config diffs included) **before** changing anything, then asks (`--yes` applies without asking):

```sh
volley setup            # interactive: confirm each step
volley setup --yes      # non-interactive (WebSocket listener kept on this machine: no phone step)
volley setup --yes --lan   # non-interactive, the broker's WebSocket listener open to your network
volley setup --repair   # check and fix only (no new admin token, no phone link)
volley setup --step services   # only the named step(s)
volley setup --no-first-wave   # everything but the 1-issue test wave
volley setup --step first-wave --repo /path/to/repo --issue 12   # the test wave on a clone of yours
volley setup --check    # what is missing: change nothing, ask nothing
volley setup --check --json   # the same as JSON, for CI
```

1. **Broker**: the install (`--layout`, detected as `volley auth` does), mosquitto's version (older than 2.1 is refused with the install hint), what the listeners on 1883 and 9001 do with an anonymous client, and how many agents are running (a retained status that has not ended).
2. **Security**: the Dynamic Security broker config `volley auth init` writes (the diff is shown; the old file is backed up to `<config>.volley-backup-<timestamp>`), the plugin's state file with its admin login (`<dir>/admin.json`, 0600), a restart with the layout's command, then a check that **both** listeners refuse anonymous clients. It also asks whether devices on your network may reach the WebSocket listener (port 9001), which the Desk on a phone needs: interactively the recommended answer is yes; `--lan` / `--no-lan` decide without asking, and `--yes` alone means no. With LAN access on, the config gets `listener 9001` (every interface) while `listener 1883 127.0.0.1` stays local, and the check also probes `ws://<desk host>:9001`, which must refuse anonymous clients (reachable, and logging in), not be unreachable. Logins are required either way, but LAN traffic is **not encrypted** until a TLS listener exists: open it only on a network you trust. A rerun keeps whichever choice the config already has.
3. **Accounts**: Volley's shared roles and the fixed identities `volleyd`, `desk`, `coordinator` (`volley auth init` underneath: existing logins keep their passwords, missing ones are created and their passwords printed once), their credential files (`<dir>/coordinator.json`, `$VOLLEYD_HOME/broker.json` and `dynsec-admin.json`; a login whose file is gone gets a new password), drifted roles (a grant this Volley added, such as the `usage` channel, missing from a broker set up earlier: publishes on it are dropped silently) with the `volley auth migrate --roles` change shown first, a copy of the coordinator's login in the macOS keychain (service `volley-broker`, written through `security -i` on stdin so the password is never on a command line; `coordinator.json` stays the file the hooks and the MCP env read, and elsewhere it is the only copy), and a **one-time admin token** for the Desk, printed in the terminal only.
4. **Sign-ins**: Claude Code and GitHub signed in on this machine, read the way `volley peer doctor` reads them (`claude auth status`: a state and a plan label; `gh auth status`: its exit code). Signed out of Claude Code, the change runs `claude auth login` with the terminal handed over (it opens your browser); signed out of GitHub, `gh auth login --web --git-protocol https` then `gh auth setup-git`; signed in but git not using gh's login (no `gh auth git-credential` helper in `~/.gitconfig`), only `gh auth setup-git`. A sign-in is not a question: the metrics count it as a sign-in. Signed in, the step says `✓ Claude Code: signed in (<plan>)` (the account's e-mail only with `--show-email`) and `✓ GitHub: signed in as o•••` (the login masked, like `volley claude list` masks e-mails). Claude Code not installed stops the step with its installer (`curl -fsSL https://claude.ai/install.sh | bash`); gh missing is reported, not a stop. It also adds this checkout to `permissions.additionalDirectories` in `~/.claude/settings.json` (the diff shown, the old file backed up to `settings.json.bak-<timestamp>` like the hooks installer does), which an unattended coordinator start needs. Claude Code's first-run screens are only reported (`✓ first-run screens answered`): volleyd seeds them in the account profiles it runs agents in. Under `--yes` with nobody at the terminal and a sign-in pending the step is skipped (`sign in, then rerun`) instead of waiting for a browser; under `VOLLEY_SIMULATED=1` (the soak, CI) fakes answer the sign-ins and nothing opens.
5. **Claude Code**: what a coordinator session here needs, with **no secret in `~/.claude.json`**. The **coordinator name**, asked once (`Coordinator name [coord-<this machine>]:`, Enter takes the default; `--yes` takes it without asking), checked against the agent-id grammar and saved as `coordinator` in `$VOLLEYD_HOME/setup.json`: `volleyd` commands use it as `VOLLEY_COORDINATOR` when the environment sets none, and `volleyd run` without `--owner` owns the wave by it and says so. The volley MCP server, registered at user scope (`claude mcp add-json -s user volley`) as `bun run <checkout>/packages/volley-mcp/src/index.ts` with env exactly `VOLLEY_AGENT_ID=coordinator`, `VOLLEY_COORDINATOR`, `VOLLEY_NAMESPACE=default`, `VOLLEY_BROKER_URL` and `VOLLEY_AUTH_DIR`: the server logs in with `coordinator.json` from that auth dir, so no password is stored in the registration (the fence refuses a registration whose env names a password or token). An existing entry with settings of your own (a `VOLLEY_AUTH_PASSWORD`, another agent id) is left as is, and the step prints the two commands that replace it, naming those settings, never their values. The skills `volley`, `volley-issues` and `volley-wait`, linked into `~/.claude/skills` through each package's `scripts/install.sh` (a folder of your own there is backed up, not replaced). The Volley hooks (the Services step plans the same install: whichever runs first makes it). `--broker-url` re-points the registration and the hooks' `VOLLEY_BROKER_URL`; without it they keep the broker they have, and setup defaults to the broker the last run used (`broker_url` in `setup.json`).
6. **Terminal**: where volleyd starts agents on this machine, recorded as `fleet.local_terminal: cmux|tmux` in `$VOLLEYD_HOME/config.yaml` (merged in: every other key and comment kept; a `config.yaml` that is not YAML stops the step and is never overwritten) and as `terminal` in `$VOLLEYD_HOME/setup.json`. On macOS with cmux installed (the app's `bin`, or `cmux` on the services' `PATH`) it is **cmux**; otherwise (a Mac without cmux, every Linux machine) it is **tmux**, which must be on the services' `PATH`, or the step stops with the line that installs it: `brew install tmux` on macOS, `sudo apt-get install -y tmux` or `sudo dnf install -y tmux` on Linux (whichever package manager is there). On Linux the step never mentions cmux. An explicit `fleet.local_terminal` already in `config.yaml` is kept while that terminal is installed; one that is not (a `cmux` copied from a Mac) is replaced, saying why. A running volleyd uses the choice from its next start. With cmux, setup checks that volleyd's service can use it (volleyd opens agents' workspaces there): outside cmux, with the service's environment, the way the service runs it, it runs `cmux capabilities --json` (the socket's access mode) and `cmux list-workspaces` (a workspace call behind the same access check as volleyd's `new-workspace`; `cmux ping` is answered before that check, so it passed where real work was refused). The mode it finds is in the found line (`cmux's socket control mode: Automation mode`, also shown by the Desk's wizard) and recorded in `$VOLLEYD_HOME/setup.json` as `cmux_socket_mode`, also by a run that stops at cmux. Out of the box cmux lets only programs it started use its socket, so setup recommends **Automation mode** (cmux → Settings… (⌘,) → Automation → Socket control mode → Automation mode: any program running as you, no password, the fit for a service running as you) in a change that checks again when applied. Password mode stays optional: when cmux is in Password mode (or is put in it before that change is applied), setup asks for the password at a hidden prompt, checks it the same way, and stores it in the macOS keychain (service `volley-cmux`) and `$VOLLEYD_HOME/cmux.json` (mode 0600). volleyd reads that file each time it runs cmux and hands the password over as `CMUX_SOCKET_PASSWORD`; it is never in the plist. Every line about cmux quotes what cmux said. Without a terminal it asks nothing: under `--yes` from a script the change stays in the plan, applied last, and fails saying to run `volley setup --step terminal` in a terminal, so such a run never ends in `Setup complete.`; the Desk (whose wizard has no Terminal step: its Services step still makes this check) lists it as a change for a terminal and never applies it. The same when cmux's socket does not answer (cmux closed, or open with its socket off): the change checks again when applied. When `volley setup` stops at cmux, `setup.json` still records the mode it found and the terminal, and the Desk's Services runs record the mode too. Under sudo it is skipped: run `volley setup --step terminal` as your user.
7. **Services**: the `volley` and `volleyd` commands installed in `~/.volley/bin`: small `sh` scripts that run this checkout's CLIs with the full path of the `bun` setup found, so they work on any `PATH`, a non-interactive ssh session's too (`volley peer join` runs it on the supervisor's machine when `volley` is not on that ssh `PATH`). The services run with that directory first on their `PATH`, and volleyd's with `VOLLEY_AUTH_DIR` set to the auth dir setup used, since volleyd runs `volley auth` to redeem the Desk's sign-in links and admin tokens. That `PATH` is a fixed list, never derived from your shell's: `~/.volley/bin`, bun's directory, then each of Homebrew's `bin` and `sbin`, `/usr/local/bin` (always), the cmux app's `bin`, `~/.local/bin` (Claude Code's installer), `~/.bun/bin`, `~/.claude/local`, `~/.npm-global/bin`, `~/.volta/bin`, nix's and snap's `bin` that exists on this machine, then `/usr/bin:/bin:/usr/sbin:/sbin`; so a rerun from any terminal plans nothing. A tool installed anywhere else is not on the services' `PATH`: link it into `~/.volley/bin`. A file of your own or a directory already at a command's path is moved aside to `<path>.volley-backup-<timestamp>`, never deleted. Add the directory to your shell's `PATH` to type `volley` yourself, volleyd (`volleyd install` on macOS, a `systemd --user` unit on Linux, with `KillMode=process` so a restart of volleyd, `volley deploy`'s included, stops volleyd alone and never the tmux server it started with the agents in it), the Volley hooks for coordinator sessions (`packages/volley-hooks/scripts/install.sh`, which backs up `~/.claude/settings.json`), and the Desk: built (`vite build`), rebuilt whenever its sources or `bun.lock` changed since the build setup recorded in `dist/.volley-build` (so `--repair` after an update serves a matching Desk), and served by `volley desk serve` on `0.0.0.0:5199` as a service. Before that, setup asks `lsof` (`ss` on Linux without it) who listens on the Desk's port, on any address: any program but the Desk's own service stops the step with its command name, PID and what to do (a leftover server on `127.0.0.1:5199` would answer `http://localhost:5199`, the printed admin link, instead of the Desk). Another user's listener shows without its PID (`ss` without root) and stops it too; macOS `lsof` without root does not see other users' programs at all. When neither probe can run (the Desk's setup wizard, whose fence does not allow them), the step says it *could not check* the port, and why. The hooks change says plainly that your own Claude Code status line keeps working (Volley runs it after its own, same input, 2 s timeout). Every launchd load is idempotent: setup boots out a loaded service, waits until launchd has let it go, then bootstraps (retrying launchd's `Bootstrap failed: 5: Input/output error` while the old job is still going away); a plist that will not load is replaced by the previous one, loaded again, and the run exits non-zero saying so, so a rerun never leaves the Desk (or volleyd, via `volleyd install`, or the peer tunnel, via a second `volley peer join`) down. A `Bootstrap failed: 5` while nothing is loaded any more is launchctl's catch-all (bad permissions, a disabled service) and is not retried. Under sudo it is skipped (the later steps still run): run `volley setup --step services` as your user.
8. **Phone**: a one-time `steer` sign-in link for "Desk on phone" (10 minutes, single use), rendered as a QR code in the terminal with the URL `http://<this machine>:5199/#signin=<token>` (`--desk-host` names another address; the default is this machine's address on a physical interface, not a container or VPN bridge). When a phone cannot reach the broker's WebSocket listener at `ws://<desk host>:9001` (LAN access off), the step is skipped, no link is spent, and the run ends saying so instead of "Setup complete".
9. **Test wave**: the proof that the install works end to end. It asks once, `Run a 1-issue test wave now?` (Enter: yes; `--yes` and `--simulated` run it without asking, `--no-first-wave` skips it, `--check` never runs it; declined, the step is skipped and says to run `volley setup --step first-wave` later). It creates a scratch **private** repository on your GitHub account, `volley-hello-<4 characters>` (`gh repo create … --private --clone`, cloned under `$VOLLEYD_HOME/first-wave/`), commits a README to it, files one issue ("Add HELLO.md"), pushes a release branch `release/<date>-hello-<4>`, then adds the repository to the fleet with `volley repo add <owner>/volley-hello-… --wait` (volleyd clones it under `fleet.repo_root` and trusts it). In that clone it writes `.volley/waves/hello-<4>.yaml` (every run is a wave of its own, so a rerun after a failed one works; one task on the issue, `pipeline: [implement, merge_ready]`, `merge: auto`, Volley's default model, `DEFAULT_MODEL` in `packages/volleyd/src/config-defaults.ts`), checks it with `volleyd validate`, submits it with `volleyd run … --owner <coordinator>`, and follows `volley/_waves/hello-<4>/state` until volleyd merged the PR (it prints the PR's URL and the wall time), the wave failed or blocked (it prints the journal's last events and the open decisions), or 15 minutes passed since the submit. `--repo <path>` runs it on a clone of your own instead (its origin's repository; the release branch is cut from the clone's checked-out commit, `HEAD`; the issue is filed unless `--issue <n>` names one; no scratch repository and no `volley repo add`); a clone with no `origin` remote is refused, as `volleyd validate` would refuse the wave (BASE_STALE). `--simulated` (CI) runs it against volley-sim's fake `gh` and `claude` (the fakes first on `PATH`, `VOLLEY_SIMULATED=1`): the origin is a bare repository under `$VOLLEY_SIM_HOME` and the wave runs from the scratch clone itself. The outcome is in `$VOLLEYD_HOME/first-wave.json` (a rerun after a merged test wave has nothing to do; it also names the scratch repositories earlier runs made) and in `setup-metrics.json` as `first_wave: { wall_ms, pr, merged }`, and the `Setup complete` line reports it. **To remove what it made**: `gh repo delete <owner>/volley-hello-… --yes` (the end of the run prints the exact line, for every scratch repository a run made), then `volley repo remove <owner>/volley-hello-…` and delete the clones (`$VOLLEYD_HOME/first-wave/volley-hello-…` and the one under `fleet.repo_root`). Under sudo it is skipped: run `volley setup --step first-wave` as your user.

A rerun plans nothing for what is in place and reports each step as already done. The admin token and the phone's link count as in place while pending or once redeemed: after they expired unused (10 minutes), a rerun issues new ones. Every step is journaled to `$VOLLEYD_HOME/setup.log` (summaries only, never a password or token). Every external command (the broker restart, `launchctl` / `systemctl`, `security`, the sign-ins, `claude mcp` for the volley entry, the skills' and hooks' installers, the Desk build) runs without a shell, through a fence that allows exactly those commands and refuses any other. The Desk build is refused while `packages/volley-desk/.env*` sets `VITE_VOLLEY_BROKER_*` (Vite would build it into the page served to your network). `--broker-url` must be `mqtt://`: TLS is not supported by `volley setup` yet.

**`--check`.** Plans every step (planning never changes anything), asks nothing (a question a step would ask is answered no, a secret is not asked for), writes nothing, and prints one row per step: `done`, `pending` with the changes a run would make, `blocked: <why>`, or `skipped: <why>`, with the lines a step reports about itself (the sign-ins, the MCP registration, the skills, the hooks, the coordinator name). It exits 0 only when nothing is pending or blocked. Not with `--yes` or `--repair`.

```text
$ volley setup --check --step signin --step claude-code
volley setup --check: broker mqtt://localhost:1883, brew-arm64 layout, auth dir /opt/homebrew/etc/mosquitto/volley
  ✓ Sign-ins     done
      ✓ Claude Code: signed in (max)
      ✓ GitHub: signed in as o•••
      ✓ Claude Code may read the Volley checkout (/path/to/volley)
      ✓ first-run screens answered
  → Claude Code  pending
      ✓ coordinator: coord-studio
      MCP: volley has settings of its own (VOLLEY_AUTH_PASSWORD): left as is
      skills: volley-wait: not installed
      ✓ hooks: installed
      → Link the Volley skills into ~/.claude/skills (volley-wait: not installed)

1 pending: run `volley setup` to apply.
```

`--check --json` prints exactly `{ "version", "steps": [{ "name", "title", "status", "changes", "blocked"?, "skipped"? }], "setup_at" }` on stdout and nothing else (`changes` holds the summaries; `setup_at` is when `setup.log` last had a line, or null), for CI.

**Metrics.** Every run (one that stops too) writes `$VOLLEYD_HOME/setup-metrics.json` (0600; `metrics` in `setup.json` points at it): `{ started_at, finished_at, wall_ms, questions, sign_ins, sudo_prompts, steps: [{ name, ms, changes }] }`. `questions` counts only what a person saw (each confirmation, the LAN question, a hidden prompt, the coordinator name: 0 under `--yes`), `sign_ins` the browser sign-ins it ran, `sudo_prompts` each command it ran through `sudo` at a terminal. Counts and step names only, scrubbed of anything token-shaped all the same. The last line reports them: `Setup complete in 2 m 5 s (1 question, 2 sign-ins, 0 sudo)`.

**`--peer`.** A machine that joins a supervisor's fleet (`install.sh --peer`, `volley machine add`) has no broker, accounts, Desk or phone of its own: `volley setup --peer` runs four steps, never mentions any of those, and writes no `setup.json` (the supervisor's install record). **Sign-ins** as above; **Claude Code** for the profile only: the skills, and the hooks with `VOLLEY_BROKER_URL` at the tunnel `volley peer join` sets up (`mqtt://127.0.0.1:<port>`, `remote_port` in `~/.volley/peer.json`, else 21883), no coordinator name and no MCP registration; **Terminal** as above; and **Peer service**: `volley peer run` as the user service in place of volleyd, written by the same unit writers as `volley peer join` (a `systemd --user` unit `volley-peer.service` with lingering, or the launchd agent `systems.volley.peer`), with the services' fixed `PATH`. Before the machine is paired it is skipped (`peer run` needs `peer.json`; join installs the service). `--step` takes `signin`, `claude-code`, `terminal`, `peer-service`; the broker's, accounts' and Desk's flags (`--lan`, `--layout`, `--broker-url`, `--desk-port`, …) are refused. `install.sh --peer` runs it with `VOLLEY_BROKER=skip`.

**From the Desk.** Settings › Setup & Security runs the same steps through volleyd (`setup_plan` / `setup_apply`, SPEC §4.6.10), all but Sign-ins, Claude Code and Terminal (a browser sign-in, your Claude Code profile and the coordinator name are a terminal's: run `volley setup --step signin --step claude-code` there): its Services step makes the Terminal step's cmux check instead, and the terminal is recorded only by `volley setup` in a terminal. volleyd runs these planners and steps itself, writes the same `setup.log` lines (with `by: "desk:<admin>"`), and seals the one-time admin token to the browser instead of printing it. It needs an admin already (an admin token redeemed, or a secured broker), so a brand-new anonymous broker's first run (broker + security) is this command. A change only a terminal can make (anything under `sudo`, volleyd's own service, the macOS keychain) is shown in the Desk with the exact command to run here.

---

## `volley desk serve`

```sh
volley desk serve                       # http://127.0.0.1:5199, from packages/volley-desk/dist
volley desk serve --host 0.0.0.0        # for a phone on the LAN (what the setup service runs)
volley desk serve --port 8080 --root /path/to/dist
volley desk serve --host 0.0.0.0 --evidence ~/.volleyd   # also serve release evidence (below)
volley desk serve --host 0.0.0.0 --broker-host box-a     # the broker runs on another machine (below)

volley desk install --port 5199 --broker-host box-a      # build it and install it as a service
volley desk uninstall                                    # stop and remove the service (keeps dist/)
volley desk check --url http://127.0.0.1:5199 --version 0.11.0
```

A small static server for the built Desk (`bun run --cwd packages/volley-desk build`): hashed assets are cached for good, the index never, every unknown path gets the index, and nothing outside the build directory is served. It holds no credentials: the page signs in to the broker itself (port 9001 on the host the page came from, unless the server names another).

**The broker on another machine.** `--broker-host <host>` (and `--broker-ws-port <n>`, default 9001) serves `GET /desk-config.json` as `{"broker":{"host":"box-a","ws_port":9001}}` with `Cache-Control: no-store`; without the flag that path is a 404. The page fetches it once before the sign-in form and connects to that broker (`wss` on an https page), so the broker can move while the Desk stays and no device signs in again; moving the Desk changes the page's origin, so devices sign in again there. The host is a bare name or IP address (an IPv6 one bare or in brackets): a scheme, a path, a port or a login exits 2. The page's own `VITE_VOLLEY_BROKER_URL` (a dev build) still wins over it.

**`volley desk install | uninstall | check`.** The Desk's own install as commands, for a machine that serves the Desk without the rest of `volley setup` (volleyd runs them over ssh when it moves the Desk). `install [--port <n>] [--broker-host <host>] [--root <checkout>]` is the Services step's Desk part: it builds the Desk in the checkout (`--root`, default this one) without the `VITE_VOLLEY_BROKER_*` variables (an env file in `packages/volley-desk` that sets one refuses the install), writes `dist/.volley-build`, and installs `volley desk serve --host 0.0.0.0 --port <n> [--broker-host <host>]` as this platform's service (launchd on macOS, `systemd --user` on Linux). It records `desk_port` and `broker_host` in `$VOLLEYD_HOME/setup.json`, so a later `volley setup` renders the same unit (its `--check` names the Desk's broker under the Services row); a second run changes nothing. `uninstall` boots the service out and removes its unit file, keeping `dist/`. `check --url <u> --version <v>` exits 0 when `<u>/` answers 200 and `<u>/version.json` is `<v>`, else 1: volleyd makes no http calls itself, so the health check runs on the target.

At start it warns on stderr, and still serves, when the build looks stale. Each line is printed only when it holds:

```text
warning: the Desk build is stale (built from <stamp or "unknown">, the checkout is <stamp>); run volley deploy or volley setup --repair
warning: the Desk bundle is <v>, this volley is <v>
```

The first compares `dist/.volley-build` (the stamp `volley setup` and `volley deploy` write after a build: a hash of the Desk's sources and `bun.lock`) with the checkout's current sources; the second compares the bundle's `dist/version.json` (written by the Desk's Vite build) with this CLI's version. `--quiet` (`-q`) prints neither.

`--evidence <volleyd home>` (off by default) also serves a release train's evidence read-only, for the Desk's Needs you window: `GET /evidence/<wave>/release/<file>` returns a `.png`, `.jpg`, `.webp`, `.txt`, `.log`, `.md` or `.json` file directly under `<home>/waves/<wave>/release/`, and nothing else. Text is served as plain text (never rendered), under `nosniff` and a sandboxing CSP. Any other path under `/evidence/` is a 404: another type, a subfolder, a dot-file, a symlink that leaves the folder, a wave id that is not one, or any traversal (the name is decoded once, never twice). The Desk reads the stage evidence JSON from it (changelog entries, screenshot names, links) and shows the screenshots. Anyone who can load the Desk can read those files without signing in. That is a LAN-trust choice like `volley setup --lan`, which is why `volley setup` leaves it off and its services step only names the flag.

---

## `volley deploy`

```sh
volley deploy v0.5.0              # from any directory, on the supervisor's machine
volley deploy --latest            # the newest v* tag by version order (0.5.0 without the v works too)
volley deploy v0.5.0 --dry-run    # print every step and command; change nothing
```

One command for the update the supervisor's machine needs after a release is tagged. It works on the **services checkout**: the checkout volleyd's installed service runs (`ProgramArguments` in `~/Library/LaunchAgents/systems.volley.volleyd.plist` on macOS, `ExecStart` in `~/.config/systemd/user/volleyd.service` on Linux). With no service installed it uses the checkout this `volley` runs from and says so; `--repo <dir>` names another checkout explicitly. Then, one summary line per step:

1. **Local changes refuse the deploy** (exit 3), listing `git status --porcelain`. `--force-clean` stashes them first (`git stash push -u -m volley-deploy-<time>`) and prints the stash name; the deploy never runs `checkout -- .`, `reset` or `clean`.
2. `git fetch --tags origin`, then the tag is resolved (`--latest`: the newest `v*` tag, a prerelease below its release). Tag names are checked against `^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$` before any git call.
3. `git checkout --detach <tag>`, `bun install --frozen-lockfile`, and the Desk build (`bun run build` in `packages/volley-desk`, without any `VITE_VOLLEY_BROKER_*` in its environment), after which it writes `dist/.volley-build` exactly as `volley setup` does.
4. **Self-check**: `volley --version` from the checkout is the tag's version, `volleyd validate` passes on its example wave file, and `dist/index.html` and `dist/version.json` (with the tag's version) exist.
5. **Restart** both services (`launchctl kickstart -k gui/<uid>/systems.volley.volleyd` and `…/systems.volley.desk`, or `systemctl --user restart volleyd.service volley-desk.service` one at a time). volleyd gets no control op: running waves continue, since volleyd reconciles its journal on start.
6. **Health check** (up to 30 s, every second): volleyd's retained status on the broker is `working` and was published after the restart (the new process got through its start, past `spawning` and `registered`), and the Desk answers `GET /` with 200 and `GET /version.json` with the tag's version, on the port setup recorded (`--desk-port` overrides; default 5199).

It ends with `deployed v0.5.0 (was v0.4.0); waves continue (volleyd reconciles on start)`.

**Rollback.** Any failure after the checkout repeats the checkout, install, build, restarts and health check at the previous ref (HEAD's branch, so a checkout on `main` stays on `main`; on a detached HEAD the release tag it was exactly at, else its commit); a rollback never stashes or fetches. The deploy reports what failed and `rolled back to v0.4.0`, and exits 1. When the rollback fails too, the checkout is left as it is and the exact commands to run by hand are printed. A failure before the checkout (the fetch, an unknown tag, the checkout itself) changes nothing.

Every command goes through one fence of exact argv shapes on the services checkout (the git commands above, the bun install and build, the self-check, the two restarts); anything else (`git push`, `git reset --hard`, a tag starting with `-`) is refused before it runs. macOS and Linux only: elsewhere it exits 2, `no service manager known here`. The broker connection for the health check is resolved as for `volley list` (`--broker-url`, `--namespace`, `--username`/`--password`, or the coordinator login setup saved).

```text
$ volley deploy v0.5.0 --dry-run
services checkout: <repo> (from ~/Library/LaunchAgents/systems.volley.volleyd.plist)
current: v0.4.0
target: v0.5.0
dry run: would run, in order:
  1. fetch tags
       $ git -C <repo> fetch --tags origin
  2. checkout v0.5.0 (detached)
       $ git -C <repo> checkout --detach v0.5.0
  3. bun install --frozen-lockfile
       $ cd <repo> && <bun> install --frozen-lockfile
  4. build the Desk
       $ cd <repo>/packages/volley-desk && <bun> run build
       (then record the checkout's Desk stamp in dist/.volley-build)
  5. self-check
       $ <bun> <repo>/packages/volley-cli/src/cli.ts --version
       $ <bun> <repo>/packages/volleyd/src/cli.ts validate <repo>/packages/volleyd/test/fixtures/example.yaml
       (volley --version is the release's; dist/index.html and dist/version.json carry it)
  6. restart systems.volley.volleyd
       $ launchctl kickstart -k gui/<uid>/systems.volley.volleyd
  7. restart systems.volley.desk
       $ launchctl kickstart -k gui/<uid>/systems.volley.desk
  8. health-check
       (volleyd's retained status is fresh; http://127.0.0.1:5199/ and /version.json answer)
On a failure after the checkout it repeats the checkout, install, build, restarts and health-check at v0.4.0.
dry run: nothing changed
```

A dry run runs only `git status --porcelain`, the current-ref lookup (`git describe --tags --exact-match HEAD`, then `git rev-parse`) and `git tag --list 'v*'`; it never fetches, so a tag not fetched yet is shown as such. It also prints each paired machine's plan, and runs nothing on any of them.

**Paired machines.** Once the supervisor's health check passes, the deploy takes every paired machine to the same tag, one at a time. The machines come from volleyd's records on the supervisor (`$VOLLEYD_HOME/peers.json`, less any being removed, and each one's `hosts.<name>` in `config.yaml` for its ssh target and `volley_dir`); a machine missing either is reported `<name>: skipped (<why>)`. On each, over `ssh -T -o BatchMode=yes <target> bash -s` (one quoted command per connection, on stdin), in its volley checkout:

1. `git status --porcelain` (local changes: `failed at status`, nothing changed) and the ref it is at;
2. `git fetch --tags origin`, then `git checkout --detach <tag>`;
3. `bun install --frozen-lockfile`, then record the `bun.lock` it installed from in `node_modules/.volley-lock-sha256` (what the doctor's own install records), so the machine's doctor says the dependencies are installed;
4. restart `volley peer run` (`systemctl --user restart volley-peer.service`, or `launchctl kickstart -k gui/<uid>/systems.volley.peer` on macOS), which runs its doctor at start;
5. `bun <volley_dir>/packages/volley-cli/src/cli.ts peer doctor --json`: it must report the tag's version.

Each machine ends with one health line: `box-a: v0.5.0 ✓ eligible`, or `box-a: v0.5.0 ✗ not eligible: <check> (<detail>)` when a block check fails on the new version (left on the tag: going back would not fix it). A repository's own check (one the doctor runs per repository in the machine's `peer.json`, such as a tool the repository needs) never makes the machine ineligible, as volleyd's readiness judges it: it follows the line, `box-a: v0.5.0 ✓ eligible · example-org/widgets blocked: tool.java (java is not installed (example-org/widgets needs it))`, and `volley repo status` shows it too. A machine that fails a step after its checkout goes back to the ref it was at (checkout, install and lock record, restart) and is reported `box-b: failed at install (<why>); rolled back to v0.4.0`; the supervisor and the other machines stay on the tag. A failed deploy of the supervisor touches no paired machine. Every remote command goes through a fence of exact argv shapes per machine (the tag, or the machine's own previous ref, and nothing else).

`--skip-peers` deploys the supervisor only. `--only <machine>` (repeatable) deploys just those paired machines, to the tag the supervisor already runs (it refuses otherwise), and leaves the supervisor alone: the way to retry one machine after fixing it.

Exit codes: `0` deployed (and every paired machine eligible), `1` failed (rolled back, or the by-hand commands printed; or a paired machine failed, was skipped or is not eligible), `2` usage (including no service manager, `--repo` without a `bun.lock`, an `--only` name that is not paired, or `--only` while the supervisor runs another tag), `3` local changes in the services checkout.

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

On first load the Desk asks for broker credentials: sign in as the `desk` identity from `volley setup` (or `volley auth init`), or open a one-time link (`<desk>#signin=<token>`: setup's phone QR, `volley auth signin-link`, or `volley auth token`'s admin token). With `--host` and no `--broker-url`, the Desk connects to port 9001 on the host it was loaded from, so a phone reaches this machine's broker, once mosquitto also has a WebSocket listener on the LAN address: the example conf binds `127.0.0.1` only. That listener exposes the broker to the LAN, so keep `allow_anonymous false` with the `volley auth` accounts, and note that `ws://` carries the password in cleartext. Open the page by IP, since Vite refuses other host names. See the Desk's [LAN use](../volley-desk/README.md#lan-use). `--build` drops `VITE_VOLLEY_BROKER_USERNAME` / `VITE_VOLLEY_BROKER_PASSWORD` from its environment, because Vite would inline them into the bundle.

`--legacy` launches the classic [`volley-dash`](../volley-dash/) dashboard (status grid + event feed + per-agent drawer) instead. It is deprecated and will be removed in a later release; every other flag works with it.

**Prerequisite:** mosquitto must have a WebSocket listener on `:9001` — the bundled `examples/mosquitto-localhost.conf` configures it. If `lsof -nP -iTCP:9001 -sTCP:LISTEN` returns nothing, see the root [README §2](../../README.md) for the install + upgrade steps.

---

## `volley notify`

Long-lived subscriber that bridges agent state transitions to the human-visible surfaces you're already paying attention to: the terminal bell in the shell you're in, macOS desktop banners, or arbitrary HTTP webhooks. Runs until SIGINT/SIGTERM. Default trigger set is `blocked,failed,reaped,digest` (attention-needed only — `done` is expected and would create noise during dispatch loops). `digest` is volleyd's morning digest push: one `progress` envelope per published wave digest (on `volley/<ns>/volleyd/progress`), whose `payload.msg` is the one-line summary, e.g. `w1 complete: 27 shipped, 3 flakes fixed, 2 conflicts resolved, 1 waiting for you (release_go)`.

```sh
# Bell-only, watch every status transition on the default namespace
volley notify --pattern 'volley/+/+/status'

# Webhook to ntfy.sh + macOS desktop banner + terminal bell
volley notify --pattern 'volley/+/+/status' \
  --surface bell,desktop,webhook \
  --webhook-url https://ntfy.sh/your-private-topic

# volleyd's pushes: one per decision left for you, and one per wave digest
volley notify --pattern 'volley/+/volleyd/progress' --surface bell,desktop
```

The surfaces fire concurrently; one surface erroring (e.g. webhook returns non-2xx) never aborts the loop. Each fired notification emits one JSON line on stdout (`{topic, type, agent_id, surfaces}`) so you can pipe to `jq` for live-tail.

| Flag | Env | Default | Description |
|---|---|---|---|
| `--pattern <filter>` | — | (required) | MQTT topic filter, e.g. `volley/+/+/status` for a whole namespace |
| `--on <csv>` | `VOLLEY_NOTIFY_ON` | `blocked,failed,reaped,digest` | Lifecycle types that fire (`spawning,working,done,blocked,failed,reaped,registered,digest`) |
| `--surface <csv>` | `VOLLEY_NOTIFY_SURFACES` | `bell` | Comma-separated surfaces: `bell`, `desktop`, `webhook` |
| `--webhook-url <url>` | `VOLLEY_NOTIFY_WEBHOOK_URL` | — | Required only when `webhook ∈ --surface`. Must be `http(s)://` |
| `--namespace <ns>` | `VOLLEY_NAMESPACE` | `default` | Informational (the pattern already encodes the namespace) |
| `--username <user>` | `VOLLEY_AUTH_USERNAME` | anonymous | Broker username |
| `--password <pw>` | `VOLLEY_AUTH_PASSWORD` | none | Broker password (prefer the env var: argv is visible in `ps`) |
| `--broker-url <url>` | `VOLLEY_BROKER_URL` | `mqtt://localhost:1883` | MQTT broker |
| `--help` / `-h` | — | — | Print usage and exit |

**Desktop surface (macOS only)** shells out to [`terminal-notifier`](https://github.com/julienXX/terminal-notifier) — install via `brew install terminal-notifier`. If absent, the desktop surface logs a one-time warning to stderr and degrades to no-op for the rest of the process; the other surfaces continue to fire. Sound configurable via `VOLLEY_NOTIFY_SOUND` (default `Glass`). The banner's body is the envelope's `payload.msg` when it carries one (the digest's summary line), else its type.

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
volley auth signin-link --role steer --label "Owner's phone"   # one-time sign-in link + QR code
echo "$TOKEN" | volley auth redeem --label "Desk on mac" --json  # what volleyd runs on redemption
```

- **`init`** detects the install (`--layout brew-arm64|brew-intel|snap|etc|container`; the snap first on Linux) and writes its config: the plugin before any listener, `per_listener_settings false`, `allow_anonymous false`, `set_tcp_nodelay true`, `max_queued_messages 10000`, TCP 1883 and WebSocket 9001 on 127.0.0.1. The WebSocket listener on 9001 keeps the bind it has: one `volley setup --lan` opened to the LAN stays open (with no 9001 listener to read, the `lan` choice `$VOLLEYD_HOME/setup.json` recorded decides), so a signed-in phone is not cut off. Only 9001's bind is kept: another WebSocket listener (say 8080) is dropped, never lending 9001 its bind, and the diff names it as removed. Before it rewrites an existing config it prints the unified diff, naming each listener change on its own line. It refuses an existing config with `per_listener_settings true` or the plugin loaded twice, naming the trap. `--no-config` leaves the config to you, `--config` / `--state-file` choose other paths, `--restart` runs the layout's restart command and carries on instead of asking you to restart and rerun.
- **Fixed identities** `volleyd`, `desk` and `coordinator` are created once; a rerun keeps their passwords, `--force` rotates them. `--coordinator-file` writes `<dir>/coordinator.json` (mode 0600; the coordinator's hooks read it when `VOLLEY_AUTH_*` is unset); `--volleyd-file` writes `$VOLLEYD_HOME/broker.json` and `$VOLLEYD_HOME/dynsec-admin.json` (0600), volleyd's login and the admin login it mints agents with; under sudo they go to the invoking user's home, owned by that user.
- **Agent logins** hold the `agent` role alone: their own channels and registry entry (`%u`), lease requests, and acks to `volleyd` and the Desk. Nothing is granted per agent, so there is no `--ack-to` and no `grant`: an agent's ack to a random-suffixed coordinator is dropped by the broker. `add-agent` refuses the fixed identities, the admin, 8-hex-digit ids (token logins) and ids the roles' namespace wildcard would carry into reserved topics (`registry`, `leases`, `health`, `federation`, `machines`, `auth`, and the channel names). `rm-agent` deletes only agent logins. Deleting a login disconnects the agent without its will: volleyd publishes its `reaped` status itself.
- **Roles** of accounts: `admin` (a coordinator's writes plus account ops on `volley/_system/auth/ops/<name>`), `steer` (write mailboxes, plus its own `volley/_system/auth/ops/<name>` for the Desk's Needs-you answers), `watch` (no writes beyond the `account` role's own-identity ones), `supervisor` (read/write everything like `volleyd`, except the account-op and answer topics under `volley/_system/auth/`), `peer` (a paired machine: `volley/_system/machines/<name>[/#]`, which the `account` role already grants). Every account holds the shared `account` role (read `volley/#`; write its own `%u` channels, registry entry, lease requests and machine record) plus its role's. The registry is `accounts.json` (name, role, kind, created, label); `--kind` is `human` \| `device` \| `machine` \| `service` (default from the role).
- **`signin-link`** prints the ready-to-open link, `http://<desk host>:<desk port>/#signin=<token>` on the LAN address `volley setup` recorded in `$VOLLEYD_HOME/setup.json` (without a record: `localhost:5199`, with a note to use this machine's address), and its QR code, like setup's phone step. `--json` prints only `{token, username, expires_at}`.
- **One-time tokens** (`token`, `signin-link`) are stored only as a sha256 hash in `tokens.json`. Each is also the password of a temporary login named by the token id, holding the `token` role: it may only write `volley-auth/redeem/<id>` and read `volley-auth/redeem/<id>/reply`, so the Desk can redeem it through volleyd (SPEC §4.6.10) while the broker keeps refusing anonymous clients. `redeem` reads the token from stdin, burns it and creates an account with the token's role (refusing, token unburned, if that `<role>-<id>` name is taken; `add` reserves that shape). The login outlives the redemption by about a minute so the redeeming client, still connected as it, gets its answer; the next account command after that, or after the token expires, deletes it (volleyd runs `volley auth list` every minute for this). `accounts.json` and `tokens.json` are replaced by rename, never rewritten in place.

Files live in `--dir` (env `VOLLEY_AUTH_DIR`; default `<mosquitto config dir>/volley`, e.g. `/opt/homebrew/etc/mosquitto/volley`, or `/var/snap/mosquitto/common/volley` on a snap-only machine; the broker never reads it). `--broker-url` (env `VOLLEY_BROKER_URL`) names the broker. The admin password reaches `mosquitto_ctrl dynsec init` on its command line once, so it is briefly visible in `ps` while that child runs.

---

## `volley machine add`

One command on the supervisor's machine makes a bare box (macOS or Ubuntu/Debian, reachable over
ssh) a ready paired machine:

```sh
volley machine add dev@box-a                 # --name (default: box-a), --hub dev@192.0.2.20, --no-signin
```

It runs as an admin account (the pairing code is an admin op, as `volley peer invite` is) and goes
in seven steps, each skipped when it is in place:

1. **ssh**: key-based ssh to the box. Without it, one interactive `ssh` on your terminal (any
   password or host-key prompt is ssh's own, never Volley's) whose only action appends this
   machine's public key to the box's `~/.ssh/authorized_keys` (a key is created first with
   `ssh-keygen -t ed25519` when this machine has none). Every later step is `ssh -T -o
   BatchMode=yes … <user@host> bash -s` with its script on stdin, the shape `volley deploy` uses.
2. **Volley**: `install.sh --peer --version <this machine's tag> --no-setup`, sent on stdin: no
   broker, no Desk, the checkout at the supervisor's release so the doctor's `volley.version`
   check passes. When the box lacks what only sudo installs (git, tmux, curl or gh on Linux;
   Homebrew on a Mac), that is announced first, and the installer is copied over and run with
   `ssh -t`, so sudo's prompt comes on your terminal.
3. **Setup**: `volley setup --peer --yes` on the box (the volley-cli README's `--peer`).
4. **ssh back**: `volley peer join` reaches this machine over ssh, so the box's key (created
   there when it has none) goes into this machine's `~/.ssh/authorized_keys`, shown as a change,
   and this machine's host keys into the box's `~/.ssh/known_hosts`. On a Mac, Remote Login must
   be on: the step checks it (`launchctl print system/com.openssh.sshd`) and stops with how to
   turn it on.
5. **Pairing**: a code bound to the box's name (`peer_invite { for: <name> }`, as `volley peer
   invite --for <name>`), redeemed on the box with `volley peer join <code> --to <hub> --name
   <name> --target <user@host>` (`--replace` when this machine has the name paired but the box
   lost its `peer.json`). The code is never printed: the join's own output is relayed with it
   redacted.
6. **Sign-ins**: GitHub with `gh auth login --web --git-protocol https && gh auth setup-git` over
   `ssh -t`, Claude through volleyd's remote sign-in (`volley claude add <name> --machine <name>
   --wait`, which prints the link to open on any device). Only what the doctor finds signed out;
   `--no-signin` defers both.
7. **Doctor**: `volley peer doctor --json` on the box, printed as one row:

```text
box-a (dev@box-a): ready ✓
  tools        ✓ volley 0.11.0, bun 1.3.2, git 2.43.0, tmux 3.4, gh 2.62.0, claude 2.0.14
  gh           ✓ signed in
  claude       ✓ signed in (max)
  trust        – no repository yet
  repositories – none yet: the hub's repositories for all machines arrive with its clone orchestration (…)
```

and a `fix:` line under it for each failing check that has one. It exits 0 when the box is
ready, 1 when it is not (or a step failed), 2 on a usage error. Repositories need no flag: this
machine's repositories assigned to `all` machines reach the box through the clone orchestration;
`volley repo add <owner/name> --machines <name>` adds one for it alone. A rerun on a paired box
changes nothing (no install, setup, key or code) and prints the row; upgrading a paired box is
`volley deploy`. Every command it runs here goes through a fence: the batch ssh with a script it
rendered itself, the connect and `ssh -t` with a command it rendered, `ssh-keygen` for this
machine's key, the Remote Login check, and `volley claude add` for that one name.

## `volley peer`

Pairs a second machine with `volleyd`'s, so waves can run agents there (SPEC §4.6.14; the volleyd
README's "Paired machines" has the whole walk-through). On the supervisor's machine, as an admin
account: `volley peer invite` (a one-time code), `volley peer invite --for <name>` (a code that
joins as `<name>` only: it re-pairs the paired machine `<name>`, or pairs a new one, as `volley
machine add` does), `volley peer list`, `volley peer remove <name> [--drain |
--now]`. On any machine, `volley peer doctor [--fix]` says whether it can run an agent and fixes
what it safely can. On the machine to pair: `volley peer join <code> --to <user@supervisor> --repo
<owner/name>[=<clone>]` (repeatable; a bare `--repo <clone>` path is the legacy single clone; add
`--name <name> --replace` with a `--for` code), then the `volley peer run` service it installs. join runs `volley peer redeem` on the supervisor's machine as `volley` when that is on its
non-interactive ssh `PATH`, else as `~/.volley/bin/volley` (where `volley setup` installs it; a
Mac's ssh `PATH` has neither bun nor volley); `--remote-volley <command>` names another.

Every machine reaches the broker through its own tunnel, kept in `~/.volley/peer.json`: `tunnel:
ssh` (the default) keeps `ssh -N -L 127.0.0.1:<port>:<broker>` to `--to` up; `join --tunnel none`
is for the machine the broker runs on, which reaches it at `127.0.0.1:<broker port>` with no ssh
at all (the port volleyd answers; before that the doctor checks against `--port`, else 1883).
peer.json's `heartbeat: false` keeps the tunnel but publishes no machine record: the supervisor's
own machine, which publishes its own. A peer.json without either key is `tunnel: ssh, heartbeat:
true`.

### `volley peer retarget`

```sh
volley peer retarget --to dev@box-b                  # the broker moved to box-b: re-point the tunnel
volley peer retarget --to dev@box-b --port 21884     # and use another local port
volley peer retarget --to dev@box-a --tunnel none    # the broker is on this machine now
```

Rewrites peer.json's `host` (and `remote_port` and `tunnel` when given; with `--tunnel none` the
port defaults to the broker's), restarts the `volley peer run` service through the same unit files
`join` writes, and exits 0 only once `127.0.0.1:<port>` answers; 1 when it does not within 30 s.
volleyd's `peer_retarget` runs it on a paired machine over ssh during a broker move.

### `volley peer remove`

```sh
volley peer remove box-a           # now: revoke its account, drop hosts.box-a, clear its record
volley peer remove box-a --drain   # place nothing new there; remove it once its agents finish
volley peer remove box-a --now     # stop its agents (each task gets a respawn question), then remove
```

With agents still running there, `--drain` and `--now` answer at once (`draining box-a: nothing
new starts there; 2 agents left. …`) and `volleyd` finishes the removal itself: `--drain` waits
for the agents to finish; `--now` asks each to stop, retires those still running after
`stop_grace_s`, and opens each task's respawn decision, which offers `respawn on <best>` (another
eligible machine). With no agent there, both remove at once like the plain form. The two flags
exclude each other.

### `volley peer doctor`

The one command that says whether this machine can run an agent, and what to do if not:

```sh
volley peer doctor                       # one line per check: ✓ ok, ! warning, ✗ blocks agents
volley peer doctor --fix                 # print the plan, ask, apply the safe fixes, check again
volley peer doctor --fix --yes --clone --origin https://github.com/example-org/example-repo
volley peer doctor --fix --yes --clone --repo-add example-org/example-repo   # add, then clone it
volley peer doctor --repo-add example-org/tools=/path/to/tools   # adopt an existing clone
volley peer doctor --repo-remove example-org/tools               # forget it (the clone stays)
volley peer doctor --json                # the machine record's doctor fields (SPEC §4.6.15)
volley peer doctor --sharing '{"skills":"own"}'   # by hand: this profile's sharing modes
```

| Check | Severity | What it looks at |
|---|---|---|
| `tool.<name>` | block (`gh`: warn) | `bun git gh tmux nc base64 cmp claude` installed (`command -v`), and their versions |
| `bun_on_path`, `claude_on_path` | warn | **an estimate**: whether the tool resolves on the non-interactive ssh `PATH` volleyd's `ssh <box> bash -s` gets, guessed as sshd's default `PATH` through your login shell's `-c` (sshd's `SetEnv`, `~/.ssh/environment` and `pam_env` are invisible to it). The detail says "estimated"; the supervisor's own probe of the real ssh `PATH` (readiness `path_ok`) decides |
| `volley.installed` | block | the volley checkout (`--volley-dir`, default the one running) has `node_modules/.bin`, installed from its current `bun.lock` (the doctor's own install records the lockfile's hash in `node_modules/.volley-lock-sha256`, so a `git pull` without a reinstall shows up), and `package.json` agrees with `bun.lock` (`bun install --frozen-lockfile --dry-run`) |
| `volley.version` | block | the checkout's version is the one the supervisor requires (its readiness verdict's `requirements.volley`, read through the tunnel when this machine is paired) |
| `repo.clone`, `repo.origin` | block | per repository in `peer.json`'s `repos` (each check names it: `repo.clone (b/b)`), else `--repo` (default `peer.json`'s legacy `repo`): a git clone whose `origin`, normalised to `<host>/<path>`, is the repository's (`github.com/<owner>/<name>`, or `--origin`'s) |
| `repo.canonical` | warn | a repository's remote names its old owner or name: GitHub (`gh repo view <slug> --json nameWithOwner`) reports the same repository for both; `--fix` repoints `origin` |
| `repo.fetch` | warn | `origin` (or `origin/<--release>`) answers `git ls-remote` with no prompt of any kind (`GIT_TERMINAL_PROMPT=0`, no askpass, `ssh -o BatchMode=yes`) |
| `tool.<name>` (a repository's), `repo.requirements` | block, for that repository only | a tool the repository needs (its manifests and `.volley/requirements.yaml`; the volleyd README's "Repository toolchains") is installed and at least its minimum version; the file is valid |
| `gh.auth` | warn | `gh auth status`, and `gh repo view <owner/repo> --json viewerPermission` is WRITE, MAINTAIN or ADMIN (`auth.gh`: `ok`, `no_write`, `unauthenticated`, `missing`) |
| `claude.signin` | warn | `claude auth status` (`auth.claude`: `signed_in` with the plan's label, `not_signed_in`, `missing`, `unknown`); while signed in, `auth.claude_email` / `auth.claude_org` are the login's identity from `~/.claude.json`'s `oauthAccount.emailAddress` / `organizationName` (the only two fields of it the doctor reports; identity, never a credential) |
| `claude.trust` | warn | `~/.claude.json` trusts the repo's folder or a parent (`auth.trust`) |
| `skills` | warn | `~/.claude/skills/volley` and `~/.claude/skills/volley-issues` link to this checkout's `packages/volley-skill` and `packages/volley-issues` (sharing `skills: copy`: they are there, copied or not; `own`: left as is) |
| `hooks` | warn | `packages/volley-hooks/scripts/install.sh --dry-run`, run with `CLAUDE_SETTINGS=~/.claude/settings.json`, `--broker-url` at the tunnel's port and `--namespace` (when not `default`), prints exactly the profile's `settings.json` (what `volley setup` checks locally; `settings.json: own`: left as is) |
| `mcp` | block (warn when only the broker, the namespace or the registration is off) | `~/.claude.json`'s `mcpServers.volley` runs this checkout's `packages/volley-mcp/src/index.ts` with bun, with `VOLLEY_BROKER_URL` at the tunnel's port and the peer's namespace (`mcp: own`: left as is); so does every other `volley` entry on the machine: each Claude account profile's under the Volley home (`~/.volley/claude/<acct>/.claude.json`, or `$VOLLEY_CLAUDE_DIR`) and the wave repo's `.mcp.json` (`account profile acct-b runs /path/to/old-checkout`; `--fix` re-points the entry at this checkout and keeps its other keys, except a `.mcp.json` git tracks, which is yours to update in the repo); and with `--supervisor-volley-dir` (volleyd's Repair passes the box's `volley_dir`), this checkout is that one (else the row names both and the fix is the doctor in that checkout) |
| `sharing` | warn | the three rows above follow the sharing modes (SPEC §4.6.11): `--sharing`, else the supervisor's readiness `requirements.sharing`, read through the tunnel, else the defaults; the detail names where they came from and which items are left as is |
| `claude.profiles` | warn | every signed-in Claude account profile under the Volley home (`~/.volley/claude/<acct>`, or `$VOLLEY_CLAUDE_DIR`) is ready to run agents unattended, past Claude Code's first-run screens: `hasCompletedOnboarding`, `lastOnboardingVersion` and `theme` in its `.claude.json`, `skipDangerousModePermissionPrompt` in its `settings.json` (`work: not ready to run agents unattended (…)` names the missing keys). `--fix` writes them (`lastOnboardingVersion` from `claude --version`; a theme already set and a `settings.json` linked to the primary's are kept); a profile an agent session runs in is `skipped: <n> session(s) running — rerun when they exit`, as Claude Code rewrites its `.claude.json` from memory |
| `machine.memory`, `machine.disk` | warn | available memory (Linux: `MemAvailable`; macOS: `vm_stat`'s free + inactive + speculative + purgeable pages, as free pages alone under-count), free space where the worktrees go (`<repo>/../.volley-worktrees`) |

Every probe runs a tool by its absolute path (the copy on the estimated ssh `PATH`, else the
shell's), so the doctor inside the `volley peer run` service reads the machine the way a terminal
does. `gh.auth` and `claude.signin` only warn (a join is not held up by them), but the
supervisor's readiness needs both, so the human output ends with a line naming them while they
fail.

**Fixes.** `--fix` runs only what writes inside the volley checkout (`bun install
--frozen-lockfile`; with a known requirement, `git fetch origin --tags && git checkout --detach
v<version> && bun install --frozen-lockfile`) and, with `--clone` and `--origin`, one `git clone`
into an empty `--repo` (`git clone -- <url> <path>`, prompt-free like `repo.fetch`). A step two
fixes share runs once, at its last place, so a fresh checkout behind the supervisor gets `fetch`,
`checkout`, then the install. `claude.profiles`' fix writes the missing keys into each
profile no agent session runs in. It prints its plan (on stderr under `--json`) and asks first unless
`--yes`, checks everything again afterwards, and a second run reports each of those as "already
done" (`volley.version` says "not checked" while the supervisor's requirement is unknown).
Everything else is printed for you to run: installing a tool (`brew install …` on macOS,
`sudo apt-get install -y …` or `sudo dnf install -y …` on Linux; `gh` from cli.github.com's
package repository on apt), the line that puts Claude Code on the ssh `PATH` (Linux:
`sudo ln -s ~/.local/bin/claude /usr/local/bin/claude`; macOS: a line in `~/.zshenv` for zsh,
`fish_add_path -U` for fish, and for bash, which reads no startup file there, `chsh -s /bin/zsh`
or an sshd `SetEnv PATH=…`), `gh auth login && gh auth setup-git`, the Claude sign-in, a wrong
`origin` (explained, never changed), and `package.json` disagreeing with `bun.lock` (local
edits: `git -C <dir> status`). Exit status 1 while a `block` check fails.

**Repositories.** `peer.json`'s `repos` maps each repository this machine works on, by its
GitHub `owner/name`, to its clone: the managed one at `~/.volley/repos/<owner>/<name>`
(`--repo-add <owner/name>`), or one you already have (`--repo-add <owner/name>=<path>`, adopted).
`--repo-add` and `--repo-remove` (both repeatable) save the map before the run; the supervisor
sends them over the same ssh channel as its Repair, and the `volley peer run` service re-reads
the map every heartbeat, so nothing restarts. A flag-less run (what `volley deploy` and the
service send) checks every repository in it. A legacy `repo` is rewritten into `repos` on the
next run, keyed by its clone's GitHub origin (a clone whose origin is not GitHub stays `repo`).
`--clone` (with `--fix`) clones each repository that has no clone yet from
`https://github.com/<owner>/<name>.git`; no `--origin` is needed. A remote that names the
repository under its old owner or name (renamed or transferred: GitHub reports the same
`nameWithOwner` for both) passes `repo.origin` and warns `repo.canonical`; `--fix` repoints
`origin` and journals it in the report's `fixes`. Any other mismatch blocks and is never changed;
without `gh`, origins are compared normalised. `--fix` also fetches every repository and, for a
managed clone whose worktree is clean and on its default branch (`origin/HEAD`), fast-forwards it
(`git merge --ff-only`); an adopted clone, a dirty or detached one, or one on another branch is
fetched only. `--json` carries `repos[]` (`slug`, `path`, `exists`, `origin`, `managed`,
`fetched_at`, `toolchain: { ok, missing, outdated }`), and `repo` too while exactly one
repository is configured.

**The Claude profile.** The last four rows prepare this machine's own Claude profile the way
`volley setup` and the packages' installers do locally, so a session you start here has
`/volley`, `/volley-issues`, the hooks and the volley MCP server without reading a README. They
only warn: an agent volleyd spawns runs without them (its spawn writes `.volley/mcp.json` and
brings the hooks itself). Their `--fix` writes only inside `~/.claude`, `~/.claude.json`'s
`mcpServers` and the hooks' state folder: the two skill installers (idempotent; a folder in the
way is backed up), or `cp -R` of a missing skill under `skills: copy`; the hooks installer with
`CLAUDE_SETTINGS`, `--broker-url mqtt://127.0.0.1:<remote_port>` and, outside the `default`
namespace, `--namespace` (it carries them in every hook's prefix; the usage statusLine comes with
it; a login in the URL is left out and said so, as the hooks take theirs from their own login
file); `claude mcp add-json -s user volley …`
(`claude mcp remove -s user volley` first when an entry is there but differs, so a new port is
re-registered). The registration carries no broker login, and an entry with settings of your own
(env keys such as a login, or an agent id other than `coordinator`) is never rewritten: its fix
is printed for you to run, and keeps those settings (each value shown as `<yours>`, for you to
fill in). A skill link that points at nothing is reported as a broken link and repaired (under
`skills: copy`, the link is removed and the copy made). On a machine that is not paired there is
no tunnel to expect: the hooks are checked against the URL they already carry (none: the
installer runs without `--broker-url`) and the MCP entry's URL is not compared. The modes come
from the supervisor's readiness verdict (`requirements.sharing`, its own `sharing.yaml`);
`--sharing <json>` sets them by hand and wins over the verdict (validated like `sharing.yaml`: an
unknown item or mode, or `mcp: linked`, is a usage error), and without either the defaults
apply (`skills` linked, `settings.json` and `mcp` copied). `.claude.json` is never linked or
copied whole, and the doctor runs no `volley auth` command.

**No secrets.** The doctor keeps states and plain labels only: exit codes of `gh auth status`,
the `loggedIn` and plan of `claude auth status`, an origin with any credentials stripped. Nothing
it prints or publishes carries a token (it also scrubs anything token-shaped), and `--origin`
refuses a URL with a password or token in it.

**Claude usage.** After the checks, the doctor prints one line per Claude Code login on this
machine:

```text
Claude usage: default 5h 37% · 7d 56% · Fable 12% (read 2 min ago)
Claude usage: work — (login expired; Claude Code renews it on its next request)
```

The logins are the default profile (`~/.claude`, as `default`) and each profile under
`$VOLLEY_CLAUDE_DIR` (else `~/.volley/claude`) that has a `.claude.json` (as its id), at most 16.
For each, the doctor's usage probe (`src/peer/usage-probe.ts`, SPEC §4.6.12) reads exactly
`claudeAiOauth.accessToken` and `expiresAt` of the login's stored credential (macOS: `security
find-generic-password` on Claude Code's Keychain item for that config dir, else the profile's
`.credentials.json`; Linux: that file), in memory, and makes one read-only `GET` to the usage
endpoint Claude Code's own `/usage` calls (`api.anthropic.com/api/oauth/usage`, the token as a
bearer, `User-Agent: claude-code/<installed version>`, 10 s, no redirects). This is SPEC
§4.6.11's one exception to never reading a credential: it never refreshes or writes a
credential, never runs `claude`, and skips an expired token (no request; Claude Code renews it
on its next request). Any error on the request's path has the token replaced by `[redacted]`,
and a failed answer's body is never read. What is published (`--json`'s `claude_logins`, and so
every heartbeat of `volley peer run` and the supervisor's own record) is numbers and states
only: `{ profile, state, attempted_at, reading?: { read_at, five_hour?, weekly?, model_weekly?
} }`, no directory, no e-mail. The state is `ok`, `expired`, `no_credential`, `rate_limited`,
`rejected` or `error`, and `reading` is the last good one (it survives failures, so its age
shows).

The probe is gentle. It makes at most one request per login per
`usage_probe_min_interval_s` (300 s); the last attempt is kept in
`~/.volley/claude-usage/<profile>.json` (folder `0700`, file `0600`, numbers only), because the
supervisor's own doctor is a fresh process every 30 s. A 429, 5xx, timeout or network error backs
off 10, 20, 40 and then 60 minutes (`usage_probe_backoff_max_s`), and the next success resets it.
A 401/403 is `rejected` and tried again at the normal interval. In practice a paired machine
reads every 10 minutes (its doctor's interval) and the supervisor's machine every 5.

**Where it runs.** `volley peer join` runs it first and stops on a `block` check before the
pairing code is used, so the code stays valid while you fix things (it prints the exact
`volley peer doctor --fix --repo …` to run); `warn` checks, the ssh `PATH` estimate among them,
are printed and the join goes on. `volley peer run` (whose service file carries the `PATH` the
join ran with) runs it once at start, and its first heartbeat waits up to
`PEER_DEFAULTS.first_doctor_wait_ms` (45 s) for that run, so a service restarted on a new version
(`volley deploy` restarts it) publishes a fresh verdict, never the last one before the restart.
It runs it again every `PEER_DEFAULTS.doctor_interval_s` (600 s, on a monotonic clock),
and at once on the next heartbeat when something the result depends on changed: the volley
checkout's `package.json`, `bun.lock` or `node_modules/.volley-lock-sha256` (a checkout update,
a `bun install`; a stat per beat), or `~/.volley/peer-doctor-ran`, which every `volley peer
doctor` on a paired machine writes (with or without `--fix`, the supervisor's `peer_doctor`
among them, so the service's next run, auth probes included, follows the latest facts). Each run re-reads the versions it reports, so readiness
follows the machine, never the service's uptime. `volley peer doctor --fix` then reads the
record back through the tunnel and prints `readiness republished` once it carries a run from
after the fix, or, when the service has not picked it up yet (or its tunnel is down), the
command that restarts it (`systemctl --user restart volley-peer.service`, `launchctl kickstart
-k gui/<uid>/systems.volley.peer`). It runs beside the heartbeat, never in its way: a beat never
waits for it, a run is given up after `PEER_DEFAULTS.doctor_timeout_ms`, and the record is
republished as soon as a run finishes. Every heartbeat carries the last finished run's result
(`versions`, `auth`, `repo`, `checks` without fix text, `doctor_at`), with `kind: peer`, `disk`
and `uptime_s` read fresh each time, and `memory` too except on macOS, whose `available_pct` is
the last doctor run's `vm_stat` figure. Available memory has one definition on every machine,
the supervisor's own included, so placement can compare them (SPEC §4.6.15): memory the kernel
can hand out without paging anything active out, over total memory (Linux: `MemAvailable`;
macOS: free + inactive + speculative + purgeable pages).

---

## `volley repo`

The repositories the supervisor's machines work on (SPEC §4.6.21), by GitHub `owner/name`.
`add` and `remove` are admin ops (an admin account's login, as `volley peer invite`); `list` and
`status` are reads any login may make.

```sh
volley repo add example-org/widgets                       # every machine
volley repo add example-org/widgets --machine box-a --path box-a=/srv/widgets --wait
volley repo status example-org/widgets
#   control: ready (/path/to/home/.volley/repos/example-org/widgets)
#   box-a: cloning
volley repo list [--json]
volley repo remove example-org/widgets --machine box-a    # its clone is kept; the path is printed
```

- `add <owner/name> [--machine <name>]... [--path <name>=<abs path>]... [--wait]`: volleyd checks
  the repository with `gh repo view` (one GitHub does not know is refused; GitHub's spelling of
  the name is kept), assigns it to the machines (default: all of them, the supervisor's own
  included) in its config, and answers. Then, on each paired machine, its doctor adds the
  repository to that machine's `peer.json` and, while it has no clone, clones it from
  `https://github.com/<owner>/<name>.git` (`--path` adopts an existing clone there instead); once
  the clone exists volleyd trusts it in the machine's default Claude profile and every signed-in
  one, so its agents never stop on the folder-trust question. The supervisor's own machine is
  never cloned for you: clone it at the printed path (`gh repo clone <owner/name> <path>`) and
  add it again. A machine that is down, or whose ssh fails, stays `blocked` with the reason and
  is retried when it is back (or after a Repair). `--wait` asks `repo_status` until every machine
  is `ready` or `blocked` (`--wait-timeout <s>`, default 900): exit 0 when all are ready, 1 when one
  is blocked, 124 on the timeout.
- `remove <owner/name> [--machine <name>]...`: drops the machines (default: all) from the
  repository's config and from each paired machine's `peer.json`. No clone is ever deleted: the
  answer lists each one's path.
- `status [<owner/name>] [--json]`: one line per machine, `<machine>: <state> (<why or path>)`,
  `state` being `ready`, `cloning`, `blocked` or `absent` — the same lines the Desk shows.
- `list [--json]`: each configured repository, its machines and adopted paths.

Connection flags as `volley peer`'s (`--broker-url`, `--namespace`, `--username`,
`--password`, `--timeout`).

---

## `volley role`

Which machine runs each machine role (SPEC §4.6.24): the broker, the supervisor (volleyd) and
the Desk. Read from volleyd's retained record `volley/_system/roles`, so it needs the broker,
not an answer from volleyd.

```sh
volley role status
#   broker      on mac
#   supervisor  on mac
#   desk        on mac (http://192.0.2.20:5199)
volley role status --json       # the whole record: the broker's address, lan, version, …
```

With no record (volleyd has never run against this broker) it exits 1 with
`no roles record: is volleyd running?`. `--timeout <s>` (default 2) bounds the wait for the
retained record; `--broker-url`, `--username` and `--password` as everywhere.

### `volley role move`

The moves below go in one order, the owner's smoke's (`docs/SMOKE-v0.11.md` part B): the Desk,
the supervisor, the broker, then rolling each back.

```sh
volley role move broker     --to <machine> [--address <ssh destination>] [--lan|--no-lan] [--drain] [--dry-run] [--yes]
volley role move supervisor --to <machine> [--drain] [--dry-run] [--yes]
volley role move desk       --to <machine> [--port 5199] [--dry-run] [--yes]
volley role rollback <move_id>
```

Admin ops, sent as `volley peer invite` sends its own (an admin login: `--username <admin>`,
password in `VOLLEY_AUTH_PASSWORD`; a login this machine's account registry says is not an admin
is refused before anything connects). `move` asks volleyd for a plan (`role_plan`) and prints its
sheet — the same text the Desk shows: the steps with the machine each runs on, what blocks the
move and how to fix it, the commands only a terminal can run, and what changes afterwards:

```text
$ volley role move desk --to box-a --dry-run
Move the desk from mac to box-a (plan 3f2a…)

Steps:
  1. on box-a: Install the Desk on box-a
  2. on box-a: Check the new Desk answers
  3. on mac: Record the Desk on box-a
  4. on mac: Sign in at the new address
  5. on mac: Stop the old Desk (kept for a rollback)

Afterwards:
  · every device signs in again at http://box-a.lan:5199
```

`--dry-run` stops there: exit 0, or 1 when the plan is blocked. Otherwise it asks once (`--yes`
skips the question), sends `role_move` with the plan's `plan_id` (a plan that changed meanwhile
is refused, `plan changed …`, exit 1: run it again), and streams the move's retained topic
`volley/_system/roles/moves/<move_id>` one line per step until it ends:

```text
✓ Install the Desk on box-a (box-a)
✓ Check the new Desk answers (box-a)
✓ Record the Desk on box-a (mac)
✓ Sign in at the new address (mac)
✓ Stop the old Desk (kept for a rollback) (mac)
the desk runs on box-a (undo: volley role rollback desk-20261024-091500-3c1d)
sign in at the Desk's new address: http://box-a.lan:5199/#signin=…
```

A failed move prints the step that failed (`✗ …`) and that every step done was undone; exit 1.
A supervisor move goes on streaming through the hand-over: the topic is retained and the new
supervisor continues it. A broker move stops the broker the stream is connected to: the CLI reads
the topic again over a fresh connection every few seconds until the supervisor, back through the
new broker, republishes it. A broker move whose new machine is not the supervisor's prints the
follow-on command (`volley role move supervisor --to <machine>`). `--drain` (broker, supervisor)
lets a move wait for a quiet fleet instead of being refused; nothing new is admitted meanwhile.
`--timeout <s>` bounds the wait for volleyd (default 30 s for the plan; a whole move 900 s for
the Desk, 1200 s for the broker, 1800 s for the supervisor): exit 124 when it passes.

### Moving the Desk

`volley role move desk --to box-a [--port 5199]` (the example above) installs the Desk on box-a,
checks it answers at the supervisor's version, records it, mints a sign-in link for the new
address and stops the old Desk last, kept for a rollback. The move answers once it is done, with
the link (sealed to this login's key, printed last): every device signs in again at the new
address. A Desk that fails its check is uninstalled there and the old one never stopped.

### Moving the supervisor to another machine

An admin moves the supervisor (`volleyd` and its home) to a paired machine with the `role_plan` /
`role_move` ops (SPEC §4.6.24). The fleet must be quiet first: no wave running, paused or
releasing and no agent live (or the move waits with `drain`). The plan checks the target is
paired and up, at the supervisor's version, signed in to GitHub with write access and to Claude,
that it can ssh to every other paired machine, and which terminal its agents will use.

**What travels**, in one bundle the old supervisor copies over ssh: the journals (`waves/`),
`config.yaml`, the paired machines and their codes (`peers.json`, `peer-codes.json`),
`claude-usage.json`, `roles.json`, the auth dir's `accounts.json`, `tokens.json`, `admin.json`
and `coordinator.json`, and the Claude account registry (`~/.volley/claude/accounts.json`).
**What does not**: worktrees, `cmux.json`, logs, `setup.json`, Claude profile directories (sign
the target's Claude logins in there) and the keychain. The broker stays where it is: the new
supervisor reaches it through the target's own peer tunnel.

On the target, volleyd runs:

```sh
volley role receive supervisor <bundle> --from <old machine> \
  [--local-terminal cmux|tmux] [--local-agents never] [--broker-url <url>]
```

It checks the bundle's manifest (a mismatch changes nothing), restores the files (anything
already there is kept under `$VOLLEYD_HOME/roles/<move_id>/replaced/`), makes `config.yaml` name
this machine (`fleet.local_name`; its own `hosts.<name>` entry is dropped), stops this machine's
own heartbeat (`peer.json` `heartbeat: false`; its tunnel stays), rotates volleyd's broker login
(`broker.json`, `dynsec-admin.json`, mode 0600: the old process can never reconnect), installs
and starts volleyd as a service, and prints a pairing code for the old machine last. The new
supervisor continues the move: it re-pairs the old machine as an ssh + tmux peer and writes the
roles record. If re-pairing fails the move still ends `done`, with a warning: re-pair it by hand
(`volley peer invite --for <old>` here, `volley peer join … --tunnel none` there). Exit codes: 0
received; 1 nothing changed; 3 a step after the rotation failed and was undone, but volleyd's login
has a password the old machine does not know (the old supervisor rotates it again).

Waves stopped for the move replay as `stopped` on the new machine: continue one with
`volleyd resume <wave>`.

### Moving the broker: `volley broker`

`volley role move broker --to box-a [--address <ssh destination>] [--lan|--no-lan]` moves the
broker, with every login it holds, from the supervisor's machine to a paired one, and re-points
every machine, the Desk and volleyd at it (the volleyd README's "Moving the broker" has the
steps). The new broker starts with no retained message: mosquitto's persistence does not travel.
volleyd runs the machine-side half with `volley broker`, which you run yourself only when the
plan says so:

```sh
volley broker receive <bundle> [--lan|--no-lan] [--layout <name>]   # on the broker's new machine
volley broker receive <bundle> --check     # exit 0 once this bundle was received here
volley broker probe [--layout <name>]      # {"layout":"brew-arm64","needs_root":false,"mosquitto":"2.1.2"}
volley broker tunnel --to <ssh destination> --port <n> --name <machine> [--broker-port <n>]
volley broker tunnel --off | --show
```

- **`receive`** checks the bundle first (its manifest, every sha256, a state file that is
  Dynamic Security JSON): a refusal writes nothing. It then places the state file at the
  layout's path and the admin login in the auth dir (each file it replaces kept as
  `<file>.before-<move_id>`), and runs `volley setup`'s Security step on them, never a second
  implementation: the config as `volley auth init` writes it (`--lan`: the WebSocket listener
  on every interface; default: the move's choice in the bundle), the layout's restart, both
  listeners checked to refuse anonymous clients. Its last line is `mosquitto 2.1.x: N logins`.
  On a root-owned install (`snap`, `etc`) without root it exits 2 with the line to run:

  ```
  $ volley broker receive /path/to/home/.volley/roles/broker/bundle.tgz --lan
  volley broker receive: this install (snap) keeps the broker's config and state file as root's: run `sudo volley broker receive /path/to/home/.volley/roles/broker/bundle.tgz --lan`
  ```

  The move's sheet shows that command under *Run in a terminal*, and the move waits for it.
- **`tunnel`** is the supervisor machine's own tunnel to the moved broker: `--to` writes
  `peer.json` (a tunnel-only one, `heartbeat: false`, when there is none), restarts the peer
  service with `volley peer retarget` and waits for the port; `--off` puts back what `--to`
  replaced; `--show` prints a paired machine's tunnel (`{"host","remote_port","tunnel"}`), which
  the move keeps for a rollback.

After the move, your Claude Code sessions on the old broker's machine still name the broker URL
they were set up with. Re-register them through that machine's tunnel:

```sh
volley setup --step claude-code --broker-url mqtt://127.0.0.1:1883
```

### `volley role rollback`

```sh
volley role rollback <move_id>
```

Undoes a done move within 7 days (the admin op `role_rollback { move_id }`), as a new move the
other way, streamed as the move was; the move undone is then `rolled_back`, and a rollback that
fails leaves it `done`. Only a done move rolls back, and only while its role still runs where the
move put it; a rollback is not rolled back in turn (move the role again). After 7 days the move's
record is removed.

- **The Desk**: the old Desk, kept stopped, started and checked again; the record written back;
  the Desk on box-a uninstalled.
- **The supervisor**: the supervisor on box-a moves itself back as a supervisor move: a fresh
  bundle of the current home travels back, so what changed since the move goes with it. The move
  undone is marked `rolled_back` at that hand-over.
- **The broker**: the old broker started again (its state file was never removed), this
  machine's tunnel down, every machine back on the tunnel it had, the Desk told the old host.
  Stop the broker on box-a there.

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
volley lease status                                        # every pool: holders, queue, reasons, by machine
```

`status` groups each pool's holders and queued requests under the machine they run on, hosts by
name and `(unknown host)` last (a holder volleyd did not spawn, or every holder of a supervisor
that does not report hosts); a pool with a `per_machine` cap shows it, and each machine's share of
it:

```text
backend-it  3/4 held  max 1 per machine  1 queued  queued l-4: 1/1 backend-it leases held on box-a (per machine)
  box-a  1/1 held
    held    l-3  agent-a  since 2026-10-19T12:00:00.000Z
    queued  l-4  agent-c  since 2026-10-19T12:00:00.000Z
  box-b  1/1 held
    held    l-2  agent-b  since 2026-10-19T12:00:00.000Z
  (unknown host)  1 held
    held    l-1  hand-1  since 2026-10-19T12:00:00.000Z
```

A pool with `per_machine_overrides` (a machine's cap in force in place of `per_machine`, set with
`lease_pools.<pool>.per_machine_overrides` in the supervisor's config) lists them in the header,
and every overridden machine gets a line, even before it holds a lease. A machine with no cap in
force shows only its count:

```text
js-suite  3/4 held  max 2 per machine (box-a 3, laptop 1)  1 queued
  box-a  2/3 held
  box-b  0/2 held
  laptop  1/1 held
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

Credentials resolve as: flags, then the `broker` block of `./.volley/agent.json` (an agent's assigned identity), then `VOLLEY_AUTH_*`, then, for a broker on this machine (`localhost`, `127.x`, `::1`), the coordinator login `volley setup` saved: the macOS keychain item `volley-broker`, then `coordinator.json` in the auth dir (`VOLLEY_AUTH_DIR`, else the one `$VOLLEYD_HOME/setup.json` records, else `<mosquitto config dir>/volley`). That last step is for the operator only, never an agent: not when `VOLLEY_AGENT_ID` or `VOLLEY_HOOKS_DIR` (set for every agent volleyd launches) is set, nor below a directory holding `.volley/agent.json`; an agent uses only the login minted for it. `VOLLEY_NO_SAVED_LOGIN=1` turns it off (the test suites set it). `volley lease --coordinator` and `volley peer` keep their own `coordinator.json` lookup. `--username` without `--password` takes the password from `VOLLEY_AUTH_PASSWORD`. Prefer the env var over `--password`: argv is visible in `ps`.

**Shell sessions on the supervisor machine need nothing exported.** A Claude Code MCP registration's `env` block reaches only the MCP server, not the session's Bash tool; on the machine `volley setup` ran on, `volley wait` / `volley sub` / `volleyd config get` find the saved coordinator login on their own. On another machine (or for a remote broker, where the saved login is never sent), export `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD`; without a login they exit `1` with `AUTH_FAILED` immediately. A refused login exits `1` with `AUTH_FAILED` and a `volley auth init` hint.

---

## Exit codes

Standardized across subcommands so shell scripts can branch cleanly:

| Code | Meaning |
|---|---|
| `0` | success — operation completed |
| `1` | broker error or unexpected runtime failure |
| `2` | invalid usage (bad flags, missing required args) |
| `3` | `deploy`: the services checkout has local changes (no `--force-clean`) |
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
  --on <csv>               Lifecycle types that fire (default: blocked,failed,reaped,digest)
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
