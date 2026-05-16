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

The full surface is in [`SKILL.md`](./SKILL.md). The skill's coordinator
loop is what handles the "watch for terminal status, pick up the PR" cycle;
just dispatch and let Claude work.

## Parity vs. legacy

The [`parity-report.md`](./parity-report.md) committed at tag time records
the measured wake-latency comparison vs. the legacy claude-peers polling
loop. See [`SMOKE.md`](./SMOKE.md) for the manual downstream-repo validation
procedure run before each release.

## License

Apache 2.0 — see the repo-root `LICENSE`.
