# shellcheck shell=bash
# What Layers 2 and 4 of the install tests share (scripts/install-tests/README.md), sourced by
# vm-linux.sh and vm-pair.sh: the run's VM names (`volley-it-<run id>-<what>`), the run's ssh key,
# the cleanup trap that always deletes the run's VMs, waiting for ssh and for a reboot, a test
# wave's submission, the check that CLI output never says `undefined`, the metrics hand-off to
# metrics.ts and, on a failing nightly, the one tracking issue labelled `install-tests` (a comment
# per failure, through `gh`).
#
# The caller sets LAYER (2 or 4) and LABEL, defines `vm_exists <name>` and `vm_delete <name>`
# for its hypervisor, and calls `lib_init` first and `finish` last.
#
# The environment: VM_OUT (results, and the run's key and cloud-init under key/; default
# ./vm-results; with a snap multipass it must be under your home directory, not under a hidden
# directory of it: the snap reads nothing else), VM_RUN_ID (default $GITHUB_RUN_ID),
# VM_POLL_S (seconds between polls; default 3), VM_MAX_WAIT_S (caps every wait; the tests' stand-ins
# answer at once), VM_TRACK_ISSUE=1 (a failing run opens or comments
# on the tracking issue; the scheduled nightly sets it, a dispatch never), VM_MULTIPASS_IS_SNAP=1 (treat multipass as the snap
# wherever it is: the tests' seam, their stand-in is not under /snap/).
# Bash 3.2 (a Mac's /bin/bash): no associative arrays, no mapfile.

LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$LIB_DIR/../.." && pwd)
OUT="${VM_OUT:-$PWD/vm-results}"
POLL_S=${VM_POLL_S:-3}
# The account cloud-init makes (cloud-init.yaml).
VM_USER=volley
# The tracking issue's label (one open issue carries it).
TRACK_LABEL=install-tests
FAILED=0
TRANSCRIPT=''
KEYDIR=''
# The run's VMs, deleted on exit whatever happened; one name per line.
VMS=''
# Timings for the summary: ` --timing <name>=<ms>` each.
TIMINGS=''

