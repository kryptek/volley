#!/usr/bin/env bash
# Runs the Dynamic Security benchmark against mosquitto 2.1.x in the official
# eclipse-mosquitto container (the version Homebrew ships on macOS), so a Linux host can
# measure both versions. See README.md.
#
#   bench/dynsec/run-2.1.sh                  # full run
#   BENCH_QUICK=1 bench/dynsec/run-2.1.sh    # smaller sizes
#   DYNSEC_IMAGE=eclipse-mosquitto:2.1.1-alpine bench/dynsec/run-2.1.sh
#
# Before the suite it also checks that a dynamic-security.json written by the host's
# mosquitto_ctrl (2.0.x) loads in 2.1, and the reverse: the upgrade/downgrade path.
#
# Without docker (or without the image), it prints the steps for running the same suite on
# a Mac with Homebrew's mosquitto 2.1.x instead.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${DYNSEC_IMAGE:-eclipse-mosquitto:2.1.2-alpine}"

owner_steps() {
  cat >&2 <<EOF
run-2.1.sh: $1

Run the same suite on macOS against Homebrew's mosquitto 2.1.x instead:

  brew install mosquitto            # 2.1.x; the plugin is \$(brew --prefix mosquitto)/lib/mosquitto_dynamic_security.so
  brew services stop mosquitto      # optional: the suite never touches 1883/9001, but frees CPU
  cd <your volley checkout> && bun install
  bench/dynsec/run-local.sh | tee dynsec-2.1-macos.txt

run-local.sh finds the Homebrew plugin by itself (DYNSEC_PLUGIN overrides it) and prints the
table; append it to bench/dynsec/README.md as the macOS column.
EOF
  exit 1
}

command -v docker >/dev/null || owner_steps "docker is not installed"
docker info >/dev/null 2>&1 || owner_steps "the docker daemon is not reachable"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker pull -q "$IMAGE" >/dev/null || owner_steps "could not pull $IMAGE"
fi

# Cross-version file check: 2.0 file -> 2.1 broker, 2.1 file -> 2.0 broker (host mosquitto).
# Each broker logs to a file, so "did not start" is reported apart from "login refused".
if command -v mosquitto_ctrl >/dev/null && command -v mosquitto_sub >/dev/null; then
  X="$(mktemp -d "${TMPDIR:-/tmp}/volley-dynsec-x.XXXXXX")"
  XNAME="volley-dynsec-x-$$"
  trap 'docker rm -f "$XNAME" >/dev/null 2>&1 || true; rm -rf "$X"' EXIT
  free_port() { # sets PORT: a free port in 20000-39999 (never a real Volley broker's)
    while :; do
      PORT=$((20000 + RANDOM % 20000))
      (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null || return 0
    done
  }
  up() { # up <port>: is anything listening yet (up to 10 s)?
    local i
    for i in $(seq 1 100); do
      (echo >"/dev/tcp/127.0.0.1/$1") 2>/dev/null && return 0
      sleep 0.1
    done
    return 1
  }
  # check <label> <port> <log>: one line for BENCH_CROSS_VERSION.
  check() {
    if ! up "$2"; then
      echo "$1: broker did not start ($(tail -n 2 "$3" 2>/dev/null | tr '\n' ' '))"
    elif mosquitto_sub -p "$2" -u admin -P xpass -t '$SYS/broker/version' -C 1 -W 3 >/dev/null 2>&1; then
      echo "$1: broker starts, admin login ok"
    else
      echo "$1: broker starts, admin login REFUSED ($(grep -m1 -i 'not authori' "$3" | cut -d' ' -f2- || true))"
    fi
  }
  free_port
  mosquitto_ctrl dynsec init "$X/v20.json" admin xpass >/dev/null
  printf 'listener %s 127.0.0.1\nallow_anonymous false\nplugin /usr/lib/mosquitto_dynamic_security.so\nplugin_opt_config_file %s\nlog_dest file %s\n' \
    "$PORT" "$X/v20.json" "$X/a.log" >"$X/a.conf"
  docker run -d --name "$XNAME" --user "$(id -u):$(id -g)" -v "$X:$X" --network host \
    "$IMAGE" mosquitto -c "$X/a.conf" >/dev/null
  fwd="$(check "2.0 file in 2.1" "$PORT" "$X/a.log")"
  docker rm -f "$XNAME" >/dev/null
  echo "run-2.1.sh: $fwd" >&2

  docker run --rm --user "$(id -u):$(id -g)" -v "$X:$X" "$IMAGE" \
    mosquitto_ctrl dynsec init "$X/v21.json" admin xpass >/dev/null
  host_plugin=""
  for c in /usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so \
    /usr/lib/aarch64-linux-gnu/mosquitto_dynamic_security.so /usr/lib/mosquitto_dynamic_security.so; do
    [ -f "$c" ] && host_plugin="$c" && break
  done
  if [ -n "$host_plugin" ]; then
    free_port
    printf 'listener %s 127.0.0.1\nallow_anonymous false\nplugin %s\nplugin_opt_config_file %s\npid_file %s\nlog_dest file %s\nlog_type all\n' \
      "$PORT" "$host_plugin" "$X/v21.json" "$X/b.pid" "$X/b.log" >"$X/b.conf"
    # A copy of the binary: Ubuntu's AppArmor profile pins /usr/sbin/mosquitto to /etc/mosquitto.
    cp "$(command -v mosquitto)" "$X/mosquitto"
    "$X/mosquitto" -c "$X/b.conf" -d || true
    back="$(check "2.1 file in 2.0" "$PORT" "$X/b.log")"
    [ -f "$X/b.pid" ] && kill "$(cat "$X/b.pid")" 2>/dev/null || true
    echo "run-2.1.sh: $back" >&2
  fi
  export BENCH_CROSS_VERSION="${fwd}; ${back:-2.1 file in 2.0: not checked}"
  # exec below replaces this shell, so the EXIT trap would never fire: clean up now.
  docker rm -f "$XNAME" >/dev/null 2>&1 || true
  rm -rf "$X"
  trap - EXIT
fi

export BENCH_DOCKER_IMAGE="$IMAGE"
exec "$HERE/run-local.sh"
