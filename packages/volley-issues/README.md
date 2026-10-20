# volley-issues — dispatch GH issues via Volley

The Claude Code skill bundle for the Volley-based replacement of the legacy
[`dispatch-issues`](https://github.com/<tbd>/dispatch-issues) skill. Same
worktree-per-issue + cmux-workspace + `claude` CLI + GH PR flow; the
coordination layer (status reporting, completion detection, crash recovery)
is swapped from claude-peers/ScheduleWakeup to Volley.

## Prerequisites

- A running MQTT broker: `brew services start mosquitto`.
- The [`volley-mcp`](../volley-mcp/) server registered with Claude Code via
  `claude mcp add-json -s user volley '...'`, with a `VOLLEY_AGENT_ID` for
  this session and `VOLLEY_NAMESPACE=example-dispatch`. (Claude Code stores MCP
  servers separately from `settings.json`; do NOT hand-edit `settings.json`.)
  The install script prints the recommended `claude mcp add-json` command
  with the path filled in.
- `gh` CLI authenticated to the target repo.
- `claude` CLI installed and on `$PATH` (the spawned agents are real `claude`
  CLI processes).
- `cmux` CLI installed and on `$PATH` (the dispatched workspaces are cmux
  workspaces).
- For the default **volleyd path**: the [`volleyd`](../volleyd/) supervisor
  running (`volleyd status` exits 0). Without it the skill falls back to the
  legacy path.

## Install

```sh
bash packages/volley-issues/scripts/install.sh
```

Symlinks `packages/volley-issues/` into `~/.claude/skills/volley-issues/`.
Edits to SKILL.md here are picked up immediately by Claude Code.

To uninstall: `rm ~/.claude/skills/volley-issues`.

## Use

In a Claude Code session:

```
/volley-issues #22                  # dispatch one issue
/volley-issues #22,#23,#25          # dispatch a batch via release branch
/volley-issues --label enhancement  # dispatch every open issue with that label
```

The full surface is in [`SKILL.md`](./SKILL.md). Two dispatch paths:

- **Volleyd path** (default when `volleyd status` succeeds): the skill turns
  the issues into a wave file at `.volley/waves/<date>-<theme>.yaml`
  (`after:` lists come from `Depends on:` / `deps:` lines in the issue
  bodies), runs `volleyd validate` then `volleyd run --owner <coordinator id>`,
  and waits on the wave's decisions and merge-ready gates.
- **Legacy path**: the skill launches each agent itself and runs the
  per-agent "watch for terminal status, pick up the PR" loop.

## Wave file helper

`scripts/wave-from-issues.ts` is the pure helper behind the volleyd path:
issues JSON in, wave YAML out.

```sh
for n in 101 102 103; do gh issue view $n --json number,title,body; done | jq -s . > issues.json
bun run scripts/wave-from-issues.ts issues.json --wave 2026-10-18-example \
  --repo "$(git rev-parse --show-toplevel)" --release-branch release/2026-10-18-example \
  --model claude-opus-4-7 --out .volley/waves/2026-10-18-example.yaml
```

Each issue becomes a task named by its title's task tag (`O0: …` → `O0`), else `i<N>`; `Depends on: #101` becomes `after: [i101]` (or the tag of #101).
`--repo-slug <owner/repo>` also accepts `owner/repo#N` references and issue
URLs for this repository. A dependency outside the set is an error naming it,
unless it is listed in `--satisfied` (already merged); so is a dependency line
the helper cannot read (`Depends on: T3`): a dependency is never silently
dropped. Issues with no dependency line are reported on stderr so their order
can be confirmed. `--help` lists every option.

## Brief gate

`scripts/validate-brief.sh <brief>` refuses a spawn brief that lacks the
narration contract. The legacy path runs it before every launch; it can also be
installed as volleyd's `$VOLLEYD_HOME/brief-gate`, and accepts volleyd's own
briefs (whose session hooks register the agent instead of a `vol_register`
step). `test/validate-brief.test.ts` runs it against volleyd's templates.

## Parity vs. legacy

The [`parity-report.md`](./parity-report.md) committed at tag time records
the measured wake-latency comparison vs. the legacy claude-peers polling
loop. The parity test runs with every `bun run test` but only rewrites the
report when asked: `bun run parity:update` (at tag time). See [`SMOKE.md`](./SMOKE.md) for the manual downstream-repo validation
procedure run before each release.

## License

Apache 2.0 — see the repo-root `LICENSE`.
