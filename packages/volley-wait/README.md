# volley-wait — the /wait Claude Code slash command

```
/wait <target> [--terminal-states ...] [--max-messages N] [--timeout S] [--namespace NS]
```

This is the Claude Code skill bundle for [Volley](../../README.md). Installed, it adds the `/wait` slash command — an event-driven block on a Volley topic. The skill backgrounds a `volley wait` or `volley sub` process, yields control so the conversation can keep working, and resumes within ~1s of the target event firing. Replaces the `sleep N; check status; sleep N` polling pattern.

The target is either an `agent_id` (expanded to `volley/<ns>/<id>/status` with terminal-state semantics) or a raw MQTT topic pattern (waits for the first matching message, or `--max-messages` of them).

## Prerequisites

- A running MQTT broker (mosquitto recommended): `brew services start mosquitto`.
- The [`volley-cli`](../volley-cli/) on `$PATH`. The skill shells out to `volley wait` and `volley sub` directly; it does NOT require the `volley-mcp` MCP server to be registered.

## Install

From the repo root:

```sh
bash packages/volley-wait/scripts/install.sh
```

This symlinks `packages/volley-wait/` into `~/.claude/skills/volley-wait/`. Edits to `SKILL.md` here are picked up immediately by Claude Code on the next slash invocation. After installing, quit Claude Code (Cmd-Q) and reopen — skills are discovered at startup.

To uninstall: `rm ~/.claude/skills/volley-wait`. The symlink is the only thing the install touches.

## Examples

Wait for a coordinator to reach a terminal state (default `done,blocked,failed,reaped`, default 1h timeout):

```
/wait coordinator-7b9c
```

Wait for any status message under the `ci` namespace; stop on the first match or after 30 minutes:

```
/wait volley/ci/+/status --max-messages 1 --timeout 1800
```

Wait at most 5 seconds for a specific agent (useful for fast smoke tests):

```
/wait coordinator-7b9c --timeout 5
```

## Full spec

The full invocation grammar, flag table, behavior steps, and exit-condition table are in [`SKILL.md`](./SKILL.md). That file is the contract Claude Code reads at slash-invocation time; this README is the human-facing overview.

## Smoke-test

The manual smoke-test checklist is at [`SMOKE.md`](./SMOKE.md). Walk through it before tagging a Volley release.

## License

Apache 2.0 — see the repo-root [`LICENSE`](../../LICENSE).