say() { printf '==> %s\n' "$*"; }
# A release tag, vX.Y.Z: it goes into a command line on the VM, so nothing else is accepted.
valid_version() { [[ ${1:-} =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; }
fail() {
  printf 'FAIL: %s\n' "$*"
  printf -- '- %s\n' "$*" >>"$OUT/failures.md"
  FAILED=1
}
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
metrics() { bun "$LIB_DIR/metrics.ts" "$@"; }
timing() { TIMINGS="$TIMINGS --timing $1=$2"; }

# <text> as part of a VM name: lower case, every other character than [a-z0-9-] a `-`, runs of
# `-` squeezed, none at either end.
mp_name_part() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | tr -s '-' | sed 's/^-*//; s/-*$//'
}
# multipass's instance-name rule (a VM's name is its hostname): a letter first, letters, digits
# and `-`, alphanumeric last, at most 63 characters.
mp_valid_name() {
  [ "${#1}" -le 63 ] && [[ $1 =~ ^[a-z]([a-z0-9-]*[a-z0-9])?$ ]]
}
run_id() { mp_name_part "${VM_RUN_ID:-${GITHUB_RUN_ID:-local-$$}}"; }
# `volley-it-<run id>-<what>`, or exit 1 when that is no valid name.
vm_name() {
  local name
  name="volley-it-$(run_id)-$(mp_name_part "$1")"
  if ! mp_valid_name "$name"; then
    echo "not a valid VM name: $name" >&2
    return 1
  fi
  printf '%s' "$name"
}

# Whether multipass is the snap (confined: it reads only non-hidden paths under the home directory).
multipass_is_snap() {
  [ "${VM_MULTIPASS_IS_SNAP:-}" = 1 ] && return 0
  case "$(command -v multipass 2>/dev/null)" in /snap/*) return 0 ;; esac
  return 1
}
# Whether a snap multipass can read <path> (a real path): under $HOME, its first component there
# not hidden.
multipass_can_read() {
  local rest
  case "$1" in "$HOME"/*) rest=${1#"$HOME"/} ;; *) return 1 ;; esac
  case "$rest" in '' | .*) return 1 ;; esac
}

# The run's results directory, its transcript, its key and the trap. A key per run: the VMs
# accept only it (cloud-init.yaml), and it is removed with them. A snap multipass refuses an $OUT
# it cannot read (exit 2) before anything is written.
lib_init() {
  # multipass is handed the cloud-init under $OUT; a snap one reads only so much.
  if multipass_is_snap; then
    local real home
    real=$(realpath -m "$OUT") && home=$(realpath -m "$HOME") || exit 1
    if ! HOME=$home multipass_can_read "$real"; then
      echo "multipass is a snap and cannot read $OUT: set VM_OUT to a directory under your home directory that is not hidden" >&2
      exit 2
    fi
  fi
  mkdir -p "$OUT"
  : >"$OUT/failures.md"
  TRANSCRIPT="$OUT/transcript.raw"
  : >"$TRANSCRIPT"
  # The run's key and cloud-init: under $OUT (a snap multipass cannot read /tmp), removed on exit.
  KEYDIR="$OUT/key"
  rm -rf "$KEYDIR"
  mkdir -m 700 "$KEYDIR" || exit 1
  ssh-keygen -q -t ed25519 -N '' -C "volley-it-$(run_id)" -f "$KEYDIR/id_ed25519" || exit 1
  sed "s|@PUBKEY@|$(cat "$KEYDIR/id_ed25519.pub")|" "$LIB_DIR/cloud-init.yaml" >"$KEYDIR/cloud-init.yaml"
  trap cleanup EXIT
  trap 'exit 130' INT TERM
}

# Refuse to start when a VM of the run's name exists: it is not this run's to delete.
refuse_existing() {
  if vm_exists "$1"; then
    echo "a VM named $1 exists already; it is not this run's, so the run will not touch it." >&2
    echo "Delete it yourself if it is a leftover (README.md: Cleaning up), then run again." >&2
    exit 1
  fi
}

# From here the VM is the run's: the trap deletes it (tracked before its launch, so a launch that
# fails half way is cleaned up too).
track() { VMS="$VMS$1
"; }

cleanup() {
  code=$?
  for name in $VMS; do
    vm_exists "$name" || continue
    say "Deleting $name"
    vm_delete "$name" >/dev/null 2>&1 || printf 'WARN: could not delete %s; delete it by hand\n' "$name"
  done
  VMS=''
  [ -n "$KEYDIR" ] && rm -rf "$KEYDIR"
  exit "$code"
}

# ---------------------------------------------------------------------------------------------
# ssh

SSH_OPTS=(-o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
  -o ConnectTimeout=5 -o LogLevel=ERROR)

# One command on the VM at <addr>, with the run's key; stdin is the caller's (pass </dev/null when
# there is none).
vm_ssh() {
  local addr=$1
  shift
  ssh -i "$KEYDIR/id_ed25519" "${SSH_OPTS[@]}" "$VM_USER@$addr" "$*"
}

# A command on the VM in a new terminal's PATH (the line install.sh adds); `on_sim` also with the
# simulator (`volley sim env`), as Layer 1 runs setup.
# shellcheck disable=SC2016 # expanded on the VM
PRELUDE='export PATH="$HOME/.volley/bin:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH";'
on() {
  local addr=$1
  shift
  vm_ssh "$addr" "$PRELUDE $*" </dev/null
}
on_sim() {
  local addr=$1
  shift
  vm_ssh "$addr" "$PRELUDE eval \"\$(volley sim env)\"; $*" </dev/null
}

# <seconds>, or VM_MAX_WAIT_S when that is less.
cap() {
  if [ -n "${VM_MAX_WAIT_S:-}" ] && [ "$1" -gt "$VM_MAX_WAIT_S" ]; then echo "$VM_MAX_WAIT_S"; else echo "$1"; fi
}

# Wait until the VM answers ssh, at most <seconds>.
wait_ssh() {
  local addr=$1 deadline
  deadline=$(($(date +%s) + $(cap "$2")))
  until vm_ssh "$addr" true </dev/null >/dev/null 2>&1; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      fail "$addr did not answer ssh within $2 s"
      return 1
    fi
    sleep "$POLL_S"
  done
}

# Run <command...> until it succeeds, at most <seconds>, its stderr quiet until the last try (which
# prints why it still fails).
poll() {
  local deadline
  deadline=$(($(date +%s) + $(cap "$1")))
  shift
  until "$@" 2>/dev/null; do
    [ "$(date +%s)" -ge "$deadline" ] && {
      "$@"
      return
    }
    sleep "$POLL_S"
  done
}

# The boot time of a Linux VM (epoch seconds). Now minus the uptime, so it can move by a second
# between two calls: for comparing against a status's time, never to tell one boot from the next.
# shellcheck disable=SC2016 # expanded on the VM
boot_epoch() { vm_ssh "$1" 'date -d "$(uptime -s)" +%s' </dev/null 2>/dev/null; }
# The kernel's id of the current boot: it changes exactly once per boot.
boot_id() { vm_ssh "$1" 'cat /proc/sys/kernel/random/boot_id' </dev/null 2>/dev/null; }

# `sudo reboot`, then wait until the VM answers ssh from a new boot, at most <seconds>.
reboot_wait() {
  local addr=$1 before
  before=$(boot_id "$addr")
  [ -n "$before" ] || {
    fail "could not read the boot id of $addr before the reboot"
    return 1
  }
  vm_ssh "$addr" 'sudo reboot' </dev/null >/dev/null 2>&1
  # shellcheck disable=SC2317 # called through poll
  booted() {
    local b
    b=$(boot_id "$addr") && [ -n "$b" ] && [ "$b" != "$before" ]
  }
  poll "$2" booted || {
    fail "$addr did not come back from the reboot within $2 s"
    return 1
  }
}

# This checkout (tracked and untracked files, not what .gitignore excludes) into ~/volley there.
copy_checkout() {
  (cd "$REPO" && git ls-files -co --exclude-standard -z | tar --null -T - -czf -) |
    vm_ssh "$1" 'rm -rf ~/volley && mkdir -p ~/volley && tar -C ~/volley -xzf -'
}

# `install.sh --no-setup [<flags>]` on the VM: this checkout's, or the release's through curl.
install_volley() {
  local addr=$1
  shift
  if [ -n "${VERSION:-}" ]; then
    on "$addr" "curl -fsSL https://raw.githubusercontent.com/kryptek/volley/$VERSION/install.sh |" \
      "sh -s -- --version $VERSION --no-setup $*" >>"$TRANSCRIPT" 2>&1
  else
    copy_checkout "$addr" >>"$TRANSCRIPT" 2>&1 &&
      on "$addr" "sh -s -- --source ~/volley --no-setup $* <~/volley/install.sh" >>"$TRANSCRIPT" 2>&1
  fi
}

# `volley setup --yes --no-lan --simulated` on the VM, then its metrics and `--check` copied out.
SETUP_OK=''
setup_volley() {
  local addr=$1
  # As a person runs it: on Linux, setup takes the snap broker's steps through sudo itself.
  if on_sim "$addr" "volley setup --yes --no-lan --simulated" >>"$TRANSCRIPT" 2>&1; then
    # shellcheck disable=SC2034 # vm-pair.sh reads it
    SETUP_OK=1
  else
    fail "volley setup exited non-zero on $addr"
  fi
  on "$addr" 'cat ~/.volley/volleyd/setup-metrics.json' >"$OUT/setup-metrics.json" 2>/dev/null ||
    fail "setup wrote no setup-metrics.json on $addr"
  # Under the simulator, like setup: its sign-ins and the services' env are the simulated ones.
  on_sim "$addr" 'volley setup --check --json' >"$OUT/check-setup.json" 2>>"$TRANSCRIPT" ||
    fail "volley setup --check exited non-zero after setup (check-setup.json)"
}

# The identity setup's Sign-ins step gives git under the simulator (the simulated account's name
# and noreply address), and what the test wave's scratch commit must carry.
SIM_GIT_NAME='Volley Sim'
SIM_GIT_EMAIL='1+volley-sim@users.noreply.github.com'

# Before the install: the fresh user has no git identity (no user.name, no user.email, no
# ~/.gitconfig), so the one setup gives it is the only one. An image or a harness that pre-seeds
# one would hide "Author identity unknown" again.
assert_no_git_identity() {
  local addr=$1 seeded
  # shellcheck disable=SC2016 # expanded on the VM
  seeded=$(on "$addr" 'git config --global --get user.name; git config --global --get user.email;' \
    '[ ! -e ~/.gitconfig ] || echo "~/.gitconfig exists"' 2>>"$TRANSCRIPT")
  [ -z "$seeded" ] ||
    fail "the VM has a git identity before the install (the image or the harness pre-seeded one): $(printf '%s' "$seeded" | tr '\n' ' ')"
}

# After setup: git commits as the simulated account, and so did every test wave's scratch clone.
check_git_identity() {
  local addr=$1 ident logs line
  ident=$(on "$addr" 'git var GIT_COMMITTER_IDENT' 2>>"$TRANSCRIPT")
  printf 'check_git_identity: git var GIT_COMMITTER_IDENT: %s\n' "$ident" | tee -a "$TRANSCRIPT"
  case $ident in
    "$SIM_GIT_NAME <$SIM_GIT_EMAIL> "*) ;;
    *) fail "git does not commit as $SIM_GIT_NAME <$SIM_GIT_EMAIL> after setup: '$ident'" ;;
  esac
  # shellcheck disable=SC2016 # expanded on the VM
  logs=$(on "$addr" 'for c in ~/.volley/volleyd/first-wave/volley-hello-*; do' \
    '[ -d "$c/.git" ] && git -C "$c" log -1 --format=%an,%ae; done' 2>>"$TRANSCRIPT")
  printf 'check_git_identity: the scratch clones'"'"' last commits: %s\n' "$(printf '%s' "$logs" | tr '\n' ' ')" |
    tee -a "$TRANSCRIPT"
  [ -n "$logs" ] || fail "no test wave scratch clone to read the commit author of (~/.volley/volleyd/first-wave)"
  while IFS= read -r line; do
    [ -z "$line" ] || [ "$line" = "$SIM_GIT_NAME,$SIM_GIT_EMAIL" ] ||
      fail "a scratch clone's last commit is by '$line', not $SIM_GIT_NAME <$SIM_GIT_EMAIL>"
  done <<<"$logs"
}

# After a reboot: `volley setup --check` exits 0 within 2 minutes (the `reboot_check_ms` target),
# its report kept as check.json for the summary.
check_after_reboot() {
  local addr=$1 t0
  t0=$(now_ms)
  # shellcheck disable=SC2317 # called through poll
  check() { on_sim "$addr" 'volley setup --check --json' >"$OUT/check.json" 2>>"$TRANSCRIPT"; }
  poll 120 check || fail "volley setup --check was not green within 2 min of the reboot (check.json)"
  timing reboot_check_ms $(($(now_ms) - t0))
}

# ---------------------------------------------------------------------------------------------
# What a person reads, and the test waves

# Fail the run when CLI output in <file> says `undefined`, `NaN`, `[object Object]` or `null on`
# (metrics.ts text; JSON is a value, not text): `FAIL: <what> prints '<word>'`.
check_text() {
  local file=$1 what=$2 words
  words=$(metrics text "$file" 2>>"$TRANSCRIPT") && return 0
  if [ -n "$words" ]; then
    fail "$what prints '$(printf '%s\n' "$words" | head -n 1)' ($(basename "$file"))"
  else
    fail "$what: could not read $(basename "$file")"
  fi
}

# Run <command> on the VM at <addr> under the simulator (as setup ran), its output kept as <file>
# under $OUT and checked as text a person reads; [what] names it in a failure (default: <command>
# up to its first flag).
capture() {
  local addr=$1 cmd=$2 file=$3 what=${4:-}
  on_sim "$addr" "$cmd" >"$OUT/$file" 2>>"$TRANSCRIPT" || fail "$cmd exited non-zero on $addr ($file)"
  check_text "$OUT/$file" "${what:-${cmd%% -*}}"
}

# Submit the wave <wave> on the VM at <addr>, made from the newest wave file setup's first wave
# wrote: its one task T1 a new issue titled <title>, pinned to [host] when given. <repo> is
# `first-wave` (that wave's scratch repository, the file kept beside it), or an owner/name no clone
# on the VM holds (the file kept under ~/.volley/it-waves, its release branch `release/<wave>`,
# which the caller pushed). SUBMIT_ENV (`NAME=value ...`) is exported for `gh` and `volleyd run`.
submit_wave() {
  local addr=$1 repo=$2 wave=$3 title=$4 host=${5:-}
  vm_ssh "$addr" "$PRELUDE eval \"\$(volley sim env)\"; ${SUBMIT_ENV:+export $SUBMIT_ENV; }bash -s '$repo' '$wave' '$title' '$host'" \
    <<'EOF'
set -eu
repo=$1 wave=$2 title=$3 host=$4
f=$(ls -t "$HOME"/.volley/volleyd/first-wave/*/.volley/waves/hello-*.yaml | head -n 1)
if [ "$repo" = first-wave ]; then
  dir=${f%/.volley/waves/*}/.volley/waves
  url=$(cd "$dir" && gh issue create --title "$title" --body "The install test's wave $wave.")
  sub=''
else
  dir=$HOME/.volley/it-waves
  url=$(gh issue create --repo "$repo" --title "$title" --body "The install test's wave $wave.")
  sub="s|^repo: .*|repo: \"$repo\"|; s|^release_branch: .*|release_branch: release/$wave|;"
fi
mkdir -p "$dir"
sed -e "s/^wave: .*/wave: $wave/; $sub s/^  T1: .*/  T1: { issue: ${url##*/}${host:+, host: $host} }/" \
  "$f" >"$dir/$wave.yaml"
volleyd run "$dir/$wave.yaml"
EOF
}

# ---------------------------------------------------------------------------------------------
# multipass (Layers 2 and 4): a fresh VM from cloud-init

# multipass ships Ubuntu's images; Debian's is its generic cloud image (VM_DEBIAN_IMAGE overrides).
mp_image() {
  case $1 in
    ubuntu-24.04) printf '24.04' ;;
    debian-13)
      arch=amd64
      [ "$(uname -m)" = aarch64 ] || [ "$(uname -m)" = arm64 ] && arch=arm64
      printf '%s' "${VM_DEBIAN_IMAGE:-https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-$arch.qcow2}"
      ;;
    *) return 1 ;;
  esac
}
vm_exists() { multipass info "$1" >/dev/null 2>&1; }
vm_delete() { multipass delete --purge "$1"; }
# Launch <name> from <distro>'s image with the run's cloud-init.
mp_launch() {
  multipass launch "$(mp_image "$2")" --name "$1" --cloud-init "$KEYDIR/cloud-init.yaml" \
    --cpus "${VM_CPUS:-2}" --memory "${VM_MEMORY:-4G}" --disk "${VM_DISK:-20G}" --timeout 900 \
    >>"$TRANSCRIPT" 2>&1
}
# The VM's first IPv4 address.
mp_addr() {
  multipass info "$1" --format json |
    bun -e 'const j = JSON.parse(await Bun.stdin.text()); console.log(j.info[process.argv[1]].ipv4[0] ?? "")' "$1"
}

