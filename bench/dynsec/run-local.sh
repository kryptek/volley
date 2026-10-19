#!/usr/bin/env bash
# Runs the Dynamic Security benchmark (bench.ts) against a throwaway mosquitto: starts brokers
# on random free ports with a fresh dynamic-security.json (`mosquitto_ctrl dynsec init`), runs
# the suite, prints the table and removes everything again. See README.md.
#
#   bench/dynsec/run-local.sh                  # the mosquitto installed on this host
#   BENCH_QUICK=1 bench/dynsec/run-local.sh    # smaller sizes (about a minute), to check the script
#   bench/dynsec/run-2.1.sh                    # the same in an eclipse-mosquitto 2.1.x container
#
# Environment:
#   DYNSEC_PLUGIN      path of mosquitto_dynamic_security.so (auto-detected)
#   BENCH_DOCKER_IMAGE run mosquitto in this image instead of the host's (set by run-2.1.sh)
#   BENCH_NODELAY      set_tcp_nodelay for the broker (default true; false shows Nagle's cost)
#   BENCH_OUT          directory for the JSON results (default: a temporary directory, kept)
#   BENCH_ONLY         comma-separated section letters to run (e.g. a,f)
#   BENCH_KEEP=1       keep the brokers' work directory for inspection
#
# Never uses ports 1883, 9001 or 18830: those carry a real Volley broker.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${BENCH_DOCKER_IMAGE:-}"
command -v bun >/dev/null || { echo "run-local.sh: 'bun' not found on PATH" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/volley-dynsec.XXXXXX")"
OUT="${BENCH_OUT:-$WORK-results}"
mkdir -p "$OUT"
ADMIN_PASS="$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
NAME="volley-dynsec-$(basename "$WORK" | tr -dc 'A-Za-z0-9' | tr 'A-Z' 'a-z')"

if [ -n "$IMAGE" ]; then
  command -v docker >/dev/null || { echo "run-local.sh: docker not found" >&2; exit 1; }
  # The work directory is mounted at the same path, so configs read the same either way. The
  # broker runs as the invoking user (no privilege drop) and on the host network (127.0.0.1).
  DOCKER_RUN=(docker run --user "$(id -u):$(id -g)" -v "$WORK:$WORK" --network host)
  PLUGIN="${DYNSEC_PLUGIN:-/usr/lib/mosquitto_dynamic_security.so}"
  ctrl() { "${DOCKER_RUN[@]}" --rm "$IMAGE" mosquitto_ctrl "$@"; }
  VERSION="$("${DOCKER_RUN[@]}" --rm "$IMAGE" mosquitto -h 2>&1 | grep -m1 '^mosquitto version' || true)"
  WHERE="container $IMAGE"
else
  for bin in mosquitto mosquitto_ctrl; do
    command -v "$bin" >/dev/null || { echo "run-local.sh: '$bin' not found on PATH" >&2; exit 1; }
  done
  MOSQUITTO="$(command -v mosquitto)"
  # Ubuntu confines /usr/sbin/mosquitto with an AppArmor profile that only lets it read
  # /etc/mosquitto and write /var/lib/mosquitto/mosquitto.db: it cannot open a config, log or
  # dynamic-security.json anywhere else. The profile attaches by path, so run a copy.
  if [ -f /etc/apparmor.d/mosquitto ] && [ "$MOSQUITTO" = /usr/sbin/mosquitto ]; then
    mkdir -p "$WORK/bin"
    cp "$MOSQUITTO" "$WORK/bin/mosquitto"
    MOSQUITTO="$WORK/bin/mosquitto"
  fi
  find_plugin() {
    if [ -n "${DYNSEC_PLUGIN:-}" ]; then echo "$DYNSEC_PLUGIN"; return; fi
    local candidates=(
      /usr/lib/x86_64-linux-gnu/mosquitto_dynamic_security.so
      /usr/lib/aarch64-linux-gnu/mosquitto_dynamic_security.so
      /usr/lib/mosquitto_dynamic_security.so
      /usr/local/lib/mosquitto_dynamic_security.so
    )
    if command -v brew >/dev/null; then
      candidates+=("$(brew --prefix mosquitto)/lib/mosquitto_dynamic_security.so")
    fi
    for c in "${candidates[@]}"; do
      if [ -f "$c" ]; then echo "$c"; return; fi
    done
    echo "run-local.sh: mosquitto_dynamic_security.so not found; set DYNSEC_PLUGIN" >&2
    exit 1
  }
  PLUGIN="$(find_plugin)"
  ctrl() { mosquitto_ctrl "$@"; }
  VERSION="$("$MOSQUITTO" -h 2>&1 | grep -m1 '^mosquitto version' || true)"
  WHERE="$(uname -s), local"
fi

cleanup() {
  if [ -n "$IMAGE" ]; then
    docker rm -f "$NAME-main" "$NAME-pls" >/dev/null 2>&1 || true
  else
    for f in "$WORK"/*/mosquitto.pid; do
      [ -f "$f" ] && kill -9 "$(cat "$f")" 2>/dev/null || true
    done
  fi
  if [ "${BENCH_KEEP:-0}" = "1" ]; then
    echo "run-local.sh: broker work directory kept at $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# free_port: sets PORT to a random free port in 20000-39999 (so never 1883, 9001 or 18830,
# where a real Volley broker listens) not handed out earlier in this run. It sets a variable
# instead of printing, so the TAKEN bookkeeping survives (no command-substitution subshell).
TAKEN=" "
free_port() {
  while :; do
    PORT=$((20000 + RANDOM % 20000))
    case "$TAKEN" in *" $PORT "*) continue ;; esac
    if ! (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      TAKEN="$TAKEN$PORT "
      return
    fi
  done
}

ctrl dynsec init "$WORK/seed.json" admin "$ADMIN_PASS" >/dev/null
# Re-running init on an existing file is the first thing an idempotent `volley auth init` does.
INIT_RERUN="$(ctrl dynsec init "$WORK/seed.json" admin "$ADMIN_PASS" 2>&1; echo "exit=$?")"

free_port; PLS_WS_PORT="$PORT"
free_port; PLS_PORT="$PORT"
free_port; WS_PORT="$PORT"
free_port

# The broker under test: the template, per_listener_settings false.
mkdir -p "$WORK/main" "$WORK/pls"
cp "$WORK/seed.json" "$WORK/main/dynamic-security.json"
sed -e "s|@PLUGIN@|$PLUGIN|" \
  -e "s|@DYNSEC_JSON@|$WORK/main/dynamic-security.json|" -e "s|@PORT@|$PORT|" \
  -e "s|@WS_PORT@|$WS_PORT|" -e "s|@NODELAY@|${BENCH_NODELAY:-true}|" -e "s|@BIND@|127.0.0.1|" \
  -e "s|@LOG_FILE@|$WORK/main/mosquitto.log|" \
  "$HERE/mosquitto-dynsec.conf" >"$WORK/main/mosquitto.conf"
echo "pid_file $WORK/main/mosquitto.pid" >>"$WORK/main/mosquitto.conf"

# README row (h): per_listener_settings true. Global options are then per listener and must
# follow a `listener` line; written before the first one (as in the template) they would create
# an implicit default listener on port 1883. So this config repeats them under each listener,
# which loads the plugin twice over the same file.
cp "$WORK/seed.json" "$WORK/pls/dynamic-security.json"
{
  echo "per_listener_settings true"
  echo "persistence false"
  echo "log_dest file $WORK/pls/mosquitto.log"
  echo "pid_file $WORK/pls/mosquitto.pid"
  for l in "$PLS_PORT" "$PLS_WS_PORT"; do
    echo "listener $l 127.0.0.1"
    [ "$l" = "$PLS_WS_PORT" ] && echo "protocol websockets"
    echo "allow_anonymous false"
    echo "plugin $PLUGIN"
    echo "plugin_opt_config_file $WORK/pls/dynamic-security.json"
  done
} >"$WORK/pls/mosquitto.conf"

wait_port() {
  local p="$1" i
  for i in $(seq 1 100); do
    if (echo >"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then return 0; fi
    sleep 0.1
  done
  return 1
}

# start <main|pls>: starts that broker the first time.
start() {
  if [ -n "$IMAGE" ]; then
    "${DOCKER_RUN[@]}" -d --name "$NAME-$1" "$IMAGE" mosquitto -c "$WORK/$1/mosquitto.conf" >/dev/null
  else
    "$MOSQUITTO" -c "$WORK/$1/mosquitto.conf" -d
  fi
}

start main
wait_port "$PORT" || { cat "$WORK/main/mosquitto.log" >&2; exit 1; }
PLS_STATUS=started
if ! start pls || ! wait_port "$PLS_PORT"; then
  PLS_STATUS="did not start: $(tail -n 8 "$WORK/pls/mosquitto.log" 2>/dev/null | tr '\n' ' ')"
fi

if [ -n "$IMAGE" ]; then
  C="$NAME-main"
  export BENCH_START="docker start $C >/dev/null"
  export BENCH_STOP="docker stop -t 60 $C >/dev/null"
  export BENCH_KILL="docker kill -s KILL $C >/dev/null && docker wait $C >/dev/null"
  export BENCH_RSS="ps -o rss= -p \$(docker inspect -f '{{.State.Pid}}' $C)"
  PID_EXPR="\$(docker inspect -f '{{.State.Pid}}' $C)"
else
  MAIN_PID="$WORK/main/mosquitto.pid"
  export BENCH_START="'$MOSQUITTO' -c '$WORK/main/mosquitto.conf' -d"
  export BENCH_STOP="pid=\$(cat '$MAIN_PID'); kill \$pid; while kill -0 \$pid 2>/dev/null; do sleep 0.02; done"
  export BENCH_KILL="pid=\$(cat '$MAIN_PID'); kill -9 \$pid; while kill -0 \$pid 2>/dev/null; do sleep 0.02; done"
  export BENCH_RSS="ps -o rss= -p \$(cat '$MAIN_PID')"
  PID_EXPR="\$(cat '$MAIN_PID')"
fi
# Cumulative broker CPU (user + system) in seconds: /proc on Linux, ps elsewhere ([[h:]m:]s).
export BENCH_CPU="pid=$PID_EXPR; if [ -r /proc/\$pid/stat ]; then awk -v t=\$(getconf CLK_TCK) '{print (\$14+\$15)/t}' /proc/\$pid/stat; else ps -o time= -p \$pid; fi"

NODELAY_NOTE=""
[ "${BENCH_NODELAY:-true}" = "true" ] || NODELAY_NOTE=", set_tcp_nodelay false"
export BENCH_LABEL="${BENCH_LABEL:-$VERSION ($WHERE$NODELAY_NOTE)}"
export BENCH_URL="mqtt://127.0.0.1:$PORT"
export BENCH_WS_URL="ws://127.0.0.1:$WS_PORT"
export BENCH_ADMIN_USER=admin
export BENCH_ADMIN_PASS="$ADMIN_PASS"
export BENCH_JSON="$WORK/main/dynamic-security.json"
export BENCH_PLS_URL="mqtt://127.0.0.1:$PLS_PORT"
export BENCH_PLS_WS_URL="ws://127.0.0.1:$PLS_WS_PORT"
export BENCH_PLS_STATUS="$PLS_STATUS"
export BENCH_INIT_RERUN="$INIT_RERUN"
export BENCH_OUT="$OUT"

echo "run-local.sh: $BENCH_LABEL on 127.0.0.1:$PORT (ws $WS_PORT), plugin $PLUGIN" >&2
bun "$HERE/bench.ts"
echo "run-local.sh: results in $OUT" >&2
