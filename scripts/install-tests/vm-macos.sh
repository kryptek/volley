#!/bin/bash
# Layer 3 of the install tests (scripts/install-tests/README.md): a fresh macOS VM through Tart,
# cloned from a clean base image. Install Volley the way a person would (the curl path, or the
# Homebrew tap), run `volley setup` unattended against volley-sim, check launchd, the keychain,
# the Desk and the hooks, restart the VM and check again.
#
#   vm-macos.sh [--brew] [--version vX.Y.Z]
#
# The curl path installs this checkout (copied in, its install.sh piped into sh as `curl … | sh`
# would) or, with --version, the release's install.sh through curl. --brew runs `brew tap` and
# `brew install` instead, after installing Homebrew the way its own page says (and, with --version,
# checks that the tap installed that release).
# $VM_TART_BASE names the base image (default volley-macos-base), $VM_TART_KEY the private key it
# accepts (default ~/.ssh/id_ed25519). Results land in $VM_OUT
# (default ./vm-results); exit 1 when a check failed. The VM is deleted whatever happens.
# shellcheck disable=SC2317 # the functions poll and the trap call
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/install-tests/lib.sh
. "$HERE/lib.sh"

BREW=''
VERSION=''
usage() {
  echo "usage: vm-macos.sh [--brew] [--version vX.Y.Z]" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case $1 in
    --brew) BREW=1 && shift ;;
    --version)
      if [ $# -lt 2 ] || ! valid_version "$2"; then usage; fi
      VERSION=$2 && shift 2
      ;;
    *) usage ;;
  esac
done
LAYER=3
if [ -n "$BREW" ]; then LABEL=macos-brew; else LABEL=macos-curl; fi
BASE=${VM_TART_BASE:-volley-macos-base}
# The base image's account, and the key it accepts (README.md: the base image): a Tart VM has no
# cloud-init to give it the run's key.
VM_USER=${VM_USER_MACOS:-admin}
SSH_KEY=${VM_TART_KEY:-$HOME/.ssh/id_ed25519}

vm_exists() { tart get "$1" >/dev/null 2>&1; }
vm_delete() {
  tart stop "$1" >/dev/null 2>&1
  [ -n "${RUN_PID:-}" ] && kill "$RUN_PID" 2>/dev/null
  tart delete "$1"
}

RUN_PID=''
# Boot the VM headless (tart run stays in the foreground while it runs) and wait for ssh.
boot() {
  tart run --no-graphics "$NAME" >>"$OUT/tart-run.log" 2>&1 &
  RUN_PID=$!
  ADDR=$(tart ip "$NAME" --wait 180 2>>"$TRANSCRIPT")
  [ -n "$ADDR" ] || {
    fail "$NAME has no IP address"
    return 1
  }
  wait_ssh "$ADDR" 300
}

lib_init
NAME=$(vm_name "$LABEL") || exit 1
refuse_existing "$NAME"
track "$NAME"

t0=$(now_ms)
say "Cloning $BASE to $NAME"
tart clone "$BASE" "$NAME" >>"$TRANSCRIPT" 2>&1 || {
  fail "tart clone $BASE $NAME failed (is the base image there? README.md: the base image)"
  finish
}
boot || finish
timing launch_ms $(($(now_ms) - t0))

# The keychain needs a login session: a VM that boots to the login window has none.
say "The VM logs in by itself"
user=$(on "$ADDR" 'defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser' 2>/dev/null)
if [ -z "$user" ]; then
  fail "$BASE has no auto-login: the keychain needs a login session (README.md: the base image, step 4)"
  finish
fi

if [ -n "$BREW" ]; then
  # The base image has no Homebrew (README.md: the base image): install it as a person would.
  say "Installing Homebrew"
  # shellcheck disable=SC2016 # expanded on the VM
  on "$ADDR" 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' \
    >>"$TRANSCRIPT" 2>&1 || {
    fail "Homebrew did not install"
    finish
  }
  say "brew tap kryptek/volley; brew install kryptek/volley/volley"
  on "$ADDR" 'brew tap kryptek/volley && brew install kryptek/volley/volley' >>"$TRANSCRIPT" 2>&1 || {
    fail "brew install kryptek/volley/volley failed"
    finish
  }
  if [ -n "$VERSION" ]; then
    got=$(on "$ADDR" 'volley --version' 2>>"$TRANSCRIPT")
    case $got in
      *"${VERSION#v}"*) ;;
      *) fail "the tap installed '$got', not $VERSION" ;;
    esac
  fi
else
  say "install.sh (the curl path) --no-setup${VERSION:+ --version $VERSION}"
  install_volley "$ADDR" || {
    fail "install.sh exited non-zero"
    finish
  }
fi

say "volley setup --yes --no-lan --simulated"
setup_volley "$ADDR"
TOTAL_MS=$(($(now_ms) - t0))

# What a person on a Mac would look at: launchd, the keychain (exit code only: the password never
# reaches the output), the Desk, the hooks in Claude Code's settings.
mac_checks() {
  for agent in systems.volley.volleyd systems.volley.desk; do
    on "$ADDR" "launchctl print gui/\$(id -u)/$agent >/dev/null" || fail "launchd has no $agent$1"
  done
  on "$ADDR" 'security find-generic-password -s volley-broker -a coordinator >/dev/null 2>&1' ||
    fail "no volley-broker keychain item for the coordinator$1"
  on "$ADDR" 'curl -fsS http://127.0.0.1:5199/version.json' >"$OUT/version.json" 2>>"$TRANSCRIPT" ||
    fail "the Desk did not answer /version.json$1"
  on "$ADDR" 'grep -q /volley-hooks/src/hooks/ ~/.claude/settings.json' ||
    fail "the Volley hooks are not in ~/.claude/settings.json$1"
}
say "launchd, the keychain, the Desk, the hooks"
mac_checks ''

# A Tart VM's own reboot stops it (tart run exits): stop it and boot it again.
say "Restarting the VM"
t1=$(now_ms)
tart stop "$NAME" >>"$TRANSCRIPT" 2>&1
wait "$RUN_PID" 2>/dev/null
if boot; then
  timing reboot_ms $(($(now_ms) - t1))
  check_after_reboot "$ADDR"
  mac_checks ' after the restart'
fi

# --no-lan keeps the broker's WebSocket listener on loopback on a Mac: no phone reaches it.
summarize --total-ms "$TOTAL_MS" --allow-skipped phone
finish
