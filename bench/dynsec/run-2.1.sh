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
if command -v mosquitto_ctrl >/dev/null && command -v mosquitto_sub >/dev/null; then
  X="$(mktemp -d "${TMPDIR:-/tmp}/volley-dynsec-x.XXXXXX")"
  trap 'docker rm -f volley-dynsec-x >/dev/null 2>&1 || true; rm -rf "$X"' EXIT
  login() { # login <port>: can the admin read $SYS through this broker?
    mosquitto_sub -p "$1" -u admin -P xpass -t '$SYS/broker/version' -C 1 -W 3 >/dev/null 2>&1
  }
  port=$((20000 + RANDOM % 20000))
  mosquitto_ctrl dynsec init "$X/v20.json" admin xpass >/dev/null
  printf 'listener %s 127.0.0.1\nallow_anonymous false\nplugin /usr/lib/mosquitto_dynamic_security.so\nplugin_opt_config_file %s\n' \
    "$port" "$X/v20.json" >"$X/a.conf"
  docker run -d --name volley-dynsec-x --user "$(id -u):$(id -g)" -v "$X:$X" --network host \
    "$IMAGE" mosquitto -c "$X/a.conf" >/dev/null
  sleep 1
  if login "$port"; then fwd="2.0 file loads in 2.1: admin login ok"; else fwd="2.0 file in 2.1: admin login FAILED"; fi
  docker rm -f volley-dynsec-x >/dev/null
  echo "run-2.1.sh: $fwd" >&2

  docker run --rm --user "$(id -u):$(id -g)" -v "$X:$X" "$IMAGE" \
    mosquitto_ctrl dynsec init "$X/v21.json" admin xpass >/dev/null
  host_plugin=""
  for c in /usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so \
    /usr/lib/aarch64-linux-gnu/mosquitto_dynamic_security.so /usr/lib/mosquitto_dynamic_security.so; do
    [ -f "$c" ] && host_plugin="$c" && break
  done
  if [ -n "$host_plugin" ]; then
    port=$((20000 + RANDOM % 20000))
    printf 'listener %s 127.0.0.1\nallow_anonymous false\nplugin %s\nplugin_opt_config_file %s\npid_file %s\n' \
      "$port" "$host_plugin" "$X/v21.json" "$X/b.pid" >"$X/b.conf"
    # A copy of the binary: Ubuntu's AppArmor profile pins /usr/sbin/mosquitto to /etc/mosquitto.
    cp "$(command -v mosquitto)" "$X/mosquitto"
    "$X/mosquitto" -c "$X/b.conf" -d 2>/dev/null || true
    sleep 1
    if login "$port"; then back="2.1 file loads in 2.0: admin login ok"; else back="2.1 file in 2.0: admin login FAILED"; fi
    [ -f "$X/b.pid" ] && kill "$(cat "$X/b.pid")" 2>/dev/null || true
    echo "run-2.1.sh: $back" >&2
  fi
  export BENCH_CROSS_VERSION="${fwd}; ${back:-2.1 file in 2.0: not checked}"
  # exec below replaces this shell, so the EXIT trap would never fire: clean up now.
  docker rm -f volley-dynsec-x >/dev/null 2>&1 || true
  rm -rf "$X"
  trap - EXIT
fi

export BENCH_DOCKER_IMAGE="$IMAGE"
exec "$HERE/run-local.sh"
