#!/usr/bin/env bats
# Test for publish-status.sh. Mocks the `volley` CLI via a PATH shim that
# captures argv (NUL-delimited) and stdin to tempfiles, then asserts the
# script invokes `volley pub` with the expected envelope shape:
# namespace=ci by default (overridable via VOLLEY_NAMESPACE), agent_id
# computed as `gh-<owner>-<repo>-<run-id>` (lowercased, slashes → hyphens,
# truncated to 63 chars per SPEC §2.2), channel=status, given type,
# optional payload-json forwarded.

setup() {
  BRIDGE_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)"
  SCRIPT="$BRIDGE_DIR/publish-status.sh"

  # Each test gets its own tempdir; shim + capture file live here.
  TEST_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/publish-status-bats.XXXXXX")"
  CAPTURE="$TEST_TMPDIR/volley-args.txt"

  # Write a `volley` shim that captures argv (NUL-delimited) and stdin to CAPTURE.
  cat >"$TEST_TMPDIR/volley" <<EOF
#!/usr/bin/env bash
# Test shim — captures invocation args + stdin for assertions.
printf '%s\0' "\$@" >"$CAPTURE.args"
cat - >"$CAPTURE.stdin" 2>/dev/null || true
exit 0
EOF
  chmod +x "$TEST_TMPDIR/volley"

  # Put the shim first on PATH so publish-status.sh resolves the mock.
  ORIG_PATH="$PATH"
  PATH="$TEST_TMPDIR:$PATH"
  export PATH

  # Default GitHub Actions env vars (tests may override before calling the script).
  export GITHUB_REPOSITORY="kryptek/volley"
  export GITHUB_RUN_ID="7891234567"
  export GITHUB_JOB="test"
  export GITHUB_SHA="abc123def456"

  # Clear Volley overrides so defaults apply.
  unset VOLLEY_BROKER_URL || true
  unset VOLLEY_AUTH_USERNAME VOLLEY_AUTH_PASSWORD || true
  unset VOLLEY_NAMESPACE || true
}

teardown() {
  PATH="$ORIG_PATH"
  export PATH
  rm -rf "$TEST_TMPDIR"
}

# Helper: read the captured argv (NUL-delimited) into an array.
_captured_args() {
  if [[ ! -f "$CAPTURE.args" ]]; then
    return 1
  fi
  # Split on NUL.
  local IFS=$'\0'
  while IFS= read -r -d '' arg; do
    printf '%s\n' "$arg"
  done <"$CAPTURE.args"
}

@test "script file exists" {
  [[ -f "$SCRIPT" ]]
}

@test "script is executable" {
  [[ -x "$SCRIPT" ]]
}

@test "publishes status=working with default namespace=ci and computed agent_id" {
  run "$SCRIPT" working
  [[ "$status" -eq 0 ]]

  # Capture must exist (the shim ran).
  [[ -f "$CAPTURE.args" ]]

  args="$(_captured_args)"
  # Expect: volley pub --namespace ci --agent-id gh-kryptek-volley-7891234567 --channel status --type working
  # Note: `--` after grep flags is required so the next arg isn't parsed as an option.
  echo "$args" | grep -qx -- "pub"
  echo "$args" | grep -qx -- "--namespace"
  echo "$args" | grep -qx -- "ci"
  echo "$args" | grep -qx -- "--agent-id"
  echo "$args" | grep -qx -- "gh-kryptek-volley-7891234567"
  echo "$args" | grep -qx -- "--channel"
  echo "$args" | grep -qx -- "status"
  echo "$args" | grep -qx -- "--type"
  echo "$args" | grep -qx -- "working"
}

@test "forwards payload JSON when provided as second arg" {
  run "$SCRIPT" done '{"summary":"all green"}'
  [[ "$status" -eq 0 ]]
  [[ -f "$CAPTURE.args" ]]
  args="$(_captured_args)"
  # The payload should be passed via --payload <json> (or piped on stdin —
  # either is acceptable; assert at least one of them carries the JSON).
  if echo "$args" | grep -q '{"summary":"all green"}'; then
    :  # passed as argv
  elif [[ -f "$CAPTURE.stdin" ]] && grep -q '{"summary":"all green"}' "$CAPTURE.stdin"; then
    :  # passed on stdin
  else
    echo "payload JSON not found in argv or stdin"
    echo "args:    $args"
    [[ -f "$CAPTURE.stdin" ]] && echo "stdin:   $(cat "$CAPTURE.stdin")"
    return 1
  fi
}

@test "VOLLEY_NAMESPACE overrides the default" {
  export VOLLEY_NAMESPACE="ci-prod"
  run "$SCRIPT" working
  [[ "$status" -eq 0 ]]
  args="$(_captured_args)"
  echo "$args" | grep -qx -- "ci-prod"
  ! echo "$args" | grep -qx -- "ci"
}

