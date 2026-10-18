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
