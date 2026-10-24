# Install tests

Four layers test the one-command install. Layer 1 runs on every PR on GitHub's hosted runners;
Layers 2–4 run nightly on the owner's machines as self-hosted runners
(`.github/workflows/install-nightly.yml`).

| Layer | Where | What |
| --- | --- | --- |
| 1 | every PR: containers, a hosted Mac | install from nothing, `volley setup --yes`, the checks below |
| 2 | nightly: fresh Ubuntu 24.04 and Debian 13 VMs (multipass) | real systemd services, a reboot, reconnect |
| 3 | nightly: fresh macOS VMs (Tart) | Homebrew, launchd, the keychain, the Desk; the curl and brew paths |
| 4 | nightly: a hub VM and a peer VM (multipass) | `volley machine add`, readiness, a task placed on the peer, removal |

## Layer 1

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
| `metrics.ts` | The targets and the step summary's table (`summary`), the log scan for secrets (`scan`), redaction of setup's output (`redact`), and the VM layers' checks (`verdict`) |
| `metrics.test.ts`, `fixtures/` | Its tests (`bun test scripts/install-tests`) |

### What a run does

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

## Layers 2–4: the nightly VMs

| File | What it is |
| --- | --- |
| `run-layer2.sh`, `run-layer3.sh`, `run-layer4.sh` | What the nightly runs: the preflight (the hypervisor, bun, ssh), then the layer's script |
| `vm-linux.sh <ubuntu-24.04\|debian-13>` | Layer 2: one fresh VM with systemd |
| `vm-macos.sh [--brew]` | Layer 3: one fresh macOS VM, the curl path or the Homebrew tap |
| `vm-pair.sh` | Layer 4: a hub VM and a peer VM |
| `lib.sh` | What they share: the VM names, the run's ssh key, the cleanup trap, the waits, the metrics hand-off, the tracking issue |
| `cloud-init.yaml` | The Linux VMs' cloud-init: a user `volley` with password-less sudo, ssh with the run's key only |
| `vm.test.ts`, `stubs/` | The tests: each script end to end against stand-in `multipass`, `tart`, `ssh` (the fake VM) and `gh` |

Each script takes `--version vX.Y.Z` to install that release (`install.sh` through curl, from the
tag) instead of this checkout, which it otherwise copies into the VM (tracked and untracked files,
not what `.gitignore` excludes) and installs with `--source`. Every VM runs
`volley setup --yes --no-lan --simulated` against volley-sim, as Layer 1 does.

### What each layer checks

**Layer 2** (`vm-linux.sh`): launch the VM from cloud-init, install, set up, `volley setup --check
--json`; then `sudo reboot` and wait for a new boot (the boot time moves), then: `--check` exits 0
within 2 minutes of ssh answering (`reboot_check_ms`), `volleyd.service` and
`volley-desk.service` are `systemctl --user is-active`, and volleyd's retained status is
`working` and newer than the boot.

**Layer 3** (`vm-macos.sh`): clone the base image, boot it headless (`tart run --no-graphics`),
wait for ssh, then fail at once when the VM did not log in by itself (no `autoLoginUser`: the
login keychain needs a login session). Install through the curl path (`install.sh` piped into
`sh`) or Homebrew (its `NONINTERACTIVE=1` installer), then `brew tap kryptek/volley` +
`brew install kryptek/volley/volley` (with `--version`, the version it installed must be that
one), set up, and check: launchd has `systems.volley.volleyd`
and `systems.volley.desk`, the `volley-broker` keychain item exists (exit code only), the Desk
answers `/version.json`, the hooks are in `~/.claude/settings.json`. Then stop the VM and boot it
again (a guest reboot ends `tart run`), `--check` green within 2 minutes, the same checks again.
Under `--no-lan` the `phone` row may be `skipped`, as on Layer 1's Mac.

