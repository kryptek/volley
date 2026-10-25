# Install tests

Layers of tests check the one-command install. Layer 1 runs on every PR on GitHub's hosted
runners; Layers 2 and 4 run on fresh VMs on the paired Linux machine's self-hosted runner
(`.github/workflows/install-vm.yml`), on demand through one command (`verify.sh`, below) and
nightly.

| Layer | Where | What |
| --- | --- | --- |
| 1 | every PR: containers, a hosted Mac | install from nothing, `volley setup --yes`, the checks below |
| 2 | on demand and nightly: fresh Ubuntu 24.04 and Debian 13 VMs (multipass) | real systemd services, the first wave, a wave on a repository with no CI, a reboot, reconnect |
| 3 | retired | macOS on Tart, never run; macOS is Layer 1's hosted Mac and the owner smoke |
| 4 | on demand and nightly: a hub VM and a peer VM (multipass) | `volley machine add`, readiness, a task placed on the peer, a repository added by slug and placed there, removal |

Layer 3 (fresh macOS VMs) never booted a real VM and needed a second always-on Mac; it was
removed. The pair layer keeps its number, 4, so its `LAYER=4` labels in metrics, artifacts and the
changelog's history stay true.

## Layer 1

Layer 1 installs Volley from nothing on every PR (`.github/workflows/install.yml`): in fresh
Ubuntu 24.04 and Debian 13 containers, and on a GitHub-hosted Mac. Each job runs the one-command
install the way a person would, but unattended and against volley-sim (no GitHub, no Claude), then
checks what that person would check. The targets: the whole run in 15 minutes or less, no
questions under `--yes`, every `volley setup --check` row `done`.

| File | What it is |
| --- | --- |
| `run-layer1.sh` | The run: `linux <ubuntu-24.04\|debian-13>` (on the host, with Docker) or `macos` |
| `Dockerfile.ubuntu`, `Dockerfile.debian` | The fresh machine: a non-root user `owner` with password-less sudo in the stock cloud-image shape (group `sudo` plus a `NOPASSWD` drop-in) and mosquitto 2.1 built from source, nothing else. CI caches each by its content |
| `systemctl-stand-in.sh` | `systemctl` in the containers, which have no systemd |
| `metrics.ts` | The targets and the step summary's table (`summary`), the log scan for secrets (`scan`), redaction of setup's output (`redact`), the VM layers' checks (`verdict`, and `text`: CLI output never says `undefined`), and `verify.sh`'s table (`table`) |
| `metrics.test.ts`, `fixtures/` | Its tests (`bun test scripts/install-tests`) |

### What a run does

Linux, inside the container as `owner`:

1. Start mosquitto 2.1 with an anonymous config (listeners 1883 and 9001), the `container` layout.
   The user has no git identity (no `user.name`, no `user.email`, no `~/.gitconfig`): anything that
   pre-seeded one would hide "Author identity unknown".
2. `sh install.sh --source <checkout> --no-setup`: apt packages, bun, gh and Claude Code's
   installer, the `volley` / `volleyd` commands in `~/.volley/bin`.
