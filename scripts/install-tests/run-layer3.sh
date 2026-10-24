#!/bin/bash
# Layer 3 of the install tests (README.md), as the nightly runs it on the Mac's runner (label
# volley-macos-tart): the preflight (tart, the base image), then vm-macos.sh for one install path.
#
#   run-layer3.sh <curl|brew> [--version vX.Y.Z]
#
# Results land in $VM_OUT (default ./layer3-results).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
for tool in tart bun ssh ssh-keygen; do
  command -v "$tool" >/dev/null || {
    echo "run-layer3.sh: $tool is not on PATH (README.md: the Mac)" >&2
    exit 1
  }
done
base=${VM_TART_BASE:-volley-macos-base}
tart get "$base" >/dev/null 2>&1 || {
  echo "run-layer3.sh: no Tart image $base (README.md: the base image)" >&2
  exit 1
}
path=${1:-}
shift || true
export VM_OUT="${VM_OUT:-$PWD/layer3-results}"
case $path in
  curl) exec bash "$HERE/vm-macos.sh" "$@" ;;
  brew) exec bash "$HERE/vm-macos.sh" --brew "$@" ;;
  *)
    echo "usage: run-layer3.sh <curl|brew> [--version vX.Y.Z]" >&2
    exit 2
    ;;
esac
