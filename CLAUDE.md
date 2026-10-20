# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Volley is an agent-messaging protocol — an MQTT topic + JSON envelope convention that lets agents from any vendor (Claude Code, Codex, plain shell scripts) coordinate across machines. This repo ships the spec, a reference MCP server, a CLI, the `volleyd` wave supervisor, Claude Code hooks, the Volley Desk dashboard, and Claude Code skills (`/volley`, `/volley-issues`).

**Status:** public; pre-1.0. The last tagged release is `v0.4.0` (the Fleet; owner smoke `SMOKE.md` Plan 12); every package is versioned `0.4.0`. `v0.3.0` shipped what `v0.2.0` planned (volleyd, volley-hooks, broker auth on mosquitto ≥ 2.1 Dynamic Security, the Desk; owner smoke path `docs/SMOKE-v0.2.md`) plus onboarding: `volley setup`, the Desk's setup wizard and one-time sign-in links, `volley peer` pairing and `volley claude` accounts (owner smoke: `SMOKE.md` Plan 11). `v0.4.0` adds the Fleet: `volley peer doctor` and Repair, readiness verdicts, automatic placement with a "why here" line, machine-aware leases, down/overload/drain handling and signing a paired machine in to Claude from the supervisor's browser. Canonical repository URL is in `spec/SPEC.md`.

**Authoritative docs (read these before changing anything substantive):**
- `spec/SPEC.md` — wire-format contract, MUST/SHOULD/MAY conformance, error codes
- `spec/schemas/` — the JSON Schemas that mirror it (`bun run validate:schemas`)
- each package's `README.md` — its behaviour in detail (`packages/volleyd/README.md` is the supervisor's reference)
- Design docs and per-phase plans live under `docs/superpowers/`, which is **gitignored** (local only). Never cite them by section number from tracked files (`bun run check:spec-refs` rejects it): readers of the public repo cannot follow the reference.

## Commands

All commands run from the repo root unless noted. Bun is the only runtime — no separate build step exists; the `bin` entries point at `.ts` files directly.

```sh
bun install              # set up workspace symlinks
bun run lint             # biome check .
bun run format           # biome format --write .
bun run typecheck        # root tsc + recurse into every workspace package
bun run test             # scripts/*.test.ts (bun test), then every package's test script
bun run validate:schemas # ajv-validates every spec/examples/{valid,invalid}/*.json against spec/schemas/
bun run check:spec-refs  # SPEC heading numbering is contiguous; every "SPEC §x.y" in the repo resolves
```

Per-package (drill in when iterating on volley-mcp):

```sh
cd packages/volley-mcp
bun run test                 # vitest run, Aedes-backed unit tests
bun run test:integration     # opt-in — runs against real mosquitto (needs VOLLEY_INTEGRATION=1; the script sets it)
bun run typecheck

bunx vitest run test/broker.test.ts              # single test file
bunx vitest run test/broker.test.ts -t 'LWT'     # single test by name pattern
```

volleyd (the wave supervisor daemon) has the same per-package shape:

```sh
cd packages/volleyd
bun run test                                   # vitest: pure modules + Aedes-backed daemon/control tests
bun src/cli.ts validate test/fixtures/example.yaml
VOLLEYD_HOME=$(mktemp -d) VOLLEY_BROKER_URL=mqtt://127.0.0.1:<private-port> bun src/cli.ts daemon
```

The mosquitto integration test is opt-in because it needs a real broker on `localhost:1883`. Locally: `brew services start mosquitto`. In CI: a docker mosquitto container is started by `.github/workflows/ci.yml` (`test-integration` job). Without `VOLLEY_INTEGRATION=1` the test self-skips.

## Architecture

**Bun workspace.** `volley-mcp` (MCP server), `volley-cli` (CLI, including `volley setup` in `src/setup/` and the broker-auth commands in `src/auth/`), `volley-desk` (the Desk, behind `volley dash`), `volley-dash` (the legacy dashboard), `volley-hooks` (Claude Code hooks), the skill packages, and `volleyd` (wave supervisor daemon).

**`packages/volley-mcp/` — the reference MCP server.** Strictly layered, single I/O boundary:
- `broker.ts` is the **only** file that imports `mqtt`. It wraps the client with `connect` (arms LWT), `publish`, `queryRetained` (subscribes to read the retained value at one topic), `subscribeCollect` (collects N messages or until a timeout), `disconnect`, `simulateCrash`.
- Pure helpers (no I/O, trivially unit-testable): `errors.ts`, `channels.ts` (SPEC §4.1 QoS/retain map), `topics.ts` (id/namespace grammar, topic builders, MQTT filter validation), `envelope.ts`, `config.ts` (env parsing + agent-id generation).
- `lifecycle.ts` sits on top of the broker: `startLifecycle` publishes initial `spawning` status and arms the LWT; `shutdownLifecycle` publishes a terminal status then DISCONNECTs (the clean DISCONNECT suppresses the LWT).
- `tools/*.ts` are pure `(state, input) => result` functions; `server.ts` wires them into an MCP `McpServer` with Zod input schemas; `index.ts` is the stdio entry point.