# ---------------------------------------------------------------------------------------------
# The end of a run

# The step summary's table and metrics.json, from the setup's metrics and the last --check.
summarize() {
  [ -f "$OUT/check.json" ] || cp "$OUT/check-setup.json" "$OUT/check.json" 2>/dev/null
  if [ ! -s "$OUT/setup-metrics.json" ] || [ ! -s "$OUT/check.json" ]; then
    fail "no summary: setup-metrics.json or check.json is missing"
    return
  fi
  # shellcheck disable=SC2086 # one word per flag
  GITHUB_STEP_SUMMARY="$OUT/summary.md" metrics summary --layer "$LAYER" --label "$LABEL" \
    --metrics "$OUT/setup-metrics.json" --check "$OUT/check.json" --yes --first-wave \
    --out "$OUT/metrics.json" $TIMINGS "$@" || fail "a target was missed (summary.md)"
}

# A failing nightly: one open issue labelled install-tests, a comment on it per failure.
track_failure() {
  [ "${VM_TRACK_ISSUE:-}" = 1 ] || return 0
  local run_url body number url
  run_url="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-kryptek/volley}/actions/runs/${GITHUB_RUN_ID:-local}"
  body="$OUT/issue-comment.md"
  {
    printf '### Layer %s: %s failed\n\n%s\n\n' "$LAYER" "$LABEL" "$run_url"
    cat "$OUT/failures.md"
    [ -f "$OUT/summary.md" ] && printf '\n' && cat "$OUT/summary.md"
  } >"$body"
  gh label create "$TRACK_LABEL" --color B60205 \
    --description "A nightly install test (Layers 2 and 4) failed" --force >/dev/null 2>&1
  number=$(gh issue list --label "$TRACK_LABEL" --state open --json number --jq '.[0].number // empty')
  if [ -z "$number" ]; then
    url=$(gh issue create --label "$TRACK_LABEL" --title "Nightly install tests are failing" \
      --body "The nightly install tests (scripts/install-tests/README.md, Layers 2 and 4) failed. Each failing run comments below; close this once a nightly passes.")
    number=${url##*/}
  fi
  [ -n "$number" ] && gh issue comment "$number" --body-file "$body" >/dev/null ||
    echo "WARN: could not comment on the tracking issue" >&2
}

finish() {
  metrics redact <"$TRANSCRIPT" >"$OUT/transcript.log" 2>/dev/null && rm -f "$TRANSCRIPT"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$OUT/summary.md" ]; then
    cat "$OUT/summary.md" >>"$GITHUB_STEP_SUMMARY"
  fi
  if [ "$FAILED" -ne 0 ]; then
    say "Layer $LAYER ($LABEL) failed. The run's output (redacted):"
    tail -n 200 "$OUT/transcript.log" 2>/dev/null
    track_failure
    exit 1
  fi
  say "Layer $LAYER ($LABEL) passed."
  exit 0
}
