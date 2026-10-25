#!/bin/bash
# Layer 2 of the install tests (scripts/install-tests/README.md): a fresh Ubuntu 24.04 or Debian 13
# VM with systemd, through multipass. Install Volley there, run `volley setup` unattended against
# volley-sim, reboot, and check that the services came back by themselves.
#
#   vm-linux.sh <ubuntu-24.04|debian-13> [--version vX.Y.Z]
#
# Without --version it installs this checkout (copied in); with it, the release through curl.
# Results land in $VM_OUT (default ./vm-results); exit 1 when a check failed (each printed as
# `FAIL: …`), after collecting them all. The VM is deleted whatever happens.
# shellcheck disable=SC2317 # the functions poll and the trap call
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/install-tests/lib.sh
. "$HERE/lib.sh"

DISTRO=${1:-}
VERSION=''
shift || true
while [ $# -gt 0 ]; do
  case $1 in
    --version)
      if [ $# -ge 2 ] && valid_version "$2"; then VERSION=$2 && shift 2; else DISTRO='' && break; fi
      ;;
    *) DISTRO='' && break ;;
  esac
done
if ! mp_image "$DISTRO" >/dev/null; then
  echo "usage: vm-linux.sh <ubuntu-24.04|debian-13> [--version vX.Y.Z]" >&2
  exit 2
fi
LAYER=2
LABEL=$DISTRO

lib_init
NAME=$(vm_name "$DISTRO") || exit 1
refuse_existing "$NAME"
track "$NAME"

t0=$(now_ms)
say "Launching $NAME ($DISTRO)"
mp_launch "$NAME" "$DISTRO" || {
  fail "multipass launch $NAME failed"
  finish
}
ADDR=$(mp_addr "$NAME")
[ -n "$ADDR" ] || {
  fail "$NAME has no IPv4 address"
  finish
}
wait_ssh "$ADDR" 300 || finish
timing launch_ms $(($(now_ms) - t0))

say "A fresh user: no git identity before the install"
assert_no_git_identity "$ADDR"
say "install.sh --no-setup${VERSION:+ --version $VERSION}"
install_volley "$ADDR" || {
  fail "install.sh exited non-zero"
  finish
}
say "volley setup --yes --no-lan --simulated"
setup_volley "$ADDR"
TOTAL_MS=$(($(now_ms) - t0))
say "git commits as the identity setup gave it"
check_git_identity "$ADDR"

say "Rebooting"
t1=$(now_ms)
if reboot_wait "$ADDR" 300; then
  timing reboot_ms $(($(now_ms) - t1))
  BOOT=$(boot_epoch "$ADDR")
  check_after_reboot "$ADDR"

  say "The services came back"
  for unit in volleyd.service volley-desk.service; do
    on "$ADDR" "systemctl --user is-active --quiet $unit" || fail "$unit is not active after the reboot"
  done
  say "volleyd's retained status is working, and from this boot"
  fresh() {
    on "$ADDR" 'volley sub --pattern volley/default/volleyd/status --max-messages 1 --timeout 10' |
      metrics verdict status --boot "${BOOT:-0}"
  }
  poll 60 fresh || fail "volleyd's retained status is not working and newer than the boot (the line above)"
fi

# --no-lan on a VM with a LAN address skips the phone step, as on Layer 3's Mac.
summarize --total-ms "$TOTAL_MS" --allow-skipped phone
finish