**Layer 4** (`vm-pair.sh`): two Ubuntu 24.04 VMs on multipass's private network. The hub is
installed and set up; the peer gets this checkout as a peer install (`install.sh --peer`; `volley
machine add` would install the hub's release tag, which a checkout under test is not), the
simulator in every shell (a line at the top of `~/.bashrc`) and the simulated GitHub and Claude
sign-ins. The run's key is copied to the hub, which then runs `volley machine add volley@<peer>
--name peer --hub volley@<hub> --no-signin`. The checks: the hub's readiness verdict on `peer`
is ready within 10 minutes (`pair_ready_ms`) and `volley peer list --json` lists it; a second wave,
`hello-peer`, on the first wave's scratch repository with its one task `host: peer`, completes
with `task_placed` naming the peer and the simulated agent's commit of `src/T1.ts` in a clone on
the peer; `volley peer remove peer --now` stops `volley-peer.service` on the peer.

### What every run does

- Its VMs are named `volley-it-<run id>-<what>` (`$GITHUB_RUN_ID`, or `$VM_RUN_ID`). It refuses to
  start when a VM of such a name exists: that VM is not this run's, so it is left alone.
- An EXIT trap deletes the run's VMs (`multipass delete --purge`, `tart stop` + `tart delete`)
  whatever happened, a launch that failed half way included, and the run's key with them.
- Each VM accepts one ssh key, made for the run (`ssh-keygen`, in a temporary directory) and
  written into cloud-init (Linux) and copied to the hub (Layer 4). A Tart VM has no cloud-init:
  it accepts the runner user's key, which its base image holds (the Mac, step 2.3).
- Every check that fails prints `FAIL: …`; the run collects them all and exits 1 at the end.
- The results land in `$VM_OUT`: `summary.md` (the step summary's table), `metrics.json` (the
  run's metrics: setup's, the end to end, and the layer's timings such as `reboot_check_ms` and
  `pair_ready_ms`), `setup-metrics.json`, `check-setup.json` and `check.json` (after the
  reboot), `failures.md`, `transcript.log` (the run's output, redacted) and, for Layer 4,
  `peer-list.json`, `wave-status.json` and `wave-events.jsonl`. The nightly uploads them.
- Under `VM_TRACK_ISSUE=1` (the nightly sets it) a failing run finds the one open issue labelled
  `install-tests` (creating the label and the issue when there is none) and comments on it: the
  layer, the run's URL, the failures and the table. One comment per failing run; close the issue
  once a nightly passes. Two runners failing within the same seconds may each open one.

### Running the tests

```sh
bun test scripts/install-tests/vm.test.ts
```

They need no hypervisor: `stubs/` stands in for `multipass`, `tart`, `ssh` and `gh`, recording
every call. The ssh stand-in is the VM: it answers each command from rules the test writes, and
behaves as a VM does on a reboot (refused connections, then a later boot time).

### Running a layer by hand

On the Linux box (with multipass) or the Mac (with Tart and the base image), from the repository
root:

```sh
bash scripts/install-tests/run-layer2.sh ubuntu-24.04
bash scripts/install-tests/run-layer3.sh curl          # or brew
bash scripts/install-tests/run-layer4.sh
```

### Cleaning up

A run always deletes its VMs; one killed with SIGKILL, or a machine that lost power, cannot. The
next run of the same run id then refuses to start. List what is left and delete it:

```sh
multipass list | grep volley-it-     # then: multipass delete --purge <name>
tart list | grep volley-it-          # then: tart delete <name>
```

## The Linux box (label `volley-linux-vm`)

Layers 2 and 4 run here. Any x86-64 or arm64 Linux machine with KVM (`/dev/kvm`), 8 GB of free
memory (Layer 4 runs two 4 GB VMs; `VM_MEMORY`, `VM_CPUS` and `VM_DISK` change the size) and
about 50 GB of free disk.

1. Install multipass: `sudo snap install multipass`. Check it: `multipass launch 24.04 --name
   probe && multipass delete --purge probe`.
2. Install bun (`curl -fsSL https://bun.sh/install | bash`), git and the GitHub CLI.
3. Images: Ubuntu 24.04 is multipass's own. Debian 13 is its generic cloud image,
   `https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-<amd64|arm64>.qcow2`,
   which multipass downloads on each run; to keep a local copy, download it once and set
   `VM_DEBIAN_IMAGE=file:///path/to/debian-13-genericcloud-amd64.qcow2` in the runner's `.env`.
4. Register the runner: in the repository's Settings → Actions → Runners → New self-hosted
   runner, follow the Linux steps as an ordinary user (not root) in the multipass group, and give
   it the label `volley-linux-vm` (`./config.sh --labels volley-linux-vm`). Install it as a
   service: `sudo ./svc.sh install && sudo ./svc.sh start`.

One runner runs one job at a time: Layer 2's two distributions and Layer 4 take turns.

### The libvirt fallback

When multipass cannot run on the box (no snap, a conflicting hypervisor), the same VMs can come from
libvirt: `virt-install --import --cloud-init user-data=<the rendered cloud-init.yaml>` over the same
cloud images, `virsh domifaddr` for the address and `virsh destroy` + `virsh undefine
--remove-all-storage` to delete. lib.sh's `vm_exists`, `vm_delete`, `mp_launch` and `mp_addr` are
the four functions to replace; the rest of the run does not know which hypervisor it is on.

## The Mac (label `volley-macos-tart`)

Layer 3 runs here: an Apple silicon Mac with 16 GB of memory or more and about 100 GB of free disk.

1. Install Tart (`brew install cirruslabs/cli/tart`), bun and the GitHub CLI.
2. **The base image.** Start from a public clean image, never a machine of your own:
   `tart clone ghcr.io/cirruslabs/macos-sequoia-vanilla:latest volley-macos-base` (vanilla: no
   Homebrew, no Xcode; its account is `admin`, password `admin`). Then `tart run
   volley-macos-base` and, in the VM:
   1. Install the Xcode Command Line Tools: `xcode-select --install`.
   2. Turn on Remote Login (System Settings → General → Sharing).
   3. Add the runner user's public key to `~/.ssh/authorized_keys`. A Tart VM has no cloud-init
      to give it the run's own key, so the runs log in with this one: `~/.ssh/id_ed25519` of the
      runner user, or the private key `VM_TART_KEY` names (in the runner's `.env`).
   4. Turn on automatic login for `admin` (System Settings → Users & Groups → Automatically log
      in as). Without it the VM boots to the login window, the login keychain is locked and
      `vm-macos.sh` stops at once, saying so.
   5. Shut the VM down. Leave Homebrew off: each path installs it, as on a new Mac (the curl
      path through `install.sh`, the brew path with Homebrew's own `NONINTERACTIVE=1` installer
      before `brew tap`).
   `VM_TART_BASE` names another base image.
3. Register the runner as for the Linux box, the macOS steps, with the label `volley-macos-tart`,
   as the user that owns the Tart images.

The two install paths take turns on the one runner.
