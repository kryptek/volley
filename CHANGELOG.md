# Changelog

All workspace packages share one version. Dates are release-tag dates.

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
