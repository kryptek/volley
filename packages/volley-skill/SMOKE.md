# Manual smoke checklist for the /volley skill

These steps verify the skill against a real mosquitto + a fake agent. CI cannot run them — they require a Claude Code session with the volley-mcp server registered. Run through every box before tagging a Volley release (most recently updated in `v0.1.0-plan6` for the auto-suffix flow).

## Setup (once)

- [ ] Volley installed with the one command (the root README's Quickstart), or `volley setup` run on this machine: `volley setup --check` reports every row `done` (the broker, the MCP server and this skill are in place)
- [ ] In a fresh Claude Code session, confirm `vol_list_agents` appears in the available MCP tools list. If not, see SKILL.md's Prerequisites (`volley setup --step claude-code`).

## Seed two fake agents

Plan 6's per-MCP-server-start auto-suffix means two Claude Code sessions
on this machine, sharing one user-scope MCP registration, automatically
get two DIFFERENT agent_ids (each MCP server picks its own `-XXXX`
suffix). To seed two agents:

### Step 1: open two Claude Code sessions

In two separate terminals (or two cmux workspaces), open Claude Code
against any cwd. Both inherit the same `claude mcp` registration, both
get the seven `vol_*` tools, both have agent_id prefix `coordinator`.

### Step 2: in each session, call `vol_register`

In **Session A**:

```
Claude, please call vol_register with capabilities=["smoke"], cwd="/tmp/smoke-a"
```

Expected response: `{ agent_id: "coordinator-XXXX", namespace: "default" }`
where `XXXX` is a 4-char suffix from `[a-z0-9]` picked by Session A's MCP server. **Record
this agent_id** — Session A is now known on the broker as this exact id.

In **Session B**:

```
Claude, please call vol_register with capabilities=["smoke"], cwd="/tmp/smoke-b"
```

Expected response: `{ agent_id: "coordinator-YYYY", namespace: "default" }`
where `YYYY` is a DIFFERENT 4-char suffix from Session A's. **Record this
agent_id** too.

Confirm the broker now holds two registry entries, one per session:

```sh
mosquitto_sub -h 127.0.0.1 -t 'volley/_system/registry/+' -v --retained-only
```

You should see two distinct retained payloads, one for `coordinator-XXXX`
and one for `coordinator-YYYY`. If you see only one, one of the sessions
hasn't called `vol_register` yet — re-check.

## `/volley list` checks

- [ ] `/volley list` shows both agents with status (⏳ registered for both — the seed only calls `vol_register`, so neither agent has advanced past `registered`).
- [ ] `/volley list --json` emits a JSON array; pipe through `jq '.[].agent_id'` mentally and confirm both ids are present.
- [ ] `/volley list --include-reaped` does not change the output (no reaped agents in the seed).
- [ ] `/volley list --namespace nonexistent` prints `(no agents registered)`.

## `/volley watch` checks

- [ ] Stage the `done` publish in another terminal in advance: `bun run packages/volley-cli/src/cli.ts pub --agent-id <Session-A-id> --channel status --type done`. Then in Claude Code: `/volley watch <Session-A-id>` — the skill prints the recent retained status (`registered`) and waits. Within 10s, run the staged `done` publish. Confirm the watch picks up the transition within ~1s and exits on the terminal state.
- [ ] `/volley watch` (no id) shows recent status messages across all agents.

## `/volley msg` checks

- [ ] `/volley msg <Session-A-id> hey check the new spec` sends a steering message. The mailbox channel is not retained (SPEC §4.1) so `inspect` won't work to confirm it landed — verify with `tap` instead (next box).
- [ ] In one Claude Code session: `/volley tap volley/default/<Session-A-id>/mailbox --max-messages 1 --timeout 10`. Then in another: `/volley msg <Session-A-id> --type nudge "ping"`. Confirm the message appears in the tap stream within the timeout.
- [ ] `/volley msg <Session-A-id> --type cancel "abort"` triggers a confirmation prompt before sending.
- [ ] `/volley msg Bad-Id "hi"` refuses with the grammar-mismatch error and does NOT call the tool.

## `/volley inspect` checks

- [ ] `/volley inspect <Session-A-id>` (id shorthand) pretty-prints the retained status envelope with a `last seen: Xs ago` line.
- [ ] `/volley inspect volley/default/<Session-B-id>/status` (full topic) does the same.
- [ ] `/volley inspect volley/default/nonexistent/status` prints `(no retained value at ...)`.

## `/volley tap` checks

- [ ] `/volley tap volley/default/+/status` emits two JSONL lines (one per agent). Each line is `topic\t<envelope JSON>`.
- [ ] `/volley tap volley/default/#/status` is rejected with `invalid topic filter` (mid-pattern `#`).
- [ ] `/volley tap volley/default/+/+ --max-messages 5 --timeout 5` exits after ~5s with the summary line.

## BROKER_DOWN check

- [ ] Stop the broker: `brew services stop mosquitto` (Linux snap: `sudo snap stop mosquitto`)
- [ ] `/volley list` prints `volley: cannot reach broker — make sure mosquitto is running.` and the `volley setup --check` hint, then stops without retrying.
- [ ] Start it again (cleanup): `brew services restart mosquitto` (Linux snap: `sudo snap start mosquitto`)

## Tear-down (after sign-off)

The seeded agents (`<Session-A-id>`, `<Session-B-id>`) and their retained status topics persist in mosquitto's retained store after the smoke. Future smoke runs against the same broker will see stale data unless cleared. To clear:

```sh
# Clear retained status + registry for each seeded agent.
# Replace <Session-A-id> and <Session-B-id> with the ids recorded in Seed step 2.
mosquitto_pub -t 'volley/default/<Session-A-id>/status'  -n -r
mosquitto_pub -t 'volley/default/<Session-B-id>/status'  -n -r
mosquitto_pub -t 'volley/_system/registry/<Session-A-id>' -n -r
mosquitto_pub -t 'volley/_system/registry/<Session-B-id>' -n -r
```

(`-n` sends an empty payload; `-r` sets retain=true; an empty retained payload clears the slot per MQTT semantics.)

## Sign-off

- [ ] All boxes ticked. Tick this last box AND record the date + HEAD commit in this section before committing the ticked-checklist file. Example: `Smoke passed 2026-05-15 against HEAD abcdef0.`