3. `eval "$(volley sim env)"`, then `volley setup --yes --no-lan --layout container --simulated`.
   The container layout leaves the broker's restart to you ("restart your container yourself"):
   the run restarts mosquitto and runs setup again, as a person would. Then `git var
   GIT_COMMITTER_IDENT` is the identity setup's Sign-ins step gave git (`Volley Sim
   <1+volley-sim@users.noreply.github.com>`), and the test wave's scratch commit carries it.
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

### Running it locally

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

### The results

`$LAYER1_OUT` holds `summary.md` (the table the job adds to its step summary), `setup-metrics.json`
(the completing setup run's), `check.json`, `setup.log`, `setup-rerun.log` (what the second run
journaled), `volleyd.log`, `desk.log`, `unknown.jsonl` (argv volley-sim had no rule for) and
`transcript.log` (setup's output, redacted). CI uploads them as the job's artifact.

### The systemctl stand-in

It answers `systemctl --user is-active [--quiet] | daemon-reload | enable | disable [--now] |
start | restart | stop | show -p MainPID --value`, as `volley setup` and `install.sh` use it, and
runs a unit's `ExecStart=` as setup wrote it (systemd's quoting) with a user manager's environment
plus its `Environment=` lines, in its `WorkingDirectory=`, appending to its
`StandardOutput=append:` and `StandardError=append:` files. `Restart=` is not supervised: a
process that exits stays down, and `is-active` says so. Anything else exits 1 naming itself.

## Layers 2 and 4: fresh VMs

| File | What it is |
| --- | --- |
| `verify.sh [<branch>] [--version vX.Y.Z]` | The one command: dispatch `install-vm.yml` on a branch, watch it, print one pass/fail table |
| `run-layer2.sh`, `run-layer4.sh` | What the workflow runs: the preflight (multipass, bun, ssh), then the layer's script |
| `vm-linux.sh <ubuntu-24.04\|debian-13>` | Layer 2: one fresh VM with systemd |
| `vm-pair.sh` | Layer 4: a hub VM and a peer VM |
| `lib.sh` | What they share: the VM names, the run's ssh key, the cleanup trap, the waits, a test wave's submission (`submit_wave`), the text check (`check_text`, `capture`), the metrics hand-off, the tracking issue |
| `cloud-init.yaml` | The VMs' cloud-init: a user `volley` with password-less sudo in the stock cloud-image shape (group `sudo` plus a `NOPASSWD` drop-in), ssh with the run's key only |
| `vm.test.ts`, `stubs/` | The tests: each script, `verify.sh` and the workflow end to end against stand-in `multipass`, `ssh` (the fake VM) and `gh` |

### Running a verification

"Does a fresh machine install, set up and run a wave on this branch?" is one command, run from a
checkout with `gh` signed in (anywhere: it only talks to GitHub):

```sh
bash scripts/install-tests/verify.sh                       # the current branch
bash scripts/install-tests/verify.sh release/<date>-<theme>
bash scripts/install-tests/verify.sh --version vX.Y.Z      # after a tag: the published release
```

It dispatches `install-vm.yml` on the branch (`gh workflow run install-vm.yml --ref <branch>
[-f version=…]`), finds the run, waits for it (`gh run watch --exit-status`), downloads each job's
results into `$VM_OUT/run-<id>/` (default `./verify-results`) and prints one table: a row per
layer (`ubuntu-24.04`, `debian-13`, `pair`) with its result, its metrics (setup's wall time, the
install end to end, the layer's timings) and its first `FAIL:` line, then the run's URL. It exits
0 when the run succeeded and 1 when it did not (with the leftover-VM check from "Cleaning up" as
its last line), 2 on a usage error or when `gh` is not signed in. Paste the table wherever the
evidence belongs (a release PR, a decision); nothing posts it for you.

`gh workflow run install-vm.yml --ref <branch>` by hand is the same run without the table, and the
Actions tab's "Run workflow" button is the third way. `--version vX.Y.Z` installs that published
tag through curl instead of the branch's checkout: the path `install.yml` never tests, the
post-tag check.

**Queued means the runner is off.** The paired Linux machine carries the runner permanently, so a
run starts at once. When its jobs are still queued after 5 minutes `verify.sh` says
`no runner is online for volley-linux-vm: start the runner service on the paired Linux machine
(scripts/install-tests/README.md, The Linux box)` and keeps waiting: starting the service makes
the run proceed, no new dispatch needed. A dispatch during the nightly queues behind it (one
runner, `concurrency: install-vm`).

**The budget: 90 minutes from dispatch to table.** The jobs run one after another on the one
runner: Layer 2 on Ubuntu and on Debian (launch, install and setup in 15 minutes, the no-CI wave,
the reboot and its checks) at `timeout-minutes: 40` each, then Layer 4 (two VMs, pairing within 10
minutes, two waves on the peer) at `timeout-minutes: 60`.

Nothing runs by itself on a push or a PR, and no check is required: the owner decides when a
fresh-VM verification is worth the machine's time. The nightly (07:41 UTC, the default branch)
runs the same jobs to catch drift between asks and keeps multipass's images and the runner warm;
only the schedule opens or comments on the `install-tests` tracking issue. A dispatched run answers
whoever asked (the table, its step summaries, its artifacts) and touches no issue.

Each script takes `--version vX.Y.Z` to install that release (`install.sh` through curl, from the
tag) instead of this checkout, which it otherwise copies into the VM (tracked and untracked files,
not what `.gitignore` excludes) and installs with `--source`. Every VM runs
`volley setup --yes --no-lan --simulated` against volley-sim, as Layer 1 does, and nothing
before it: on the snap broker, setup runs its broker steps through sudo itself (`sudo -n`, the
VMs' sudo being password-less), as it does for a person.

### What each layer checks

**Layer 2** (`vm-linux.sh`): launch the VM from cloud-init; before the install, the user has no
git identity (`assert_no_git_identity`: `FAIL: the VM has a git identity before the install …`
otherwise); install, set up, `volley setup --check --json`; git commits as the simulated account
and every scratch clone's last commit carries it (`check_git_identity`). What a person reads
says nothing broken: `volleyd status <first wave>` (plain and `--json`) and `volley setup --check`
are kept (`status-first-wave.txt`, `status-first-wave.json`, `check-setup.txt`) and checked by
`metrics.ts text`, which fails on `undefined`, `NaN`, `[object Object]` and `null on` outside JSON
values (`FAIL: volleyd status prints 'undefined'`, #597's class). Then a wave on a repository with
no CI, as every real first wave is (#602's class): volleyd's user service gets
`VOLLEY_SIM_WORKFLOWS=0` through a drop-in (`~/.config/systemd/user/volleyd.service.d/sim.conf`,
`daemon-reload`, `restart`), the wave `hello-noci` is submitted on the scratch repository with
the same variable, and within 10 minutes (`noci_wave_ms`) its journal has `ci_mode_detected { mode:
"none" }`, no `ci_pending`, no decision but the wave's own `wave_complete`, and `wave_complete`
(`metrics.ts verdict wave --ci none`; `wave-noci-status.json`, `wave-noci-events.jsonl`); the
drop-in is removed before the reboot. Then `sudo reboot` and wait for a new boot (the boot time
moves), then: `--check` exits 0
within 2 minutes of ssh answering (`reboot_check_ms`), `volleyd.service` and
`volley-desk.service` are `systemctl --user is-active`, and volleyd's retained status is
`working` and newer than the boot. Under `--no-lan` the `phone` row may be `skipped`, as on
Layer 1's Mac: the VMs have a LAN address.

**Layer 4** (`vm-pair.sh`): two Ubuntu 24.04 VMs on multipass's private network. The hub is
installed and set up, with Layer 2's two identity checks around it; the peer gets this checkout as a peer install (`install.sh --peer`; `volley
machine add` would install the hub's release tag, which a checkout under test is not), the
simulator in every shell (a line at the top of `~/.bashrc`) and the simulated GitHub and Claude
sign-ins. The run's key is copied to the hub, which then runs `volley machine add volley@<peer>
--name peer --hub volley@<hub> --no-signin`. The checks: the hub's readiness verdict on `peer`
is ready within 10 minutes (`pair_ready_ms`) and `volley peer list --json` lists it; a second wave,
`hello-peer`, on the first wave's scratch repository with its one task `host: peer`, completes
with `task_placed` naming the peer and the simulated agent's commit of `src/T1.ts` in a clone on
the peer. Then a repository added by slug and placed on the peer (#596's class): both machines'
fake GitHubs share the hub's origins over ssh (`VOLLEY_SIM_ORIGINS=volley@<hub>:<origins>` in the
line at the top of both `~/.bashrc`s, the run's key on the peer too, and the peer's git pointed at
the hub's origin for `https://github.com/<slug>.git`, which is what volleyd's peer clone fetches);
the hub runs `gh repo create volley-sim/volley-slug-<run id> --private` (main and the release
branch pushed from a clone it then removes, so the hub holds none), then `volley repo add <slug>
--machine peer --wait`, whose `peer: ready (<path>)` must name a clone on the peer (`FAIL: the
peer's clone is reported at a hub path` otherwise); the wave `hello-slug` on that slug, its one
task `host: peer`, completes with `task_placed` naming the peer, no `REMOTE_REPO_MISSING` in its
journal, and `src/T1.ts` committed in the peer's clone (`slug_wave_ms`). `volley peer list`,
`volley repo add` and `volleyd status` of both waves go through the same text check as Layer 2's.
Last, `volley peer remove peer --now` stops `volley-peer.service` on the peer.

