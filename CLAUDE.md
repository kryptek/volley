# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Volley is an agent-messaging protocol — an MQTT topic + JSON envelope convention that lets agents from any vendor (Claude Code, Codex, plain shell scripts) coordinate across machines. This repo ships the spec, a reference MCP server, a CLI, a Claude Code skill, and dispatch-issues examples.

**Status:** public; pre-1.0. Most recent shipped phase is Plan 9 at `v0.1.3` (notify subcommand + dashboard browser notifications). Canonical repository URL is in `spec/SPEC.md`.

**Authoritative docs (read these before changing anything substantive):**
- `spec/SPEC.md` — wire-format contract, MUST/SHOULD/MAY conformance, error codes
- `docs/superpowers/specs/2026-05-14-volley-v0.1-design.html` — full design rationale, architecture diagram, slash-command set, dogfood plan
- `docs/superpowers/plans/2026-05-14-volley-v0.1-*.html` — one HTML plan per phase. Plans 1 and 2 are tagged (`v0.1.0-plan1`, `v0.1.0-plan2`).

## Commands

All commands run from the repo root unless noted. Bun is the only runtime — no separate build step exists; the `bin` entries point at `.ts` files directly.

```sh
bun install              # set up workspace symlinks
bun run lint             # biome check .
bun run format           # biome format --write .
bun run typecheck        # root tsc + recurse into every workspace package
bun run test             # bun run --filter='*' test — runs every package's test script
bun run validate:schemas # ajv-validates every spec/examples/{valid,invalid}/*.json against spec/schemas/
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

**Bun workspace.** `volley-mcp` (MCP server), `volley-cli` (CLI), `volley-dash` (dashboard), the skill packages, and `volleyd` (wave supervisor daemon).

**`packages/volley-mcp/` — the reference MCP server.** Strictly layered, single I/O boundary:
- `broker.ts` is the **only** file that imports `mqtt`. It wraps the client with `connect` (arms LWT), `publish`, `queryRetained` (subscribes to read the retained value at one topic), `subscribeCollect` (collects N messages or until a timeout), `disconnect`, `simulateCrash`.
- Pure helpers (no I/O, trivially unit-testable): `errors.ts`, `channels.ts` (SPEC §4.1 QoS/retain map), `topics.ts` (id/namespace grammar, topic builders, MQTT filter validation), `envelope.ts`, `config.ts` (env parsing + agent-id generation).
- `lifecycle.ts` sits on top of the broker: `startLifecycle` publishes initial `spawning` status and arms the LWT; `shutdownLifecycle` publishes a terminal status then DISCONNECTs (the clean DISCONNECT suppresses the LWT).
- `tools/*.ts` are pure `(state, input) => result` functions; `server.ts` wires them into an MCP `McpServer` with Zod input schemas; `index.ts` is the stdio entry point.

**`packages/volleyd/` — the wave supervisor daemon (pre-release).** Pure core, thin I/O shell:
- Pure: `wave-file.ts` (YAML → `spec/schemas/wave-file.schema.json` → normalised `Wave`, path-qualified errors), `reducer.ts` (journal events → T1 `wave-state` payload; idempotent by `seq`), `scheduler.ts` (critical-path-ordered `ready`, `admit` under hard ceiling + spawn budget), `fence.ts` (the authority fence over every external command).
- `exec.ts` is the **only** place a child process is spawned, and it calls the fence first (a test greps for it). Never spawn anywhere else.
- `journal.ts` (fsync'd JSONL per wave + snapshots), `config-store.ts` (defaults ← `$VOLLEYD_HOME/config.yaml` ← per-wave `config:`; `config_set` validated, journaled in `_system`, hot-applied). Tunable literals live only in `config-defaults.ts` (grep-guard test).
- `daemon.ts` registers as agent `volleyd`, answers control ops on its mailbox (`control.ts`: mailbox `query` → `ack` with the same `correlation_id`), and publishes retained `volley/_waves/<wave>/state` + the `/events` mirror after every journal append. `cli.ts` + `commands/*.ts` are thin wrappers; later tasks add one line each to the `cli.ts` command table.

**Why Aedes for unit tests.** `test/helpers/aedes-broker.ts` spawns a real in-process MQTT broker on a free port. Every "unit" test exercises the real `mqtt.js` client against real MQTT semantics — retained messages, QoS, LWT — without external dependencies. Mocking the broker would defeat the purpose.

**The seven tools (`vol_register`, `vol_publish`, `vol_query`, `vol_subscribe`, `vol_list_agents`, `vol_tap`, `vol_send_mailbox`) are the v0.1 contract.** Three more names (`vol_subscribe_async`, `vol_recv`, `vol_unsubscribe`) are *reserved* in SPEC §10 for v0.2+ async paths — do not redefine them.

## Conventions that aren't obvious from the code

- **No build step.** `package.json` `bin` fields point at `./src/*.ts` directly. Bun runs TS natively. Don't add a `dist/` build target.
- **Imports are extensionless.** `moduleResolution: "Bundler"` (in the root `tsconfig.json`) plus Bun's resolver both handle this. Biome enforces `useImportType` and `useNodejsImportProtocol` (so use `node:net`, not `net`).
- **`exactOptionalPropertyTypes: true`** is on. Optional properties must literally be optional in the type — passing `undefined` to a field typed `string` (not `string | undefined`) is an error. This bites at the MCP SDK boundary; see `server.ts` for the explicit `any` cast at `wrap()` (the SDK validates via Zod *before* the handler runs, so the cast is safe).
- **`exports` field gates cross-package imports.** When work in Plan 3+ adds cross-package consumers, expose modules via an `exports` map on the producer (the consumer imports `volley-mcp/<subpath>`). Don't reach into `packages/*/src/` via relative paths.
- **Commit message style:** see `git log --oneline` — scoped Conventional Commits (`feat(volley-mcp): ...`, `test(volley-mcp): ...`, `ci: ...`, `refactor(volley-mcp): ...`).

## Workflow rhythm

Each phase of the project gets its own HTML plan in `docs/superpowers/plans/`. The plan is written first (with the `superpowers:writing-plans` skill), then executed phase-by-phase with `superpowers:subagent-driven-development` — fresh implementer per phase, two-stage spec-then-quality review per phase, final whole-impl review on opus before tagging `v0.1.0-plan<N>`. Plans 1 and 2 are complete and tagged; Plan 3 (`volley-cli`) is the next in flight.

Plans are HTML, not Markdown — user preference for this project.
