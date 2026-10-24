#!/bin/bash
# `systemctl` for Layer 1's containers, which have no systemd (scripts/install-tests/README.md).
# It answers what `volley setup` and install.sh ask of a user manager:
#
#   systemctl --user is-active [--quiet] <unit>     0 when its process is alive
#   systemctl --user daemon-reload                  nothing to reload
#   systemctl --user enable|disable [--now] <unit>  a marker (and with --now, start/stop)
#   systemctl --user start|restart|stop <unit>
#   systemctl --user show -p MainPID --value <unit> its process, else 0
#
# and runs a unit's ExecStart= as setup wrote it (systemd's quoting), with a user manager's
# environment plus its Environment= lines, in its WorkingDirectory=, appending to its
# StandardOutput=append: / StandardError=append: files. Restart= is not supervised: a process that
# exits stays down, so `is-active` says so. Anything else exits 1 and names itself on stderr.
set -u

STATE="${SYSTEMCTL_STAND_IN_STATE:-$HOME/.local/state/systemctl-stand-in}"
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

fail() {
  printf 'systemctl (stand-in): %s\n' "$*" >&2
  exit 1
}

# systemd's word splitting of one line: whitespace separates words, "…" and '…' group them, a
# backslash escapes the next character. Prints each word NUL-terminated.
sd_words() {
  local line=$1 word='' in_word='' quote='' c i
  for ((i = 0; i < ${#line}; i++)); do
    c=${line:i:1}
    if [ -n "$quote" ]; then
      if [ "$c" = "\\" ] && [ "$quote" = '"' ]; then
        i=$((i + 1))
        word+=${line:i:1}
      elif [ "$c" = "$quote" ]; then
        quote=''
      else
        word+=$c
      fi
    elif [ "$c" = '"' ] || [ "$c" = "'" ]; then
      quote=$c
      in_word=1
    elif [ "$c" = "\\" ]; then
      i=$((i + 1))
      word+=${line:i:1}
      in_word=1
    elif [ "$c" = ' ' ] || [ "$c" = $'\t' ]; then
      if [ -n "$in_word" ]; then printf '%s\0' "$word"; fi
      word='' in_word=''
    else
      word+=$c
      in_word=1
    fi
  done
  if [ -n "$in_word" ]; then printf '%s\0' "$word"; fi
}

# The value of each `<key>=` line in the unit's [Service] section, one per line.
unit_values() {
  sed -n '/^\[Service\]/,/^\[/p' "$1" | sed -n "s/^$2=//p"
}

pid_of() {
  local f="$STATE/$1.pid" pid
  [ -f "$f" ] || return 1
  pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null; then
    printf '%s' "$pid"
  else
    return 1
  fi
}

start() {
  local unit=$1 file="$UNITS/$1" line out err wd
  [ -f "$file" ] || fail "Unit $unit not found."
  pid_of "$unit" >/dev/null && return 0
  local -a argv=() envs=()
  line=$(unit_values "$file" ExecStart | head -n 1)
  [ -n "$line" ] || fail "$unit has no ExecStart="
  while IFS= read -r -d '' w; do argv+=("$w"); done < <(sd_words "$line")
  while IFS= read -r line; do
    while IFS= read -r -d '' w; do envs+=("$w"); done < <(sd_words "$line")
  done < <(unit_values "$file" Environment)
  wd=$(unit_values "$file" WorkingDirectory | head -n 1)
  out=$(unit_values "$file" StandardOutput | sed -n 's/^append://p' | head -n 1)
  err=$(unit_values "$file" StandardError | sed -n 's/^append://p' | head -n 1)
  out=${out:-/dev/null}
  err=${err:-$out}
  mkdir -p "$STATE"
  [ "$out" = /dev/null ] || mkdir -p "$(dirname "$out")"
  [ "$err" = /dev/null ] || mkdir -p "$(dirname "$err")"
  (
    cd "${wd:-$HOME}" || exit 1
    # A user manager's environment, not the caller's: what the unit sets is all it gets.
    exec setsid env -i HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${USER:-$(id -un)}" \
      SHELL="${SHELL:-/bin/sh}" PATH=/usr/local/bin:/usr/bin:/bin \
      "${envs[@]}" "${argv[@]}" </dev/null >>"$out" 2>>"$err"
  ) &
  printf '%s\n' "$!" >"$STATE/$unit.pid"
}

stop() {
  local unit=$1 pid n
  pid=$(pid_of "$unit") || {
    rm -f "$STATE/$unit.pid"
    return 0
  }
  kill -TERM "$pid" 2>/dev/null
  for ((n = 0; n < 50; n++)); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -KILL "$pid" 2>/dev/null
  rm -f "$STATE/$unit.pid"
}

unit_name() {
  case "$1" in
    *.service) printf '%s' "$1" ;;
    *) printf '%s.service' "$1" ;;
  esac
}

main() {
  local user='' quiet='' now='' prop='' value='' verb='' arg
  local -a units=()
  while [ $# -gt 0 ]; do
    arg=$1
    shift
    case "$arg" in
      --user) user=1 ;;
      --quiet | -q) quiet=1 ;;
      --now) now=1 ;;
      --value) value=1 ;;
      -p)
        prop=${1:-}
        shift
        ;;
      -*) fail "unsupported option $arg" ;;
      *) if [ -z "$verb" ]; then verb=$arg; else units+=("$(unit_name "$arg")"); fi ;;
    esac
  done
  if [ -z "$user" ]; then
    # No system manager here: every system unit is inactive (install.sh asks after snapd).
    [ "$verb" = is-active ] || fail "only --user units are supported (systemctl $verb)"
    [ -n "$quiet" ] || echo inactive
    exit 3
  fi
  case "$verb" in
    daemon-reload) ;;
    is-active)
      [ ${#units[@]} -eq 1 ] || fail "is-active takes one unit"
      if pid_of "${units[0]}" >/dev/null; then
        [ -n "$quiet" ] || echo active
      else
        [ -n "$quiet" ] || echo inactive
        exit 3
      fi
      ;;
    enable | disable)
      mkdir -p "$STATE"
      for u in "${units[@]}"; do
        if [ "$verb" = enable ]; then
          [ -f "$UNITS/$u" ] || fail "Unit $u not found."
          : >"$STATE/$u.enabled"
          [ -z "$now" ] || start "$u"
        else
          rm -f "$STATE/$u.enabled"
          [ -z "$now" ] || stop "$u"
        fi
      done
      ;;
    start) for u in "${units[@]}"; do start "$u"; done ;;
    stop) for u in "${units[@]}"; do stop "$u"; done ;;
    restart)
      for u in "${units[@]}"; do
        stop "$u"
        start "$u"
      done
      ;;
    show)
      if [ "$prop" != MainPID ] || [ -z "$value" ] || [ ${#units[@]} -ne 1 ]; then
        fail "show supports only -p MainPID --value <unit>"
      fi
      pid_of "${units[0]}" || printf '0'
      printf '\n'
      ;;
    *) fail "unsupported command: ${verb:-(none)}" ;;
  esac
}

main "$@"
