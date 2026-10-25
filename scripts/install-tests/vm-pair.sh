#!/bin/bash
# Layer 4 of the install tests (scripts/install-tests/README.md): two machines. A hub VM and a peer
# VM (Ubuntu 24.04, multipass) on multipass's private network; the hub set up against volley-sim,
# the peer made a paired machine with `volley machine add`, a wave placed on it, then removed.
#
#   vm-pair.sh [--version vX.Y.Z]
#
# The checks: `volley machine add` exits 0; the hub's readiness verdict on the peer is ready
# within 10 minutes (`pair_ready_ms`) and `volley peer list` lists it; the wave hello-peer
# (`host: peer`) completes with `task_placed` naming the peer and the simulated agent's commit in
# the peer's clone; `volley peer remove` stops the peer's service. Results land in $VM_OUT
# (default ./vm-results); exit 1 when a check failed. Both VMs are deleted whatever happens.
# shellcheck disable=SC2317 # the functions poll and the trap call
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/install-tests/lib.sh
. "$HERE/lib.sh"

VERSION=''
usage() {
  echo "usage: vm-pair.sh [--version vX.Y.Z]" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case $1 in
    --version)
      if [ $# -lt 2 ] || ! valid_version "$2"; then usage; fi
      VERSION=$2 && shift 2
      ;;
    *) usage ;;
  esac
done
LAYER=4
LABEL=pair
PEER=peer
WAVE=hello-peer

lib_init
HUB_VM=$(vm_name hub) || exit 1
PEER_VM=$(vm_name peer) || exit 1
refuse_existing "$HUB_VM"
refuse_existing "$PEER_VM"
track "$HUB_VM"
track "$PEER_VM"

t0=$(now_ms)
for vm in "$HUB_VM" "$PEER_VM"; do
  say "Launching $vm"
  mp_launch "$vm" ubuntu-24.04 || {
    fail "multipass launch $vm failed"
    finish
  }
done
HUB=$(mp_addr "$HUB_VM")
PEER_ADDR=$(mp_addr "$PEER_VM")
if [ -z "$HUB" ] || [ -z "$PEER_ADDR" ]; then
  fail "a VM has no IPv4 address (hub '$HUB', peer '$PEER_ADDR')"
  finish
fi
wait_ssh "$HUB" 300 || finish
wait_ssh "$PEER_ADDR" 300 || finish
timing launch_ms $(($(now_ms) - t0))

say "The hub: install.sh, volley setup --simulated"
install_volley "$HUB" || {
  fail "install.sh exited non-zero on the hub"
  finish
}
setup_volley "$HUB"
[ -n "$SETUP_OK" ] || finish

# The peer gets this checkout as the peer install (`machine add` would install the hub's release
# tag, which a checkout under test is not), the simulator in every shell (the agents' launches
# read ~/.bashrc), and the fake GitHub and Claude sign-ins. `machine add` skips what is in place.
say "The peer: install.sh --peer, the simulator, the sign-ins"
install_volley "$PEER_ADDR" --peer || {
  fail "install.sh --peer exited non-zero on the peer"
  finish
}
# shellcheck disable=SC2016 # expanded in the peer's shells
on "$PEER_ADDR" 'printf "%s\n" "eval \"\$(\$HOME/.volley/bin/volley sim env)\"" | cat - ~/.bashrc >~/.bashrc.it && mv ~/.bashrc.it ~/.bashrc' ||
  fail "could not add the simulator to the peer's ~/.bashrc"
on_sim "$PEER_ADDR" 'gh auth login --web --git-protocol https && claude auth login' >>"$TRANSCRIPT" 2>&1 ||
  fail "the simulated sign-ins failed on the peer"

# The hub reaches the peer with the run's key, which both VMs accept (cloud-init.yaml).
say "The run's key on the hub"
if ! vm_ssh "$HUB" 'umask 077 && mkdir -p ~/.ssh && cat >~/.ssh/id_ed25519' <"$KEYDIR/id_ed25519" ||
  ! vm_ssh "$HUB" 'cat >~/.ssh/id_ed25519.pub' <"$KEYDIR/id_ed25519.pub"; then
  fail "could not copy the run's key to the hub"
