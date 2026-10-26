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
# the peer's clone; a repository added by slug (#596: `gh repo create`, then
# `volley repo add <slug> --machine peer --wait` reporting a clone on the peer) runs the wave
# hello-slug there the same way, with no REMOTE_REPO_MISSING; `volley peer list`, `volley repo add`
# and `volleyd status` never say `undefined`; `volley peer remove` stops the peer's service.
# Results land in $VM_OUT (default ./vm-results); exit 1 when a check failed. Both VMs are deleted
# whatever happens.
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
SLUG_WAVE=hello-slug

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
assert_no_git_identity "$HUB"
install_volley "$HUB" || {
  fail "install.sh exited non-zero on the hub"
  finish
}
setup_volley "$HUB"
[ -n "$SETUP_OK" ] || finish
check_git_identity "$HUB"

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
capture "$HUB" 'volley peer list' peer-list.txt

# <wave> complete on the hub, its task T1 placed on the peer (`<wave>-status.json`,
# `<wave>-events.jsonl`); a REMOTE_REPO_MISSING in its journal says so at once (#596) and ends the
# poll (exit 3).
done_on_peer() {
  local wave=$1
  on "$HUB" "volleyd status $wave --json" >"$OUT/$wave-status.json" 2>/dev/null &&
    on "$HUB" "volleyd events $wave --cursor vm-pair" >"$OUT/$wave-events.jsonl" 2>/dev/null || return 1
  if grep -qi remote_repo_missing "$OUT/$wave-events.jsonl"; then
    echo "the wave $wave hit REMOTE_REPO_MISSING: volleyd found no clone of its repository on $PEER" >&2
    return 3
  fi
  metrics verdict wave --status "$OUT/$wave-status.json" --events "$OUT/$wave-events.jsonl" \
    --task T1 --host "$PEER"
}

# A second wave on the first wave's scratch repository, its one task pinned to the peer.
say "The wave $WAVE, host: $PEER"
t2=$(now_ms)
submit_wave "$HUB" first-wave "$WAVE" "Add PEER.md" "$PEER" >>"$TRANSCRIPT" 2>&1 ||
  fail "could not submit the wave $WAVE"
poll 900 done_on_peer "$WAVE" || fail "the wave $WAVE did not complete on $PEER (the line above)"
timing peer_wave_ms $(($(now_ms) - t2))
capture "$HUB" "volleyd status $WAVE" "$WAVE-status.txt" "volleyd status"
# The simulated implementer commits src/<task>.ts in the clone it worked in, on the peer.
# shellcheck disable=SC2016 # expanded on the peer
on "$PEER_ADDR" 'for g in $(find ~ -maxdepth 6 -name .git -prune 2>/dev/null); do git -C "${g%/.git}" log --all --format=%H -- src/T1.ts; done | grep -q .' ||
  fail "no commit of src/T1.ts in a clone on the peer"

# A repository added by slug (#596): no clone of it on the hub, one on the peer that volleyd makes.
# Both machines' fake GitHubs share the hub's origins over ssh (VOLLEY_SIM_ORIGINS, with the run's
# key), so the peer's `gh repo clone` and git reach the origin the hub's `gh repo create` made.
say "A repository added by slug, placed on $PEER"
t3=$(now_ms)
SLUG="volley-sim/volley-slug-$(run_id)"
# shellcheck disable=SC2016 # expanded on the hub
ORIGINS=$(on_sim "$HUB" 'printf "%s/origins" "$VOLLEY_SIM_HOME"' 2>>"$TRANSCRIPT")
if [ -z "$ORIGINS" ]; then
  fail "could not read the hub's origins directory (volley sim env)"
