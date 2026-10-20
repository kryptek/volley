# Changelog

All workspace packages share one version. Dates are release-tag dates.

## Unreleased

### Fixed

- An agent that ends its turn to wait on its own background work (a long test run, `gh run watch`) is no longer nudged or
  reported as stalled. volleyd reads the hooks' `background_wait` flag, a lease the agent holds, the running shells in its
  terminal footer, and recent writes under its worktree; `volleyd status` says `idle N min: <reason>`. A real stall's
  repeated `agent_stalled` decisions of one idle back off (each waits twice as long, capped by the new
  `stall_backoff_max_s`); the new `background_wait_max_s` bounds how long any of that evidence holds off the nudge, counted
  from the start of the idle (SPEC §4.3, §4.6.4). (#177)
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