@test "agent_id is sanitised per SPEC §2.2 (lowercase, slashes → hyphens)" {
  export GITHUB_REPOSITORY="KrypteK/Volley"
  run "$SCRIPT" working
  [[ "$status" -eq 0 ]]
  args="$(_captured_args)"
  echo "$args" | grep -qx -- "gh-kryptek-volley-7891234567"
}

@test "agent_id is truncated to 63 chars" {
  export GITHUB_REPOSITORY="someorg/$(printf 'a%.0s' {1..80})"
  export GITHUB_RUN_ID="1"
  run "$SCRIPT" working
  [[ "$status" -eq 0 ]]
  args="$(_captured_args)"
  # Find the value passed to --agent-id and assert its length <= 63.
  agent_id="$(echo "$args" | awk '/^--agent-id$/{getline; print}')"
  [[ -n "$agent_id" ]]
  [[ "${#agent_id}" -le 63 ]]
}

@test "missing GITHUB_REPOSITORY fails with exit 2 and a clear error" {
  unset GITHUB_REPOSITORY
  run "$SCRIPT" working
  [[ "$status" -eq 2 ]]
  [[ "$output" == *"GITHUB_REPOSITORY"* ]]
}

@test "missing type arg fails with exit 2" {
  run "$SCRIPT"
  [[ "$status" -eq 2 ]]
}

@test "fallback to mosquitto_pub when volley is not on PATH" {
  # Remove the volley shim from the test PATH; add a mosquitto_pub shim instead.
  rm "$TEST_TMPDIR/volley"
  cat >"$TEST_TMPDIR/mosquitto_pub" <<EOF
#!/usr/bin/env bash
printf '%s\0' "\$@" >"$CAPTURE.args"
exit 0
EOF
  chmod +x "$TEST_TMPDIR/mosquitto_pub"

  run "$SCRIPT" working
  [[ "$status" -eq 0 ]]
  [[ -f "$CAPTURE.args" ]]
  args="$(_captured_args)"

  # mosquitto_pub flags: -h <host> -p <port> -q 1 -r -t <topic> -m <envelope>
  echo "$args" | grep -qx -- "-h"
  echo "$args" | grep -qx -- "localhost"
  echo "$args" | grep -qx -- "-p"
  echo "$args" | grep -qx -- "1883"
  echo "$args" | grep -qx -- "-q"
  echo "$args" | grep -qx -- "1"
  echo "$args" | grep -qx -- "-r"
  echo "$args" | grep -qx -- "-t"
  echo "$args" | grep -qx -- "volley/ci/gh-kryptek-volley-7891234567/status"

  # The envelope JSON follows -m; pull it out and validate shape.
  envelope="$(echo "$args" | awk '/^-m$/{getline; print}')"
  [[ -n "$envelope" ]]
  echo "$envelope" | grep -q '"schema_version":"0.1"'
  echo "$envelope" | grep -q '"agent_id":"gh-kryptek-volley-7891234567"'
  echo "$envelope" | grep -q '"channel":"status"'
  echo "$envelope" | grep -q '"type":"working"'
  echo "$envelope" | grep -q '"payload":{}'
}

@test "fallback passes VOLLEY_AUTH_* to mosquitto_pub as -u/-P" {
  rm "$TEST_TMPDIR/volley"
  cat >"$TEST_TMPDIR/mosquitto_pub" <<EOF
#!/usr/bin/env bash
printf '%s\0' "\$@" >"$CAPTURE.args"
exit 0
EOF
  chmod +x "$TEST_TMPDIR/mosquitto_pub"

  export VOLLEY_AUTH_USERNAME="coordinator"
  export VOLLEY_AUTH_PASSWORD="s3cret"
  run "$SCRIPT" working
  [[ "$status" -eq 0 ]]
  args="$(_captured_args)"
  [[ "$(echo "$args" | awk '/^-u$/{getline; print}')" == "coordinator" ]]
  [[ "$(echo "$args" | awk '/^-P$/{getline; print}')" == "s3cret" ]]
}

@test "fallback rejects mqtts:// with exit 2 (TLS requires the volley CLI)" {
  rm "$TEST_TMPDIR/volley"
  cat >"$TEST_TMPDIR/mosquitto_pub" <<EOF
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$TEST_TMPDIR/mosquitto_pub"

  export VOLLEY_BROKER_URL="mqtts://broker.example.com:8883"
  run "$SCRIPT" working
  [[ "$status" -eq 2 ]]
  [[ "$output" == *"mqtts"* ]]
}
