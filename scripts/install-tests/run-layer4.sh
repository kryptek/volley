#!/bin/bash
# Layer 4 of the install tests (README.md), as install-vm.yml runs it on the Linux box's runner
# (label volley-linux-vm): the preflight, then vm-pair.sh.
#
#   run-layer4.sh [--version vX.Y.Z]
#
# Results land in $VM_OUT (default ./layer4-results).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
for tool in multipass bun ssh ssh-keygen; do
  command -v "$tool" >/dev/null || {
    echo "run-layer4.sh: $tool is not on PATH (README.md: the Linux box)" >&2
    exit 1
  }
done
export VM_OUT="${VM_OUT:-$PWD/layer4-results}"
exec bash "$HERE/vm-pair.sh" "$@"