fi

say "volley machine add $VM_USER@$PEER_ADDR"
t1=$(now_ms)
on_sim "$HUB" "volley machine add $VM_USER@$PEER_ADDR --name $PEER --hub $VM_USER@$HUB --no-signin" \
  >>"$TRANSCRIPT" 2>&1 || fail "volley machine add exited non-zero"

say "The peer is ready within 10 minutes"
ready() {
  on "$HUB" "volley sub --pattern volley/_system/machines/$PEER/readiness --max-messages 1 --timeout 5" |
    metrics verdict ready --name "$PEER"
}
poll 600 ready || fail "the peer was not ready within 10 min (the line above)"
timing pair_ready_ms $(($(now_ms) - t1))
on "$HUB" 'volley peer list --json' >"$OUT/peer-list.json" 2>>"$TRANSCRIPT" ||
  fail "volley peer list --json exited non-zero"
bun -e 'const j = JSON.parse(await Bun.file(process.argv[1]).text()); process.exit((j.machines ?? []).some((m) => m.name === process.argv[2]) ? 0 : 1)' \
  "$OUT/peer-list.json" "$PEER" 2>/dev/null || fail "volley peer list does not list $PEER (peer-list.json)"

# A second wave on the first wave's scratch repository, its one task pinned to the peer.
say "The wave $WAVE, host: $PEER"
t2=$(now_ms)
vm_ssh "$HUB" "$PRELUDE eval \"\$(volley sim env)\"; bash -s $WAVE $PEER" >>"$TRANSCRIPT" 2>&1 <<'EOF' ||
set -eu
wave=$1 host=$2
f=$(ls -t "$HOME"/.volley/volleyd/first-wave/*/.volley/waves/hello-*.yaml | head -n 1)
repo=${f%/.volley/waves/*}
url=$(cd "$repo" && gh issue create --title "Add PEER.md" --body "The pair test's wave, on $host.")
sed -e "s/^wave: .*/wave: $wave/" -e "s/^  T1: .*/  T1: { issue: ${url##*/}, host: $host }/" "$f" \
  >"$repo/.volley/waves/$wave.yaml"
volleyd run "$repo/.volley/waves/$wave.yaml"
EOF
  fail "could not submit the wave $WAVE"
done_on_peer() {
  on "$HUB" "volleyd status $WAVE --json" >"$OUT/wave-status.json" 2>/dev/null &&
    on "$HUB" "volleyd events $WAVE --cursor vm-pair" >"$OUT/wave-events.jsonl" 2>/dev/null &&
    metrics verdict wave --status "$OUT/wave-status.json" --events "$OUT/wave-events.jsonl" \
      --task T1 --host "$PEER"
}
poll 900 done_on_peer || fail "the wave $WAVE did not complete on $PEER (the line above)"
timing peer_wave_ms $(($(now_ms) - t2))
# The simulated implementer commits src/<task>.ts in the clone it worked in, on the peer.
# shellcheck disable=SC2016 # expanded on the peer
on "$PEER_ADDR" 'for g in $(find ~ -maxdepth 6 -name .git -prune 2>/dev/null); do git -C "${g%/.git}" log --all --format=%H -- src/T1.ts; done | grep -q .' ||
  fail "no commit of src/T1.ts in a clone on the peer"

say "volley peer remove $PEER stops the peer's service"
on "$HUB" "volley peer remove $PEER --now" >>"$TRANSCRIPT" 2>&1 || fail "volley peer remove exited non-zero"
# Exit 3 is systemd's "inactive"; anything else (ssh's 255 among them) is not a stopped service.
stopped() {
  on "$PEER_ADDR" 'systemctl --user is-active --quiet volley-peer.service'
  [ $? -eq 3 ]
}
poll 120 stopped || fail "volley-peer.service still runs on the peer after volley peer remove"

# --no-lan on a VM with a LAN address skips the phone step, as on Layer 3's Mac.
summarize --total-ms $((t1 - t0)) --allow-skipped phone
finish
