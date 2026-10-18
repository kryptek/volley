#!/bin/sh
# Write the identities mosquitto-auth.test.ts logs in as into <dir>/passwd and
# copy the ACL next to it. Each password is "<username>-test-pw" (test-only).
# Run with the broker's own mosquitto_passwd so the hash format matches it.
# Usage: auth-fixture.sh <dir> <acl.conf>
set -eu
dir=$1
acl=$2
mkdir -p "$dir"
cp "$acl" "$dir/acl.conf"
: > "$dir/passwd"
chmod 0600 "$dir/passwd" "$dir/acl.conf"
for user in volleyd desk coordinator w1-t1-implementer-1 w1-t2-implementer-1; do
  mosquitto_passwd -b "$dir/passwd" "$user" "$user-test-pw"
done
# What `volley auth add-agent w1-t1-implementer-1 --ack-to coordinator-ab12`
# appends to acl.conf (the test checks the agent can ack that coordinator).
cat >> "$dir/acl.conf" <<'ACL'

# >>> volley agent w1-t1-implementer-1 (managed by `volley auth`; do not edit)
user w1-t1-implementer-1
topic write volley/+/coordinator-ab12/mailbox
# <<< volley agent w1-t1-implementer-1
ACL
