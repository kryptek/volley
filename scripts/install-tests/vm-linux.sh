#!/bin/bash
# Layer 2 of the install tests (scripts/install-tests/README.md): a fresh Ubuntu 24.04 or Debian 13
# VM with systemd, through multipass. Install Volley there, run `volley setup` unattended against
# volley-sim, check that what a person reads (`volleyd status`, `volley setup --check`) never says
# `undefined`, run a second wave on a repository with no CI (hello-noci), reboot, and check that the
# services came back by themselves.
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

say "What a person reads says no 'undefined'"
# shellcheck disable=SC2016 # expanded on the VM
FIRST=$(on "$ADDR" 'f=$(ls -t ~/.volley/volleyd/first-wave/*/.volley/waves/hello-*.yaml | head -n 1); sed -n "s/^wave: //p" "$f"' 2>>"$TRANSCRIPT")
if [ -n "$FIRST" ]; then
  capture "$ADDR" "volleyd status $FIRST" status-first-wave.txt "volleyd status"
  capture "$ADDR" "volleyd status $FIRST --json" status-first-wave.json "volleyd status --json"
else
  fail "no first wave's file to read its name from (~/.volley/volleyd/first-wave)"
fi
capture "$ADDR" "volley setup --check" check-setup.txt "volley setup --check"

# Every real first wave runs on a repository with no workflows (#602): volleyd's service, as a
# person who edits it would, gets VOLLEY_SIM_WORKFLOWS=0 through a drop-in, removed before the
# reboot so the reboot's checks see the service as setup wrote it.
say "A wave on a repository with no CI (hello-noci)"
t2=$(now_ms)
# shellcheck disable=SC2088 # expanded on the VM
DROPIN='~/.config/systemd/user/volleyd.service.d'
RESTARTED=$(on "$ADDR" 'date +%s' 2>>"$TRANSCRIPT")
on "$ADDR" "mkdir -p $DROPIN && printf '[Service]\\nEnvironment=VOLLEY_SIM_WORKFLOWS=0\\n' >$DROPIN/sim.conf &&" \
  'systemctl --user daemon-reload && systemctl --user restart volleyd.service' >>"$TRANSCRIPT" 2>&1 ||
  fail "could not restart volleyd with VOLLEY_SIM_WORKFLOWS=0"
back() {
  on "$ADDR" 'volley sub --pattern volley/default/volleyd/status --max-messages 1 --timeout 10' |
    metrics verdict status --boot "${RESTARTED:-0}"
}
if poll 120 back; then
  SUBMIT_ENV='VOLLEY_SIM_WORKFLOWS=0' submit_wave "$ADDR" first-wave hello-noci "Add NOCI.md" \
    >>"$TRANSCRIPT" 2>&1 || fail "could not submit the wave hello-noci"
  noci() {
    on "$ADDR" 'volleyd status hello-noci --json' >"$OUT/wave-noci-status.json" 2>/dev/null &&
      on "$ADDR" 'volleyd events hello-noci --cursor vm-linux' >"$OUT/wave-noci-events.jsonl" 2>/dev/null &&
      metrics verdict wave --ci none --status "$OUT/wave-noci-status.json" --events "$OUT/wave-noci-events.jsonl"
  }
  poll 600 noci || fail "the wave hello-noci on a repository with no CI did not pass (the line above)"
  timing noci_wave_ms $(($(now_ms) - t2))
else
  fail "volleyd did not come back after the restart with VOLLEY_SIM_WORKFLOWS=0 (the line above)"
fi
on "$ADDR" "rm -f $DROPIN/sim.conf && systemctl --user daemon-reload" >>"$TRANSCRIPT" 2>&1 ||
  fail "could not remove volleyd's VOLLEY_SIM_WORKFLOWS drop-in"

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

# --no-lan on a VM with a LAN address skips the phone step.
summarize --total-ms "$TOTAL_MS" --allow-skipped phone
finish
