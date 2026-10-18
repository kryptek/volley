# Changelog

All workspace packages share one version. Dates are release-tag dates.

## 0.2.0 — unreleased

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
