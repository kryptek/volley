#!/bin/bash
# Layer 2 of the install tests (README.md), as install-vm.yml runs it on the Linux box's runner
# (label volley-linux-vm): the preflight, then vm-linux.sh for one distribution.
#
#   run-layer2.sh <ubuntu-24.04|debian-13> [--version vX.Y.Z]
#
# Results land in $VM_OUT (default ./layer2-results).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
for tool in multipass bun ssh ssh-keygen; do
  command -v "$tool" >/dev/null || {
    echo "run-layer2.sh: $tool is not on PATH (README.md: the Linux box)" >&2
    exit 1
  }
done
export VM_OUT="${VM_OUT:-$PWD/layer2-results}"
exec bash "$HERE/vm-linux.sh" "$@"
