# volley-skill — the /volley Claude Code slash command

This is the Claude Code skill bundle for [Volley](../../README.md). Installed, it adds the `/volley` slash command to your Claude Code sessions, wrapping the seven `volley-mcp` tools with human-friendly agent-handling commands.

## Prerequisites

Volley installed with the one command (the root README's [Quickstart](../../README.md#quickstart)): `volley setup` sets up the broker, registers the [`volley-mcp`](../volley-mcp/) server with Claude Code (no password in it) and links this skill. `volley setup --check` says what is missing (the Broker, Claude Code and Services rows); `volley setup --repair` fixes it.

## Install

`volley setup` links it (its Claude Code step). By hand, from the repo root:

```sh
bash packages/volley-skill/scripts/install.sh
```

This symlinks `packages/volley-skill/` into `~/.claude/skills/volley/`. Edits to `SKILL.md` here are picked up immediately by Claude Code on the next slash invocation.

To uninstall: `rm ~/.claude/skills/volley`. The symlink is the only thing the install touches.

## Verify

In a fresh Claude Code session:

```
/volley list
```

You should see either a list of agents or `(no agents registered)`. If `vol_list_agents` isn't in the tool list, the volley-mcp server isn't registered. Run `claude mcp list` to check; if `volley` is missing, `volley setup --step claude-code` registers it, then restart the Claude Code session.

## Subcommands

- `/volley list` — one-screen agent overview
- `/volley watch <id>` — live tail one agent
- `/volley msg <id> <text>` — send a mailbox message
- `/volley inspect <topic|id>` — read a retained topic
- `/volley tap <pattern>` — wildcard debug stream

Run `/volley` with no args (or any invalid subcommand) to print the full usage.

## Smoke-test

The manual smoke-test checklist is at [`SMOKE.md`](./SMOKE.md). Walk through it before tagging a Volley release.

## License

Apache 2.0 — see the repo-root `LICENSE`.
