# github-actions — publish CI status to a Volley topic

A drop-in bash script for GitHub Actions workflows. One step publishes a Volley
status envelope to `volley/<ns>/<agent_id>/status` so a developer's Claude Code
session — sitting in `/wait` — can resume the moment CI flips state, instead of
polling `gh run watch` or refreshing a browser tab.

## What it does

`publish-status.sh <type> [payload-json]` reads the standard `GITHUB_*` env
vars GitHub Actions injects into every step, computes a deterministic
`agent_id` from `GITHUB_REPOSITORY` + `GITHUB_RUN_ID`, and shells out to
`volley pub` (or `mosquitto_pub` as a fallback) to publish a SPEC §3 envelope
on the `status` channel.

The agent_id form is `gh-<owner>-<repo>-<run-id>`, lowercased, slashes
collapsed to hyphens, truncated to 63 chars — so a developer running `/wait`
in their Claude Code session can compute the same id from a PR number or a
local `gh run list` query and target it directly.

## Prerequisites

- **MQTT broker reachable from the runner.** Mosquitto on the developer's
  laptop is fine for local self-hosted runners; cloud runners need the broker
  exposed via a tunnel (Tailscale, Cloudflare Tunnel, ngrok) or a public TLS
  endpoint. See "Self-hosted vs. cloud runners" below.
- **One of:**
  - the `volley` CLI installed on the runner. Easiest: clone this repo on the runner, install [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`), and symlink the CLI onto `$PATH` (`ln -s "$PWD/packages/volley-cli/src/cli.ts" /usr/local/bin/volley` — `cli.ts` has `#!/usr/bin/env bun` so Bun must be on the runner). See [`packages/volley-cli/README.md`](../../../packages/volley-cli/README.md). Required for `mqtts://` brokers.
  - `mosquitto-clients` installed on the runner (`apt-get install -y
    mosquitto-clients` on Ubuntu; the script's fallback path uses
    `mosquitto_pub`). Plain-TCP `mqtt://` only — `mqtts://` requires the
    `volley` CLI path.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GITHUB_REPOSITORY` | yes | — | `owner/repo`, set automatically by GitHub Actions. |
| `GITHUB_RUN_ID` | yes | — | Numeric run id, set automatically by GitHub Actions. |
| `VOLLEY_AUTH_USERNAME` / `VOLLEY_AUTH_PASSWORD` | when the broker requires auth | — | Broker credentials, from repo secrets. The reference ACL ([`examples/mosquitto-auth/`](../../mosquitto-auth/README.md)) only lets a per-agent identity write its own channels, and the run's `gh-…` agent id is not known ahead of time, so use the `coordinator` identity (or mint `volley auth add-agent gh-<owner>-<repo>-<run-id>` per run). |
| `VOLLEY_BROKER_URL` | no | `mqtt://localhost:1883` | MQTT broker URL. Set this for cloud runners pointing at a public/tunneled broker. `mqtts://` requires the `volley` CLI on the runner (the `mosquitto_pub` fallback is plain-TCP only). |
| `VOLLEY_NAMESPACE` | no | `ci` | Volley namespace; the topic becomes `volley/<ns>/<agent_id>/status`. |

## Workflow snippet

Copy this into `.github/workflows/<your-workflow>.yml`:

```yaml
- name: Publish Volley status (working)
  run: ./examples/bridges/github-actions/publish-status.sh working

- name: Run tests
  id: test
  run: make test

- name: Publish Volley status (terminal)
  if: always()
  run: |
    if [[ "${{ steps.test.outcome }}" == "success" ]]; then
      ./examples/bridges/github-actions/publish-status.sh done '{"summary":"all green"}'
    else
      ./examples/bridges/github-actions/publish-status.sh failed '{"reason":"make test failed"}'
    fi
```

The first step flips the run to `working` so any waiter sees that the bridge
is alive. The terminal step runs with `if: always()` so it fires on both
success and failure, mapping the GitHub job outcome to a Volley terminal
status (`done` / `failed`). The optional second argument is forwarded
verbatim as the envelope's `payload`.

## Pair with `/wait`

Once the workflow is wired up, a developer can drop into a Claude Code
session and run:

```
/wait gh-<owner>-<repo>-<run-id> --namespace ci --timeout 1800
```

…where the agent_id is computed the same way the script computes it. The
`/wait` skill (see [`packages/volley-wait/`](../../../packages/volley-wait/)) backgrounds a
`volley wait` process and yields control. When the bridge publishes a
terminal `type` (`done` / `failed` / `blocked` / `reaped`), the Claude Code
harness fires a task-notification and the conversation resumes within ~1s
with a single summary line:

```
✅ gh-kryptek-volley-7891234567 reached done
```

No polling loop. No `sleep 60; gh run view`. The developer can carry on with
unrelated work in the same session until the wait resumes itself.

## Self-hosted vs. cloud runners

- **Self-hosted runners on the same network as the broker:** the default
  `mqtt://localhost:1883` (or a LAN address) just works. Easiest setup.
- **Cloud runners (`ubuntu-latest` etc.):** GitHub-hosted runners can't
  reach your local mosquitto. Options:
  - Expose your broker over the public internet with TLS + auth
    (`mqtts://broker.example.com:8883`) and set `VOLLEY_BROKER_URL` in the
    workflow's `env:` block or via repo secrets.
  - Run a managed broker (HiveMQ Cloud, EMQX Cloud) and point
    `VOLLEY_BROKER_URL` at it.
  - Tunnel the local broker out via Tailscale Funnel, Cloudflare Tunnel,
    or ngrok and set `VOLLEY_BROKER_URL` to the tunnel address.

In all cases, treat the broker URL as a secret if it carries credentials:
store it in the repo's GitHub Actions secrets, not in the workflow YAML.

## Test

A bats test pins the script's contract (env vars → captured `volley pub`
argv). To run it locally:

```sh
brew install bats-core   # one-time
bats examples/bridges/github-actions/test/publish-status.bats
```

The test uses a PATH shim to mock the `volley` CLI; it does not require a
broker.

## License

Apache 2.0 — see the repo-root `LICENSE`.
