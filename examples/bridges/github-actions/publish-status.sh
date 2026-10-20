#!/usr/bin/env bash
# publish-status.sh — publish a Volley status envelope from a GitHub Actions step.
#
# Usage: publish-status.sh <type> [payload-json]
#
# Reads from environment (GitHub Actions sets these automatically):
#   GITHUB_REPOSITORY   required, e.g. "kryptek/volley"
#   GITHUB_RUN_ID       required, e.g. "7891234567"
#   VOLLEY_BROKER_URL   optional, defaults to mqtt://localhost:1883 (forwarded to volley CLI)
#   VOLLEY_NAMESPACE    optional, defaults to "ci"
#   VOLLEY_AUTH_USERNAME / VOLLEY_AUTH_PASSWORD
#                       optional broker credentials (store them as repo secrets).
#                       The volley CLI reads them itself; the mosquitto_pub
#                       fallback passes them as -u/-P.
#
# Computes a deterministic agent_id: gh-<owner>-<repo>-<run-id>, sanitised per
# SPEC §2.2 grammar [a-z0-9][a-z0-9_-]{0,62} (lowercased, slashes → hyphens,
# truncated to 63 chars). Publishes to volley/<ns>/<agent_id>/status.
#
# Prefers the `volley` CLI when available on PATH; falls back to `mosquitto_pub`
# (constructing the SPEC §3 envelope inline) when it isn't.

set -euo pipefail

die() {
  printf '%s\n' "publish-status.sh: $*" >&2
  exit 2
}

# --- args ---------------------------------------------------------------------

if [[ $# -lt 1 ]]; then
  die "missing required <type> argument; usage: publish-status.sh <type> [payload-json]"
fi
TYPE="$1"
PAYLOAD="${2:-{\}}"

# --- required env -------------------------------------------------------------

if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  die "GITHUB_REPOSITORY is not set (expected owner/repo, e.g. kryptek/volley)"
fi
if [[ -z "${GITHUB_RUN_ID:-}" ]]; then
  die "GITHUB_RUN_ID is not set"
fi

# --- optional env / defaults --------------------------------------------------

NAMESPACE="${VOLLEY_NAMESPACE:-ci}"
BROKER_URL="${VOLLEY_BROKER_URL:-mqtt://localhost:1883}"

# --- compute agent_id ---------------------------------------------------------
# gh-<owner>-<repo>-<run-id>, lowercased, slashes → hyphens, then truncated
# to 63 chars per SPEC §2.2 grammar: [a-z0-9][a-z0-9_-]{0,62}

raw_id="gh-${GITHUB_REPOSITORY}-${GITHUB_RUN_ID}"
# Lowercase + slashes to hyphens. Any other non-grammar characters are also
# replaced with '-' so we never emit an id the broker would reject.
lowered="$(printf '%s' "$raw_id" | tr '[:upper:]' '[:lower:]' | tr '/' '-')"
sanitised="$(printf '%s' "$lowered" | sed 's/[^a-z0-9_-]/-/g')"
AGENT_ID="${sanitised:0:63}"

# --- publish ------------------------------------------------------------------

if command -v volley >/dev/null 2>&1; then
  # Preferred path: let the CLI build the envelope, talk to the broker, and
  # handle exit-code conventions.
  exec volley pub \
    --broker-url "$BROKER_URL" \
    --namespace "$NAMESPACE" \
    --agent-id "$AGENT_ID" \
    --channel status \
    --type "$TYPE" \
    --payload "$PAYLOAD"
fi

# Fallback: construct the SPEC §3 envelope inline and shell out to mosquitto_pub.
# Requires mosquitto-clients to be installed on the runner.
if ! command -v mosquitto_pub >/dev/null 2>&1; then
  die "neither 'volley' nor 'mosquitto_pub' is on PATH; install one of them on the runner"
fi

case "$BROKER_URL" in
  mqtts://*)
    die "mqtts:// scheme requires the volley CLI for TLS handling; install volley or use mqtt:// (mosquitto_pub fallback path is plain-TCP only)"
    ;;
esac

TOPIC="volley/${NAMESPACE}/${AGENT_ID}/status"
WALL_TIME="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

# Build envelope JSON without depending on jq. PAYLOAD is inserted verbatim;
# callers are responsible for passing valid JSON when they pass a payload.
ENVELOPE="$(cat <<EOF
{"schema_version":"0.1","agent_id":"${AGENT_ID}","parent_id":null,"wall_time":"${WALL_TIME}","channel":"status","type":"${TYPE}","payload":${PAYLOAD},"correlation_id":null}
EOF
)"

# Status is QoS 1 + retained per SPEC §4.1.
# Parse mqtt[s]://host[:port] into the flags mosquitto_pub wants.
host="$(printf '%s' "$BROKER_URL" | sed -E 's#^mqtts?://([^:/]+).*#\1#')"
port="$(printf '%s' "$BROKER_URL" | sed -nE 's#^mqtts?://[^:/]+:([0-9]+).*#\1#p')"
port="${port:-1883}"

auth=()
if [[ -n "${VOLLEY_AUTH_USERNAME:-}" ]]; then
  auth=(-u "$VOLLEY_AUTH_USERNAME")
  [[ -n "${VOLLEY_AUTH_PASSWORD:-}" ]] && auth+=(-P "$VOLLEY_AUTH_PASSWORD")
fi

mosquitto_pub \
  -h "$host" \
  -p "$port" \
  ${auth[@]+"${auth[@]}"} \
  -q 1 \
  -r \
  -t "$TOPIC" \
  -m "$ENVELOPE"
