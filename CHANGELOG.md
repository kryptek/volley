# Changelog

All workspace packages share one version. Dates are release-tag dates.

## 0.13.1 — 2026-10-25

### Fixed

- **install.sh: the one command no longer dies at sudo on a stock cloud image.** It probes with
  `sudo -n true` and runs `sudo -v` only when a password is really needed (sudo's `verifypw` made
  `-v` ask on accounts that run every command without one); with a password needed and no
  terminal it stops before asking and says so. The install tests' machines now have the stock
  cloud-image sudoers shape. (#590)
- **volley setup: on a Linux install whose broker files are root's (the snap, /etc/mosquitto), the
  broker steps run through sudo by themselves.** Setup prints why, runs detect, security and
  accounts as root (a silent `sudo -n true` probe first, so a cloud image's passwordless sudo asks
  nothing, in any locale; one prompt otherwise), with the config and state file it planned with,
  then continues as you; without a terminal it stops with the exact commands. The
  one-command install no longer dies at `Security: … EACCES`, and the documented manual pre-step
  is gone. (#591)

## 0.13.0 — 2026-10-25

### Added

- **volley-desk: the Getting started wizard's art.** Seven vector cartoon scenes of Volley's otter
  raft (the Welcome toss animated, reduced motion respected), behind an asset map
  (`public/getting-started/art.json`) that can name raster files later without a code change. (#565)
- **volley-cli, volleyd: the Network step.** `volley setup --network tailscale|manual|none` installs
  Tailscale (the default), records this machine's private name and address in setup.json and the
  machine record, adds the `network.private` doctor row, and runs as a Desk setup step
  (`setup_plan`/`setup_apply`). Your own VPN is the `manual` option; nothing is ever exposed
  publicly. `install.sh --network tailscale` installs the Tailscale package on Linux with the
  other packages, and `volley peer list` shows each machine's kind. (#566)
- **volleyd: the coordinator role.** volleyd keeps a `claude remote-control` server alive on the
  machine `coordinator.machine` names (a paired machine through its tunnel, or this one), in a
  fixed directory under a fence-sealed script, restarting it with backoff, publishing its state
  and link on `volley/_system/federation/coordinator`; a laptop is refused by default;
  `volley coordinator status|open|restart|stop`. (#567)
- **volley-desk: Getting started.** A first-launch wizard (Welcome → This computer → Your machines → Repos → People → Access → You're good to go!) opens after the admin sign-in until it is finished or skipped, is re-runnable from Settings › Setup & Security, and shows what each step changes before applying it. (#568)
- **volley-cli, volley-desk: the Desk on your private network.** `volley desk install --tailscale`
  serves the Desk and the broker's WebSocket listener over HTTPS at the machine's Tailscale name
  (two loopback-only `tailscale serve` targets, never Funnel; `volley desk uninstall` takes off
  only those two), and `volley setup`'s Services step plans the same when the Network step
  recorded Tailscale. `/desk-config.json` carries `ws_url` (`volley desk serve --ws-url`), which
  the page opens over HTTPS; setup.json records `desk_private_url`, the roles record's `desk.url`
  becomes the private address with the LAN one in `desk.lan_url`, and `volley setup`'s end,
  `volley auth token`, `volley auth signin-link` and `volley role status` show it. volley-sim's
  fake `tailscale` answers `serve`. The private network serves only this machine's broker, so
  `--tailscale` refuses a Desk that names a broker on another machine (`--broker-host`), and
  setup leaves that Desk on the LAN; Tailscale briefly not answering keeps the recorded private
  address. (#569)
- **volley-desk, volleyd: finding the coordinator.** An Open coordinator button in the Desk, a
  Coordinator card in Settings › Machines (pick the machine, laptops refused by default, Restart),
  an owner-only `notice` inbox item pushed to the phone when the coordinator's link changes or it
  stops, and a handoff text volleyd puts into a fresh coordinator session's first turn (running
  waves, open items, the previous session). (#570)
- **volley-cli, volleyd: unreachable-supervisor diagnosis.** When the broker does not answer, every
  command probes internet → private network → tunnel → broker → volleyd, prints the exact cause
  and fix, submits nothing and exits 69 `SUPERVISOR_UNREACHABLE` (`--json` carries the reason; a
  silent volleyd names the namespace asked, so a wrong `--namespace` shows); `volley peer doctor`
  gains the reach rows; the `/volley-issues` skill relays the reason and asks instead of
  switching. Supersedes #244. (#571)
- **volley-desk: Getting started › This computer and Your machines.** Install checks and versions
  from the machine record, the setup steps' plans with Apply, naming this computer
  (`fleet.local_name`), the paired machines, and adding one by pairing code, SSH key or a username
  and password that is exchanged for a key. (#572)
- **volley-desk: Getting started › Repos and People.** GitHub sign-in status, adding a repository
  from a slug or from a folder on a paired machine (validated by `repo_probe`), the people table,
  and invite links by role (Superuser = admin token, Standard = steer link, Viewer = watch link).
  (#573)
- **volley-desk: Getting started › Access and You're good to go.** The private-network choice
  (Tailscale, your own VPN, this network only) applied through setup's Network step, the
  coordinator's always-on machine, the summary, and the two lines that add a computer with a
  fresh pairing code. (#574)

### Fixed

- **install.sh: a fresh Ubuntu or Debian gets a broker.** snapd is detected when socket-activated
  (fresh cloud images), snapd is installed with apt when the `snap` command is missing (Debian 13),
  and the install stops with exit 1 and the exact fix, before cloning Volley, instead of saying
  "Volley is installed" when no mosquitto 2.1 can be put on the machine (a `snap` command whose
  snapd is not running is named, with `sudo systemctl enable --now snapd.socket`). A broker you
  run in a container gets past the stop with `--broker container`: mosquitto is neither installed
  nor checked, and `volley setup --layout container` runs. (#577)
- **install tests: Layers 2 and 4 launch on a snap multipass.** VM names are valid instance names
  (`volley-it-<id>-ubuntu-24-04`), the run's key and cloud-init live under `VM_OUT` (never `/tmp`),
  a snap multipass refuses an unreadable `VM_OUT` up front, and the nightly's new `report` job
  comments on the tracking issue when a job fails or never starts. (#577)
- **volley-cli: setup finds the mosquitto snap's broker.** The snap's broker is a service with no
  `/snap/bin/mosquitto`, so the Broker step reads its version from `snap list mosquitto` instead of
  stopping at "no mosquitto found"; the snap layout runs `/snap/bin/mosquitto.ctrl` by its path
  (under sudo on Debian `/snap/bin` is not on PATH). (#577)
- **volley-cli: on the snap layout, `sudo volley setup` gives the Volley auth dir to you.**
  `/var/snap/mosquitto/common/volley` (0700) and its files (`admin.json`, `coordinator.json`, the
  account and token registries; 0600) go to the sudo user, as `~/.volley/volleyd/dynsec-admin.json` already does, so the documented
  second run (`volley setup` as yourself) no longer blocks at Security and your CLIs read the
  coordinator's login. mosquitto's `dynamic-security.json` and `mosquitto.conf` stay root's (an
  auth dir that holds them is not handed over), and a handover that fails is a warning, not the
  command's exit code. (#577)

### Docs

- docs: the v0.13 owner smoke (Getting started, reach from anywhere, the coordinator from a phone)
  and the docs sweep for the Getting started wizard and the coordinator role. (#575)

## 0.12.1 — 2026-10-24

### Fixed

- **volleyd, volley-cli: the account balance counts only the agents in flight, and stale sessions
  leave an account's record.** A ranked candidate's `agents` (the `claude_balance` answer,
  `account_chosen`, the CLI column and the tie-break) is now the agents counted against the
  account (supervised, launching and reserved), not every session that ever reported usage on it;
  a session the supervisor does not supervise is forgotten an hour after its last sample and its
  retained `usage` topic cleared, so interactive sessions and restarts no longer inflate the count
  ("33 agents" on an idle primary). `volley claude balance` and the pick's `why` print `5h unused`
  / `7d 68% left` when no reset is known instead of `left in unknown` / `left in now`. (#562)

## 0.12.0 — 2026-10-24

### Changed

- **volleyd: account balancing spends the room that expires first, under a 97% cap.** The
  automatic pick ranks a machine's signed-in Claude accounts by pace (room left in each window
  against the time until that window resets; the tightest of the 5-hour, 7-day and model-family
  windows decides), takes no account with a window at or over `claude.balance.cap_pct` (default
  97) while another has room, and spreads near-equal accounts (`claude.balance.tie_band_pct`,
  default 10) over the one with fewer agents. `account_chosen.why`, the Desk's account chip and
  `volley claude balance` say which window is expiring and when (`work: 18% left, resets in
  52m (use it or lose it)`). Pinned accounts are unchanged; `most_headroom` stays a synonym for
  balancing. (#556)
- **volleyd: the balance counts the agents already on an account.** Each running agent, and
  each one picked earlier in the same pass, reserves its next hour of use (`claude.balance.reserve_h`)
  against the account's windows at the rate the account has shown per agent-hour (learned from its
  usage samples; `claude.balance.agent_cost_pct_h` and `agent_cost_weekly_pct_h` until it has),
  and the 97% cap and the use-it-or-lose-it score apply to that projection. Twelve spawns in one
  pass spread across the accounts that fit, and an account at 95% takes none. `why` and
  `volley claude balance` show the projection (`18% left (8% after 1 in flight)`). (#557)

### Fixed

- **volleyd: an agent that hits its usage limit moves to an account with room, unattended.** On
  `credit_exhausted`, when another signed-in account on the agent's machine has room, volleyd opens
  `agent_account_limit` (`class: credit_exhausted`) instead of `model_switch`, and autopilot answers
  `move <agent> to <acct>` under `account_move_max` (`agent_account_limit/move-exhausted`). The
  exhausted account is marked at 100% until its window resets, so new spawns avoid it and its other
  agents get their own move. The owner is asked only when no account has room (`model_switch`, as
  before) or the budget is spent. (#555)

## 0.11.1 — 2026-10-24

### Fixed

- **volleyd: commands on a paired machine run its own volley checkout.** The doctor, Repair,
  repository adds and every role-move step run `bun <volley_dir>/packages/volley-cli/src/cli.ts …`
  (as `volley deploy` already did), so a machine whose ssh PATH has no `volley` is no longer
  blocked with `command not found`; when the checkout or bun is missing, the error names the
  expected path and the fix. (#550)
- **volley-desk: Add repository says why Add is off, checks the clone's path on the machine, and
  shows a blocked chip's full reason.** A new read-only `repo_probe` op reports whether the path
  exists, is a git clone and which GitHub repository its origin names; a matching origin fills
  owner/name, a mismatch (or a folder inside a clone rather than its root) blocks Add, and a
  blocked chip's `Why` opens the whole text. (#551)

## 0.11.0 — 2026-10-24

### Added

- **volley-cli: `volley setup --check [--json]` reports what is missing, and every run measures
  itself.** `--check` plans every step without changing or asking anything and prints each as
  done, pending (with the changes a run would make), blocked or skipped, exiting 0 only when
  nothing is pending or blocked; `--json` prints `{ version, steps, setup_at }` for CI. Every run
  writes `$VOLLEYD_HOME/setup-metrics.json` (wall time, the questions the person saw, sign-ins,
  sudo prompts, each step's time and change count; 0600, never a token) and ends with
  `Setup complete in <m> m <s> s (<n> questions, <n> sign-ins, <n> sudo)`. (#453)
- **volleyd: agents on the supervisor's own machine run in tmux when cmux is not there.** The new
  `fleet.local_terminal` (`cmux` | `tmux`; unset: `cmux` on macOS when cmux is installed, else
  `tmux`; a `cmux` set off macOS is `tmux`) picks the local host: `local-tmux` starts each agent
  in a detached session `volley-<wave>-<task>-<role>` on your default tmux server (`tmux attach -t
  <it>` shows it), with the same screen, keys, typed text, resize (the Desk's Terminal popout
  resizes it), retire and cleanup as cmux. The fence admits local tmux only for those session
  names and shapes, the launch only with the worktree's sealed `launch.sh`, and killing a session
  only with consent. `agent_spawned` carries `terminal`; `volleyd cleanup` closes each workspace
  in the terminal its agent ran in. A launch (or a cleanup) where tmux is missing fails with the
  line to install it. Read at start: a change applies to agents spawned after the next start, and
  a restarted volleyd keeps reaching each running agent in the terminal it started in. (#454)
- **volley-cli: `volley setup` gains a Terminal step.** Between Accounts and Services, it picks
  the terminal volleyd starts local agents in: cmux on a Mac that has it (with the socket-mode
  check that used to run in Services), else tmux, blocking with the install line (`brew install
  tmux`, `sudo apt-get install -y tmux`, `sudo dnf install -y tmux`) while tmux is missing; Linux
  never hears of cmux. The choice goes in `config.yaml` (`fleet.local_terminal`) and `setup.json`
  (`terminal`), keeping `config.yaml`'s file mode. The volleyd systemd unit gets `KillMode=process`, so restarting volleyd leaves
  its tmux agents running. (#454)
- **volley-sim: fake `claude` and `gh` for installed-mode runs.** A new package,
  `packages/volley-sim`, whose `bin/claude` and `bin/gh` stand in for Claude Code and the GitHub
  CLI under `VOLLEY_SIMULATED=1`, so an installed Volley (real volleyd, tmux or cmux, git and
  broker) runs a whole wave without an account. The world (PRs, issues, labels, CI runs, sign-ins)
  is one JSON file under `$VOLLEY_SIM_HOME`, advisory-locked so separate processes share it; git
  is real: heads come from a local bare origin and a merge writes to it. `gh` answers every argv
  shape volleyd's fence allows plus `volley setup`'s (`auth`, `api user`, `repo view|create|delete`,
  `issue`, `label`, `pr create|view|list|merge|ready|checks`, `run list|view|watch`, `api` for the
  CI runs and queue and the release train's tag refs, CI always green);
  any other shape exits 1 with `unknown argv` and is logged to `unknown.jsonl`. `claude` keeps
  sign-ins per profile, `mcp add-json|list|get|remove` in the profile's `.claude.json`, and, launched
  in a worktree with `.volley/agent.json`, runs a simulated agent that registers with its own
  login, does its role's work (an implementer commits, pushes and opens the PR; a reviewer
  publishes an approving `result`) and reports `done`. Outside `VOLLEY_SIMULATED=1` both hand
  the call to the real program; the services' PATH and the installer never include them. (#455)
- **volley-cli: `volley sim env | reset`.** `eval "$(volley sim env)"` puts the fakes first on
  PATH and sets `VOLLEY_SIM_HOME` (default `~/.volley/sim`) and `VOLLEY_SIMULATED=1`;
  `volley sim reset` clears the simulated world. (#455)
- **install.sh: one command installs Volley.** `curl -fsSL
  https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh` installs what is missing
  of the prerequisites (Homebrew, bun, mosquitto ≥ 2.1, gh, git, tmux and Claude Code on macOS;
  apt, bun's installer, gh's apt repository and `snap install mosquitto` when none is installed on Ubuntu/Debian, behind
  one `sudo -v`), clones Volley at the latest release tag (`--version`) into `~/.volley/src`,
  writes the `volley` and `volleyd` commands into `~/.volley/bin` exactly as `volley setup` does,
  adds that directory to PATH once and runs `volley setup` on the terminal. Rerunning it changes
  nothing; `--check` lists what is found and missing, `--uninstall` (`--purge`) removes it again,
  `--source <dir>` uses a checkout, `--no-setup` stops before setup and `--peer` passes through. (#456)
- **Machine roles: the record of where the broker, the supervisor and the Desk run.** SPEC
  §4.6.24 names the three machine roles, the retained record `volley/_system/roles`
  (`roles.schema.json`), the moves topic `volley/_system/roles/moves/<move_id>`
  (`role-move.schema.json`), the ops `role_plan`, `role_move` and `role_rollback`, the quiet and
  7-day retention rules and six `_system` events (`roles_changed`, `role_move_*`,
  `role_rolled_back`); `auth-request.schema.json` gains those ops plus `peer_invite`,
  `peer_remove` and the reserved `peer_retarget`. volleyd keeps the record in
  `$VOLLEYD_HOME/roles.json` (on its first start, all three on this machine), publishes it at
  start and journals `roles_changed` when it differs. (#457)
- **volley-cli: `volley role status [--json]`** prints which machine runs each role from the
  retained record, with no answer needed from volleyd. (#457)
- **volley-cli: `volley setup` signs you in and sets Claude Code up, with no secret in
  `~/.claude.json`.** Two new steps after Accounts. Sign-ins: Claude Code (`claude auth login`)
  and GitHub (`gh auth login --web`, then `gh auth setup-git`) in your browser, read with the
  doctor's parsers (the e-mail only with `--show-email`, the GitHub login masked), and the
  checkout added to `permissions.additionalDirectories`. Claude Code: a coordinator name asked
  once and saved in `setup.json`, the volley MCP server registered with `VOLLEY_AUTH_DIR` in
  place of a password (an entry with settings of your own is left as is), the `volley`,
  `volley-issues` and `volley-wait` skills linked, the hooks installed; `--broker-url` re-points
  the registration and the hooks. (#458)
- **volley-mcp: a registration that names `VOLLEY_AUTH_DIR` logs in with its
  `coordinator.json`.** Without the file the server fails naming it, never printing a password.
  (#458)
- **volleyd: `volleyd run` without `--owner` uses the coordinator name `volley setup` saved, and
  says so;** the other commands use it as `VOLLEY_COORDINATOR` when the environment sets none.
  The skill installers and the `/volley-issues` prerequisites point at `volley setup --check`
  instead of printing an `add-json` with a password. (#458)
- **packaging: `brew install kryptek/volley/volley` on macOS.** A Homebrew formula
  (`packaging/homebrew/volley.rb`) installs the release tarball into `libexec`, writes the `volley`
  and `volleyd` commands, depends on bun, mosquitto, gh, git and tmux, and says to run
  `volley setup`. A release workflow on every `v*` tag builds the tarball (the checkout with its
  `node_modules`, reproducible: `scripts/packaging/tarball.sh`) and its sha256, uploads both to the
  release, renders the formula, checks it with `brew style` and pushes it to the tap when the
  `HOMEBREW_TAP_TOKEN` secret is set. `install.sh` on macOS runs `brew install` when Homebrew
  resolves the tap (and no `--version` or `--source` is given, and no curl-path install is already
  there), else clones as before; a failed `brew install` stops it; `--check` and `--uninstall`
  know the brew install. `volley setup` run from brew's install points the commands and services
  at `$(brew --prefix)/opt/volley/libexec`, so `brew upgrade` does not break them; rerun
  `volley setup` after an upgrade to rebuild the Desk. A release tag must match `package.json`'s
  version. How to create the tap: `packaging/README.md`. (#459)
- **volley-cli: every machine through its own tunnel.** `peer.json` gains `tunnel: ssh | none`
  (none: the broker runs on this machine, reached at its own port, no ssh) and `heartbeat`
  (false: the tunnel is kept and no record is published); `volley peer run` honours both, and
  `volley peer join --tunnel none` pairs a machine the broker runs on. `volley peer retarget
  --to <host> [--port <n>] [--tunnel ssh|none]` rewrites `peer.json`, restarts the service and
  exits 0 only once the tunnel answers (1 after 30 s); a service that does not restart leaves
  `peer.json` as it was. (#460)
- **volleyd: `peer_join` answers the broker from the roles record, and `peer_retarget`.**
  `peer_join` answers the broker's port as `roles.broker.address` names it and takes `tunnel:
  "none"` (`hosts.<name>.tunnel.remote_port` is then the broker's port); the fence holds a paired
  machine's launch env to exactly its own broker port. The new admin op `peer_retarget { name,
  address, port?, tunnel? }` runs `volley peer retarget` on that machine over ssh and answers
  once its record comes up through the new tunnel, journaling `peer_retargeted`; one run per
  machine at a time. (#460)
- **volley-cli: `volley setup` ends with a 1-issue test wave.** The new last step, `first-wave`, asks
  once ("Run a 1-issue test wave now?", Enter: yes; never under `--yes`, `--simulated`,
  `--no-first-wave` or `--check`), creates a scratch private repository `volley-hello-<4>`, files
  "Add HELLO.md", pushes `release/<date>-hello-<4>`, adds it to the fleet with `volley repo add …
  --wait`, writes `.volley/waves/hello-<4>.yaml` (`pipeline: [implement, merge_ready]`, `merge:
  auto`; every run is a wave of its own, so a rerun after a failure works), submits it with `volleyd
  run … --owner <coordinator>` and follows the wave until volleyd merged its PR (the URL and the
  wall time; on a failure the journal's tail and the open decisions; 15 minutes from the submit at
  most). `--repo <path> [--issue <n>]` runs it on a clone of yours; `--simulated` against
  volley-sim's fakes. `setup-metrics.json` records `first_wave: { wall_ms, pr, merged }`, the
  `Setup complete` line reports it, and the end prints `gh repo delete <owner>/<name> --yes` for
  the scratch repository and any an earlier run left. (#461)
- volleyd: the default model lives in one place, `DEFAULT_MODEL` in `config-defaults.ts`; the
  test wave, the `/volley-issues` skill and the README cite it. (#461)
- **volley-cli: `volley machine add <user@host>` makes a bare box a ready paired machine, from
  the supervisor's.** One interactive ssh installs this machine's key there (the prompt is ssh's
  own; every later step is `ssh -T -o BatchMode=yes … bash -s` with its script on stdin); then
  `install.sh --peer --version <this machine's tag> --no-setup` (over `ssh -t`, announced, only
  when the box lacks what sudo installs), `volley setup --peer --yes`, the box's key authorized
  here (on a Mac, Remote Login checked first), a pairing code bound to its name redeemed with
  `volley peer join` there, `gh auth login --web` over `ssh -t` and Claude through volleyd's
  remote sign-in (`--no-signin` defers both), and the doctor's readiness row: tools, gh, claude,
  trust, repositories, ready or not with the fixes (exit 1 when not ready). A rerun on a paired
  box changes nothing; no line carries the code or a password; a fence allows only its own
  commands. (#462)
- **volley-cli: `volley setup --peer`.** The sign-ins, Claude Code for the profile only (the
  skills, and the hooks at the peer tunnel; no coordinator name or MCP registration), the
  Terminal, and `volley peer run` as the user service in place of volleyd (skipped until the
  machine is paired). It never mentions a broker, the Desk or the phone, and refuses their flags. (#462)
- **install.sh: `--peer` installs no broker.** mosquitto is neither installed nor checked, the
  Homebrew tap is not used, and `volley setup --peer` runs with `VOLLEY_BROKER=skip`; `--uninstall`
  removes the peer service too. (#462)
- **volleyd: `peer_invite { for }` may name a machine not paired yet.** The code then pairs that
  new machine only (`volley machine add`); a host configured by hand is still refused. (#462)
- **volley-cli, volley-desk: the Desk learns the broker's host from its server.**
  `volley desk serve --broker-host <host> [--broker-ws-port <n>]` serves `/desk-config.json`
  (`{"broker":{"host","ws_port"}}`, never cached; a 404 without the flag), and the page connects
  there: the prop, then `VITE_VOLLEY_BROKER_URL`, then the served broker, then its own host,
  fetched once before the sign-in form and kept in memory only. Settings › About names the broker
  and whether it was *served* or the *page host*. `setup.json` records `broker_host`, and the
  Services step renders the flag into the Desk's unit; `volley setup --check` names it. (#463)
- **volley-cli: `volley desk install | uninstall | check`.** The Desk's own install as commands
  (what volleyd runs over ssh to move it): `install [--port] [--broker-host] [--root]` builds the
  Desk without the `VITE_VOLLEY_BROKER_*` variables, stamps the build and installs its service for
  this platform, idempotently, then records its port and broker host in `setup.json` (only once
  it takes) so a later `volley setup` renders the same unit; `uninstall` removes the service and keeps `dist/`; `check --url
  --version` exits 0 when `/` answers 200 and `/version.json` matches. (#463)
- **CI: Layer 1 installs Volley from nothing on every PR.** A new `Install` workflow
  (`.github/workflows/install.yml`) runs `install.sh` in fresh Ubuntu 24.04 and Debian 13
  containers (a non-root user, mosquitto 2.1 built from source, a `systemctl` stand-in) and on a
  GitHub-hosted Mac, then `volley setup --yes --simulated` against volley-sim, and fails when
  setup's wall time or the install end to end is over 15 minutes, setup asked a question, a
  `volley setup --check` row is not done, the test wave's PR did not merge, a rerun changes
  anything, a log holds a password or token, or `install.sh --uninstall` leaves a service running.
  The metrics table lands in the step summary; the logs are uploaded.
  `scripts/install-tests/README.md` runs it locally with Docker. (#464)
- **volley-desk: Settings › Machines › Add a bare machine….** A form (the box's `user@host`, its
  password or a key file, an optional sudo password, a name) makes a box with only ssh a paired
  machine from the Desk: each of `volley machine add`'s seven steps streams into the sheet as it
  happens (the sheet waits as long as rows keep coming), and the run ends with the machine's
  readiness and its sign-in buttons; a failure names the step and its fix. (#465)
- **volleyd: `machine_add`, an admin op.** It runs `volley machine add`'s step list over
  `ssh -T … bash -s` without a terminal, publishing `progress` rows on the op's reply topic before
  its answer. A password reaches ssh only through an `SSH_ASKPASS` helper reading a 0600 temp file
  removed after the step, sudo on the box through a `SUDO_ASKPASS` helper, and neither is
  journaled, logged or answered; the fence gains the machine-add ssh forms and refuses an askpass
  env anywhere else. A second `machine_add` for a name whose run has not ended is refused. (#465)
- **volleyd: the role-move engine and moving the Desk.** `role_plan`, `role_move` and
  `role_rollback` (admin ops, SPEC §4.6.24) move the Desk to a paired machine: blockers (not
  paired, down, behind the supervisor's version, no `bun` on its ssh PATH, the port taken), then
  install there, a health check (`volley desk check`), the roles record, a sign-in link for the
  new address sealed to the requester, and the old Desk unloaded last. A failing step undoes the
  steps before it; a `plan_id` that no longer matches is refused with `plan changed`; one move at
  a time. Progress is the retained `volley/_system/roles/moves/<move_id>`, journaled
  `role_move_*` in `_system` and logged under `$VOLLEYD_HOME/roles/<move_id>/`, kept 7 days for a
  rollback and removed at the next start after that; a rollback is journaled `role_rolled_back`,
  and a move a restart finds half-done is ended `failed`. (#466)
- **CI: Layers 2–4 of the install tests, nightly on self-hosted runners.** `install-nightly.yml`
  (a schedule and `workflow_dispatch` only, never a PR) installs Volley in fresh Ubuntu 24.04 and
  Debian 13 VMs through multipass and reboots them (the services come back, `--check` green within
  2 minutes, volleyd's status from the new boot); in fresh macOS VMs through Tart, on both the curl
  and the Homebrew path (launchd, the keychain, the Desk, the hooks, a restart); and pairs a peer VM
  to a hub VM with `volley machine add` (ready within 10 minutes, a task placed on the peer, then
  `volley peer remove`). Every run deletes its VMs, refuses a name it does not own, writes its
  metrics to the step summary and, on failure, comments on the one `install-tests` issue. The
  runners' set-up is in `scripts/install-tests/README.md`; `scripts/install-tests/vm.test.ts` tests
  the scripts against stand-in `multipass`, `tart`, `ssh` and `gh`. (#467)
- **volleyd: moving the supervisor.** `role_move { role: "supervisor", to }` bundles the
  supervisor's home (waves, config, registries, the auth dir's logins; never worktrees, logs or
  sign-ins), copies it to the target and runs `volley role receive` there, then unloads itself;
  the new supervisor continues the same move at its start: its own `working` status, the old
  machine re-paired with `tunnel: none` (its agents run in tmux over ssh), the roles record. The
  plan requires a quiet fleet (or `drain: true`, which waits for one and admits nothing new), the
  target up at the supervisor's version with `gh` write access, a signed-in Claude profile and
  ssh to every other paired machine. A failed receive leaves the old supervisor in charge;
  `role_rollback` moves it back within 7 days, as a new supervisor move with a fresh bundle.
  Supersedes #247 and #248. (#469)
- **volley-cli: `volley role receive supervisor <bundle> --from <old>`.** Restores the bundle
  (checking its manifest first; what it replaces is kept), rewrites `config.yaml`, stops this
  machine's own heartbeat (after the rotation, which goes through its tunnel), rotates
  volleyd's login into `broker.json`, installs and starts
  volleyd, and prints a pairing code for the old machine last; any failure puts everything back
  (exit 1, or 3 after the rotation). (#469)
- **volleyd: moving the broker.** `role_move { role: "broker", to, address?, lan? }` moves the
  MQTT broker, with every login it holds, from the supervisor's machine to a paired one: the old
  broker stopped through its layout, its Dynamic Security state file, admin login and `lan`
  bundled (the persistence DB never travels), copied and received there, the supervisor's own
  ssh tunnel to it (and volleyd's unit pointed at it), a health check (volleyd's login, the
  broker's version, both listeners refusing anonymous clients), every paired machine re-pointed
  with `peer_retarget` (the target with `tunnel: none`) and up through the new broker within the
  grace, the Desk told the new broker host, then the roles record with `address`. The plan blocks
  on a fleet that is not quiet (or waits with `drain: true`), no mosquitto 2.1 on the target,
  a machine that cannot ssh to `address`, and with `lan` port 9001 unreachable; a root-owned
  install on the target gets its receive as a `sudo` terminal command the move waits for. The
  move answers as it starts (`handing_over: true`): volleyd runs it without a broker and restarts
  through the new one when it ends, republishing what it owns. A failing step or a machine that
  never comes back up undoes everything (`failed`, `rolled_back: true`); `role_rollback` brings
  the broker back within 7 days. The plan's `after` names the one line for your own sessions:
  `volley setup --step claude-code --broker-url mqtt://127.0.0.1:<port>`. (#470)
- **volley-cli: `volley broker receive | probe | tunnel`.** `receive <bundle> [--lan|--no-lan]
  [--layout <name>]` checks a broker move's bundle (refusing one whose state file is not Dynamic
  Security JSON before writing anything), places the state file and admin login, then runs
  `volley setup`'s Security step on them (config, restart, the anonymous check) and prints
  `mosquitto 2.1.x: N logins`; a root-owned layout without root exits 2 with the `sudo` line.
  `probe` prints this machine's mosquitto layout and version; `tunnel --to | --off | --show` is
  the supervisor machine's own tunnel to the moved broker. (#470)
- **volley-cli: `volley role move broker|supervisor|desk --to <machine>` and
  `volley role rollback <move_id>`.** The CLI over the machine-role ops: `move` prints the plan
  sheet volleyd answers `role_plan` with (one renderer, `volleyd/roles/sheet`, the Desk's too),
  `--dry-run` stops there (exit 1 when blocked), otherwise it asks once (or `--yes`), sends
  `role_move` with the plan's `plan_id` and streams the move's retained topic as `✓ step` lines
  until it ends — `the <role> runs on <machine> (undo: volley role rollback <move_id>)`, a Desk
  move's sealed sign-in link, exit 1 on a failed or changed plan, 124 when volleyd does not
  answer in time. A supervisor move goes on streaming through the hand-over. Broker flags
  `--address <ssh destination>` and `--lan|--no-lan`, `--drain` for a quiet-fleet wait, `--port`
  for the Desk; a non-admin login is refused before connecting. (#471)
- **volley-desk: machine roles in Settings › Machines, and moving a role from the Desk.** Each
  machine card gets a **Roles** row (`broker`, `supervisor`, `desk`), the section a summary line
  (`broker · studio — supervisor · studio — desk · box-a`) and the Machines window's rows the
  letters `B S D`, from volleyd's `volley/_system/roles`. For an admin, **Move a role here…** opens
  a sheet that plans the move (`role_plan`): its steps with each machine, the commands to run in a
  terminal, what blocks it with each fix, and the notes for after. It moves on confirm
  (`role_move`), or waits for an idle fleet. A broker move queues the supervisor's by default. The
  sheet follows the move's live steps, then shows the hand-over for a supervisor move and the
  sign-in link and QR for a Desk move. Done names `volley role rollback <move_id>` (kept 7 days),
  and the old Desk address shows where the Desk lives now. (#472)

### Changed

- **release: v0.11.0 — install and machine roles.** Every package, the root and the
  `volley-issues` skill (`version: 0.11`) move to 0.11.0: the one-command install (epic #302) and
  machine roles (epic #296). The owner smoke is `docs/SMOKE-v0.11.md` (parts A and B). (#474)

### Fixed

- **volleyd: a wave names a repository held only by paired machines by its owner/name.**
  `repo: owner/name` resolves to the supervisor's clone when its machine holds one, is kept as the
  owner/name when only paired machines hold it (its tasks are placed there; the supervisor needs no
  checkout and runs its `gh` work, the pipeline's PR, CI and merge steps included, with `--repo`
  and no working directory), and is refused only when no machine holds it, naming them. Each task
  of such a wave pinned to the supervisor's machine is refused at submit with the fix that applies
  to it, and so is a release `playbook:`; such a wave's PRs merge one by one, never in a merge
  train. `volleyd validate` gives the same verdict offline (saying so when `config.yaml` does not
  parse) and both CLIs print a `repo:` line.
  (#448)
- **volley-hooks: parallel tool calls no longer lose their count on a busy machine.** A hook
  waits for `work-log.lock` as long as a live holder can keep it (5 s, when a dead hook's lock
  turns stale) instead of 2 s, so hooks queued behind each other on a loaded machine still count
  their tool call. (#455)
- **volley-cli: `volley setup --yes --simulated` finishes on a fresh machine.** The Sign-ins step
  no longer asks for `gh auth setup-git` under the simulator (its fake writes no git config, so the
  step never verified); the test wave's scaffold commits with the simulated world's git identity
  instead of failing with "Author identity unknown" where git has none; and setup trusts the
  scratch clone it made for Claude Code (the simulated wave skips `volley repo add`, whose add
  volleyd takes as consent), so the wave no longer waits on a `repo_untrusted` decision; and the
  services run with the simulator on (`VOLLEY_SIMULATED=1`, its fakes first on PATH; on macOS
  `volleyd install` keeps it in the plist when run with it), so volleyd's `gh` and `claude` are the
  fakes rather than the real ones. (#464)
- volley-cli: `volley setup` and `volley auth init` create the broker's state-file directory when it
  is missing (a fresh Homebrew mosquitto has no `var/mosquitto` until it first runs), instead of
  failing at `mosquitto_ctrl dynsec init`. (#464)
- **volley-mcp: a publish still unacknowledged when the connection closes fails instead of
  waiting forever.** mqtt.js keeps a persistent session's QoS 1 publishes for a reconnect that
  never comes (Volley clients never reconnect), so a broker move hung at its first step: volleyd
  published the move's progress as the old broker stopped and that publish never settled. It now
  fails with `BROKER_DOWN` and the move goes on without a broker, as designed. (#473)
- CI: a `release/**` push that reuses a PR run no longer fails its `CI reused` job (a YAML comment
  truncated the step's command to `echo "PR`). (#535)
- volleyd: a PR's own failing test is no longer called a flake because the release branch is red
  on something else; bun test ids now carry their file from the log's group header, and the flake
  question names the release branch only when it fails the same test. (#536)

### Docs

- **docs: the README Quickstart is the one command,**
  `curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh`, with Linux
  and macOS side by side, the three questions and two sign-ins `volley setup` asks, and the Desk
  link it prints; the seven manual steps (and their circular order: setup before the clone) are
  gone. The new
  `docs/INSTALL.md` says what the installer does on each platform, every flag, `--check`,
  `--uninstall`, the Linux notes (sudo once, mosquitto 2.1, the snap's root-owned config,
  `systemd --user` and lingering), the Homebrew path, adding a bare machine
  (`volley machine add`), updating and setup from a clone. (#468)
- **docs: `docs/SMOKE-v0.11.md` part A, blank machine to first wave.** The owner's real-Claude
  canary on a fresh Tart macOS VM and a fresh multipass Ubuntu VM: the one command timed from
  Enter to the merged PR, reboot survival, a bare machine added, the first-run screens (the
  browser-extension prompt included) as a checklist line, *Pass* lines, and a results table with
  the install targets beside each count; the owner's new workstation is a run-history entry, not a
  gate. (#468)
- **docs: no stale install instructions.** The package READMEs, skills and their smoke lists point
  at the one command and `volley setup --check` instead of a hand-pasted `claude mcp add-json`
  with a password, a `brew services` broker prerequisite, the old example namespace (now
  `default`), hard-coded model ids (now `DEFAULT_MODEL`) and Cmd-Q-only wording; the skills'
  broker-down hint is `volley setup --check`. `scripts/check-install-docs.test.ts` fails on any
  tracked Markdown file that brings one back, and pins the Quickstart to the one command and
  `docs/INSTALL.md` to every installer flag. (#468)
- **docs: machine roles end to end.** `docs/SMOKE-v0.11.md` part B is the owner's run on real
  hardware: the Desk moved to a paired machine with the phone signed in there, the supervisor
  moved there with the old machine re-paired as a tmux peer and a two-task wave placed on it, the
  broker moved there with the Desk staying (the phone, and the old machine's sessions after the
  one-line `volley setup --step claude-code` fix), each rolled back, with *Pass* lines and a
  results block. The root README's use case 2 adds moving the broker, the supervisor or the Desk
  to the box from the Desk; `/volley-issues`' prerequisites say what to run where when
  `volley role status` names another machine for the supervisor; the volleyd and volley-cli
  READMEs' machine roles sections follow one order (record → Desk → supervisor → broker →
  rollback), the rollbacks gathered in one closing section. (#473)
- **volleyd: the three role moves and their rollbacks run end to end in CI**
  (`test/roles-e2e.test.ts`): real daemons on fake machines, a second in-process supervisor
  taking each hand-over, the broker move between two Aedes brokers. (#473)

## 0.10.0 — 2026-10-24

### Added

- **volley-desk: agent windows show an animated pixel Clawd doing what the agent does.** Typing
  while implementing, glasses or a magnifier while reviewing, a wrench or hammer in fixup,
  sparkles when merge-ready; dozing, "?", X eyes and a green check for blocked, needs-you,
  failed and done. Three looks per step, picked per agent at random but stably. Settings ›
  Appearance › Agent icons keeps the classic spinner. One shared 8 fps clock, no filters on
  phones, a still frame under reduced motion. (#350)
- **volley-desk: Settings › Appearance › Theme.** The Desk reads its colours from one token set;
  Volley (today's look) is the default and twelve palettes are listed (the other eleven arrive
  with #368 and #369). The theme applies before the first paint, live on change, on every
  screen. (#365)
- **volley-desk: Settings › Appearance › Current step, and depth on the agent window.** Nine
  treatments of the current pipeline step (Glint by default; Pulse, Aurora, Scanline, Ember,
  Liquid, Circuit, Prism; Classic keeps the flat look), each card a live preview. Done steps are
  raised success glass with a ✓, future steps are pressed in, chips get the toggle's bevel and the
  footer bar is glossy with a slow glint. Transforms and opacity only, no blur; a still frame
  under reduced motion. (#366)
- **volley-desk: the wave window's graph and progress rail take the current-step effect.** Running
  nodes and segments show the effect from Appearance › Current step; merged ones are raised with a
  ✓, queued ones pressed in; an ended wave stays flat. Graph nodes are HTML now (same layout), so
  their text is real text for screen readers. (#367)
- **volley-desk: Material Lighter, a light theme.** The first light palette, WCAG AA for text:
  accent-coloured text darkens on white, the dock and the sign-in card go light, native controls
  follow. The Desk's status colours, mascot and backgrounds stay as they are. (#368)
- **volley-desk: ten more themes.** Material Oceanic, Material Darker, Material Palenight,
  Material Deep Ocean, Dracula, Night Owl, One Dark, GitHub Dark, Monokai Pro and Solarized Dark,
  each at WCAG AA for text (comment-grey "dim" tints lifted where the editor theme's own value fell
  short). (#369)
- **volleyd, volley-cli, volley-desk: rename and remove a Claude account; every open Desk follows
  live.** `volley claude rename` / `remove` and the card's ✎ / Remove…; remove is refused while
  an agent, a running wave or the config default uses the profile, and clears the profile
  directory, the usage record and the registry entry in one step (a paired machine's directory
  only as `<home>/.volley/claude/<acct>`, through a new fence token); volleyd publishes a
  registry-changed signal (`volley/_system/claude/registry`) and prunes usage records of
  profiles that no longer exist. Part of #391. (#497)
- **volleyd, volley-desk: a wave's Claude account on its window.** The wave window shows the
  account its new agents start under (`Account: Balanced` by default, else the account's name)
  and switches it in place (`wave_account_set`, journaled as `wave_account_moved`, `null` meaning
  balanced; running agents finish where they are, a task naming its own `account:` keeps it; a pick an open `account_limit` offers answers
  it), and the wave state carries `account: { pinned, source, moved_from? }`. The wave's
  `account_limit` is a banner on its window; the wave's settings modal and the Settings › Claude
  accounts section no longer carry the account or its Needs-you banners, and the agent window's
  account picker names the account by its registry label. Part of #391. (#499)
- **volleyd, volley-cli, volley-desk: sign a Claude account in from any device.** The sign-in
  dialog and `volley claude add|signin` show Anthropic's code-page link first (with a QR code in
  the Desk) and take either the code it shows or the localhost address a browser ended up on, in
  one box (a no-echo prompt under `--wait`, or `volley claude code <acct> <entry>` /
  `volley claude signin <acct> --code <entry>` for the sign-in already waiting);
  volleyd types the code into the sign-in waiting on that machine, or completes the redirect on
  it, for the supervisor's and every paired machine (`claude_signin_entry`). The localhost
  redirect stays as a shortcut when the browser is on the supervisor's machine, never a
  requirement, and a paired machine's forward is best-effort. The code and `state` are never
  journaled, logged or echoed. (#500)
- **volleyd: the wave owner's presence comes from its connection's will.** The wave state's
  `coordinator` carries `presence` (`online` / `offline`, read from the owner's retained status)
  and a new `state`, `away`: an offline owner reads `away` while autopilot runs the wave and
  nothing waits on it, and `gone` only while something only the owner can answer waits (an
  escalated decision, an owner-only inbox item, a gate under `merge: manual`). A coordinator
  name still reads `reconnecting` within `autopilot.reconnect_grace_s`. `volleyd status` prints
  the owner as `· online`, `· away (autopilot) · last seen 2h ago`, `· gone · 1 decision waits
  for you` (`· gone · something waits for you` when a gate or an inbox item waits) or
  `· reconnecting`. No timer re-publishes the wave state to keep `last_seen` fresh any
  more; a quiet connected owner simply stays `online`. (#502)

### Changed

- volley-desk: a handful of near-duplicate text tints (onboarding, machines, inbox, the terminal's
  error lines, Settings' error acks, the context and usage meters) now use the shared semantic
  text tints, so they shift by a hair on Volley. (#368)
- **volley-desk: a task waiting on CI gets a CI panel.** A task held for CI with no agent running
  gets its own window, cabled to the wave window like an agent window: task and PR, a jobs
  progress bar with the estimate, the running and failed jobs and a link to the PR's checks; it
  leaves when CI finishes or an agent takes the task over. The tiny CI stub pill is gone. (#488)
- **volley-desk, volley-cli: Settings › Claude accounts is one clean card per account.** Name,
  masked e-mail and plan, the account's three meters once, a machine list with sign-in state
  only, Add / Rename / Remove, and "Last updated"; no per-machine figures, stale warnings, waves,
  agent counts, Use-for or next-pick. A paired machine is listed once; a profile waiting for
  sign-in is a row with Finish sign-in, not a card; a 0% window with no reset reads "no usage yet
  this window". `volley claude list` heads a group with its registry label, prints
  `last updated:` instead of `freshest:` and per-row `(stale)`, and lists `waiting for sign-in:`.
  Part of #391. (#496)
- **volleyd, volley-desk, volley-cli: adding a Claude account ends primed.** On sign-in done
  volleyd reads the login's identity and plan and probes its usage at once (`claude_prime { acct }`
  asks again, at most once per 5 min; `volley peer doctor --probe-login <profile>` runs that one
  login's probe); the Add dialog says who signed in; a card missing data asks volleyd for it and
  shows "reading…" until volleyd answers ("no reading yet" after), never a command to run; a
  sign-in matching an account already on that machine says so and offers to remove the new
  profile. (#498)
- **volleyd: `volleyd claim` follows the owner's presence; `claim_after_s` is retired.** A wave is
  claimable exactly when its owner is offline — a coordinator name once its bound session has
  been offline past `autopilot.reconnect_grace_s`, so a wave shown `reconnecting` never is —
  and a quiet connected owner is never claimable, however long it says nothing. A refusal says
  why (`online`, or `reconnecting` with the time a claim becomes possible). A stored
  `claim_after_s` (in `config.yaml` or a wave file's `config:`) is dropped with a log line, and
  `volleyd config set claim_after_s` is refused. (#503)
- **volley-desk: an owner away while autopilot runs its wave reads `away (autopilot)`, never `No
  coordinator · claim it`.** The Desk keeps no silence timer: a quiet connected coordinator stays
  `working` however long, and `reconnecting`, `away` and `gone` come from each wave's own
  `coordinator.state` (volleyd's reading of the owner's presence), never from another wave of the
  same owner. An `away` wave is Info `Owner away · autopilot runs this wave` (`Owner away` with
  autopilot off), with a neutral `away` chip and `Owner away · autopilot · last seen 2h ago` in
  the coordinators window, no Needs-you banner, no `claim it`, and its chat refused until a
  session is back (its decisions, gates and inbox items escalate as under a live coordinator);
  `gone`, with its banner and claim, now shows only when volleyd says so. A terminal status reads
  as `gone` only from a supervisor that publishes no `coordinator`. Settings › Supervisor's
  Attention summary drops `claim_after_s`; demo mode shows an `away (autopilot)` wave beside the
  reconnecting one. (#483) (#504)

### Fixed

- **volley-desk: the "why here" cards render above the canvas.** The agent window's machine chip
  tooltip and the wave window's host-chip popover were clipped inside their window and scaled
  with the canvas; they now portal to the screen layer, flip and shift to stay in the viewport, follow their chip as the canvas pans and zooms,
  and wrap at 360 px. (#349)
- **volley-desk: a burst of Needs-you cards no longer paints its buttons as white boxes.** Each
  Specular button drew on a WebGL context of its own, and a dozen cards pushed the page past the
  browser's context cap; at most six are live now, the rest (and any whose context is lost) draw a
  flat tinted rim. Identical open decisions are one card (`×11`, `11 tasks waiting · …`) whose one
  answer goes to every task; the card stays whole while its members are answered or held one
  by one, and a partial failure's retry goes to the rest only. (#417)
- **volley-desk: a graph node's status never runs into its issue number.** The CI hold reads
  `CI · 12/17` (`CI pending` without a count) on the node, a status too long for the room left of
  the number is cut with an ellipsis, and every node's tooltip carries the full line
  (`T8 · <title> · waiting for CI · 12/17 jobs`). (#489)
- volleyd: a pipeline test no longer flakes on a busy CI runner: it publishes the implementer's
  result before `done`, so its wait no longer spends two 1 s result probes. (#524)

### Removed

- **volley-mcp: no heartbeat timer; presence is the connection's will (SPEC §7.5).** The MCP
  server no longer publishes a `progress` heartbeat every `VOLLEY_HEARTBEAT_S`: an idle connected
  server publishes nothing after `registered`, and a dropped connection flips its retained status
  to `reaped` by the will. `VOLLEY_HEARTBEAT_S` is ignored, with one stderr line from the server (the hooks and `volley lease` stay quiet). SPEC §7.5
  defines presence (online while the retained status is live, offline once it is `reaped`, `done`,
  `failed`, or a `blocked` with `reason: "shutdown"` left by a clean shutdown, which §7.4 now
  requires), and §4.3 no longer asks agents for a periodic heartbeat. (#501)

### Docs

- volley-desk: the Desk README describes themes, the current-step effects, the light tone and
  the token layer, with screenshots, and `themes.mjs --matrix` runs every theme against the
  current-step effects at desktop and phone width. (#370)
- docs: presence replaces heartbeats in the owner's guide, the `/volley-issues` skill and the smoke plan. (#483) (#505)

## 0.9.0 — 2026-10-23

### Added

- **spec, volleyd: the contracts for overlap-aware waves.** A wave file's task may carry `issues`
  (a bundle), `footprint` (`listed` | `resolved` | `guessed` | `none`) and `plan` (its cluster and
  `collapse` | `chain` | `cap` | `independent`); the wave state gains `overlap_plan`, `spawns`,
  `trains` and each task's `cluster` and `churn`; new wave events `wave_planned`,
  `cluster_strategy_changed`, `train_started`, `train_merged` and `train_failed`; a synthetic
  `train-<n>` task; the `churn_exhausted` decision kind; and the `autopilot.merge_train` tunable
  (default `true`). Schemas, examples and types only: nothing acts on them yet. (#378)
- volleyd: a replay fixture of the 26-issue dogfood wave (titles, Files lists and the tree's file
  sizes), regenerated by `scripts/replay-fixture.ts`. (#378)
- **volleyd: footprints — an issue's Files list resolved against the repository tree, with a
  confidence.** `footprintOf` turns bare names (`types.ts`), relative fragments, globs and
  directories into tree paths (inside the last resolved package first), accepts `(new)` and
  `changes/` entries, drops identifiers such as `github.slug`, sums the files' bytes and rates the
  list `listed`, `resolved`, `guessed` or `none`; `readTree` reads the tree with
  `git ls-tree -r -l --full-tree` (now a read-only verb of the fence) and `sharedFiles` matches
  two footprints with globs expanded against it. The 26 dogfood issues all resolve to `listed` or
  `resolved`. (#379)
- volleyd: a bare file name beside a path in the same Files bullet now lands in that path's
  directory (`config-defaults.ts, types.ts`), so overlap warnings see it. (#379)
- **volleyd: the overlap planner.** `volleyd/overlap-plan` weighs every pair of a wave's tasks by
  the source bytes they share (a shared doc at `plan_doc_weight`; `changes/**` and
  `spec/examples/**` never count), clusters the tasks that share a source file, and per cluster
  collapses strongly coupled tasks into one bundled task (up to `plan_bundle_issues_max` issues and
  `plan_bundle_files_max` source files, tests aside), chains a strong pair that cannot bundle
  (bigger first, one chain per task; none where a declared `after` already orders the pair), and
  caps a big cluster at `plan_cluster_in_flight_max` in flight, with a why on every task and
  cluster. `explain` puts the plan in a few lines and `diffPlan` notes where a wave file differs
  from it. Globs match with the footprint resolver's `sharedFiles`. Pure: nothing runs it yet; the
  26-issue dogfood replay, resolved by `footprintOf`, plans to 14 tasks. (#380)
- **volleyd, volley-issues: the overlap plan is wired in.** `wave-from-issues` resolves each
  issue's Files list against the `--repo` tree at `origin/<release branch>` (else the local branch;
  else `no tree: footprints unresolved`), plans the wave and writes each task's `files:`,
  `footprint:` and `plan:`, a bundle's `issues:` and title, and the chains' `after:` (marked
  `# chained by the planner: shares …`), with the plan in words as the file's header and on stderr
  beside a `footprints: …` line (`--verbose` lists the unresolved entries). `--no-plan` writes
  footprints only, `--plan-only` prints the plan and writes nothing (the two together are a usage
  error). The wave file parses `issues`
  (must contain `issue`, no repeats, none another task closes), `footprint` and `plan`, and rebuilds
  the file's own plan from them. `volleyd validate` and `volleyd run` print that plan, a `note:` per
  place the planner would differ, and the footprint line; the daemon resolves a task without
  `files:` against the tree once per wave, journals `footprint_unavailable` (and `run` warns) when
  its issue cannot be read, carries `issues`/`files`/`footprint`/`plan` on `task_queued`, journals
  `wave_planned { clusters }` once per plan version, and the state fills `overlap_plan`,
  `tasks[].cluster` and `spec.tasks[]` (a later version without a plan clears them); `volleyd status` prints a `plan:` line per cluster. SPEC
  §4.6.22. (#381)
- **volleyd: bundles run end to end.** A task with several `issues` gets one agent and one PR:
  its `ISSUE.md` holds every issue under a `# Bundle: #310, #312` header with the planner's why,
  its brief names them all and asks for one `Closes #<n>` line and one changelog fragment per
  issue, and `agent.json` and `agent_spawned` carry `issues`. A verified PR body missing a
  `Closes` line (one indented as code or inside a fence does not count) steers the implementer
  once, then a fixup runs for it even when both reviewers approve, and the fixup's PR body is
  checked the same way; the digest ships
  each issue of a merged bundle (`#310 + #312 (one PR)`). A single-issue task's `ISSUE.md` and
  briefs are unchanged. (#382)
- **volleyd: the cluster cap and the churn monitor.** Admission enforces the overlap plan's cap
  per cluster: a ready member whose cluster has no room is held, its `why_waiting` naming the
  members in flight (`cluster A: 4 in flight (i315, i317, i318, i322)`), and `ready()` no longer
  reorders by shared files (critical path, then id). Each tick the churn monitor
  (`autopilot/churn.ts`) reads the journal's branch updates, gated members and merges and
  switches a churning cluster (a member updated its branch twice in
  `churn_window_ms`, or gated members are not merging) to `hold` (cap 1 until its gated members merge) or `train`, and back
  to `planned` once calm, journaling `cluster_strategy_changed` at most once per
  `cluster_strategy_min_interval_ms` (30 min). `volleyd status` shows each cluster's state and its
  members in flight on the plan line. (#384)
- **spec, volleyd: the merge train's formation, token and merge commit.** `formTrain` picks a
  merge train when at least two gated tasks wait on a release branch with no merge in flight: up
  to `train_size_max` (4) of the front task's wave, its overlap-plan cluster first, named
  `train-<n>` on the branch `volley/train/<wave>-t<n>`. A train's members show `merging` in the
  merge queue, and while one runs no task on its release branch takes the ordinary turn. The fence
  allows exactly `gh pr merge <n> --merge --match-head-commit <head>` with a `TrainToken` for that
  PR and head (never `--squash`, and a `MergeToken` never allows `--merge`), and `mergeTrain`
  re-reads the PR before merging as `mergePr` does. SPEC §4.6.23 "Merge train" states the rule.
  Nothing forms a train yet: the driver comes with the integrator. (#385)
- **volleyd: the merge train runs end to end.** Under `merge: auto` with `autopilot.merge_train`
  on, two or more gated tasks whose front is behind the release branch form `train-<n>`:
  `train_started`, then a synthetic task (`Train: #310, #312`) that a new `integrator` role runs
  from `.volley/integrate.md`. It merges each member's gated head into the train branch with
  `--no-ff` and opens one PR with every member's `Closes` line. The train head is verified to
  contain every member (a lacking head is steered, then fixed up), CI runs once on it, member
  reviewers whose flagged files a conflict resolution touched review the resolution diff (else
  `train_reviews_skipped`), and the gate mints the TrainToken. The merge commit lands every
  member: `train_merged`, each member `merged_by_supervisor { via: "train" }` and done, a member
  PR GitHub still reports open alarmed as `train_member_open`. The train holds the release branch
  throughout (`volleyd merge` of a member is refused, naming it). A conflict asks
  `merge_conflict { train }`; autopilot drops the member (`merge_conflict/drop-from-train`) and
  the train forms again without it. A refused merge (behind, moved, closed, retargeted) or a train
  red after `ci_fixup_max` CI fixups fails it (`train_failed`; the latter also holds its
  clusters), its members queue again. (#386)
- **volley-desk: the overlap plan in the wave window.** The graph tints each cluster's nodes with
  one palette hue and badges them with the cluster id (`A · 4/4` while capped, `A · hold` while
  held), labels a bundle `#310 +1` with every issue linked, and dashes the edges the planner
  chained. A collapsible **Clusters** panel under the graph lists each cluster's members, hot
  files, strategy, state and why (just the id and state at phone width). The merge queue line
  leads with its trains (`train-1 (i301, i302, i303) integrating · queued i305`), linking a
  train's PR; the title gains a `churn 7` chip; the plan's five events join the wave feed; the
  store types mirror `overlap_plan`, `spawns`, `trains` and the tasks' `cluster`, `churn`,
  `issues`, `files`, `footprint` and `plan`. Demo mode shows a planned wave. (#388)
- **volleyd: the replay soak.** `test/soak/replay.test.ts` runs the 26-issue dogfood batch
  through the real daemon on the fake clock twice. The baseline has one task per issue, no merge
  train and the gate as it was before #383 (the test-only `VOLLEYD_REPLAY_BASELINE=1`). The epic
  runs the overlap planner's wave with the merge train on. The test asserts the epic's targets:
  branch-update rounds ≤ 0.3 × the baseline's, merge rounds ≤ 0.5 × the baseline's, no
  spawn-budget decisions caused by churn, and at most 16 planned tasks. It prints the table on
  every run. CI runs it as a gating step of the `soak` job (`REPLAY=1 bun run test:soak --
  replay`). The soak harness now takes tasks with footprints (`{ id, issue?, files, after? }`),
  seeds its world with the fixture's tree, and records the conflicts that branch updates resolve.
  (#389)

### Changed

- **volleyd: churn never spends the spawn budget.** A spawn is now productive or churn
  (`src/spawn-class.ts`): a branch update (`rebase`), a merge train's spawn (`integrator`, and the
  train's own roles), a review round a branch update caused (and its fixup), or a relaunch,
  respawn or retry of a role in its step is churn, journaled `agent_spawned { churn: true, cause }`.
  The spawn budget counts productive spawns only (its derived size is unchanged); a churn spawn
  never opens `spawn_budget_exhausted` and is never held by the budget (the hard ceiling still
  holds it). The wave state counts both (`spawns: { productive, churn, churn_by, budget }`,
  `tasks[].churn`); `volleyd status` prints `spawns: 52 productive / 156 budget · 141 churn (116
  branch updates, 25 re-reviews)` under the header; the digest's `auto.churn` counts them by cause
  and its push summary names churn only when there was any (`5 churn spawns (no budget)`). (#387)
- **volleyd: the churn fuse.** A task in a cluster whose churn spawns pass 3 × its pipeline roles
  puts its cluster on `hold` (`cluster_strategy_changed { churn }`); churn that goes on while the
  cluster is held, or after the churn monitor let that hold go, opens one task-level
  `churn_exhausted` decision (`hold cluster` | `continue` |
  `cancel`). Autopilot's new `churn_exhausted/hold` rule answers `hold cluster` once per task
  (budget key `churn:<task>`), then escalates. (#387)
- **CI: volleyd runs in 8 balanced shards, volley-desk in 2; a release-branch push whose tree a
  pull_request run already passed reuses that run.** Every pull_request run records the tree it
  tested as a `tested-tree-<tree>` artifact; a push to `release/**` that is a PR's squash with that
  tree (the PR was up to date with its base) and whose PR's newest run passed reports `CI reused —
  this tree passed pull_request run <id>` with every other job skipped (`scripts/ci-reuse.ts`).
  Anything else, and every push to `main`, runs the full suite. A reused push skips bun 1.3 and the
  32-task soak (a task PR's run is not a full run); the release PR and `main` still run them.
  volleyd no longer takes a skipped job's duration as the estimate for its next run, so a reused run
  leaves the CI hold's ETA as it was. (#492)

### Fixed

- **volleyd: a task behind the release branch is gated at its reviewed head and updated only at
  its merge turn.** Before, a task that fell behind was updated before its gate, every time it
  came back from a fixup: the update, its CI and the re-review took about as long as the gap
  between merges, so it was behind again by the time it returned, and the merge queue's "N
  merges, at most N−1 updates" never held. Now the gate records how far behind the head is
  (`behind` in the evidence and on the gate's `artifact_verified`), the task queues with
  `why_waiting: "gated 3 commits behind <release branch>; updated at its merge turn"`, and its turn
  brings it up to date once. A CONFLICTING PR and a landed flake fix are still updated before the
  gate. Under `merge: manual` the evidence says to update the branch before merging. (#383)
- **volleyd: a transient GitHub merge refusal is retried with backoff, not escalated.** `Merge
  already in progress`, `Base branch was modified`, 5xx answers, rate limits and transport errors
  now read as `reason: transient`: they never count toward `autopilot.merge_retry_max`, the task
  keeps its merge turn, and the merge is retried on the new `autopilot.merge_transient_backoff_s`
  ladder (default 1, 2, 5 and 10 minutes), re-reading the PR before each retry (a re-read that
  fails the same way is transient too). Only a refusal
  that outlasts the ladder opens `merge_refused` (with `transient_attempts` and `since`), which the
  new `merge_refused/transient` policy row answers `retry` once per task
  (`autopilot.merge_transient_retry_max`, default 1). (#445)

### Docs

- **volley-issues: planning a batch for the overlap planner.** SKILL.md's new "Planning a batch:
  footprints and overlap" section says the Files list is the task's footprint and how to write
  one (exact paths, one per bullet, `(new)`, identifiers in parentheses, `changes/` last), to run
  `--plan-only` before filing or submitting, when to file one bundled issue (`T0a`, `T0b`)
  instead of several, how to read and override the plan lines, and to declare a chain with
  `Depends on:`. `templates/issue-plan.md` is the brief for an agent writing a batch's issues;
  `validate-skill.ts` checks both. (#390)
- docs: the owner's guide (`docs/AUTOPILOT.md`) has an "Overlap-aware waves" section (the plan
  lines, a hold and a train in the Desk and the digest, `churn_exhausted`, the two overrides);
  volleyd's README Contents and Autopilot table list the overlap plan, the merge train, churn
  accounting and the replay, which now cross-reference each other. (#390)

## 0.8.0 — 2026-10-23

### Added

- **volleyd: repositories by `owner/name`.** The config gains `repos.<owner/name>.machines`
  (`all` or a list of machines), `fleet.repo_root` (default `~/.volley/repos`, managed clones at
  `<repo_root>/<owner>/<name>`) and `hosts.<name>.repos` (adopted clones). A task's host resolves
  its clone of the wave's repository from them, with worktrees under
  `~/.volley/worktrees/<owner>/<name>`; a host with no clone fails the spawn naming
  `volley repo add`. A wave file's `repo:` may be an `owner/name`, resolved at submit to the
  supervisor's clone; a relative path of that shape now reads as a slug, so write it `./owner/name`. The deprecated `hosts.<name>.repo` still works and migrates itself, once,
  when the machine's record reports its clone's origin. (#433)
- **volley-cli: a paired machine works on many repositories.** `peer.json` gains `repos`
  (`owner/name` → clone), edited by `volley peer doctor --repo-add <owner/name>[=<path>]` and
  `--repo-remove <owner/name>` and read by every flag-less run (the service, `volley deploy`);
  `volley peer join --repo` takes `<owner/name>[=<path>]` (`~` expands in `<path>`), repeatable, and a legacy `repo`
  migrates into `repos` on the next doctor run. The doctor runs `repo.clone`, `repo.origin` and
  `repo.fetch` per repository (each check carries `repo`), and `--fix --clone` clones each
  missing one from `https://github.com/<owner>/<name>.git` with no `--origin`. (#435)
- **volley-cli: the doctor follows renamed repositories and keeps managed clones current.** A
  remote naming a renamed or transferred repository passes when GitHub reports one
  `nameWithOwner` for both and warns `repo.canonical`, which `--fix` repoints and journals in the
  report's `fixes`; when the remote already has GitHub's name and `peer.json` holds the old one,
  the warn says to update `peer.json` instead. Any other mismatch still blocks, untouched. `--fix` fetches every repository
  and fast-forwards (`--ff-only`) a managed clone's clean, checked-out default branch; adopted
  clones are fetched only. (#435)
- **volley-cli: per-repository toolchains.** The doctor derives each repository's tools from its
  manifests (`package.json`, `pom.xml`, `build.gradle*`, `go.mod`, `Cargo.toml`, `pyproject.toml`,
  `requirements.txt`, `Dockerfile`) plus an optional `.volley/requirements.yaml` (`tools`, `min`),
  probes only those, and fails `tool.<name>` for that repository alone when one is missing or too
  old. (#435)
- **volleyd: the machine record carries `repos[]`** (`slug`, `path`, `exists`, `origin`,
  `managed`, `fetched_at`, `toolchain`) and each check's `repo`; `RemoteHost.runDoctor` takes
  `repos_add` / `repos_remove`, which the fence allows as `--repo-add <owner/name>[=<abs path>]`,
  `--repo-remove <owner/name>` and `--clone`. `repo` stays while exactly one repository is
  configured. (#435)
- **volleyd: repositories are added to machines, cloned and trusted for you.** New admin ops
  `repo_add { slug, machines?, paths? }`, `repo_remove { slug, machines? }`, `repo_list` and
  `repo_status { slug? }` (SPEC §4.6.21). `repo_add` checks the slug with `gh repo view` (keeping
  GitHub's canonical name), assigns it in config (`repos.<slug>.machines`, `hosts.<m>.repos` for an
  adopted path), then on each paired machine runs the doctor with `--repo-add` (and `--fix
  --clone` while it has no clone) and, once the clone exists, trusts it in the machine's default
  Claude profile and every signed-in one: adding a repository is the consent, so its agents never
  stop on `repo_untrusted`. A machine that is down or failing stays `blocked` with the reason and
  is retried on its next `up`, on a newer doctor report from it, after another doctor run there
  ends and after Repair; a profile signed in later is trusted for every
  repository on its machine. `repo_remove` never deletes a clone (the answer names each path).
  Journaled in `_system` as `repo_added`, `repo_removed`, `repo_clone_run` and `repo_trusted`.
  `peer_doctor` takes `repos_add` / `repos_remove`. (#437)
- **volleyd: `remote_repo_missing`'s `add` answer adds the repository to that machine** (as
  `repo_add` does) before the task is retried. (#437)
- **volleyd: readiness judges every repository assigned to a machine**, beside the running waves',
  and shows a `repo_add` in progress there as `cloning` and a failed one as `blocked` with its
  why. (#437)
- **volley-cli: `volley repo add <owner/name> [--machine <m>]... [--path <m>=<abs>]... [--wait]`,
  `volley repo list [--json]`, `volley repo remove <owner/name> [--machine <m>]...` and
  `volley repo status [<owner/name>] [--json]`.** `--wait` follows every machine until it is
  `ready` (exit 0) or `blocked` (exit 1). (#437)
- **volley-desk: Settings › Repositories.** A new section lists every repository config names,
  linking each to GitHub, with a chip per machine it is assigned to saying where it stands there
  (`ready`, `cloning…`, `blocked: <why>` with **Repair** inline, `no clone yet`) and the toolchain
  the machines lack. **Add repository…** checks the `owner/name` as it is typed, adds it to every
  machine by default (or the ones you tick, adopting an existing clone per machine), sends
  `repo_add` and follows each machine until it is ready or blocked. **Remove…** names the clone
  paths it leaves on disk (a clone is never deleted) before it sends `repo_remove`. Every action
  shows its `volley repo` twin. (#438)
- **volley-desk: machine cards and Repair per repository.** A machine card lists its repositories
  read-only with a link to the section; Repair has a row per repository (a **Clone <owner/name>**
  switch for one without a clone, sent as `peer_doctor`'s `repos_add`, and the tools it lacks), and
  a per-repository check's fix names its repository and clone. A check the Desk does not know is
  left to Repair's plan instead of telling you to run `volley peer doctor` by hand. (#438)

### Changed

- **volleyd: readiness and placement are per (machine, repository).** A machine's verdict gains
  `repos`: each repository by `owner/name` (every running wave's, and every one the machine
  reports) as `ready`, `blocked` or `absent` with its reasons. A tool a repository needs that the
  machine lacks blocks that repository only (`java not installed (needed by owner/name)`), never
  the machine, and the machine-level "repo origin differs from the host's" line is gone.
  Placement skips a machine without a ready clone of the wave's repository (`no ready clone of
  owner/name (absent: …)`, also in `volleyd run`'s preview and `why_waiting`), so two waves on two
  repositories each go where their clone is. The supervisor's own doctor runs once per running
  wave's clone, folded into one record with `repos[]`; a clone whose run fails keeps its last
  entry rather than reading as absent. (#436)
- **volleyd: a remote spawn uses the repository's own clone and worktree root.** volleyd learns a
  box's home from the managed clones its record reports, so `~/.volley/repos/<owner>/<name>` and
  `~/.volley/worktrees/<owner>/<name>` work without absolute paths. A missing clone asks `Needs
  you: <machine> has no clone of <owner/name>. Add it to <machine> (Settings → Repositories, or
  volley repo add <owner/name> --machine <machine>)?` with `add` / `retry` / `cancel` (`add`
  answers like `retry` for now). (#436)

### Fixed

- **volley-desk: a task waiting on CI after its agent finished says so.** The graph node, the rail
  segment and the task row now say what is happening now, not the pipeline stage: a running agent
  (`implementing`, `reviewing`, `fixing`), else `waiting for CI · 21/22 jobs`, else a merge turn,
  else `waiting for a decision` (the graph node shortens these two to `merge turn` and `decision`).
  All four of volleyd's CI-hold wordings count, so an unreadable CI poll no longer flips the node
  back to `implementing` or reads a quiet held agent as stalled, and a held task with no agent
  shows a `CI` stub on the wave window's tether side. (#451)
- **volleyd: a plan version that moves a queued task's host lets placement place it.** A task
  admitted but not yet spawned whose host a new version changes (`placement: local` → `auto`,
  `auto` → a named host, a named host → `auto`) gives its admission back: volleyd journals the new
  `task_admission_returned { task, from_host, to_host }` event, drops its placement, and the next
  tick admits and places it, instead of failing every launch with `host 'auto' reached the host
  resolver`. A spawn that still meets an unplaced `auto` host raises the `host_auto_unresolved`
  alarm and gives its admission back, so the task waits for placement and shows placement's own
  reason. (#434)
- **volleyd: a repository assigned only to paired machines no longer runs on the supervisor's.**
  The supervisor's own checkout of a running wave's repository that config assigns elsewhere is
  `blocked` there (`<owner/name> is not assigned to <machine>: add it …`), so placement keeps the
  wave on the machines it was added to. (#439)
- **volley-cli: `volley deploy` no longer calls a paired machine ineligible over one repository.**
  A repository's own failing check (a tool it needs) follows the machine's health line instead,
  as volleyd's readiness judges it. (#439)

### Docs

- **docs: repositories end to end.** `docs/SMOKE-v0.8.md` is the owner smoke for a real paired
  machine: two repositories added from the Desk, one wave each, a missing tool, `volley deploy`
  and a removal. The volleyd, volley-cli and Desk READMEs describe a host's clones by
  `repos` / `hosts.<name>.repos`, with the legacy `hosts.<name>.repo` marked deprecated (it
  migrates by itself), and `packages/volleyd/test/fleet-repos.test.ts` runs the same scenarios on
  a supervisor and one fake paired machine. (#439)
- **docs: v0.8.0 is the compute pool — add a repository once, every machine can run it.** Add an
  `owner/name` from Settings › Repositories or `volley repo add`, and volleyd clones and trusts it
  on every paired machine it is assigned to; each wave is then placed on a machine with a ready
  clone of its repository. `docs/SMOKE-v0.8.md` is this release's owner smoke on a real paired
  machine. (#440)

## 0.7.0 — 2026-10-23

### Added

- **volleyd, Desk: a CI hold counts jobs and says how long is left.** `ci_pending` carries
  `jobs: { done, total, running, failed }` and `eta_s` (the slowest unfinished job's last
  duration in an earlier completed run of the wave, minus its elapsed time), and `why_waiting`
  reads `CI 3/13 · running: Backend IT shard 2–6/6 · ~8 min left` instead of `(n/m checks)`
  counted in workflow runs. The Desk shows the same line and adds `possibly stuck: no job
  finished for <n> min (the slowest usually takes <m>)` when no job finished for longer than the
  slowest job's last duration. (#415)
- **volleyd: volleyd owns a wave's issue lifecycle.** A PR into the release branch closes nothing
  on GitHub, so the issues of a finished wave used to stay open with nothing on them until the
  release reached main. Now, when a task merges into the release branch, volleyd labels its issue
  `merged-to-release` (creating the label if it is missing) and comments once. The digest gains
  `closes`, and every release stage's brief carries the release PR body's `Closes #N` lines.
  Once the release branch's PR has merged, volleyd closes every done task's issue that is still
  open, with a comment naming the release PR, and removes the label. Cancelled and deferred
  tasks' issues stay open with one comment saying why; tasks sharing an issue give it one outcome,
  and an issue gh cannot read holds back none of the others (it is retried after a minute, then
  every 5 minutes). `volleyd issues <wave>` lists each
  task's issue state; `--verify [--pr <n>]` runs the release check for a release merged by hand,
  on a complete wave only (once verified, it answers from the journal; a `--pr` that is not a
  merged PR from the release branch is refused). Each comment carries a
  marker, so a restart never repeats one. A wave finished before the upgrade and not yet
  archived gets the same treatment when the upgraded volleyd starts. (#416)

### Changed

- **ci: a PR's checks come back in about 5 minutes instead of 20.** volleyd's suite runs in four
  shards balanced by measured per-file time (`packages/volleyd/test/timings.json`,
  `scripts/test-shards.ts`, `bun run test:shard <i>/<n>`), under both bun's runner and vitest. A PR
  runs the newest bun and the 8-task soak. A full run (pushes to `main` and `release/**`, a nightly,
  release PRs, and PRs labelled `ci:full`) also runs bun 1.3 and the 32-task soak. Running only
  the tests of the packages a PR touches is left for a follow-up. (#398)
- **volleyd tests: a test daemon starts in milliseconds, not a second.** The test broker holds the
  `done` status a cleanly stopped volleyd leaves, so the startup "already running?" probe no longer
  waits out its whole `probe_ms` in every daemon test; one test still starts on a broker volleyd
  has never used. (#398)
- **volley-desk: opening a window keeps the zoom and pans to it.** A window opened from the
  dock, a top-bar count or a hidden wave shown again is placed in free space in its region,
  moves no other window, and the view pans at the current zoom so its top edge sits near the
  top of the screen. Closing a window moves nothing. Auto-arrange now runs only on first load
  and after a browser resize; Arrange & fit still arranges on demand. (#404)

### Fixed

- **volley-hooks: sessions sharing a repo directory keep their own coordinator identity.** Each
  session's hooks keep their state under the session (the hook input's `session_id`, else the
  cmux surface) instead of the directory, and speak for the registry entry recorded from their own
  cmux surface (volley-mcp now records `pid` and `surface` on its registry entry), so a second
  session in the same repo no longer takes over the first one's entry, activity or steering. A
  remembered `workspace` is republished only from the session's own environment, so a handoff
  answer reaches the session that asked. (#392)
- **volleyd: a handoff answer goes to the workspace its question came from** when the session's
  registry entry names another session's screen; when it cannot, the refusal names that workspace
  and the Desk's Needs-you row offers **Send to mailbox** instead of a dead Send. (#392)
- **volley-hooks: coordinator hooks are silent on a machine with no coordinator login.** With no
  `VOLLEY_AUTH_*` and no `coordinator.json`, a refused anonymous connect is `NOT_CONFIGURED`: every
  hook exits 0 with nothing printed, instead of an `AUTH_FAILED` line per hook in every session.
  Credentials that exist but are refused stay loud. `install.sh` refuses a user-level install
  without a coordinator identity unless `--force`. (#407) (#392)
- **volley-desk: Arrange & fit uses the whole screen, in regions.** Waves with their agents,
  then the side windows (unassigned agents, Sessions, Wave coordinators, Machines) right next
  to them, then Needs you. Each wave picks its own agent column count, Needs you is never
  taller than the screen (its list scrolls inside), and of layouts at the same zoom the one
  that fills most of the screen wins, so windows no longer end up in one tall strip. (#397)
- **volley-desk: an agent of a `placement: local` wave shows its machine chip again.** A wave
  task with no paired host and no placement runs on the supervisor's own machine, so its agent
  window reads `this machine`, the same as an auto-placed local agent. (#399)
- **volleyd: a signed-in Claude account profile is ready to run agents unattended.** Signing an
  account in, on this machine or a paired one, and every spawn under it now write what the
  default login has (`hasCompletedOnboarding`, `lastOnboardingVersion`, a `theme` in
  `.claude.json`; `skipDangerousModePermissionPrompt` in `settings.json`), so agents no longer
  stall on Claude Code's theme picker, security notice or bypass-permissions confirmation. A
  local profile is written only while no agent session runs in it, and a `settings.json` that
  is not a JSON object is refused with a message instead of being replaced. An agent that still lands
  on one of those screens has its session closed, its profile prepared (`profile_repaired`) and
  is relaunched once; a second time opens `unknown_screen` naming the screen in plain words
  (`… is stuck on Claude Code's first-run setup (theme picker) for account <acct> on
  <machine>`). (#400)
- **volley-cli: `volley peer doctor` checks the account profiles (`claude.profiles`).** It names
  each signed-in profile missing those keys, and `--fix` writes them, skipping a profile an
  agent session runs in until it exits. (#400)
- **volleyd: a decision's answer reaches a paired machine's agent.** The remote fence now lets
  volleyd write `.volley/decisions.md` (and a retired agent's `.volley/retired.json`) on a paired
  machine; before, resolving a remote task's decision logged `FENCE_DENIED: remote file write`
  and the agent never saw the answer. A new test fails the build when the supervisor reads or
  writes a `.volley/` file, or types a constant, that the remote fence does not know. (#401)
- **volleyd: waking an idle agent on a paired machine types the wake line.** `exec` now passes
  the wake token to the fence, so the wake is no longer refused as `text volleyd never types`.
  (#406) (#401)
- **volleyd: a fence denial on a paired machine is reported as itself.** It is no longer
  reported as `ssh … failed: no result` and retried: the spawn fails once with the denied step
  (`FENCE_DENIED: remote cat … (read <path> on <target>)`) and opens a decision without
  retrying. (#406) (#401)
- **volleyd: a relaunch decision closes itself once its agent is alive, and offers a harmless
  third answer.** `unknown_screen`, `hooks_auth_failed` and `mcp_not_registered` close on their
  own (`by: volleyd`, `started on its own`) as soon as the agent they are about registers,
  publishes progress or a narration (waiting at a prompt or idle does not count), or reports
  `working`; nothing is relaunched or stopped. `unknown_screen` counts only a sign the session
  got past its screen (its hooks, or its MCP server doing work), not the MCP server's start-up
  heartbeat or registration; `hooks_auth_failed` closes only once its hooks reach the broker,
  and the paused agent is then told to resume. Until then they offer `it's running` beside
  `relaunch` / `cancel`, which (typed with a straight or curly apostrophe) checks the agent is
  live and closes the card (retiring the agent if a newer run already replaced it), or keeps it
  open saying no live agent was found.
  Decisions carry `option_help`, hover text for their options, which the Desk shows on the
  button. (#402)
- **volleyd, desk: the Terminal popout resizes the agent's terminal.** A paired machine's agent
  now starts in a 220×50 tmux session (`tmux_cols`, `tmux_rows`), not tmux's detached 80×24, and
  while its Terminal popout is open the Desk sends volleyd the popout's size in cells (debounced,
  the new `terminal_resize` control op), which runs `tmux resize-window` on that machine, so
  Claude Code wraps at the popout's width. Closing the popout returns the terminal to its launch
  size. While it sizes the terminal the popout keeps the width it opened at (or was dragged to)
  rather than following the screen. A local (cmux) agent's terminal is not resized. (#403)
- **volley-cli: `volley deploy <tag>` takes every paired machine to the tag.** After the
  supervisor's health check passes, each paired machine (from volleyd's `peers.json` and
  `hosts.<name>`) is upgraded over its ssh: fetch, check the tag out, `bun install
  --frozen-lockfile` with the lock recorded for its doctor, restart `volley peer run`, and a fresh
  doctor run, with one health line each (`box-a: v0.6.4 ✓ eligible`). A machine that fails rolls
  back alone to its previous ref and is named with the step and why; the deploy exits 1.
  `--skip-peers` and `--only <machine>` choose the machines; `--dry-run` prints each one's plan. (#405)
- **volley-cli: a restarted `volley peer run` publishes a fresh doctor verdict.** It runs the
  doctor at start and its first heartbeat waits for that run, so readiness never shows the
  install verdict from before an upgrade. (#405)
- **volleyd: autopilot merges a draft PR instead of escalating `merge_refused`.** A draft is
  marked ready (`gh pr ready`, journaled `pr_marked_ready { pr, head, at }`) before the CI gate,
  and the gate counts only the runs created after the mark (allowing for a little clock skew),
  so the jobs a repository skips on drafts actually run; a head with no run yet inside the
  mark's grace is held, not merged. A merge refused because the PR is a draft (`reason: draft`)
  marks it ready, holds the gated head for that CI and merges once it is green; the first such
  refusal never uses up `merge_retry_max`, and autopilot's `merge_refused/draft` row answers
  `retry`. When `gh pr ready` keeps failing, further draft refusals count, and the owner is asked
  (`ready_failed`, which that row does not answer). (#408)
- **volleyd: a dropped terminal status is recovered, not just alarmed.** A `done` or `failed`
  still unhandled `terminal_recover_ms` (60 s) after its `terminal_status_unjournaled` alarm is
  re-read from the agent's retained status and handed to the pipeline again, journaling
  `terminal_status_recovered`; when that fails too, decision `terminal_status_lost` names the
  agent and offers `accept done` / `relaunch` (asked again when `accept done` fails too, and at
  once when a `failed`'s handoff throws after its agent was retired). A throw in the status
  handoff (a remote verification step the fence denied, a timeout) is journaled as `pipeline_error { check:
  "status" }` instead of being dropped, so a task no longer sits with no live agent and its
  dependents queued until volleyd restarts. (#414)
- **volleyd: one `repo_untrusted` question per machine, account and repo, not one per task.** A
  wave's launches into an untrusted folder used to open one identical decision each (12 tasks, 12
  cards). The decision is now keyed by (machine, Claude profile, repo root): the first launch opens
  it and every later one, even one racing it in the same tick, joins it (`decision_joined`), parks
  and is listed in its new `waiting` field. The question names the machine (not its ssh target)
  and the account once, and how many tasks wait (`… 12 tasks are waiting: i392, i416, …`). One
  `trust` answer resumes them all. `cancel` now cancels only the waiting launches
  (`spawn_failed` `LAUNCH_CANCELLED`, no retry): the tasks keep their other work, and the launches
  start once the repo is trusted. (#418)

## 0.6.3 — 2026-10-22

### Fixed

- **volleyd: the pipeline also starts when the implementer launches on a later attempt.** 0.6.2 moved such a task's stage to `implement`, but its pipeline (step, roles) still waited for the `stage_entered` that only attempt 1 journals, so CI was never re-polled and review never started. The pipeline now starts at the implement step when its implementer launches, on replay too. (#409)

## 0.6.2 — 2026-10-22

### Fixed

- **volleyd: a task whose first implementer launches failed now starts.** `stage_entered { implement }` was journaled only on attempt 1, so a task whose implementer launched on a later attempt stayed `queued`: its CI was never polled again and review and merge never started. The reducer now moves a queued task to `implement` when its implementer launches, which also recovers a stuck wave on restart. (#409)

## 0.6.1 — 2026-10-22

### Fixed

- **volleyd: a paired machine starts agents again.** Since 0.6.0 the spawn's MCP approval check reads the worktree's `.mcp.json`; the remote fence denied that `cat`, so every launch on a paired machine failed as an ssh error (`no result`). The fence now allows reading an absolute `<dir>/.mcp.json` with no `..` segment. (#393)

## 0.6.0 — 2026-10-22

### Added

- **volleyd, volley-cli: every machine reports which Claude account its logins belong to.** A
  login's `email` and `org` — exactly `oauthAccount.emailAddress` and
  `oauthAccount.organizationName` from the profile's `.claude.json`, nothing else of it — are
  stored in the registry at sign-in and carried on `claude_signin_done`, each `claude_accounts`
  row, `primary`, the new `machines` list, the retained usage record
  (`volley/_system/claude-accounts/<acct>`, `primary@<name>` from the machine record) and the
  machine record (`auth.claude_email` / `auth.claude_org`, from `volley peer doctor`, only while
  signed in). They are identity, never credentials, and never journaled; the schemas and SPEC
  §4.6.11, §4.6.12 and §4.6.15 say so. (#281)
- **volley-desk: Settings › Claude accounts & usage shows one card per Anthropic account.** Logins
  on every machine that share an e-mail (a peer's default login through its machine record's
  `auth.claude_email`) are one card: the e-mail masked (`o•••@example.com`) until its eye button
  shows it (never stored), the organisation, the meters from the freshest reading with any older
  reading that disagrees named stale with its age, and one row per machine holding the account
  (signed in or not, the profile there, its waves). A login whose e-mail is not reported yet keeps
  its own card; pickers and "Move a wave here…" still answer with account ids. (#282)
- **volleyd: `volley claude add <label> --machine <peer>` creates a Claude profile on a paired
  machine and signs it in there.** The profile is `~/.volley/claude/<acct>` on that machine, the
  account `<acct>@<peer>`: Claude Code's own `claude auth login` runs there in the tmux session
  `volley-signin-<acct>`, with the browser callback forwarded to the supervisor's machine, as a
  paired machine's own sign-in does. `claude_signin_done` carries the plan, e-mail and org, which
  the registry records; `claude_accounts` shows the row pending, then signed in. `volley claude
  signin <acct>@<peer>` refuses a profile already signed in there and names the
  `ssh <target> CLAUDE_CONFIG_DIR=… claude auth logout` to run first. The fence lets
  `claude auth status` carry exactly `CLAUDE_CONFIG_DIR=<home>/.volley/claude/<acct>` and nothing
  else. Such a profile is signed in and shown, not yet used by placement. (#283)
- **volley-desk: Add Claude account signs a profile in on any paired machine.** The dialog's first
  step picks the machine (this machine, or a paired host whose tunnel is up); on a peer it shows the
  same **Open sign-in ↗** and phone steps as Settings › Machines, never a code field, and the
  "run `volley claude add` there" hint is gone. Each account card has **Add to another machine…**,
  which opens the dialog with the label filled in as `<label> (<machine>)` (volleyd names a profile
  once across machines; this machine goes by its host name), following the machine you pick until
  you type your own, and the machines already holding the account greyed out. A paired host that
  has reported nothing yet is offered with "no record yet". (#284)
- **volley-desk: each account card shows every configured machine, and signs the account in on the
  ones missing it.** One row per machine (this machine, then each paired host): a filled dot and the
  profile where it holds the account, a hollow dot and **Sign in on <machine>** where it does not
  (disabled with "tunnel down" while the tunnel is down), with an `on 2 of 3 machines` chip, amber
  while one is missing. The button opens the Add dialog already at the sign-in step, titled with the
  masked account (`Sign in with o•••@example.com on peer-a`); a sign-in that finishes on another
  e-mail says `signed in as another account (p•••@example.com)` instead of filling the row. The new
  profile is named `<label> (<machine>)`, keeping one machine suffix (`Work (peer-a)` signs in on
  peer-b as `Work (peer-b)`). Each
  card in Settings › Machines gains a **Claude accounts** block with the same dots and button. (#297)
- **volley-cli: `volley claude list` prints `not on: peer-b`** under an account that a configured
  machine does not hold, and nothing when every machine does. (#297)
- **volley-desk + volley-cli: three usage meters per Claude account, Fable's weekly window
  included, each with the reading's age.** An account card in Settings › Claude accounts shows
  5-hour, 7-day and Fable (7-day) side by side. The Fable figure is the one the machine's usage
  probe last read, labelled `read 4 min ago on peer-a`. While the probe's last attempt failed, it
  reads `—` and says why (login expired, no credential, rate limited, probe failed), with when it
  last read. Every machine row on the card, and each held account on a Settings › Machines card
  (where it replaces the single 5-hour meter), shows the three figures compactly
  (`5h 37% · 7d 56% · Fable 12%`), plus `sampled 3 h ago` when that machine's own reading is
  older. `volley claude list` prints the same three windows on one line, for example
  `Fable 12% (resets in 4d 2h, read 4 min ago)` or `Fable — (login expired, last read 25 min ago)`,
  with the freshest machine on the line below it. A window whose reset has passed counts as 0%. (#298)
- **volley-desk: each agent's Claude account, why it was chosen, and autopilot's moves.** The
  agent window's account picker lists only the accounts of the agent's own machine, labelled
  `Work · 12% · peer-a`, with a tooltip saying why it runs there (the task role's latest
  `account_chosen`, or `moved off primary by autopilot: <why>` / `moved by <person>`); its
  Volley feed shows `Account ·` rows for those events; and an open `agent_account_limit` is a
  banner on the agent (what autopilot will do, or `Move to work (5h 12%, 7d 40%)` / Not now). Settings › Claude accounts
  renders the agent-level decision beside the wave-level one (`move to work (5h 12%, 7d 40%)`,
  `not now`) and, from `claude_balance`, says on each card which model families pick it next
  (`picks next: Fable, others`) and marks the machine rows that would (`next pick`). (#300)
- **volley-cli: `volley claude balance` shows what the next spawn would pick.** Per machine, the
  signed-in accounts ranked by headroom with their 5-hour, 7-day and Fable figures and agents,
  and an arrow on each model family's pick (`--model <m>` for one model, `--machine <name>` for
  one machine, `--json` for volleyd's answer; e-mails masked unless `--show-email`).
  An account with no reading yet shows `no usage yet` and still its agent count.
  `volley claude list` marks `next pick` on those logins (asking volleyd for at most 3 s). (#300)
- **volley-cli + volleyd: each machine reads its own Claude logins' usage, Fable's weekly window
  included.** `volley peer doctor` probes every Claude Code login on the machine (the default
  profile and each profile under `~/.volley/claude`). It reads the login's own stored token in
  memory, for one read-only request to Claude's usage endpoint, and reports only the 5-hour,
  7-day and per-model weekly windows in the machine record's `claude_logins` and in one
  `Claude usage:` line per login. The token is never refreshed, written, logged or sent, and
  never crosses ssh or the broker. An expired token is skipped, and the probe makes at most one
  request per login per 5 minutes, backing off after 429 or 5xx. volleyd folds the readings into
  the retained account records (`primary@<name>` / `<id>@<name>` for a paired machine's logins)
  as `model_weekly` and `probe`. A reading and a statusLine sample race for the 5-hour and
  weekly windows, and the freshest wins. SPEC §4.6.11 now allows this one read, and says why.
  (#306)
- **volleyd: a wave without `placement:` uses a paired machine.** The new tunable
  `placement.default` (`local` | `auto`, default `auto`) decides a wave file that sets no
  `placement:`: `auto` once a `hosts.<name>` is configured, `local` while none is; an explicit
  `placement:` is unchanged, and a later plan version of a running wave keeps the placement the
  wave already has, whatever its own `config: placement.default` says (its `run` prints no placement preview then). `volleyd validate` and `run` print the outcome
  (`placement: auto (placement.default; 1 paired machine)`, `placement: local (no paired machine)`). (#324)
- **volleyd: a paired machine's `max_agents` is derived from its size.** `volley peer join` sends
  the machine's total memory (when it can read it), and the join writes `hosts.<name>.max_agents =
  clamp(min(floor(cores / 3), floor(memory_total_mb / 4096)), 2, 16)` (a 32-core / 60 GB box: 10);
  unset, readiness derives it the same way from the machine record, and 4 applies only when the
  size is unknown. An explicit value always wins. `volley peer doctor` shows it on a new
  `machine.size` row (`max_agents 10 (derived from 32 cores, 60 GB)`). (#324)
- **volleyd: a local wave on an overloaded supervisor says what it leaves unused.** When the
  supervisor's load per core is over `placement.load_per_core_max` (the wave's own, when its
  `config:` sets one) while a ready, undrained peer
  has free slots, a running `placement: local` wave raises `alarm_raised { alarm:
  "peer_idle_under_load" }` once, and clears it (`alarm_cleared`) when the load has passed; while it
  holds, the wave state's new `alarms`, `volleyd status` and the digest show it. (#324)
- volley-issues: `wave-from-issues.ts --placement local|auto` pins a wave's placement. (#324)
- **volley-desk: demo mode shows autopilot, the Needs-you inbox, the digest and live machines.**
  `?demo=1` now loads the autopilot waves (chip, feed, merge queue, release train), the Needs-you
  inbox with its Dock tile, an ended wave with its morning digest card and, after 40 s, a running
  wave's morning digest. The Machines window's load and memory sparklines move: the machines beat
  every 5 s with a load walk, and box-a swells into its overload band and back. (#326)
- **volley-desk: sign out and switch account from Settings and the Dock.** Settings' account
  card and the Dock's new account menu (the avatar) offer **Sign out**, which forgets the stored
  login and its role and shows the sign-in form, and **Switch account…**, which redeems a
  sign-in link or one-time token over the running Desk and reconnects as the new account
  without a reload. Every read-only notice (Machines, Broker accounts, Supervisor, the
  Autopilot policy table) links to **Switch to an admin account**, and Setup & Security's
  admin-token sign-in uses the same entry. A Desk signed in by `VITE_VOLLEY_BROKER_*` says so and
  offers neither. (#328)
- **volleyd: `agent_mcp_allow` starts only the MCP servers a repository names under
  `agent_mcp: inherit`.** `inherit` alone starts every server in the owner's profile in every agent
  (one process each). A non-empty list (global or in a wave's `config:`) copies just those entries
  from the profile's `.claude.json` and the repository's `.mcp.json` (a paired machine's own) into
  the agent's `.volley/mcp.json` beside `volley` and launches it strict; a `.mcp.json` entry only
  when the profile approved it for the repository (`enabledMcpjsonServers` /
  `enableAllProjectMcpServers` in its `.claude.json`), since the file comes from the branch checked out. A name found nowhere is
  skipped and journaled once per wave and machine (`agent_mcp_allow_missing`, saying when the name is in `.mcp.json`
  but not approved); so is an entry of a shape volleyd does not copy (a string `command` with
  string `args` and `env`, or a string `url` with string `headers`), the same on every machine,
  and a broader scope's entry of that name is not used in its place.
  Only names are ever logged, and the agent's `mcp.json` is written owner-only (0600, on a paired
  machine too: a file volleyd writes there is replaced, never left at an older file's mode), since
  the copied entries can hold the user's tokens.
  `volleyd validate` prints `agent_mcp: inherit (allow: …)`, and the Desk's settings edit the list.
  (#331)
- **volleyd, volley-desk: held decisions: "waiting on <task|PR|issue>", never escalated,
  released when the blocker lands.** `volleyd hold <decision-id> --on <task|#pr|issue#n>`,
  `volleyd inbox hold`, and the Desk's **Hold · waiting on…** picker on a Needs-you row journal
  `decision_held`; a hold on a task that waits on the held decision's own task (through
  `after:` or a hold of its own) is refused, as it would never release; the decision and its inbox item carry `held`, and the Desk shows the item
  amber (`Held · waiting on T4 (#194) · 3 h`), never red, never pulsing. volleyd releases the
  hold (`decision_released`) when the task is done or cancelled, the PR merged or closed, or the
  issue closed (a PR or issue read once per CI poll interval), and autopilot's rule runs again,
  a red head's once its PR head is read again (green now: answered `re-verify`); `volleyd
  release` lifts one by hand. Autopilot holds a red head on its flake's fixer task itself, and
  lifts that hold when the fixer fails so the escalation reaches the owner (a hold the owner set
  on another blocker stands); `volleyd decisions` prints `held on …` and the digest lists held
  decisions under their own heading (the Desk's digest card too, its headline counting them
  like volleyd's summary line). A wave whose only open decisions are held shows `running`, not
  `awaiting_decision`. (#335)

### Changed

- **volley-cli: `volley claude list` shows one block per Anthropic account.** Logins are grouped
  by e-mail the way the Desk's account cards are: the heading names the account (its profile
  label, or `default login`; plan, org, e-mail masked as `o•••@example.com` unless `--show-email`), one line per machine holding
  it with its sign-in state and waves, and per usage window the freshest reading from the retained
  usage records, with where it came from and its age; a machine's older reading that disagrees is
  marked `(stale)`. An account whose e-mail is not reported yet keeps a block of its own.
  `--json` prints the `claude_accounts` answer plus the records it read as `records`. The masking
  rules are exported as `volley-mcp/mask`. (#285)
- **volley-desk: Settings sections drill into groups, like macOS System Settings.** Supervisor,
  Autopilot, Sound and Claude accounts open on a list of group rows with live summaries; a row
  opens the group's page with a back control (Escape goes back too); search opens the matching
  group. (#286)
- **volleyd: spawns balance across the Claude accounts signed in on each machine.** With
  `claude.default_account: null` (the default; `most_headroom` means the same) every spawn
  picks the account with the most headroom on the machine it runs on, by the 5-hour, 7-day and
  the model family's weekly windows (`rankAccounts`); a one-login machine runs as before, and
  `primary`, a registry id or a task or wave `account:` still pins. A paired machine's agents
  can run under the profiles kept for it (their `CLAUDE_CONFIG_DIR` there, sealed by the fence
  for that host only). Each pick is journaled as `account_chosen` with a one-line `why`
  (`agent_spawned.account_why`), and `claude_balance` answers each machine's ranking. (#299)
- **volleyd: autopilot moves a running agent off a hot account at the warn level.** A new
  task-level `agent_account_limit` decision opens when an agent's account reaches
  `claude.warn_at_pct` in a window that counts for it, suggesting another login on its machine;
  autopilot answers `move <agent> to <acct>` under the new `autopilot.account_move_max` budget
  (default 2 per task role) or waits (`not now`); an agent whose task, wave or
  `claude.default_account` names an account gets none (the wave-level `account_limit` covers
  it). A balanced wave gets no `move wave` decision, and placement judges a machine by its best
  login (`usage 12% (work)`). (#299)

### Fixed

- **volley-desk: the Desk no longer lags on a phone.** On a touch screen (or under
  `prefers-reduced-transparency`) windows, the dock, the sheets and the sign-in card drop their
  backdrop blur for an opaque-ish fill of the same colours, Liquid glass renders as Frosted glass,
  the Needs-you pulse animates opacity, and a pan or pinch moves the canvas directly, with the view
  committed on release. Desktop keeps the glass. (#295)
- **volleyd: an unreadable `gh run list` is not "no CI".** A CI read that fails (a rate limit,
  HTTP 403 / 429, a 502, output that is not JSON) is CI state `unknown`: it opens no decision,
  never starts or advances the `ci_none_grace_ms` clock (unreadable time is not counted: the next
  readable `none` starts it over), and is re-polled; the task reads
  `CI unreadable (<error>), retrying`. A rate-limited answer backs the wave's CI calls off for
  `ci_rate_limit_backoff_ms` (new tunable, default 300000), journaling one
  `github_rate_limited` alarm that the next readable answer clears. A head's runs are now read with
  one `gh api …/actions/runs?head_sha=` call on the supervisor, which lists no workflows. A red head whose release
  branch's CI cannot be read is not classified (no CI fixup or flake request on it): it is
  re-verified and classified once the release branch reads again; a blocked agent on such a head
  gets the plain `agent_blocked` question. (#310)
- **volleyd: a merge GitHub refuses for a reason other than "behind" no longer updates the branch.**
  A `merge_refused` alarm now carries `reason` (`behind`, `head_moved`, `retargeted`, `closed`,
  `checks` or `unknown`; GitHub's "Base branch was modified" is `behind`). Only `behind`,
  `head_moved`, `retargeted` and `closed` give up the merge turn. A refusal for required checks, branch
  protection or an unknown reason keeps the turn and the task's place in the queue, and the merge
  is tried again up to `autopilot.merge_retry_max`. A branch update starts only when the turn's
  rebase check counts commits the head lacks. A failed `git fetch` or `git log` is now a failed
  check, not "behind by 1". (#311)
- **volleyd: a merge at the gated head is never `merged_unverified_head`.** A person who merges
  the PR at the head volleyd gated while a branch update or fixup is still running completes the
  task (`artifact_verified { role: "merged" }`, then `done`; the digest counts it as a GitHub merge). No alarm is raised,
  and the running update or fixup agent is retired as `superseded`. A merge whose head GitHub does
  not report still alarms. (#311)
- **volleyd: a conflicting PR is brought up to date instead of waiting for CI that never runs.**
  GitHub runs no CI on a PR that conflicts with the release branch, so volleyd used to wait out
  `ci_none_grace_ms` and ask "No CI run exists … accept | cancel". The PR read now carries
  `mergeable` and `mergeStateStatus`: a `CONFLICTING` PR journals `pr_conflicting` and enters the
  branch-update step at once (under the wave's `branch_update`, its brief saying the PR conflicts),
  and `UNKNOWN` is re-polled like running CI. If the update step's own head still conflicts, it is
  not updated again: after the grace the owner is asked, and the question says the PR still
  conflicts with the release branch. (#312)
- **ci, volley-issues: release PRs pass the changelog guards by construction.** The `untouched`
  guard accepts a `release:` / `chore(release):` subject in any case, so a release PR squashed
  under `Release: <date> — <theme>` passes; the CI workflow re-runs on `labeled` / `unlabeled`, so
  adding `no-changelog` reaches the fragment check without a new push; `bun scripts/changelog-ci.ts
  labels --ensure` creates the `no-changelog` label when the repository lacks it; and the skill's
  release steps title and squash both release PRs `release: …` and label the release-prep PR
  `no-changelog`, naming each PR on `gh pr merge` (the skill validator checks each command and
  rejects a bare `gh pr merge`). (#313)
- **volleyd: cleanup keeps unfinished tasks' worktrees, and the pipeline reads GitHub from the
  repo root.** `volleyd cleanup` removes only the worktrees of tasks that are done or cancelled
  (an unfinished one prints `skip <task>: <stage>`; `--all` includes it), so a `merge_ready`
  task's worktree survives until it merges. The pipeline's `gh pr` / `gh run` reads run from the
  wave's repo root with `--repo <owner/repo>`, and its git checks fall back to the repo root
  (fetching the PR head; a failed fetch says so) when the head's worktree is gone: a removed
  worktree no longer fails every merge check with `ENOENT` and wedges the task short of `done`.
  (#314)
- **volleyd: a `spawn_budget_exhausted` raise is sized for the wave, not one spawn.** The offered
  `raise by <n>` now covers the spawns the wave's unfinished tasks still need (each implement and
  review stage not yet spawned, plus one fixup allowance per task), at least a quarter of the
  derived budget, capped by `autopilot.budget_raise_max` while that cap leaves room for one; one
  raise, by the owner or autopilot, lets every held spawn through instead of opening a new
  decision per spawn. (#315)
- **volleyd: `resolve` and the inbox refuse an answer a decision cannot apply.** `raise 120` was
  accepted, journaled and ignored; it is now read as `raise by 120`, and an answer that is neither
  an option nor a form the kind accepts (`spawn_budget_exhausted`, `machine_down`,
  `repo_untrusted`) is refused with `BAD_ANSWER` (`volleyd resolve` / `volleyd inbox answer` exit
  3), saying what to write, and nothing is journaled. `volleyd resolve --help` lists the answers
  each kind takes. (#315)
- **volleyd: a resolved decision's `.volley/decisions.md` reaches a remote task's worktree.**
  `resolve` wrote it with local file calls at the remote worktree's path, so the agent on the
  paired machine never saw it (and on macOS it failed with ENOTSUP). It now goes through the
  task's host, over ssh for a paired machine; a failed write is journaled once per decision as
  `alarm_raised { alarm: "decisions_file_unwritten" }` and never fails the resolve. (#316)
- **volleyd: a steer reaches the task's live agent of any role, and wakes it when it is idle.**
  `volleyd steer` targets the task's newest agent that is not retired, whatever its role, so a
  live rebase agent is no longer answered `queued for the next agent of the task`; `--role`
  accepts `rebase` and `release` (task `_release` for the release train's stage agent). A queued
  steer also goes to an agent already up at its next hook signal, not only to a newly registered
  one. When an idle agent's hooks do not ack a mailbox steer (a steer, the liveness nudge, an
  answer, `nudge again`) within `mailbox_wake_after_ms` (new tunable, default 20 s), volleyd
  types `Check your Volley mailbox.` + Enter into its session under a new fence `WakeToken`, once
  per message (one wake drains every message sent before it), and journals `agent_woken` (with
  `enter_failed: true` when the line was typed but its Enter failed: the next wake then sends only
  the Enter, never a second line); a working agent or one with a picker open is never typed into,
  and the pause steer to an agent whose hooks the broker refused arms no wake.
  `volleyd status` shows `steer unacked (<agent>)` until the woken message is acked (also after a
  newer message or a daemon restart), and the CLI prints
  `delivered · woke the agent` / `delivered (acked by …)` / `queued (no live agent)`. (#317)
- **volleyd: a retained `blocked` always gets a decision, and an undecided block is a stall.** A
  `blocked` status already retained when supervision attaches (a fast agent, every agent after a
  restart) is handled like a live one, and the watchdog is armed for it. A `blocked` the pipeline
  cannot own (a `merge_ready` or `done` task, a stale or accepted run, a pipeline error) journals
  `alarm_raised { alarm: "blocked_unhandled", agent_id, why }` and opens a daemon-level
  `agent_blocked` (`respawn | cancel`, or `manual | cancel` without parking a settled task or
  a stale run's) instead of returning silently or logging an error; a per-tick sweep asks for one
  never decided, waiting while a red head is still being classified.
  The watchdog counts only a decision or a retire as handling a `blocked`, and a blocked agent no
  decision names (open, or answered for that status) for `blocked_undecided_stall_ms` (new tunable, default 300000) is
  `agent_stalled` (`respawn | stop task`); that stall names the status too, so a steer that leaves
  the agent blocked is not asked again every window. (#318)
- **volleyd: spawns admitted together no longer fail on a fetch race.** Every `git fetch` volleyd
  runs into a clone (both hosts' worktree prepare, a continued branch's check, the pipeline's
  artifact probes, the release train's stage check) now waits its turn on a per-machine, per-clone lock, so two tasks admitted on
  the same tick no longer race `refs/remotes/origin/<branch>` (`incorrect old value provided`) into
  `BASE_STALE`. A fetch that still loses a ref-lock race to another git process is retried once
  after 500 ms and the spawn goes on, journaling `alarm_raised { alarm: "fetch_retried" }`. A fetch
  that never reached origin (`Could not resolve host`, `Connection timed out`) is refused as
  `BASE_UNREACHABLE` and retried with the usual backoff, instead of a `BASE_STALE` that says the
  base is old. A fetch under the lock that names no timeout of its own is bounded by
  `git_fetch_timeout_ms` with credential prompts off, so a hung fetch cannot hold the lock and stall
  every later spawn into that clone. (#319)
- **volley-cli, volleyd: peer readiness no longer keeps a stale doctor result until the service
  restarts.** `volley peer run` re-runs the doctor on the next heartbeat when the volley
  checkout's `package.json`, `bun.lock` or install marker changes, or when `volley peer doctor`
  ran (it writes `~/.volley/peer-doctor-ran`), and re-reads the versions it reports; `volley peer
  doctor --fix` says it is waiting (up to about 2 minutes), then prints `readiness republished`
  once the service's record carries the new run, else how to restart the service (and says it
  could not check when the broker refuses it). A Repair (`peer_doctor`) folds its report into
  the box's retained machine record and readiness verdict at once, and while the box's
  heartbeats still carry its service's older run the supervisor republishes them with the newer
  one, so neither the Desk nor readiness goes back to the stale checks. A record the supervisor
  republishes no longer counts as the box's heartbeat, nor brings a down box back up. A doctor
  report's `doctor_at` is now when its run started, so a run that began before a fix never reads
  as one after it, and runs are compared as instants. A Repair on a box whose tunnel is down
  leaves its record as it is. (#320)
- **volley-cli: the doctor checks every `volley` MCP entry on the machine against this checkout.**
  The `mcp` row covers each Claude account profile under the Volley home and the wave repo's
  `.mcp.json` as well as `~/.claude.json` (`mcp: own` skips only the latter): an entry that runs
  another checkout is a blocking failure (`✗ mcp: account profile acct-b runs
  /path/to/old-checkout`), and `--fix` re-points it, keeping its other keys (a `.mcp.json` git
  tracks is reported, never rewritten in the clone). volleyd's Repair passes the box's `volley_dir`
  (`--supervisor-volley-dir`), and a checkout other than that one fails naming both. (#321)
- **volley-cli: `volley peer join` finds the supervisor's volley without `--remote-volley`.** It
  runs `volley peer redeem` as `volley` when that is on the supervisor's non-interactive ssh
  `PATH`, else as `~/.volley/bin/volley`, where `volley setup` installs it. (#321)
- **volleyd: the hard ceiling counts the agents volleyd runs, not admitted tasks.** It counted every
  admitted, unsettled task of every loaded wave, so tasks awaiting a decision, blocked tasks whose
  agents had retired and the tasks of paused, stopped or ended waves held slots (`9/9 live` with 4
  running starved a new wave). It now counts supervised agents, those launching or spawning
  (release stages too), and one slot per admitted task of a running wave that will spawn its
  next agent (queued for its implementer, or between pipeline roles with a role still to
  come). A task whose agent died unverified, or whose next role was refused for good, holds
  nothing. A reviewer or fixup spawn and a queued task's first agent (a retry, a resumed
  wave's backlog) start only while the agents running or starting leave room, so neither
  overshoots and held slots never deadlock.
  A release stage's spawn checks the same, so another wave's held slots never hold a release.
  `volleyd admission` prints `ceiling: 4/12 live agents · 2 launching · by wave: …`
  (`launching`: not supervised yet, held slots included; the `admission` op and retained
  payload carry `ceiling`), and `volleyd status` prints `hard ceiling: 4/12`. (#322)
- **volleyd: a running task keeps its host across plan versions.** Switching an in-flight wave to
  `placement: auto` no longer fails the checks of the tasks already running locally with
  `host 'auto' is not configured`: a task that has spawned, or was spawning when the new version
  arrived, keeps the host it runs on (the wave
  state's `tasks[].host_actual`, the plan's own as `host_planned`), only unstarted tasks are
  placed, and `volleyd run` prints `T3: host kept local (already running; new plan says auto)`. (#323)
- **volley-mcp, volleyd, volley-desk: a live but quiet coordinator no longer reads "No coordinator ·
  claim it".** The MCP server publishes a `progress` heartbeat every `VOLLEY_HEARTBEAT_S` (default
  300 s) while registered, so a session blocked on `volley wait` stays alive; volleyd re-publishes
  the wave state's `coordinator.last_seen` at least every `claim_after_s / 4` while it hears the
  coordinator; and the Desk finds a coordinator-name owner through its bound agent
  (`coordinator.agent_id`) and trusts volleyd's fresh `last_seen`. A heartbeat no longer counts as a
  progress report on the Desk, and it leaves a coordinator waiting on the owner in `awaiting_input`
  ("needs you") rather than flipping it back to working. (#325)
- **volley-desk: the wave header's autopilot chip never truncates mid-word, and a long task id
  fits its dependency-graph node.** The chip shows the full sentence, or `⚙ 4 · ↑ 1` in a compact
  window, with the full text as its title; the owner chip has a title too. A graph node elides an
  id longer than it fits as `head…tail` (a flake-fixer's `fix-<slug>`), with the full id in its
  tooltip; the `#issue` link moves to the second line, and a synthetic task draws its wrench
  instead of `#0`. (#327)
- **volleyd, volley-hooks: a long foreground tool call no longer raises `hooks_silent`.** A full
  test suite or `gh run watch` kept the hooks quiet for 10 min while the screen changed, which
  opened a "hooks may be broken" decision that cleared itself when the tool returned. PreToolUse
  now publishes a tool boundary on every call (`activity` with `tool_use_id` and `tool`, outside
  the 5 s work-log limit) and PostToolUse's heartbeat carries the same `tool_use_id`; volleyd
  treats a tool in flight (each of several parallel calls until its own PostToolUse) as work, not silence, until the new `tool_in_flight_max_s` (default 2 h)
  with a static screen. With no tool in flight, `hooks_silent` now needs the screen to keep
  changing with no hook signal across two `heartbeat_alarm_s` windows (20 min by default). (#329)
- **volley-hooks: the lease hook matches the commands the shell would execute, not text that
  mentions them.** A pool's `match` regexes were tested against the whole Bash command string, so
  a heredoc writing a note, a `#` comment, a `git commit -m "… bun run test …"` or an `echo`
  queued behind real test runs. They now run against each executed command: the line is split on
  `;`, `&&`, `||`, `|`, newlines and `$(…)`, `sh -c` scripts are split in turn, and comments,
  heredoc bodies, `echo` / `printf` arguments and git / gh message text (`-m`, `-am`, `--body`,
  …) are dropped. (#330)
- **volleyd: a coordinator that ended while the daemon was down reads `gone` after the restart,
  whatever order the replays arrive in.** The retained statuses and registry entries replay on
  two subscriptions; when the `done` came first, the daemon forgot it (no coordinator name known
  yet) and the wave's `coordinator` then read `working` forever. A forgotten terminal status is
  now set aside (bounded) and taken back when the session's registry entry arrives (not by an
  entry that started after it: that id registered anew). (#332)
- volleyd tests: the broker and journal waits (`eventually`, `until`, `journalWait`) fail after
  5 s naming what they waited for and the last assertion error, never as a vitest timeout, and a
  grep guard keeps every test's wait helper on them; the spawn test's set-up moves to its hook
  and its cleared-topic reads run at once. (#332)

### Docs

- **repo: no home-directory paths in tracked files.** Docs, examples, `config.example.yaml`, the
  spec examples and the tests now write `/path/to/repo`, `/path/to/volley`, `/path/to/worktrees`
  and `/path/to/home` in place of invented `/home/<user>` and `/Users/<user>` paths, and the new
  `scripts/no-home-paths.test.ts` guard keeps them out. (#333)
- **spec: the decision kinds, wave events and tunables are one item per line, checked against
  the schemas.** Sibling PRs that each add a kind, event or key no longer edit the same line.
  `bun run check:spec-refs` fails, naming the item, when a list and its schema
  (`decision.schema.json`, `wave-event.schema.json`, `config.schema.json`) differ; the tunables
  list gains the missing `autopilot.digest_min_interval_s`. New `spec/RESERVED.md` reserves SPEC
  section numbers for an epic's parallel children, and the check fails when a sibling's heading
  takes a reserved number (or when `spec/RESERVED.md` is missing); `/volley-issues` says to reserve them in the epic's first PR. (#334)

## 0.5.0 — 2026-10-21

The Autopilot release: a wave runs unattended. volleyd answers routine decisions from a
reviewable policy table (#197), relaunches and respawns stalled agents (#200), heals red CI by
classifying it (#204) and fixing a flake with its own task (#207), merges each gated PR itself at
exactly its gated head (#198) through a merge queue (#203), runs the repository's release train
(#201, #205), and refers what needs a person to one needs-you inbox (#202, #206) that the Desk
answers from any screen, a phone included (#208, #209). A wave is owned by a stable coordinator
name, so its session can end (#199); the night is summed up in one digest and one push (#210);
`/volley-issues` submits and leaves (#211); a simulated soak runs a whole wave in CI (#212). The
owner's guide is [`docs/AUTOPILOT.md`](docs/AUTOPILOT.md) (#213). Owner smoke:
[`SMOKE.md`](SMOKE.md) Plan 13.

### Added

- **volleyd: archive ended waves.** `volleyd archive <wave> [--yes]` retires a stopped or
  complete wave: its open decisions close as `archived`, `wave_archived { by, reason,
  closed_decisions }` is journaled, its state is published once with `status: "archived"` and
  then cleared, and it leaves the live set (`volleyd status`, `decisions`, ticks, restarts) while
  its journal and evidence stay on disk. `volleyd status --all` still lists it; `run` refuses its
  id. An admin may archive any ended wave through its account-op topic. New tunables
  `archive_ended_after_h` (default 24; 0: never) and `archive_on_ack` (default true) archive
  ended waves automatically. A retained index, `volley/_waves/_archive` (`archive.schema.json`),
  lists archived waves (SPEC §4.6.20). **Behaviour change on upgrade:** the first tick archives
  every wave that ended more than 24 h ago in one pass; set `archive_ended_after_h: 0` first to
  keep them. (#192)
- **Desk: archived waves leave every Desk.** The coordinators window and the canvas drop an
  archived wave for every client, not just the browser that dismissed it, and the window's footer
  counts `N archived (volleyd archive)` from the index. Dismiss stays for ended waves not archived
  yet. (#192)
- volleyd: `volleyd run` warns when the wave it submits has no owner (nobody can answer its
  decisions), and `volleyd validate` notes that `run` needs one. (#192)
- volleyd: a terminal-status watchdog. A `done`, `blocked` or `failed` status that nothing in the
  wave journal names within 60 s (`terminal_unjournaled_alarm_ms`) raises
  `alarm_raised { alarm: "terminal_status_unjournaled" }` once, cleared when something does. (#196)
- **volleyd: the autopilot policy engine answers routine decisions from a reviewable table.**
  The table is data in one pure module (`src/autopilot/policy.ts`); a decision a rule matches is
  answered in the same turn, journaled `decision_auto_resolved { decision_id, kind, policy,
  answer, rationale, evidence, budget? }` and then `decision_resolved { by: "volleyd" }`, and does
  not ring. A decision no rule answers, an owner-only kind, a spent budget or an answer that could
  not be applied stays open as `decision_escalated { why }`, its question prefixed `Autopilot
  could not resolve this (<why>): `, and rings once. An answer is always one of the decision's
  own options. New `autopilot` tunables (SPEC §4.6.4, §4.6.16), global and per wave: `enabled`
  (default `true`), `owner_only`, and the per-wave budgets (`relaunch_max`, `nudge_max`,
  `respawn_max`, `rereview_max`, `question_max`, `budget_raise_max`), reduced from the journal so
  a restart keeps them. `volleyd policy [--json]` and the `policy` control op print the table;
  `volleyd status` prints `autopilot: on · N auto-resolved · M escalated` and the wave state
  carries `autopilot { enabled, auto_resolved, escalated, budgets }`. (#197)
- **volleyd: autopilot merging, behind the fence.** volleyd can merge a gated PR itself, exactly
  at the head its evidence describes: the gate mints a `MergeToken` for `{ wave, task, pr, head,
  release_branch }` after writing the evidence package, and the authority fence allows exactly
  `gh pr merge <n> --squash --match-head-commit <head> [--delete-branch]` with a token for that PR
  and head (never `--admin`, `--auto`, `--merge` or `--rebase`; `git merge`, `push` and `rebase`
  stay denied). A merge is journaled `merged_by_supervisor { task, pr, head, merge_sha, by }`,
  then `artifact_verified { role: "merged", via: "supervisor" }` and `done`. A merge GitHub
  refuses (head moved, checks required, branch protection) raises `merge_refused` and the PR is
  re-read; after `autopilot.merge_retry_max` (2) refusals decision `merge_refused` asks `retry`,
  `manual` or `cancel`. New wave-file key `merge: auto | manual` (default: the new tunable
  `autopilot.merge`, default `auto`); under `manual` nothing changes. For now volleyd merges only
  in a wave of one task (the merge queue that orders merges across tasks comes next). The
  evidence package says who merges. Before the gate and again right before `gh pr merge` the PR
  is re-read: a PR retargeted away from the release branch, or whose head moved, is never
  merged. **Behaviour change:** a one-task wave with no `merge:` key is now merged by volleyd
  after upgrading; set `merge: manual` in the wave file (or `autopilot.merge: manual`) to keep
  merging by hand. (#198)
- **volleyd: stable coordinator identity.** Set `VOLLEY_COORDINATOR` (e.g. `coord-main`) in the MCP
  registration's `env` and submit with `volleyd run --owner "$VOLLEY_COORDINATOR"`: the wave is
  owned by the name, which volleyd binds to the newest live registry entry carrying it (the MCP
  server publishes it as the registry entry's `coordinator`; `vol_register` returns it). A session
  whose MCP server restarts under a new agent id keeps its waves: volleyd journals
  `owner_reconnected { owner, agent_id, previous_agent_id }`, nothing is claimed, and the wave
  state's `coordinator.state` reads `reconnecting` (new) while the session is away, for
  `autopilot.reconnect_grace_s` (default 900), then `gone`. `volleyd status` prints
  `owner: coord-main (via coordinator-c7d9)`; the CLI picks the name up from `VOLLEY_COORDINATOR`
  or the session's registry entry. (#199)
- **volleyd: three stalls the pipeline now fixes itself.** An `agent_stalled` decision offers
  `nudge again`, `respawn` or `stop task`, and `respawn` relaunches the agent on its branch (the
  next attempt). A verify that finds an agent's artifacts missing offers `respawn` beside
  `re-verify` and `cancel`. A `ci_failed` decision offers `fixup`: a fixup agent gets the CI result
  (failing jobs, failing tests and the tail of the failed logs) as its directive; after a red first
  head the reviews run on the fix, and after a red fixup or rebase head the green fix goes straight
  to the gate. Autopilot answers them within budget: a second stall and a missing artifact get
  `respawn` (`respawn_max`), and a red head caused by the PR's own change gets `fixup`. (#200)
- **volleyd: the release train, part 1: a release playbook, the `releasing` status and the
  `release_go` / `stage_go` decisions.** A repository may ship `.volley/release.yaml`
  (`spec/schemas/release-playbook.schema.json`): named stages, each a `brief`, optional `run`
  argv lines, `verify` facts (`commits_on_release`, `tag`, `files`, `result`) and `gate: auto |
  owner`. A wave file's `playbook: <path> | none` overrides the default path. `volleyd validate`
  and `run` print `release playbook: <path> (N stages, M owner-gated)` or `none`; an invalid
  playbook refuses the wave with `RELEASE_PLAYBOOK_INVALID`. Under autopilot a settled wave with a
  playbook journals `release_started` instead of `wave_complete` and becomes `releasing` (wave
  state `release: { stage, stages }`; `volleyd status` prints `release: <stage> (k/N
  verified)`); once every stage is verified volleyd asks the owner `release_go` (`go` → `release_done`,
  `complete`; `hold` asks again). Stages are not run yet; that is the next part. (#201)
- **volleyd: the needs-you inbox, with volleyd as referee.** Everything waiting for a person is
  one retained record on `volley/_inbox/<id>` (`inbox-item.schema.json`, SPEC §4.6.18), published
  by volleyd only: `{ id, kind: decision | picker | handoff | release, version, owner_only, …,
  answered? }`. Every decision is mirrored as an item (`d-<wave>-<decision_id>`, `owner_only` from
  `autopilot.owner_only`). An answer is the mailbox op `inbox_answer { id, version, answer, where }`
  from any login that may steer, accepted only at the item's current version (compare-and-set);
  a late one is refused `already answered on <where>` (`desk·phone`, `<machine>·terminal`, `cli`,
  `autopilot`). Every path (`volleyd resolve [--where]`, autopilot, the Desk) closes the item
  through the same referee and journals `inbox_answered`. Answered items stay retained for the
  new tunable `autopilot.inbox_answered_ttl_s` (600), then are cleared. New `volleyd inbox
  [--json]` and `volleyd inbox answer <id> <answer> [--where] [--version]`; the Desk's store
  keeps the items in `state.inbox` (its window comes next); the broker roles let every account
  read the inbox and only the supervisors write it. (#202)
- **volleyd: the merge queue.** Under `merge: auto` volleyd merges a wave's gated tasks one at a
  time: ordered by dependency (tasks with more dependents first; never ahead of a task they come
  after), then by when they were queued, with one merge in flight per release branch across every
  wave on the daemon. After each merge the next task is checked against the release branch and,
  if behind, brought up to date under `branch_update` (`merge` recommended for unattended waves)
  before it gates again and merges: at most N−1 updates, serially. A rebase or merge agent that
  is blocked or fails while its task is queued opens `merge_conflict` (`respawn` | `manual` |
  `cancel`; autopilot answers `respawn` once). New: `merge_queued`, `merge_dequeued`,
  `merge_started` and `merge_ended` events, wave-state `merge_queue` and its `volleyd status`
  line, `volleyd merge <wave> <task>` (owner only; merges one gated task now, under
  `merge: manual` too) and `autopilot.delete_branch` (default `false`).
  A multi-task wave without `merge:` is now merged by volleyd (the `autopilot.merge` default,
  `auto`). A task whose turn checks keep failing gives up the turn and is passed over, so it never
  wedges the queue. (#203)
- **volleyd: self-healing CI, step one: a red head is classified before anyone is asked.** Own
  change (a failing test's file is in the PR) opens `ci_failed` with `fixup` first; a flake (a
  failing test the PR does not touch, or red on the release branch too) journals
  `remediation_requested { kind: fix_flake }` and offers `fix flake`; an infra incident (an
  infra-shaped run, or GitHub's status page reporting an Actions / API incident) holds the task in
  CI and re-checks it for up to `autopilot.incident_wait_max_s` (default 4 h) before asking. The
  decision carries `classification` and `evidence`; a blocked agent whose reason is a failing
  test on a red PR head is routed the same way (`agent_blocked_ci`). Nothing ever re-runs CI.
  (#204)
- **volleyd: the release train runs its stages.** A releasing wave spawns one `release` agent
  per playbook stage, serially, through the normal spawn path (`<wave>-release-<stage>-<n>` on
  `<wave>/release-<stage>-<n>`, cut from the release branch's tip, under the pseudo task
  `_release`). Its brief and `.volley/stage.md` carry the stage's brief, its `run` lines verbatim,
  the `verify` facts and the `stage` result contract (`review-result.schema.json`); a `heavy`
  stage takes its lease first. After its `done` volleyd verifies read-only (every command exited
  0, `commits_on_release`, `tag` through `gh api …/matching-refs/tags/`, `files` through `git
  show`, `result` fields), writes `$VOLLEYD_HOME/waves/<wave>/release/<stage>.{md,json}` and
  journals `release_stage_verified`; a missing fact gets one steer, then `release_stage_failed`
  and a wave-level `agent_blocked` decision (`respawn` / `skip` / `cancel`). An owner-gated stage
  waits on `stage_go` (`go` / `skip` / `hold`); `release_go`'s `stages` point at every stage's
  evidence, and `volleyd status` prints `release: smoke running (2/4 verified)`. SPEC §4.6.19. (#205)
- **volleyd, volley-hooks: Claude pickers and coordinator handoffs in the needs-you inbox.** Two new hooks on `AskUserQuestion` publish `progress/picker_opened { tool_use_id, questions }` and `picker_answered { tool_use_id, answers }`; volleyd opens a `p-<agent_id>-<tool_use_id>` item for every picker in any session, and an `h-<agent_id>-<seq>` item for a coordinator turn that ends on a question (a coordinator's own items are answered only by that session or the coordinator name bound to it). A Desk answer is carried out on the session's screen before it is accepted: volleyd checks the same picker is still shown (else `picker not on screen`) and selects the answer by keystroke, or types a handoff reply into an idle prompt below the question it asked (else `prompt not idle` / `the question is not on screen`); `Up`/`Down`/`Space` and the typed text pass the fence only with a `PickerToken` / `HandoffToken` for exactly that item and answer. The picker's own hook, the session's next prompt, or the session ending closes the item with `where: terminal` when it was answered there. The volley-issues skill asks go/no-go through `AskUserQuestion` (`go`, `hold`, `cancel`). (#206)
- **volleyd: self-healing CI, step two: a flake gets a dedicated fixer task, and its merge
  unblocks every PR that waited on it.** On a `fix_flake` request volleyd adds a synthetic task
  `fix-<slug>` to the wave (issue 0, the wave's pipeline, scheduled first, one per distinct test,
  at most `autopilot.fix_flake_max`, default 3, past which the red head is escalated
  `budget_exhausted`). Its implementer gets a root-cause brief instead of an issue: reproduce,
  find the cause, fix it test-first; never re-run, skip or quarantine. When the fixer is done,
  `remediation_closed` releases each blocked task: its decision is resolved `fix landed`, it
  updates from the release branch and is verified again. A fixer that is cancelled, blocked or
  escalated puts the blocked red heads back to the owner once. `volleyd status` shows
  `fixer for T3, T7 (flake: <test>)`. (#207)
- **volley-desk: the Needs you window.** One row per item in the needs-you inbox (decisions,
  pickers, handoffs, release go/no-go), filtered All / Only you / Pickers / Decisions / Handoffs.
  Each answer button sends `inbox_answer` to volleyd. A refusal ("already answered on …") flips
  the row to answered, and without broker credentials a row offers the `volleyd inbox answer`
  command to copy. The dock's Needs you tile and the top-bar pill count what needs a person, and
  owner-only items fire the browser notification. At phone width the rows are stacked cards with
  48 px targets. A release item shows the train as a Stepper, plus the changelog entries (a safe
  inline Markdown renderer), the staging smoke screenshots, and links to the release PR, the CI
  runs and the smoke log. A release guide is a link only. (#208)
- **volley-cli: `volley desk serve --evidence <volleyd home>`.** Serves
  `/evidence/<wave>/release/<file>` read-only (`.png .jpg .webp .txt .log .md .json` directly
  under `waves/<wave>/release/`, nothing else) for the Needs you window. It is off by default,
  a LAN-trust choice that `volley setup` names but does not turn on. (#208)
- **volley-desk: autopilot on the Desk.** A coordinator whose session is reconnecting (inside
  volleyd's `autopilot.reconnect_grace_s`) reads `Coordinator reconnecting · Nm` with a neutral
  chip, no `claim it` and no Needs-you banner, until volleyd says it is gone. The wave window gets
  an `autopilot on · N auto · M escalated` / `autopilot off` chip, the merge queue as one line, the
  release train's stages while releasing, a wrench and `fixer for …` on synthetic fixer tasks, and
  autopilot's `decision_auto_resolved` / `decision_escalated` events as feed lines (also in the
  agent window's feed), the evidence behind the row's disclosure. Settings › Autopilot has every
  `autopilot.*` tunable (`owner_only` as a multi-select of decision kinds) and the policy table
  from the `policy` op, read-only. (#209)
- **volleyd: the morning digest: one retained digest per wave, one push, `volleyd digest`, and
  the Desk's digest card.** volleyd computes, from a wave's journal, what shipped (each merged
  task with its PR, merge sha and who merged it), what autopilot handled on its own (decisions
  answered, flakes fixed, conflicts resolved, retries, merges) and what is waiting for the owner,
  and publishes it retained on `volley/_waves/<wave>/digest` (`digest.schema.json`), journaling
  `digest_published { trigger }`, when the wave completes or its release is done, its `release_go`
  opens, it is stopped, or it first needs the owner (an escalation; at most once per
  `autopilot.digest_min_interval_s`, default 1800, per trigger). Each publish sends one `progress`
  envelope of type `digest` whose `msg` is the one-line summary (`w1 complete: 27 shipped, 3 flakes
  fixed, 2 conflicts resolved, 1 waiting for you (release_go)`); `volley notify` rings for it by
  default (`--on` now defaults to `blocked,failed,reaped,digest`) and its desktop banner shows
  `msg`. `volleyd digest <wave> [--json]` prints it; the Desk shows it in the wave window while the
  wave has ended or a decision it lists is still open. Archiving a wave clears its digest. (#210)
- **volleyd: a simulated soak runs one whole wave unattended.** `bun run test:soak` (and CI's
  `soak` job) drives a wave through the real daemon against a simulated GitHub, with a flaky test,
  a merge conflict, launch timeouts, a dropped coordinator, slow screens, and stalled, failed and
  unparseable agents, and checks that every task merges and only `stage_go` and `release_go` are
  left for the owner. PR heads moved by release-only merges are opt-in (`SOAK_MOVED_HEADS=2`)
  until #269 and #271 are fixed, and CI gates on an 8-task run while the 32-task run is reported
  without gating until #269. `SOAK_TASKS` (default 32) and `SOAK_SEED` size and replay it. (#212)
- volley-desk: the agent window's title bar is two rows that never bunch: the status mark, the
  wave, role, stage and machine chips and the actions on the first; the headline in full (at
  most two lines), its issue and PR links and the account picker on the second. Under 420 px the
  window is compact (an icon-only account picker, shorter chips). The new machine chip says where
  the agent runs (a paired machine's name or `this machine`) with an up / down / overloaded dot,
  a why-here and load tooltip on hover or focus, and opens Settings › Machines at that machine's
  card; it replaces the footer's `on <host>`, and the body's purpose line now shows only when the
  headline does not already. (#220)
- volley-desk: GitHub links everywhere a wave shows work. A repo chip (the GitHub mark and
  `owner/repo`) on the wave window, each wave row of the Coordinators window and its Supervisor
  row (`N repositories` past two); every `#n` / `PR #n` on the agent window header, the
  dependency graph and the machine-down banner is a link named `Issue #n on GitHub` /
  `PR #n on GitHub`, opening in a new tab. Links come from the wave state's `github` only;
  without it the numbers render unlinked. (#225)
- volleyd: the wave state carries `github: { slug, url }`, the repository's `owner/repo` name and
  URL from the `gh repo view` volleyd already runs per wave version (now
  `--json nameWithOwner,url,visibility`, under every `public_hygiene` level); absent when it
  could not be read. `volleyd status` prints `github: owner/repo`. (#225)
- **`volley deploy [<tag>|--latest] [--dry-run]`.** One command takes the checkout this
  machine's volleyd and Desk services run from (read from volleyd's installed launchd plist or
  systemd unit; `--repo` overrides) to a release tag: fetch tags, check the tag out detached,
  `bun install --frozen-lockfile`, build the Desk (and write setup's `dist/.volley-build` stamp),
  self-check, restart both services and health-check them (volleyd is `working` again, the Desk serves
  the tag's `version.json`). A failure after the checkout repeats those steps at the previous
  ref and exits 1; a failed rollback prints the commands to run by hand. A checkout with local
  changes exits 3 unless `--force-clean` stashes them (never discards). Every command goes
  through one fence of exact argv shapes. `--dry-run` prints the steps and runs only read-only
  git commands. (#232)
- The Desk's build writes `dist/version.json`; `volley desk serve` warns at start (and still
  serves) when the build is stale against the checkout's Desk sources or the bundle's version is
  not the CLI's. `--quiet` silences both lines. (#232)
- volleyd: an adaptive hub. `fleet.local_agents: always | fallback | never` sets how the
  supervisor's own machine takes auto-placed tasks; `null`, the default, is `fallback` once any
  `hosts.<name>` is configured, else `always`. Under `fallback` the own machine takes a task only
  while no paired machine is eligible (a peer down for less than
  `placement.down_decision_after_s` may be back, so it waits), and then under a lighter profile:
  at most `fleet.fallback.max_agents` (default 3) of its own agents and
  `fleet.fallback.per_machine.<pool>` heavy slots (default 1). Nothing running is moved when a
  peer comes back. The candidate line says why (`local (fallback: no peer eligible: …)`,
  `ineligible: fallback: box-a is eligible`, `ineligible: local_agents: never`); the own
  readiness verdict carries `local_agents { mode, active, why? }`, `volleyd status` prints
  `local agents: fallback (active: …)`, and `volleyd validate` warns about a task pinned to
  `local` under `never`. `lease_pools.<pool>.per_machine_overrides: { <host>: n }` caps one
  machine's share of a pool (0 allowed, `local` names the supervisor's own), enforced by the lease
  book and shown in the pool state, `volley lease status` and the Desk's lease pools; the Desk's
  supervisor card shows the mode as a chip. (#233)
- **volley-desk: the context meter pulses from 70% and faster once red.** The agent window's (and
  a session's) `ctx` meter pulses its bar from 70% and faster from 85%; under
  `prefers-reduced-motion` it only changes colour. (#289)
- **volleyd: agents compact before they hit the context wall.** Every launch exports
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` as `agent_auto_compact_pct` (default 85, 0 to leave Claude
  Code's default; per wave through `config:`) of the model's context window in tokens;
  `agent_spawned` records it and the fence pins it. (#289)
- **volley-desk: a Machines window with load and memory sparklines per machine.** The dock's new
  Machines tile (badged with the machines that are down) opens one row per machine in the pool,
  this machine first: the health dot, `load <1-min>/<cores>`, `mem <used %>`, `<n>/<max> agents`,
  cores and memory, and two sparklines over the last 10 minutes (load per core in teal, memory
  used in coral) that turn amber at 70 % and red at 90 %. A down machine reads
  `down · last seen 6m ago` with flat grey lines; a click opens Settings › Machines at its card.
  The Desk keeps each machine's readings from the records it already receives. (#290)

### Changed

- **volley-issues: the autopilot flow is the default volleyd path.** `/volley-issues` submits the wave owned by the stable coordinator name (`--owner "$VOLLEY_COORDINATOR"`) and leaves: volleyd answers routine decisions and merges gated PRs itself, and what still needs the owner (owner-only kinds, escalations, `release_go`) is answered from the Desk's Needs-you window, `volleyd inbox answer` / `volleyd resolve`, or the terminal. The optional wait is one `volley sub` on `volley/_waves/<wave>/digest`; the per-event loop moves to "Driving a wave by hand" for `autopilot: off` waves. `scripts/wave-from-issues.ts` gains `--merge auto|manual` (writes `merge:`, default `auto`), `--autopilot on|off` and `--branch-update merge|rebase` (written into the wave's `config:`), and prints the submit line with its owner; the brief-preface template adds the go/no-go `AskUserQuestion` convention. (#211)
- **Changelog entries are per-PR fragments.** A PR records its change as a new file,
  `changes/<issue>.<added|changed|fixed|removed|docs>.md`, never by editing `CHANGELOG.md`, so two
  PRs in a wave never conflict on it. `bun run changelog --version <v> --date <YYYY-MM-DD>
  [--check] [--commit]` assembles the fragments into the release's section and deletes them. CI
  fails a PR that touches `packages/` or `spec/` without a fragment (unless labelled
  `no-changelog`), and a non-release commit that changes `CHANGELOG.md`. (#231)

### Fixed

- **volleyd: the auto-archive tests no longer time out under load.** They moved the fake clock
  24–48 h with every daemon interval firing on the way (several seconds per test), so a busy
  machine crossed the 15 s timeout. The TTL is wall-clock time, so the tests now let the host
  sleep across it, as a laptop does. (#192)
- **volleyd: a launch whose outcome is unknown is reconciled before any retry.** A `cmux
  new-workspace` that timed out (on the cmux side, or volleyd's new `launch_timeout_ms` bound)
  could still have started the agent, and the retry then ran a second session under the same
  agent id. A failed launch now says whether it created nothing (`refused`) or may have
  (`unknown`); for an unknown one volleyd looks the workspace up by name and waits
  `launch_reconcile_ms` for the agent's registration, then adopts it (`spawn_adopted`), closes
  the empty workspace (`launch_orphan_closed`) or, when the host cannot be asked, burns the
  attempt (`spawn_identity_burned`) so the retry takes the next agent id. A workspace title now
  carries the attempt after the first (`<wave> <task> <role> 2`), so the lookup never finds an
  earlier attempt's workspace; two workspaces with the same title burn the attempt too. Launches
  are serialized per host. (#193)
- **volleyd: a retire ends the agent's session, and cleanup stops its process.** After a retire
  volleyd closes the agent's workspace (cmux `close-workspace`, now bounded by a 15 s timeout, or
  tmux `kill-session`) and, on this machine, stops any `claude` process still running under the
  agent's worktree (matched by its `--mcp-config=` argv; SIGTERM, a grace, SIGKILL), journaled as
  `agent_session_closed`. After a daemon restart the workspace is re-found by its title. The new
  `retire_close_session` tunable (default `true`) keeps finished sessions open when `false`.
  Before deleting the agent's login the retire writes `<worktree>/.volley/retired.json`.
  `volleyd cleanup <wave> --yes` also stops the retired agents' processes still running under
  their worktrees (the dry run lists them). (#194)
- volley-hooks: the hooks of a retired agent (a `.volley/retired.json` naming their own agent id)
  exit 0 quietly, before any broker connect, with a one-time `{ code: "RETIRED" }` note in
  `hooks-error.json`, instead of printing the `AUTH_FAILED` advice for a login volleyd deleted on
  purpose. (#194)
- **volleyd: a `pr_head_moved` that only merged the release branch can be accepted.** When CI
  on the new head is green and the move is a merge of the release branch whose changed files the
  release branch changed too (a CHANGELOG conflict resolved in the merge counts), the decision
  offers `accept`: the gate moves to the new head with the reviews of the old one, and the
  evidence records who accepted it and the files the merge touched. A move that adds the PR's own
  changes is still `rereview | fixup | cancel`. (#195)
- **volleyd: a PR merged while its task is not at `merge_ready` is noticed.** The merge check
  runs in every stage short of `done` / `cancelled` (an open decision, the reviews, a fixup):
  the task's open decisions are resolved `superseded_by_merge`, its live agents retired, and it
  becomes `done` with `merged_unverified_head`, releasing its dependents. Before, a merged task
  waited on its decision and could only be recorded as `cancelled`. (#195)
- volleyd: an agent's `blocked` status was never journaled or decided, whatever its role, so a
  stuck task (a rebase agent, on a downstream wave) stayed silently in its stage. Every role's
  `blocked` now opens an `agent_blocked` decision with the agent's reason (`continue | respawn |
  cancel`); the agent is not retired while it is open (SPEC §5.2). (#196)
- volley-desk: Arrange & fit and the first fit framed only the arranged (unpinned) windows, so a
  window pinned in place could be left off-screen; the view now frames the pinned windows with
  the rest, and the layout is chosen to fit beside them. (#221)
- **volley deploy: the volleyd health check no longer reports a live broker as unreachable at
  the end of its wait.** The check polls until its deadline, and a last poll that started with
  a few milliseconds left gave its broker connection only that long, so a slow moment turned
  "volleyd has not re-registered" (or "its status is spawning") into "the broker is
  unreachable". Each connection attempt now gets at least a second. (#232)
- **volley-desk: the version.json build test passes on macOS.** It built from a temp directory
  under the `/var` → `/private/var` symlink, which vite refused; it now uses the real path. (#232)
- **volleyd: reviews and verification work on a paired machine.** The remote fence allows the
  read-only `gh` verbs a reviewer's verification needs (never `gh api`, merges or workflow runs),
  and a remote worktree for a PR head sha is created at that commit instead of an
  `origin/<sha>` ref that does not exist. (#223)
- **volleyd: a flake fixer for a long test id spawns its reviewers.** An agent id whose task part
  leaves no room for its role (a fixer's `fix-<test>` under `spec_reviewer` or
  `quality_reviewer`) now has that task part cut and replaced by a short hash, so every role of
  every task gets a valid, unique id; ids that already fit are unchanged. A spawn refused because
  its agent id cannot be formed is no longer retried with backoff forever: it fails once and its
  decision says the retries stopped, which the autopilot escalates. (#268)
- **volleyd: one merge_ready invariant breach opens one decision.** When a PR head moved while
  the reviewers worked, the invariant asked the same `rereview` question three times in one
  instant: autopilot answered the first two, which spent `rereview_max` and started two review
  rounds, and escalated the third to the owner. The question for a head is now asked once until
  its answer is handled, so one `rereview` starts one round and the wave goes on unattended. (#269)
- **volleyd: a release-only head move accepted while the reviewers still run no longer strands the
  task in review.** When a PR takes an "Update branch" during `spec_review` and autopilot (or the
  owner) answers `accept`, the reviews that arrive afterwards for the old head count at the new one:
  the task's head stays at the moved head, the move is not reported a second time, and the task goes
  on to the gate there instead of sitting in `spec_review` for good. (#270)
- **volleyd: a queued PR's head move seen by two checks on one tick is handled once.** When the
  merge check and the turn's gate check both see a queued PR's head move (an "Update branch"), the
  gate check no longer raises its own `pr_head_moved` alarm and re-verifies the implementer while
  the `pr_head_moved` decision is open or its `accept` is still being recorded: the accept keeps the
  reviews and the PR merges without a re-review, instead of the move voiding both reviews and the
  task escalating `budget_exhausted`. (#271)
- **volleyd, volley-desk, volley-cli: a Desk login answers a wave's Needs-you items from any
  screen.** The Desk sends `inbox_answer` and `resolve` on its own account-op topic, where the
  broker names the sender, and volleyd treats a Desk login's answer (a `steer` or `admin`
  account, or the fixed `desk` identity) as the owner's; a mailbox answer still needs the owner.
  The `desk` role gains its own `volley/_system/auth/ops/%u`: an existing broker reports the role
  as drifted, and `volley auth migrate --roles --yes` applies it (its holders reconnect); until
  then the broker drops a Desk answer, and the Desk's "did not answer" names that step to a steer
  or admin login. (#274)
- **volley-desk: Settings › Autopilot's policy table fits the pane.** Its columns are fixed widths
  (rationale gets the most room) and long monospace strings wrap, comma-joined kind lists after
  their commas, so the rationale column is no longer cut off; a pane narrower than the table
  scrolls it sideways instead of clipping it, and at phone width each rule is a stacked block. (#278)
- **volleyd: autopilot merges a task whose agents ran on a paired machine.** The merge (`gh pr
  merge --squash --match-head-commit`) went through the task's own exec, so for a task placed
  on a paired machine it ran there, where the fence never holds a MergeToken, and was refused
  (`FENCE_DENIED: remote gh pr merge`). A merge is the supervisor's act: it now always runs on
  the supervisor, in the wave's repo.

### Docs

- **docs: the autopilot release, documented.** `docs/AUTOPILOT.md`, a one-page owner's guide
  (what runs unattended, what still asks, how to opt a wave out, how to read the digest), linked
  from the root README's first use case; the volleyd README's Autopilot section opens with a map
  of every piece and its Contents lists them; the Desk README points at the Needs you window and
  Settings › Autopilot; SPEC §11.6 (conforming supervisors) gathers the autopilot MUST and MAY
  lines of §4.6.16 and §4.6.17, and the wave state's `gates` says who merges in each mode.
  [`SMOKE.md`](SMOKE.md) Plan 13 is the owner's real unattended run against a scratch repository,
  with the metrics for the tag annotation and a run-history table. (#213)
- volleyd's implementer and fixup briefs, the volley-issues skill, its brief-preface template and
  README tell agents to write a `changes/` fragment and never edit `CHANGELOG.md`; the release
  step runs `bun run changelog`. (#231)

## 0.4.0 — 2026-10-20

The Fleet release: volleyd judges which machines can run an agent, places a wave's tasks across
them and says why, and asks the owner before anything is re-placed when a machine goes down,
gets busy or leaves. A paired machine is checked, repaired and signed in to Claude from the Desk.
Owner smoke: [`SMOKE.md`](SMOKE.md) Plan 12.

### Added

- **SPEC §4.6.15 Fleet**, with the machine record's doctor fields, the new readiness verdict
  schema, placement in the wave file and wave state, `per_machine` lease caps, the
  `machine_down` decision and the Fleet tunables, each with valid and invalid examples. (#112)
- **`volley peer doctor [--fix] [--clone] [--json]`**: one line per check (tools, the
  non-interactive ssh PATH, the volley checkout and version, the repo clone and origin, GitHub
  push access, the Claude sign-in and folder trust, memory and disk), the fix for each, and
  `--fix` applying only the safe ones. `peer join` runs it first; every heartbeat carries its
  result. `volley peer invite --for <name>` / `join --replace` re-pair a machine. (#113)
- **The peer's Claude profile:** the doctor's `skills`, `hooks`, `mcp` and `sharing` rows, and
  `--fix` provisioning them, so a session on a paired machine has `/volley` and the hooks
  without reading a README. (#117)
- **Readiness:** volleyd publishes a record for its own machine and a retained verdict per
  machine (`volley/_system/machines/<name>/readiness`): ready or not in plain words, eligible
  for placement or not, from the doctor and its own probe of the ssh PATH an agent gets.
  `hosts.<name>.max_agents` and `hosts.<name>.drain`; the admin op `peer_doctor` (Repair). (#116)
  Repair's clone clones from the running wave's origin (`--clone --origin <https URL>`). (#188)
- **Placement:** `placement: auto` in a wave file (or `host: auto` on a task) places each task
  at admission on the best eligible machine, scored from CPU, slots, memory and usage headroom,
  with `placement_prefer` / `placement_avoid` and `heavy: true`. Every candidate gets a "why
  here" line; `volleyd validate` / `run` preview the placement and `volleyd status` prints it.
  A peer's own load and memory gate its admissions. (#118)
- **Machine-aware leases:** each lease holder's host, and a pool's `per_machine` cap. (#114)
- **A fresh base:** `require_fresh_base` (a worktree is cut from a freshly fetched release
  branch), `base_sha` on every task, and a steer to running implementers whose files overlap a
  PR that just merged (`placement.nudge_on_merge`). (#115)
- **Down, overload, drain, remove:** a machine down for 5 minutes opens one `machine_down`
  decision per wave (wait, re-place queued tasks, cancel); an overloaded machine takes no new
  agents until three clean heartbeats; respawn decisions offer `respawn on <best>`;
  `volley peer remove --drain | --now`. A running agent is never moved. (#120)
- **The Desk's Machines v2:** readiness and doctor rows on each card, the cap editor,
  **Repair…**, **Re-pair…** and **Remove…** sheets, Add a machine's checks / Claude / ready
  steps, lease pools grouped by host, a host chip with "why here" on each task, and the
  `machine_down` banner with re-place pre-selected. (#121)
- **Signing a paired machine in to Claude from the Mac:** **Sign in on <machine>** runs Claude
  Code's own `claude auth login` on the machine in tmux and forwards its localhost callback for
  the length of the sign-in (one fenced, transient `ssh -L`), with a phone fallback that types
  the code into a terminal, never into Volley. (#122)
- **Desk sound themes:** twelve themes of short generated clips (Synthwave by default) for 28 Desk events: clicks, drags,
  tethers, panels, agents spawning, finishing and failing, reviews, decisions, CI, gates, merges, waves, steering, account
  limits, machines and the broker, and anything that needs you. Settings › Sound picks a theme, plays any clip of any theme,
  and has master volume, mute, per-event switches, only-when-hidden, quiet hours, reduced motion and vibrate. A burst plays
  once and is read out ("12 agents completed"). The clips are generated with the ElevenLabs Sound Effects API from
  `sounds/prompts.yaml` (`bun run sounds:generate`, `sounds:pick`, `sounds:check`). The Desk's old chime is gone; the
  legacy dashboard keeps its own. (#171)

## 0.3.2 — 2026-10-20

Fixes found running a downstream project's wave through volleyd 0.3.0.

### Fixed

- An agent that ends its turn to wait on its own background work (a long test run, `gh run watch`) is no longer nudged or
  reported as stalled. volleyd reads the hooks' `background_wait` flag, a lease the agent holds, the running shells in its
  terminal footer, and recent writes under its worktree; `volleyd status` says `idle N min: <reason>`. A real stall's
  repeated `agent_stalled` decisions of one idle back off (each waits twice as long, capped by the new
  `stall_backoff_max_s`); the new `background_wait_max_s` bounds how long any of that evidence holds off the nudge, counted
  from the start of the idle (SPEC §4.3, §4.6.4). (#177)
- **CI gate stuck red on a superseded run:** volleyd judges CI on a head by the latest run per workflow and trigger event. A run
  cancelled by `concurrency: cancel-in-progress` and replaced by a newer run on the same head no longer opens `ci_failed`
  (re-verify looped on it forever), and restart reconciliation ignores its cancelled check. A cancelled run that nothing
  replaced still fails, and now says to re-run it rather than to check the provider's status page. The evidence package lists
  superseded runs under `ci.superseded` (SPEC §4.6.8). (#176)
- **Reviewer hygiene follows the repository's visibility** (`public_hygiene: auto | on | off`, tunable, default `auto`). Under
  `auto` volleyd reads the repository's visibility once per wave version (`gh repo view`, journaled as
  `repo_visibility_detected`): a public repository, or one whose visibility cannot be read (`repo_visibility_unknown` alarm),
  keeps the P1 hygiene check and the required `hygiene` block; a private or internal one gets a non-blocking P3 note and an
  optional block. `on` forces P1, `off` drops the check. The wave state carries `repo_visibility` and `hygiene_level`;
  `volleyd status` prints `hygiene: P1 (public)` / `P3 (private)` / `off`. `review-result.schema.json` no longer lists
  `hygiene` as required (SPEC §4.6.4, §4.6.8). (#178)
- `volleyd steer` to a task between stages no longer goes to the retired agent's mailbox, where it was lost. With no live agent
  the steer is queued (`steering_queued`), the CLI says so, and the task's next agent (of the `--role`, when given) gets it when
  it registers, with the same `seq` / `supersedes` chain. `volleyd status` shows `steer queued (n)`; a cancelled or done task,
  or a stopped wave, drops the queue (`steering_dropped`). `--urgent` with no live agent is an error (SPEC §4.4, §4.6.3). (#179)

## 0.3.1 — 2026-10-20

Fixes from the owner's real-machine smoke of 0.3.0, and the first changes found by running a
downstream project's dispatch through volleyd.

### Added

- **`branch_update: rebase | merge`** (tunable, config or wave file). `merge` updates a PR branch by merging the release branch in
  and pushing normally, for repositories that allow no force-push of any kind. Verification accepts a merge commit and rejects
  rewritten history (SPEC §4.6.4, §4.6.8). (#155)
- **`agent_mcp: strict | inherit`** (tunable). `inherit` lets launched agents load the user's own MCP servers (plugin servers,
  connectors) alongside volleyd's `volley` server. Every Volley server in the session carries the agent's identity. (#155)
- **Desk window pinning:** pin a window in place, or anchor it to the screen; fit and arrange leave pinned windows alone. Pins
  follow the task slot, so a respawned agent keeps its window's pin. (#154)
- **What each agent is doing:** agent windows lead with a purpose line: the task title for wave agents, an optional `title` on
  `vol_register` for others, then the worktree name, never blank. The agent id becomes secondary. Needs-you notifications use
  the same label. (#169)
- **Sessions:** interactive Claude Code sessions registered by the hooks show as `session`, in their own group, titled from the
  cmux workspace. volley-hooks publishes a rate-limited, redacted work log (one line per tool call, never prompt text) and flips
  status between working and idle. A dispatched agent that reports no progress for 10 minutes gets a badge. (#169)
- The Terminal tab says why an agent launched outside volleyd has no screen. (#169)

### Fixed

- `volley setup` reruns are idempotent for the launchd services. Setup checks cmux socket access and explains Automation mode.
  `peer join` checks `claude`, `bun` and `tmux` on the non-interactive ssh PATH. Peer errors are faster and clearer. Device
  admin sign-ins expire, and in-use ones are never offered for revocation. (#151)
- The Desk's first load no longer flashes every retained (finished) agent, a reconnect over a slow link no longer empties the
  canvas, and agents with a registry entry but no status still get their window. The Desk also gains wave status chips with an
  "Ended" group, canvas drag that never selects text, and glow styles without scrollbars. (#152)
- Test suites no longer leak temp directories. A leak guard in CI fails a run that leaves any behind. (#170)
- An intermittent volleyd test ("sweeps once at start") was made deterministic. (#151)

## 0.3.0 — 2026-10-19

The onboarding release: a fresh machine reaches a phone-signed-in Desk, a paired second machine
and a second Claude account without reading source. It is also the first tag of everything listed
under 0.2.0, which was never tagged on its own. Owner smoke: [`SMOKE.md`](SMOKE.md) Plan 11 (and
[`docs/SMOKE-v0.2.md`](docs/SMOKE-v0.2.md) for the supervisor).

### Added

- **`volley setup`**, the first-run and repair wizard: broker (mosquitto ≥ 2.1), security (the
  Dynamic Security config with the diff shown and the old file backed up, a restart, both
  listeners checked against anonymous clients, and a choice about LAN access to the WebSocket
  listener), accounts (roles, fixed identities, the macOS keychain, a one-time admin token),
  services (volleyd, the hooks, the Desk served by `volley desk serve` on port 5199, and
  `volley` / `volleyd` installed in `~/.volley/bin`, runnable on any `PATH`), the admin token
  printed as a link to the Desk, and a phone sign-in QR code. Every step says
  what it will change before changing it, and a rerun changes nothing.
- **The Desk's onboarding**: the first-run setup wizard (the same five steps through volleyd's
  `setup_plan` / `setup_apply`), one-time sign-in links and admin tokens (`#signin=<token>`),
  Settings › Broker accounts, Setup & Security, Machines and Claude accounts & usage.
- **Broker accounts and one-time tokens** on mosquitto 2.1 Dynamic Security: `volley auth add |
  rotate | revoke | list | token | signin-link | redeem`, `volley auth migrate` from a
  `password_file` / `acl_file` setup.
- **Paired machines**: `volley peer invite | join | list | remove | run`: one code gives a
  second machine its own account, an ssh tunnel service and a health heartbeat.
- **Several Claude accounts**: `volley claude add | signin | list | sync | move`, usage meters
  from the statusLine, and an `account_limit` decision at `claude.warn_at_pct` (volleyd never
  switches accounts by itself).

- **SPEC** §4.6.9 Brief preface, §4.6.10 Accounts and one-time tokens, §4.6.11 Claude account
  profiles, §4.6.12 Usage metering, §4.6.13 Broker logins and §4.6.14 Machines and pairing, with
  their JSON Schemas.
- The Desk's **Settings window** (General, Appearance, Supervisor, About, sidebar search) and the
  slimmed dock; the agent window's **context meter and Claude account picker**.
- volleyd's **per-repo brief preface** (`.volley/brief-preface.md` in the wave's repo).

### Changed

- **Bun 1.3 and 1.4** are supported (`engines.bun` is `>=1.3 <1.5`); CI runs both.
- Broker auth needs **mosquitto 2.1 or newer** with the Dynamic Security plugin (no password or
  ACL files); an older broker is refused with `BROKER_TOO_OLD`.

## 0.2.0 — never tagged (shipped in 0.3.0)

The supervisor release: Volley grows from a messaging protocol into a dispatch system that
survives the coordinator session. Owner smoke path: [`docs/SMOKE-v0.2.md`](docs/SMOKE-v0.2.md).

### Added

- **`volleyd`** (`packages/volleyd`), the durable wave supervisor: wave files and an append-only
  journal per wave, a dependency scheduler, an authority fence over every external command,
  agent spawning (worktree, identity, cmux launch, registration check, per-worktree lock), the
  implement → review → fixup → merge-ready pipeline with merge detection, decisions, ownership and
  claim, pause/stop and the kill switch, steering with acks, heavy-operation leases, load-aware
  spawn admission, recovery (heartbeat alarms, known screens, credit exhaustion, sleep/wake,
  restart reconciliation), versioned wave files, screen tails, remote hosts over ssh + tmux, and a
  launchd service.
- **`volley-hooks`** (`packages/volley-hooks`): Claude Code hooks that register the real model,
  drain and ack the mailbox from a persistent session, persist steering, report idle /
  awaiting-input / heartbeats, and wrap heavy commands in leases.
- **Volley Desk** (`packages/volley-desk`), the new dashboard behind `volley dash`: an infinite
  canvas of wave and agent windows, attention tiers, steering, settings, arrange & fit,
  appearance, phone layout. The old dashboard stays reachable with `volley dash --legacy`.
- **Broker authentication and ACLs**: `volley auth init | add-agent | rm-agent`, the reference
  ACL in `examples/mosquitto-auth/`, credentials in every client. The bundled
  `examples/mosquitto-localhost.conf` now refuses anonymous clients.
- **Must-deliver mailbox** (SPEC §4.4): persistent sessions, message ids and end-to-end acks.
- SPEC §4.6 supervisor topics and their JSON Schemas; `/volley-issues` submits waves to volleyd.
- `volley lease` (`run`, `acquire`, `release`, `status`); `volley lease run --coordinator` for
  coordinator sessions. A refused login fails closed.
- `bun run check:spec-refs`: SPEC numbering and every `SPEC §` reference in the repo are checked
  in CI.

### Changed

- CI runs on `release/**` branches and pull requests to them, not only `main`.
- Every package reports the shared version from its `package.json` (`volley --version`,
  `volleyd --version`, the MCP server's version, the legacy dashboard's top bar).
- The parity test only rewrites `packages/volley-issues/parity-report.md` on request
  (`bun run parity:update`).

### Licensing

- The vendored React Bits components in `packages/volley-desk/src/rb/` keep their upstream
  licence (MIT + Commons Clause), documented in
  [`packages/volley-desk/THIRD_PARTY_NOTICES.md`](packages/volley-desk/THIRD_PARTY_NOTICES.md).

## 0.1.3 — 2026-05-16

`volley notify` and dashboard browser notifications. Earlier 0.1.x releases: see the git tags.
