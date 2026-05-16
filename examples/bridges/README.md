# bridges — publish external events into Volley topics

A "bridge" is a small adapter that turns an event from somewhere outside the
Volley ecosystem — a CI run, a deploy, a webhook, a cron job — into a SPEC §3
envelope published on a Volley topic. Once an event is on a topic, any
subscriber (a `/wait` skill in a Claude Code session, a TUI dashboard, another
agent) can react to it without polling the source system.

Bridges are intentionally tiny: most are a single shell script or a few lines
of code in whatever language the source system natively speaks. They are not
long-lived services — each invocation is one publish and exit.

## The pattern

Every bridge follows the same recipe:

1. **Pull stable identifiers** out of the source system's environment
   (e.g. GitHub Actions injects `GITHUB_REPOSITORY` + `GITHUB_RUN_ID`).
2. **Compute a deterministic `agent_id`** from those identifiers so that any
   downstream subscriber can derive the same id and target the bridge's
   topic directly. Sanitise to SPEC §2.2 grammar `[a-z0-9][a-z0-9_-]{0,62}`:
   lowercase, hyphenate slashes, truncate to 63 chars.
3. **Publish a SPEC §3 envelope** to `volley/<ns>/<agent_id>/status` with
   the appropriate `type` (`working`, `done`, `failed`, etc.) and an
   optional `payload` carrying source-specific detail.
4. **Let subscribers wait.** A developer in Claude Code drops to `/wait
   <computed-agent-id>` and the session resumes the moment the bridge
   publishes a terminal status — no polling, no callbacks, no webhooks to
   wire up.

The bridge itself doesn't need to know who's listening or whether anyone is.
That decoupling is the whole point.

## Shipped bridges

| Bridge | Source | Topic shape |
|---|---|---|
| [`github-actions/`](./github-actions/) | GitHub Actions workflow steps | `volley/ci/gh-<owner>-<repo>-<run-id>/status` |

## Contributing a new bridge

A new bridge lives in its own subdirectory under `examples/bridges/`. The
minimum file structure is:

```
examples/bridges/<source-name>/
├── README.md                    # usage, env vars, workflow snippet
├── <publish-script>             # the bridge itself (any language)
└── test/<script>.bats           # contract test, mocking the volley CLI
```

The README must cover:

- Prerequisites (broker reachability, required CLI tools on the runner).
- The full set of env vars the bridge reads, with defaults.
- A copy-paste-ready snippet showing how to invoke the bridge from the
  source system's native config (YAML for CI, JSON for webhooks, etc.).
- A "Pair with `/wait`" section showing the agent_id form so a developer
  can compute it from the source system's identifiers and target the topic
  from a Claude Code session.

Follow the conventions in the github-actions bridge: bash + `set -euo
pipefail`, explicit exit codes (`2` for usage errors, propagate the
underlying publish exit code otherwise), prefer the `volley` CLI but fall
back to `mosquitto_pub` so the bridge works on runners that don't have the
Bun toolchain available.
