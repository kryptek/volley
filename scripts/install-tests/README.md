# Install tests: Layer 1

Layer 1 installs Volley from nothing on every PR (`.github/workflows/install.yml`): in fresh
Ubuntu 24.04 and Debian 13 containers, and on a GitHub-hosted Mac. Each job runs the one-command
install the way a person would, but unattended and against volley-sim (no GitHub, no Claude), then
checks what that person would check. The targets: the whole run in 15 minutes or less, no
questions under `--yes`, every `volley setup --check` row `done`.

| File | What it is |
| --- | --- |
| `run-layer1.sh` | The run: `linux <ubuntu-24.04\|debian-13>` (on the host, with Docker) or `macos` |
| `Dockerfile.ubuntu`, `Dockerfile.debian` | The fresh machine: a non-root user `owner` with password-less sudo and mosquitto 2.1 built from source, nothing else. CI caches each by its content |
| `systemctl-stand-in.sh` | `systemctl` in the containers, which have no systemd |
| `metrics.ts` | The targets and the step summary's table (`summary`), the log scan for secrets (`scan`), and redaction of setup's output (`redact`) |
| `metrics.test.ts`, `fixtures/` | Its tests (`bun test scripts/install-tests`) |

## What a run does

Linux, inside the container as `owner`:

1. Start mosquitto 2.1 with an anonymous config (listeners 1883 and 9001), the `container` layout.
2. `sh install.sh --source <checkout> --no-setup`: apt packages, bun, gh and Claude Code's
   installer, the `volley` / `volleyd` commands in `~/.volley/bin`.
3. `eval "$(volley sim env)"`, then `volley setup --yes --no-lan --layout container --simulated`.
   The container layout leaves the broker's restart to you ("restart your container yourself"):
   the run restarts mosquitto and runs setup again, as a person would.
4. `volley setup --check --json`: every row `done`. `install.sh --check` exits 0. The Desk answers
   `/version.json`.
5. A second `volley setup --yes` applies nothing: the lines it adds to the setup journal are all
   `done` events.
6. No log line (`setup.log`, `volleyd.log`, `desk.log`, the world's `unknown.jsonl`) holds a
   broker password (read from the credentials files) or anything token-shaped.
7. `metrics.ts summary`: setup's wall time and the install's end to end at most 15 minutes, no
   questions, the test wave's PR merged, every `--check` row `done`.
8. `install.sh --uninstall`: neither `volleyd.service` nor `volley-desk.service` is still running.

macOS runs the same, with the install script piped into `sh` as `curl … | sh` does (Homebrew is
on the runner; no cmux, so tmux), `--layout` left to setup, and also checks that launchd has
`systems.volley.volleyd` and `systems.volley.desk` and that the `volley-broker` keychain item
exists (by exit code only). One row may differ: under `--no-lan` setup keeps the Mac's
WebSocket listener on loopback, so the `phone` row may be `skipped` (`--allow-skipped phone`);
`pending` or `blocked` there still fails.

Every check that fails prints `FAIL: …`; the run goes on to collect the rest and exits 1 at the
end, printing setup's output with the secrets redacted.

## Running it locally

You need Docker and a few minutes (the first build compiles mosquitto). From the repository root:

```sh
bash scripts/install-tests/run-layer1.sh linux ubuntu-24.04
bash scripts/install-tests/run-layer1.sh linux debian-13
```

It builds `volley-layer1:<distro>` (pass `LAYER1_IMAGE=<image>` to use one you built), copies this
checkout into a fresh container (tracked and untracked files, not what `.gitignore` excludes),
runs there, copies the results to `./layer1-results` (or `$LAYER1_OUT`) and removes the
container. The container publishes no ports, so the broker on your machine is never touched.

The macOS run changes the machine it runs on (Homebrew packages, launchd agents, a keychain item,
`~/.volley`): run it only on a throwaway Mac.

## The results

`$LAYER1_OUT` holds `summary.md` (the table the job adds to its step summary), `setup-metrics.json`
(the completing setup run's), `check.json`, `setup.log`, `setup-rerun.log` (what the second run
journaled), `volleyd.log`, `desk.log`, `unknown.jsonl` (argv volley-sim had no rule for) and
`transcript.log` (setup's output, redacted). CI uploads them as the job's artifact.

## The systemctl stand-in

It answers `systemctl --user is-active [--quiet] | daemon-reload | enable | disable [--now] |
start | restart | stop | show -p MainPID --value`, as `volley setup` and `install.sh` use it, and
runs a unit's `ExecStart=` as setup wrote it (systemd's quoting) with a user manager's environment
plus its `Environment=` lines, in its `WorkingDirectory=`, appending to its
`StandardOutput=append:` and `StandardError=append:` files. `Restart=` is not supervised: a
process that exits stays down, and `is-active` says so. Anything else exits 1 naming itself.
