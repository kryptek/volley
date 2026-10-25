# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Volley is an agent-messaging protocol — an MQTT topic + JSON envelope convention that lets agents from any vendor (Claude Code, Codex, plain shell scripts) coordinate across machines. This repo ships the spec, a reference MCP server, a CLI, the `volleyd` wave supervisor, Claude Code hooks, the Volley Desk dashboard, and Claude Code skills (`/volley`, `/volley-issues`).

**Status:** public; pre-1.0. The release in progress is `v0.13.0` (Getting started and reach from anywhere: the Desk's first-launch wizard, the Network step and the Desk over HTTPS on a private network, and the coordinator as a role volleyd keeps alive, opened from the Claude app on a phone; owner smoke `docs/SMOKE-v0.13.md`), which the owner tags after that run; every package is versioned `0.12.1` until the release PR bumps it. `v0.11.0` was install and machine roles (owner smoke `docs/SMOKE-v0.11.md`); `CHANGELOG.md` has each release since `v0.5.0` (Autopilot; owner smoke `SMOKE.md` Plan 13, owner's guide `docs/AUTOPILOT.md`) and `v0.4.0` (the Fleet; owner smoke `SMOKE.md` Plan 12). `v0.3.0` shipped what `v0.2.0` planned (volleyd, volley-hooks, broker auth on mosquitto ≥ 2.1 Dynamic Security, the Desk; owner smoke path `docs/SMOKE-v0.2.md`) plus onboarding: `volley setup`, the Desk's setup wizard and one-time sign-in links, `volley peer` pairing and `volley claude` accounts (owner smoke: `SMOKE.md` Plan 11). `v0.4.0` adds the Fleet: `volley peer doctor` and Repair, readiness verdicts, automatic placement with a "why here" line, machine-aware leases, down/overload/drain handling and signing a paired machine in to Claude from the supervisor's browser. `v0.5.0` adds Autopilot: a wave runs unattended (the policy table answers routine decisions, self-healing CI, merging under `merge: auto` through a merge queue, the release train, the needs-you inbox, the morning digest, stable coordinator identity, and a simulated soak in CI). Canonical repository URL is in `spec/SPEC.md`.

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
bun run check:spec-refs  # SPEC heading numbering is contiguous; every "SPEC §x.y" in the repo resolves;
                         # the SPEC lists match the schemas; spec/RESERVED.md holds
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
bun run test:shard 2/8                         # one CI shard (scripts/test-shards.ts; `--runner vitest` for vitest)
bun src/cli.ts validate test/fixtures/example.yaml
VOLLEYD_HOME=$(mktemp -d) VOLLEY_BROKER_URL=mqtt://127.0.0.1:<private-port> bun src/cli.ts daemon
```

**CI run sizes.** A PR runs the newest bun and the 8-task soak; a *full* run (every push to `main`, every push to `release/**` that is not reused (below), the nightly, a release PR, or a PR labelled `ci:full`) adds bun 1.3 and the 32-task soak. volleyd's suite runs in eight shards balanced by `packages/volleyd/test/timings.json` (volley-desk's in two vitest shards); after adding or slowing a test file noticeably, refresh it: `bun test --timeout 15000 --reporter=junit --reporter-outfile=/path/to/junit.xml` in `packages/volleyd`, then `bun ../../scripts/test-shards.ts timings /path/to/junit.xml`. A file not in the table yet still runs, in the shard its path hashes to. A push to `release/**` that is a PR's squash, whose tree that PR's newest pull_request run recorded (`tested-tree-<tree>` artifact) and passed, runs only `CI reused — this tree passed pull_request run <id>`, every other job `skipped` (`scripts/ci-reuse.ts`); anything else, and every push to `main`, runs everything. A reused push therefore gets neither bun 1.3 nor the 32-task soak (a task PR's run is not a full run); a wave's commits get those at the release PR, which never reuses, and on `main`.

**The install workflow.** `.github/workflows/install.yml` (Layer 1; every PR, every push to `main`/`release/**`, `workflow_dispatch`; never reused) installs Volley from nothing in fresh Ubuntu 24.04 and Debian 13 containers and on a hosted macOS runner, runs `volley setup --yes --simulated` against volley-sim and checks the targets (15 minutes, no questions, every `--check` row `done`, no secret in a log); the table lands in the step summary. Run it locally with Docker: `bash scripts/install-tests/run-layer1.sh linux ubuntu-24.04` (`scripts/install-tests/README.md`).

The mosquitto integration test is opt-in because it needs a real broker on `localhost:1883`. Locally: `docker run -d -p 1883:1883 -v "$PWD/packages/volley-mcp/test/integration/mosquitto.conf:/mosquitto/config/mosquitto.conf" eclipse-mosquitto:2` from the repo root (the anonymous test config CI uses; not the broker `volley setup` secured). On a machine `volley setup` already set up, its broker holds 1883: publish another port (`-p 1884:1883`) and point the test at it with `VOLLEY_BROKER_URL=mqtt://127.0.0.1:1884`. In CI: the same container is started by `.github/workflows/ci.yml` (`test-integration` job). Without `VOLLEY_INTEGRATION=1` the test self-skips.

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

**The overlap plan (volleyd).** Pure modules too: `footprint.ts` resolves an issue's Files list against the repository tree (`footprintOf`: paths, globs, `(new)`, identifiers dropped) into a task's footprint with a confidence; `overlap-plan.ts` (`planWave`, `explain`, `diffPlan`) clusters a wave's tasks by the source files they share and collapses, chains or caps each cluster (the `/volley-issues` helper writes the result into the wave file; the daemon runs it as written); `autopilot/churn.ts` reads the journal each tick and switches a churning cluster to `hold` or `train`; `autopilot/merge-train.ts` (`formTrain`) picks the gated PRs one merge train integrates and merges at once. Churn spawns (branch updates, re-reviews, trains, retries; `spawn-class.ts`) never spend the spawn budget. `packages/volleyd/README.md` ("Footprints and the overlap plan", "The merge train", "Spawn budget", "The replay") is the reference.

**Why Aedes for unit tests.** `test/helpers/aedes-broker.ts` spawns a real in-process MQTT broker on a free port. Every "unit" test exercises the real `mqtt.js` client against real MQTT semantics — retained messages, QoS, LWT — without external dependencies. Mocking the broker would defeat the purpose.

**The seven tools (`vol_register`, `vol_publish`, `vol_query`, `vol_subscribe`, `vol_list_agents`, `vol_tap`, `vol_send_mailbox`) are the v0.1 contract.** Three more names (`vol_subscribe_async`, `vol_recv`, `vol_unsubscribe`) are *reserved* in SPEC §10 for v0.2+ async paths — do not redefine them.

## Conventions that aren't obvious from the code

- **No build step.** `package.json` `bin` fields point at `./src/*.ts` directly. Bun runs TS natively. Don't add a `dist/` build target.
- **Imports are extensionless.** `moduleResolution: "Bundler"` (in the root `tsconfig.json`) plus Bun's resolver both handle this. Biome enforces `useImportType` and `useNodejsImportProtocol` (so use `node:net`, not `net`).
- **`exactOptionalPropertyTypes: true`** is on. Optional properties must literally be optional in the type — passing `undefined` to a field typed `string` (not `string | undefined`) is an error. This bites at the MCP SDK boundary; see `server.ts` for the explicit `any` cast at `wrap()` (the SDK validates via Zod *before* the handler runs, so the cast is safe).
- **`exports` field gates cross-package imports.** When a package needs another's module, expose it via an `exports` map on the producer (the consumer imports `volley-mcp/<subpath>`). Don't reach into `packages/*/src/` via relative paths.
- **No home-directory paths in tracked files.** The repository is public: docs and examples write `/path/to/<thing>` (`/path/to/repo`, `/path/to/volley`, `/path/to/worktrees`), and a test that needs a HOME passes `/path/to/home`. `scripts/no-home-paths.test.ts` fails on any `/home/<user>` or `/Users/<user>` outside its short allowlist.
- **Install instructions point at the one command.** Users install with `curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh` (the README Quickstart; `docs/INSTALL.md` has every flag and the Linux notes) and check with `volley setup --check`. `scripts/check-install-docs.test.ts` fails on a tracked `.md` that brings back a stale install instruction (an MCP registration carrying a password, starting the broker with `brew services` as a prerequisite, the old example namespace, a model id written out instead of naming `DEFAULT_MODEL` in `packages/volleyd/src/config-defaults.ts`); the test names each form, and `CHANGELOG.md` and `changes/` are exempt.
- **Temp dirs in tests go through `tempDir` / `tempDirForAll`** (each package's `test/helpers/tmp.ts`), never `mkdtemp` directly (`scripts/no-direct-mkdtemp.test.ts` rejects it): they are removed when the test or file ends, pass or fail. The root `test` script runs under `scripts/check-tmp-leaks.ts`, which fails on any Volley-prefixed entry a run leaves in the temp dir.
- **SPEC lists are one item per line.** The decision kinds (§4.6.2), wave events (§4.6.3) and tunables (§4.6.4) live between `<!-- spec-list: … -->` markers, and `check:spec-refs` fails when one differs from its schema (`decision.schema.json`, `wave-event.schema.json`, `config.schema.json`). Add a kind, event or key as a new line (with the schema change), never by editing a neighbour's line. Parallel tasks that add SPEC sections reserve the numbers in `spec/RESERVED.md` first.
- **Commit message style:** see `git log --oneline` — scoped Conventional Commits (`feat(volley-mcp): ...`, `test(volley-mcp): ...`, `ci: ...`, `refactor(volley-mcp): ...`).

## Workflow rhythm

Each phase of the project gets its own HTML plan in `docs/superpowers/plans/` (local only, gitignored). The plan is written first (with the `superpowers:writing-plans` skill), then executed task by task with `superpowers:subagent-driven-development` — fresh implementer per task, spec-then-quality review per task, a final whole-implementation review before the release is tagged. Work for a release lands on a `release/<date>-<theme>` branch (CI runs on `release/**` pushes and PRs too) and reaches `main` with the release. A batch's issues are planned too: write each issue's Files list as its footprint (the `/volley-issues` skill's "Planning a batch" section; `packages/volley-issues/templates/issue-plan.md` is the brief for an agent writing them), and run the skill's helper with `--plan-only` first to read the overlap plan before anything is filed or submitted.

**Versions.** Every workspace package and the root share one version (a test in `volley-cli` enforces it). The `--version` output of `volley` / `volleyd`, the MCP server's reported version and the legacy dashboard's top bar all read it from their `package.json`; bump the `package.json` files (and `bun.lock`'s workspace entries) and write the `CHANGELOG.md` section with `bun run changelog --version <v> --date <YYYY-MM-DD> --commit`, which assembles the `changes/` fragments (a `volley-cli` test checks all three agree); a minor bump also changes `version:` in `packages/volley-issues/SKILL.md` (its tests check major.minor). Once the tag is pushed, `volley deploy v<X.Y.Z>` moves the supervisor's machine to it: it rebuilds the Desk, restarts volleyd and the Desk, health-checks them and rolls back on failure.

**Changelog.** A PR never edits `CHANGELOG.md`: it adds a fragment, `changes/<issue>.<added|changed|fixed|removed|docs>.md` (format in `changes/README.md`). CI fails a PR that touches `packages/` or `spec/` without one (unless labelled `no-changelog`), and any commit outside a release commit (`release:` / `chore(release):`) that changes `CHANGELOG.md`.

Plans are HTML, not Markdown — user preference for this project.