**`packages/volleyd/` — the wave supervisor daemon (pre-release).** Pure core, thin I/O shell:
- Pure: `wave-file.ts` (YAML → `spec/schemas/wave-file.schema.json` → normalised `Wave`, path-qualified errors), `reducer.ts` (journal events → T1 `wave-state` payload; idempotent by `seq`), `scheduler.ts` (critical-path-ordered `ready`, `admit` under hard ceiling + spawn budget), `fence.ts` (the authority fence over every external command).
- `exec.ts` is the **only** place a child process is spawned, and it calls the fence first (a test greps for it). Never spawn anywhere else.
- `journal.ts` (fsync'd JSONL per wave + snapshots), `config-store.ts` (defaults ← `$VOLLEYD_HOME/config.yaml` ← per-wave `config:`; `config_set` validated, journaled in `_system`, hot-applied). Tunable literals live only in `config-defaults.ts` (grep-guard test).
- `daemon.ts` registers as agent `volleyd`, answers control ops on its mailbox (`control.ts`: mailbox `query` → `ack` with the same `correlation_id`), and publishes retained `volley/_waves/<wave>/state` + the `/events` mirror after every journal append. `cli.ts` + `commands/*.ts` are thin wrappers; a new command is one line in the `cli.ts` command table.

**Why Aedes for unit tests.** `test/helpers/aedes-broker.ts` spawns a real in-process MQTT broker on a free port. Every "unit" test exercises the real `mqtt.js` client against real MQTT semantics — retained messages, QoS, LWT — without external dependencies. Mocking the broker would defeat the purpose.

**The seven tools (`vol_register`, `vol_publish`, `vol_query`, `vol_subscribe`, `vol_list_agents`, `vol_tap`, `vol_send_mailbox`) are the v0.1 contract.** Three more names (`vol_subscribe_async`, `vol_recv`, `vol_unsubscribe`) are *reserved* in SPEC §10 for v0.2+ async paths — do not redefine them.

## Conventions that aren't obvious from the code

- **No build step.** `package.json` `bin` fields point at `./src/*.ts` directly. Bun runs TS natively. Don't add a `dist/` build target.
- **Imports are extensionless.** `moduleResolution: "Bundler"` (in the root `tsconfig.json`) plus Bun's resolver both handle this. Biome enforces `useImportType` and `useNodejsImportProtocol` (so use `node:net`, not `net`).
- **`exactOptionalPropertyTypes: true`** is on. Optional properties must literally be optional in the type — passing `undefined` to a field typed `string` (not `string | undefined`) is an error. This bites at the MCP SDK boundary; see `server.ts` for the explicit `any` cast at `wrap()` (the SDK validates via Zod *before* the handler runs, so the cast is safe).
- **`exports` field gates cross-package imports.** When a package needs another's module, expose it via an `exports` map on the producer (the consumer imports `volley-mcp/<subpath>`). Don't reach into `packages/*/src/` via relative paths.
- **Temp dirs in tests go through `tempDir` / `tempDirForAll`** (each package's `test/helpers/tmp.ts`), never `mkdtemp` directly (`scripts/no-direct-mkdtemp.test.ts` rejects it): they are removed when the test or file ends, pass or fail. The root `test` script runs under `scripts/check-tmp-leaks.ts`, which fails on any Volley-prefixed entry a run leaves in the temp dir.
- **Commit message style:** see `git log --oneline` — scoped Conventional Commits (`feat(volley-mcp): ...`, `test(volley-mcp): ...`, `ci: ...`, `refactor(volley-mcp): ...`).

## Workflow rhythm

Each phase of the project gets its own HTML plan in `docs/superpowers/plans/` (local only, gitignored). The plan is written first (with the `superpowers:writing-plans` skill), then executed task by task with `superpowers:subagent-driven-development` — fresh implementer per task, spec-then-quality review per task, a final whole-implementation review before the release is tagged. Work for a release lands on a `release/<date>-<theme>` branch (CI runs on `release/**` pushes and PRs too) and reaches `main` with the release.

**Versions.** Every workspace package and the root share one version (a test in `volley-cli` enforces it). The `--version` output of `volley` / `volleyd`, the MCP server's reported version and the legacy dashboard's top bar all read it from their `package.json`; bump the `package.json` files (and `bun.lock`'s workspace entries) and add the `CHANGELOG.md` section (a `volley-cli` test checks all three agree); a minor bump also changes `version:` in `packages/volley-issues/SKILL.md` (its tests check major.minor).

Plans are HTML, not Markdown — user preference for this project.
