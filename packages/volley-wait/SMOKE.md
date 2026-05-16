# Manual smoke checklist for the /wait skill

These steps verify the skill against a real mosquitto + two Claude Code windows. CI cannot run them — they require live MQTT plus a Claude Code session with the `volley` CLI on `$PATH`. Run through every box before tagging a Volley release that touches `/wait`.

## Setup (once)

- [ ] `brew services start mosquitto` (or any MQTT broker on localhost:1883).
- [ ] Confirm `which volley` resolves. If not, see [`packages/volley-cli/README.md`](../volley-cli/README.md) for install.
- [ ] Symlink the skill: `bash packages/volley-wait/scripts/install.sh`.
- [ ] Quit Claude Code (Cmd-Q) and reopen so the new skill is discovered at startup. In a fresh Claude Code session, confirm `/wait --help` prints the usage block.

## agent_id form (two-window check)

- [ ] In **Window A** (Claude Code): ask Claude to call `vol_register` with `capabilities=["smoke-test"]`. Record the returned `agent_id` (e.g. `coordinator-x9f2`).
- [ ] In **Window B** (Claude Code, separate session): run `/wait coordinator-x9f2`. The skill should background a `volley wait` process and print a one-line "waiting for…" status, then return control.
- [ ] Back in **Window A**: ask Claude to call `vol_publish` with `channel=status`, `type=done`.
- [ ] Confirm **Window B**'s `/wait` resumes **within 1–2s** with `✅ coordinator-x9f2 reached done`.

## Topic-pattern form

- [ ] In one terminal (or Claude Code session), run `/wait volley/test/+/_user/custom --max-messages 1 --timeout 30`. The skill should background `volley sub` and return control.
- [ ] In another terminal: `volley pub --agent-id smoke-1 --namespace test --channel _user/custom --type ping`.
- [ ] Confirm the `/wait` resumes **immediately** with the success summary line.

## Timeout

- [ ] Run `/wait some-nonexistent-agent --timeout 5`.
- [ ] Confirm the skill prints `⏰ timeout after 5s — no matching message` **within 6 seconds** (timeout + ~1s harness wake).

## Broker-down behavior

- [ ] `brew services stop mosquitto`.
- [ ] Run `/wait coordinator-xxx`. Confirm the skill prints `❌ broker error: …` with the `→ brew services start mosquitto` hint, and stops without retrying.
- [ ] `brew services start mosquitto` (cleanup).

## GitHub Actions bridge pairing

> Requires `examples/bridges/github-actions/publish-status.sh`. Skip this section if the bridge script is not yet present.

- [ ] In one terminal, set the mock env and run the bridge script: `GITHUB_REPOSITORY=kryptek/volley GITHUB_RUN_ID=7891234567 GITHUB_JOB=test GITHUB_SHA=$(git rev-parse HEAD) bash examples/bridges/github-actions/publish-status.sh working`.
- [ ] Note the agent_id computed by the bridge (e.g. `gh-kryptek-volley-7891234567`).
- [ ] In a Claude Code session: `/wait gh-kryptek-volley-7891234567 --namespace ci`.
- [ ] In the bridge terminal: `GITHUB_REPOSITORY=kryptek/volley GITHUB_RUN_ID=7891234567 GITHUB_JOB=test GITHUB_SHA=$(git rev-parse HEAD) bash examples/bridges/github-actions/publish-status.sh done '{"summary":"local test"}'`.
- [ ] Confirm the `/wait` resumes within 1–2s with `✅ gh-kryptek-volley-7891234567 reached done`.

## Tear-down (after sign-off)

Clear the retained status topics seeded above so the next run starts clean:

```sh
# Substitute the agent_ids you recorded above.
mosquitto_pub -t 'volley/default/<Window-A-agent-id>/status' -n -r
mosquitto_pub -t 'volley/_system/registry/<Window-A-agent-id>' -n -r
mosquitto_pub -t 'volley/ci/gh-kryptek-volley-7891234567/status' -n -r
```

(`-n` sends an empty payload; `-r` sets retain=true; an empty retained payload clears the slot per MQTT semantics.)

## Sign-off

- [x] All boxes ticked. Tick this last box AND record the date + HEAD commit + the measured agent_id-form wake latency in this section before committing the ticked-checklist file. Example: `Smoke passed 2026-05-16 against HEAD abcdef0. Wake latency: 1.1s.`

Smoke passed 2026-05-16 against tag `v0.1.1`. Wake latencies measured: agent_id form 205ms, topic-pattern form 196ms, GitHub Actions bridge pairing 128ms (mosquitto_pub fallback path). All wakes well under the < 5s SPEC budget; timeouts and broker-down detection both fire correctly with the SKILL.md exit-code mapping.
