#!/bin/bash
# Layer 1 of the one-command install's tests (scripts/install-tests/README.md): install Volley from
# nothing, run `volley setup` unattended against volley-sim, and check what a person would.
#
#   run-layer1.sh linux <ubuntu-24.04|debian-13>   on the host: builds the image (or uses
#                                                  $LAYER1_IMAGE), runs the install inside a
#                                                  fresh container as its non-root user
#   run-layer1.sh macos                            on a (hosted) Mac, as the logged-in user
#   run-layer1.sh inside                           the container half of `linux` (not by hand)
#
# Results land in $LAYER1_OUT (default ./layer1-results): setup-metrics.json, check.json,
# summary.md, setup.log, volleyd.log, desk.log, unknown.jsonl and transcript.log (setup's output,
# redacted). Exit 1 when any check failed (each is printed as `FAIL: …`), after collecting them all.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT="${LAYER1_OUT:-$PWD/layer1-results}"
FAILED=0

say() { printf '==> %s\n' "$*"; }
fail() {
  printf 'FAIL: %s\n' "$*"
  FAILED=1
}
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }

# ---------------------------------------------------------------------------------------------
# The host half (Linux): image, container, the checkout copied in, results copied out.

linux_host() {
  distro=${1:-}
  case "$distro" in
    ubuntu-24.04) dockerfile=Dockerfile.ubuntu ;;
    debian-13) dockerfile=Dockerfile.debian ;;
    *)
      echo "usage: run-layer1.sh linux <ubuntu-24.04|debian-13>" >&2
      exit 2
      ;;
  esac
  image=${LAYER1_IMAGE:-volley-layer1:$distro}
  if [ -z "${LAYER1_IMAGE:-}" ]; then
    say "Building $image"
    docker build -f "$HERE/$dockerfile" -t "$image" "$HERE" || exit 1
  fi
  name="volley-layer1-$distro-$$"
  mkdir -p "$OUT"
  # shellcheck disable=SC2064 # the name is fixed now
  trap "docker rm -f $name >/dev/null 2>&1" EXIT
  docker run -d --name "$name" --hostname layer1 "$image" sleep infinity >/dev/null || exit 1
  say "Copying this checkout into $name"
  # Tracked and untracked files, not what .gitignore excludes (node_modules, results).
  (cd "$REPO" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) |
    docker exec -i "$name" bash -c 'mkdir -p ~/volley && tar -C ~/volley -xf -' || exit 1
  # The image's user's home (its HOME), where the checkout and the results live.
  home=$(docker exec "$name" printenv HOME) || exit 1
  docker exec -e LAYER1_LABEL="$distro" -e LAYER1_OUT="$home/layer1-results" "$name" \
    bash "$home/volley/scripts/install-tests/run-layer1.sh" inside
  code=$?
  docker cp "$name:$home/layer1-results/." "$OUT/" || code=1
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$OUT/summary.md" ]; then
    cat "$OUT/summary.md" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit "$code"
}

# ---------------------------------------------------------------------------------------------
# The broker of the container: mosquitto 2.1 from the image, run as this user (the `container`
# layout; setup leaves restarting it to us).

MQ_CONF=/mosquitto/config/mosquitto.conf
MQ_PID=/mosquitto/mosquitto.pid

broker_start() {
  setsid mosquitto -c "$MQ_CONF" </dev/null >>/mosquitto/log/mosquitto.log 2>&1 &
  echo "$!" >"$MQ_PID"
  for _ in $(seq 50); do
    (: </dev/tcp/127.0.0.1/1883) 2>/dev/null && return 0
    sleep 0.1
  done
  fail "mosquitto did not listen on 1883 (/mosquitto/log/mosquitto.log)"
  return 1
}

broker_restart() {
  pid=$(cat "$MQ_PID" 2>/dev/null) || pid=''
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    for _ in $(seq 50); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  broker_start
}

# ---------------------------------------------------------------------------------------------
# What both platforms check.

SETUP_FLAGS=''
TRANSCRIPT=''
# A step this platform's setup skips by design (`--no-lan` on a Mac: the phone cannot reach the
# broker), allowed to be skipped rather than done.
ALLOW_SKIPPED=''

# `volley setup` with the platform's flags, its output appended to the raw transcript.
setup_run() {
  # shellcheck disable=SC2086 # one word per flag
  volley setup --yes --no-lan $SETUP_FLAGS --simulated >>"$TRANSCRIPT" 2>&1
}

volleyd_home() { printf '%s' "${VOLLEYD_HOME:-$HOME/.volley/volleyd}"; }

