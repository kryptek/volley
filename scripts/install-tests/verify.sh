#!/bin/bash
# One command verifies a branch on fresh VMs (scripts/install-tests/README.md: Running a
# verification): dispatch install-vm.yml on <branch> (default: the current one), watch the run on
# the paired Linux machine's runner (Layer 2 on Ubuntu 24.04 and Debian 13, then Layer 4's hub and
# peer), download each job's results and print one pass/fail table.
#
#   verify.sh [<branch>] [--version vX.Y.Z]
#
# --version installs that published release through curl instead of the branch's checkout (the
# post-tag check). Exit 0 when the run succeeded, 1 when it did not, 2 on a usage error or when gh
# is not signed in. Nothing here gates anything: it runs when the owner asks.
#
# The environment: VM_OUT (where the results land, under run-<id>/; default ./verify-results),
# VERIFY_POLL_S (seconds between looks at the run; default 15), VERIFY_QUEUED_S (how long the jobs
# may sit queued before the no-runner notice; default 300), VERIFY_FIND_S (how long to look for the
# run the dispatch made; default 30).
# Bash 3.2 (a Mac's /bin/bash): no associative arrays, no mapfile.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
WORKFLOW=install-vm.yml
OUT=${VM_OUT:-$PWD/verify-results}
POLL_S=${VERIFY_POLL_S:-15}
QUEUED_S=${VERIFY_QUEUED_S:-300}
FIND_S=${VERIFY_FIND_S:-30}

usage() {
  echo "usage: verify.sh [<branch>] [--version vX.Y.Z]" >&2
  exit 2
}
BRANCH=''
VERSION=''
while [ $# -gt 0 ]; do
  case $1 in
    --version)
      { [ $# -ge 2 ] && [[ $2 =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; } || usage
      VERSION=$2 && shift 2
      ;;
    -*) usage ;;
    *)
      [ -z "$BRANCH" ] || usage
      BRANCH=$1 && shift
      ;;
  esac
done

if ! gh auth status >/dev/null 2>&1; then
  echo "verify.sh: gh is not signed in: run gh auth login, then try again" >&2
  exit 2
fi
if [ -z "$BRANCH" ]; then
  BRANCH=$(git -C "$HERE" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ -z "$BRANCH" ] || [ "$BRANCH" = HEAD ]; then
    echo "verify.sh: this checkout is on no branch: name one" >&2
    exit 2
  fi
fi

# <expression over j> of the JSON on stdin, printed (an object as JSON); nothing for null.
field() {
  bun -e "const t = await Bun.stdin.text(); const j = t.trim() === '' ? null : JSON.parse(t); const v = $1;
if (v !== undefined && v !== null) console.log(typeof v === 'object' ? JSON.stringify(v) : String(v));"
}
latest() {
  gh run list --workflow "$WORKFLOW" --branch "$BRANCH" --limit 1 --json databaseId 2>/dev/null |
    field 'j?.[0]?.databaseId'
}

BEFORE=$(latest)
echo "==> Dispatching $WORKFLOW on $BRANCH${VERSION:+ (installing $VERSION)}"
if ! gh workflow run "$WORKFLOW" --ref "$BRANCH" ${VERSION:+-f "version=$VERSION"}; then
  echo "verify.sh: gh workflow run $WORKFLOW --ref $BRANCH failed (the line above)" >&2
  exit 1
fi

# The dispatch prints no run id: the newest run of the workflow on the branch, once it is not the
# one that was newest before.
ID=''
deadline=$(($(date +%s) + FIND_S))
while :; do
  ID=$(latest)
  [ -n "$ID" ] && [ "$ID" != "$BEFORE" ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "verify.sh: no new $WORKFLOW run on $BRANCH within ${FIND_S} s of the dispatch (gh run list --workflow $WORKFLOW)" >&2
    exit 1
  fi
  sleep $((POLL_S < 2 ? POLL_S : 2))
done

view() { gh run view "$ID" --json status,conclusion,url,jobs; }
URL=$(view | field 'j.url')
echo "==> Run $ID: ${URL:-gh run view $ID}"

# Queued: the run, or every job it has, not started yet. The runner is always on, so jobs still
# queued after VERIFY_QUEUED_S mean it is not: say so once, and keep waiting (starting the runner
# service makes the run proceed, no new dispatch needed).
started=$(date +%s)
noticed=''
while :; do
  state=$(view | field '(j.status === "queued" || (j.jobs ?? []).every((x) => x.status === "queued")) ? "queued" : j.status')
  [ "$state" = queued ] || break
  if [ -z "$noticed" ] && [ $(($(date +%s) - started)) -ge "$QUEUED_S" ]; then
    echo "no runner is online for volley-linux-vm: start the runner service on the paired Linux machine (scripts/install-tests/README.md, The Linux box)"
    noticed=1
  fi
  sleep "$POLL_S"
done
gh run watch "$ID" --exit-status >&2

DIR="$OUT/run-$ID"
mkdir -p "$DIR"
view >"$DIR/run.json"
gh run download "$ID" --dir "$DIR" --pattern 'layer*' >/dev/null 2>&1 ||
  echo "verify.sh: some results could not be downloaded (gh run download $ID)" >&2
CONCLUSION=$(field 'j.conclusion' <"$DIR/run.json")

echo
bun "$HERE/metrics.ts" table --run "$DIR/run.json" --dir "$DIR"
echo
echo "run: ${URL:-$ID} ($CONCLUSION); results in $DIR"
if [ "$CONCLUSION" = success ]; then
  exit 0
fi
echo "Leftover VMs? On the paired Linux machine: multipass list | grep volley-it- (scripts/install-tests/README.md, Cleaning up)"
exit 1