### What every run does

- Its VMs are named `volley-it-<run id>-<what>` (`$GITHUB_RUN_ID`, or `$VM_RUN_ID`), each part
  lower-cased with every character outside `[a-z0-9-]` turned into `-` (`ubuntu-24.04` becomes
  `ubuntu-24-04`): multipass's rule is a letter first, letters, digits and `-`, alphanumeric
  last, at most 63 characters, and a run whose name breaks it stops before launching. It refuses
  to start when a VM of such a name exists: that VM is not this run's, so it is left alone.
- An EXIT trap deletes the run's VMs (`multipass delete --purge`) whatever happened (success,
  failure, SIGINT), a launch that failed half way included, and the run's key with them. A
  cancelled job can outrun the trap, so each VM job of the workflow ends with a step that always
  runs, purges the VMs named `volley-it-<run id>-*` and only those, and prints any other
  `volley-it-` VM it sees without touching it.
- Each VM accepts one ssh key, made for the run (`ssh-keygen`, into `$VM_OUT/key/` with the
  rendered `cloud-init.yaml`; never `/tmp`, which a snap multipass cannot read) and written into
  cloud-init and copied to the hub and the peer (Layer 4). The trap removes `key/`; the
  workflow's uploads exclude it in case a killed run left it.
- Every check that fails prints `FAIL: …`; the run collects them all and exits 1 at the end.
- The results land in `$VM_OUT`: `summary.md` (the step summary's table), `metrics.json` (the
  run's metrics: setup's, the end to end, and the layer's timings such as `reboot_check_ms` and
  `pair_ready_ms`), `setup-metrics.json`, `check-setup.json` and `check.json` (after the
  reboot), `failures.md`, `transcript.log` (the run's output, redacted), the captured CLI output
  and, per wave, `<wave>-status.json` and `<wave>-events.jsonl` (Layer 2's `wave-noci-*`). The
  workflow uploads them (never `transcript.raw`, never `key/`).
- Under `VM_TRACK_ISSUE=1` (the scheduled nightly sets it; a dispatch never does) a failing run finds the one open issue labelled
  `install-tests` (creating the label and the issue when there is none) and comments on it: the
  layer, the run's URL, the failures and the table. One comment per failing run; close the issue
  once a nightly passes. Two runners failing within the same seconds may each open one.
- The workflow's `report` job (a hosted runner, after the other two, whatever they did) fails the
  workflow when any job's result is not `success`, and on the schedule comments on the same issue
  (same label, same title): a job that never found a runner, or stopped before the run's own
  reporting, is reported too. A scheduled failure therefore gets two comments: the run's, with
  the failures and the table, and the report's one-line results.

### Running the tests

```sh
bun test scripts/install-tests/vm.test.ts
```

They need no hypervisor: `stubs/` stands in for `multipass`, `ssh` and `gh`, recording every
call (`gh` also answers `verify.sh`'s run list, view, watch and download from files the test
writes). The ssh stand-in is the VM: it answers each command from rules the test writes, and
behaves as a VM does on a reboot (refused connections, then a later boot time).

### Running a layer by hand

On the Linux box (with multipass), from the repository root:

```sh
bash scripts/install-tests/run-layer2.sh ubuntu-24.04
bash scripts/install-tests/run-layer4.sh
```

### Cleaning up

A run always deletes its VMs, and the workflow's cleanup step purges the run's VMs once more; a
run killed with SIGKILL on a machine that then lost power cannot. The next run of the same run id
then refuses to start, and the cleanup step of any later run prints what it saw and left alone.
List what is left and delete it:

```sh
multipass list | grep volley-it-     # e.g. volley-it-<id>-ubuntu-24-04; then: multipass delete --purge <name>
```

## The Linux box (label `volley-linux-vm`)

Layers 2 and 4 run here. Any x86-64 or arm64 Linux machine with KVM (`/dev/kvm`), 8 GB of free
memory (Layer 4 runs two 4 GB VMs; `VM_MEMORY`, `VM_CPUS` and `VM_DISK` change the size) and
about 50 GB of free disk.

1. Install multipass: `sudo snap install multipass`. Check it: `multipass launch 24.04 --name
   probe && multipass delete --purge probe`. The snap is confined: it reads only files under
   your home directory that are not under a hidden directory of it (`~/.cache`, `~/.local`), and
   never `/tmp`. Every file a run hands it lives under `$VM_OUT`, so keep `VM_OUT` (and the
   runner's work directory, where the nightly puts it) under a non-hidden path of the home
   directory; with a snap multipass a run refuses any other `VM_OUT` up front (exit 2).
2. Install bun (`curl -fsSL https://bun.sh/install | bash`), git and the GitHub CLI.
3. Images: Ubuntu 24.04 is multipass's own. Debian 13 is its generic cloud image,
   `https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-<amd64|arm64>.qcow2`,
   which multipass downloads on each run; to keep a local copy, download it once and set
   `VM_DEBIAN_IMAGE=file:///path/to/debian-13-genericcloud-amd64.qcow2` in the runner's `.env`.
4. Register the runner: in the repository's Settings → Actions → Runners → New self-hosted
   runner, follow the Linux steps as an ordinary user (not root) in the multipass group, and give
   it the label `volley-linux-vm` (`./config.sh --labels volley-linux-vm`). Install it as a
   service: `sudo ./svc.sh install && sudo ./svc.sh start`. Registered, it runs the nightly and
   every `verify.sh`; while it is not (or its service is stopped) the jobs sit queued, `verify.sh`
   says so after 5 minutes, and on the schedule the `report` job tells the tracking issue.

One runner runs one job at a time: Layer 2's two distributions and Layer 4 take turns.

### The libvirt fallback

When multipass cannot run on the box (no snap, a conflicting hypervisor), the same VMs can come from
libvirt: `virt-install --import --cloud-init user-data=<the rendered cloud-init.yaml>` over the same
cloud images, `virsh domifaddr` for the address and `virsh destroy` + `virsh undefine
--remove-all-storage` to delete. lib.sh's `vm_exists`, `vm_delete`, `mp_launch` and `mp_addr` are
the four functions to replace; the rest of the run does not know which hypervisor it is on.