# `--secrets <file>` for each credentials file whose passwords must never reach a log.
SECRETS=()
collect_secrets() {
  SECRETS=()
  vh=$(volleyd_home)
  for f in "$vh/broker.json" "$vh/dynsec-admin.json" "${AUTH_DIR:-/nonexistent}"/*.json; do
    if [ -f "$f" ]; then SECRETS+=(--secrets "$f"); fi
  done
}

metrics() { bun "$REPO/scripts/install-tests/metrics.ts" "$@"; }
# scan and redact take the secrets (bash 3.2's `set -u` rejects an empty "${a[@]}").
scan() { metrics scan ${SECRETS[@]+"${SECRETS[@]}"} "$@"; }
# setup's output with the secrets replaced; the raw copy never leaves the machine.
redact_transcript() {
  metrics redact ${SECRETS[@]+"${SECRETS[@]}"} <"$TRANSCRIPT" >"$OUT/transcript.log" &&
    rm -f "$TRANSCRIPT"
}

common_checks() {
  label=$1
  vh=$(volleyd_home)
  total_ms=$2

  say "volley setup --check --json"
  volley setup --check --json >"$OUT/check.json" 2>>"$TRANSCRIPT" ||
    fail "volley setup --check exited non-zero (check.json)"

  say "install.sh --check"
  sh "$REPO/install.sh" --check >>"$TRANSCRIPT" 2>&1 || fail "install.sh --check found something missing"

  say "The Desk answers /version.json"
  curl -fsS "http://127.0.0.1:${DESK_PORT:-5199}/version.json" >"$OUT/version.json" 2>>"$TRANSCRIPT" ||
    fail "the Desk did not answer /version.json on port ${DESK_PORT:-5199}"

  # Only after a run that finished: a rerun of one that did not would only repeat it.
  say "A second volley setup --yes applies nothing"
  if [ -n "$SETUP_OK" ]; then
    before=$(wc -l <"$vh/setup.log" 2>/dev/null || echo 0)
    setup_run || fail "the second volley setup --yes exited non-zero"
    tail -n +"$((before + 1))" "$vh/setup.log" >"$OUT/setup-rerun.log" 2>/dev/null
    others=$(grep -v '"event":"done"' "$OUT/setup-rerun.log" 2>/dev/null |
      grep -cv "\"step\":\"${ALLOW_SKIPPED:-none}\",\"event\":\"skipped\"") || true
    [ -s "$OUT/setup-rerun.log" ] || fail "the second run wrote nothing to setup.log"
    [ "${others:-0}" -eq 0 ] || fail "the second run did more than report done ($others events; setup-rerun.log)"
    collect_logs
  else
    fail "not rerun: the first volley setup did not finish"
  fi

  say "No secrets in the logs"
  collect_secrets
  scan "$OUT/setup.log" "$OUT/volleyd.log" "$OUT/desk.log" \
    "$OUT/unknown.jsonl" "$OUT/setup-rerun.log"
  case $? in
    0) ;;
    1) fail "a log holds a secret (the lines above)" ;;
    *) fail "the secret scan could not run (the line above)" ;;
  esac

  say "The summary"
  GITHUB_STEP_SUMMARY="$OUT/summary.md" metrics summary --label "$label" \
    --metrics "$OUT/setup-metrics.json" --check "$OUT/check.json" --yes --first-wave \
    --total-ms "$total_ms" ${ALLOW_SKIPPED:+--allow-skipped "$ALLOW_SKIPPED"} ||
    fail "a target was missed (summary.md)"
}

# The run's metrics, kept before a rerun replaces them, and its logs (a job cut off later still
# uploads them).
SETUP_OK=''
keep_metrics() {
  cp "$(volleyd_home)/setup-metrics.json" "$OUT/setup-metrics.json" 2>/dev/null ||
    fail "setup wrote no setup-metrics.json"
  collect_logs
  collect_secrets
  [ -s "$OUT/volleyd.log" ] || fail "no volleyd.log"
  [ -s "$OUT/desk.log" ] || fail "no desk.log"
}

collect_logs() {
  vh=$(volleyd_home)
  for f in setup.log volleyd.log desk.log; do cp "$vh/$f" "$OUT/$f" 2>/dev/null; done
  cp "${VOLLEY_SIM_HOME:-$HOME/.volley/sim}/unknown.jsonl" "$OUT/unknown.jsonl" 2>/dev/null
  return 0
}

finish() {
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$OUT/summary.md" ]; then
    cat "$OUT/summary.md" >>"$GITHUB_STEP_SUMMARY"
  fi
  if [ "$FAILED" -ne 0 ]; then
    say "Layer 1 failed. setup's output (redacted):"
    cat "$OUT/transcript.log" 2>/dev/null
    say "volleyd.log, its last 80 lines (redacted):"
    tail -n 80 "$OUT/volleyd.log" 2>/dev/null | metrics redact ${SECRETS[@]+"${SECRETS[@]}"}
    exit 1
  fi
  say "Layer 1 passed."
}

# ---------------------------------------------------------------------------------------------
# The container half (Linux), as the non-root user.

linux_inside() {
  label=${LAYER1_LABEL:-linux}
  SRC="$HOME/volley"
  REPO=$SRC
  AUTH_DIR=/mosquitto/config/volley
  SETUP_FLAGS='--layout container'
  mkdir -p "$OUT"
  TRANSCRIPT="$OUT/transcript.raw"
  : >"$TRANSCRIPT"
  broker_start || finish

  t0=$(date +%s%3N)
  say "install.sh --source $SRC --no-setup"
  sh "$SRC/install.sh" --source "$SRC" --no-setup >>"$TRANSCRIPT" 2>&1 || {
    fail "install.sh exited non-zero"
    cp "$TRANSCRIPT" "$OUT/transcript.log"
    finish
  }
  # A new terminal's PATH (the line install.sh added), and the simulator.
  export PATH="$HOME/.volley/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
  eval "$(volley sim env)"

  say "volley setup --yes --no-lan --layout container --simulated"
  if setup_run; then
    SETUP_OK=1
  elif grep -q 'restart your container yourself' "$TRANSCRIPT"; then
    # The container layout leaves the broker's restart to the person: do it, then rerun.
    say "Restarting the broker, as setup asks"
    if broker_restart && setup_run; then
      SETUP_OK=1
    else
      fail "volley setup failed after the broker restart"
    fi
  else
    fail "volley setup exited non-zero"
  fi
  total_ms=$(($(date +%s%3N) - t0))
  keep_metrics
  common_checks "$label" "$total_ms"

  say "install.sh --uninstall leaves no service running"
  sh "$SRC/install.sh" --uninstall >>"$TRANSCRIPT" 2>&1 || fail "install.sh --uninstall exited non-zero"
  for unit in volleyd.service volley-desk.service; do
    if systemctl --user is-active --quiet "$unit"; then fail "$unit still runs after --uninstall"; fi
  done
  redact_transcript
  finish
}

# ---------------------------------------------------------------------------------------------
# macOS: the curl path on a hosted runner (Homebrew there, no cmux: tmux).

macos() {
  label=${LAYER1_LABEL:-macos}
  mkdir -p "$OUT"
  TRANSCRIPT="$OUT/transcript.raw"
  : >"$TRANSCRIPT"
  uid=$(id -u)

  t0=$(now_ms)
  # The curl path, its script read from a pipe as `curl … | sh` would; --source installs this
  # checkout rather than the latest tag.
  say "install.sh (piped) --source $REPO --no-setup"
  sh -s -- --source "$REPO" --no-setup <"$REPO/install.sh" >>"$TRANSCRIPT" 2>&1 || {
    fail "install.sh exited non-zero"
    cp "$TRANSCRIPT" "$OUT/transcript.log"
    finish
  }
  export PATH="$HOME/.volley/bin:$HOME/.bun/bin:$HOME/.local/bin:$PATH"
  eval "$(volley sim env)"
  # Homebrew links mosquitto into sbin; Setup's Security step starts it (brew services).
  PATH="$PATH:$(brew --prefix)/sbin"
  AUTH_DIR="$(brew --prefix)/etc/mosquitto/volley"
  # --no-lan keeps the broker's WebSocket listener on loopback here: no phone reaches it.
  ALLOW_SKIPPED=phone

  say "volley setup --yes --no-lan --simulated"
  if setup_run; then SETUP_OK=1; else fail "volley setup exited non-zero"; fi
  total_ms=$(($(now_ms) - t0))
  keep_metrics

  say "launchd has the services; the keychain has the coordinator's login"
  for label_ in systems.volley.volleyd systems.volley.desk; do
    launchctl print "gui/$uid/$label_" >/dev/null 2>&1 || fail "launchd has no $label_"
  done
  # Exit code only: the password never reaches the output.
  security find-generic-password -s volley-broker -a coordinator >/dev/null 2>&1 ||
    fail "no volley-broker keychain item for the coordinator"

  common_checks "$label" "$total_ms"

  say "install.sh --uninstall leaves no service running"
  sh "$REPO/install.sh" --uninstall >>"$TRANSCRIPT" 2>&1 || fail "install.sh --uninstall exited non-zero"
  for label_ in systems.volley.volleyd systems.volley.desk; do
    if launchctl print "gui/$uid/$label_" >/dev/null 2>&1; then fail "$label_ still loaded after --uninstall"; fi
  done
  redact_transcript
  finish
}

case "${1:-}" in
  linux) linux_host "${2:-}" ;;
  inside) linux_inside ;;
  macos) macos ;;
  *)
    echo "usage: run-layer1.sh linux <ubuntu-24.04|debian-13> | macos" >&2
    exit 2
    ;;
esac