else
  SIM_ORIGINS="$VM_USER@$HUB:$ORIGINS"
  # The line both machines' shells (and the agents' launches) read first.
  SIM_LINE="export VOLLEY_SIM_ORIGINS=$SIM_ORIGINS; eval \"\$(\$HOME/.volley/bin/volley sim env)\""
  # git over ssh to the hub without a question, a new host key accepted. On the peer, the run's key
  # goes beside the key `volley machine add` made (which stays the pairing's), named for the hub alone.
  # Only the hub makes the origins directory: the fake gh treats an ssh base whose directory exists
  # here as this machine's own.
  vm_ssh "$PEER_ADDR" 'umask 077 && mkdir -p ~/.ssh && cat >~/.ssh/volley-it' <"$KEYDIR/id_ed25519" ||
    fail "could not copy the run's key to the peer"
  SET_ENV='chmod 600 ~/.ssh/config && cat - ~/.bashrc >~/.bashrc.it && mv ~/.bashrc.it ~/.bashrc'
  # shellcheck disable=SC2016 # expanded on the VM
  vm_ssh "$HUB" "mkdir -p $ORIGINS && printf 'Host $HUB\\n  StrictHostKeyChecking accept-new\\n' >>~/.ssh/config &&" \
    "$SET_ENV" <<<"$SIM_LINE" || fail "could not set VOLLEY_SIM_ORIGINS on $HUB"
  # shellcheck disable=SC2016 # expanded on the VM
  vm_ssh "$PEER_ADDR" "printf 'Host $HUB\\n  StrictHostKeyChecking accept-new\\n  IdentityFile ~/.ssh/volley-it\\n' >>~/.ssh/config &&" \
    "$SET_ENV" <<<"$SIM_LINE" || fail "could not set VOLLEY_SIM_ORIGINS on $PEER_ADDR"
  # volleyd's peer clone fetches https://github.com/<slug>.git: on the peer, that is the hub's origin.
  on "$PEER_ADDR" "git config --global url.$SIM_ORIGINS/$SLUG.git.insteadOf https://github.com/$SLUG.git" ||
    fail "could not point the peer's git at the hub's origin of $SLUG"
  # The repository, with main and the wave's release branch, and no clone left on the hub.
  # shellcheck disable=SC2016 # expanded on the hub
  on_sim "$HUB" "gh repo create $SLUG --private && d=\$(mktemp -d) && gh repo clone $SLUG \"\$d/c\" &&" \
    "git -C \"\$d/c\" commit -q --allow-empty -m root &&" \
    "git -C \"\$d/c\" push -q origin HEAD:main HEAD:release/$SLUG_WAVE && rm -rf \"\$d\"" \
    >>"$TRANSCRIPT" 2>&1 || fail "could not create $SLUG on the hub"
  capture "$HUB" "volley repo add $SLUG --machine $PEER --wait" repo-add.txt "volley repo add"
  CLONE=$(sed -n "s/^ *$PEER: ready (\\(.*\\))\$/\\1/p" "$OUT/repo-add.txt" | tail -n 1)
  if [ -z "$CLONE" ]; then
    fail "volley repo add did not report $PEER ready (repo-add.txt)"
  elif ! on "$PEER_ADDR" "git -C '$CLONE' rev-parse --git-dir" >/dev/null 2>>"$TRANSCRIPT"; then
    fail "the peer's clone is reported at a hub path ($CLONE is no clone on the peer)"
  fi

  say "The wave $SLUG_WAVE on $SLUG, host: $PEER"
  submit_wave "$HUB" "$SLUG" "$SLUG_WAVE" "Add SLUG.md" "$PEER" >>"$TRANSCRIPT" 2>&1 ||
    fail "could not submit the wave $SLUG_WAVE"
  poll 900 done_on_peer "$SLUG_WAVE"
  case $? in
  0) ;;
  3) fail "the wave $SLUG_WAVE hit REMOTE_REPO_MISSING: volleyd found no clone of $SLUG on $PEER" ;;
  *) fail "the wave $SLUG_WAVE did not complete on $PEER (the line above)" ;;
  esac
  timing slug_wave_ms $(($(now_ms) - t3))
  capture "$HUB" "volleyd status $SLUG_WAVE" "$SLUG_WAVE-status.txt" "volleyd status"
  check_text "$OUT/$SLUG_WAVE-status.json" "volleyd status --json"
  if [ -n "$CLONE" ]; then
    on "$PEER_ADDR" "git -C '$CLONE' fetch -q origin && git -C '$CLONE' log --all --format=%H -- src/T1.ts | grep -q ." ||
      fail "no commit of src/T1.ts in the peer's clone of $SLUG ($CLONE)"
  fi
fi

say "volley peer remove $PEER stops the peer's service"
on "$HUB" "volley peer remove $PEER --now" >>"$TRANSCRIPT" 2>&1 || fail "volley peer remove exited non-zero"
# Exit 3 is systemd's "inactive"; anything else (ssh's 255 among them) is not a stopped service.
stopped() {
  on "$PEER_ADDR" 'systemctl --user is-active --quiet volley-peer.service'
  [ $? -eq 3 ]
}
poll 120 stopped || fail "volley-peer.service still runs on the peer after volley peer remove"

# --no-lan on a VM with a LAN address skips the phone step.
summarize --total-ms $((t1 - t0)) --allow-skipped phone
finish
