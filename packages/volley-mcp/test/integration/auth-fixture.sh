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
for user in volleyd desk coordinator w1-t1-implementer-1 w1-t2-implementer-1 \
  admin-test steer-test watch-test peer-test supervisor-test redeem-0000abcd; do
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
# What `volley auth add <name> --role <role>` appends for each role, and what
# `volley auth token` appends for a token login (volleyd's mosquitto-roles.test.ts
# checks them; volley-cli's auth.test.ts checks they match the generator).
cat >> "$dir/acl.conf" <<'ACL'

# >>> volley account admin-test (managed by `volley auth`; do not edit)
# role: admin
user admin-test
topic write volley/+/+/mailbox
topic write volley/+/+/status
topic write volley/+/+/progress
topic write volley/+/+/result
topic write volley/+/+/capability
topic write volley/+/+/control
topic write volley/+/+/_user/#
topic write volley/_system/registry/+
topic write volley/_system/auth/ops/admin-test
# <<< volley account admin-test

# >>> volley account steer-test (managed by `volley auth`; do not edit)
# role: steer
user steer-test
topic write volley/+/+/mailbox
# <<< volley account steer-test

# >>> volley account watch-test (managed by `volley auth`; do not edit)
# role: watch
user watch-test
# <<< volley account watch-test

# >>> volley account peer-test (managed by `volley auth`; do not edit)
# role: peer
user peer-test
topic write volley/_system/machines/peer-test
topic write volley/_system/machines/peer-test/#
# <<< volley account peer-test

# >>> volley account supervisor-test (managed by `volley auth`; do not edit)
# role: supervisor
user supervisor-test
topic deny volley/_system/auth/ops/#
topic deny volley/_system/auth/replies/#
topic readwrite volley/#
# <<< volley account supervisor-test

# >>> volley token 0000abcd (managed by `volley auth`; removed when redeemed or expired)
user redeem-0000abcd
topic write volley/_system/auth/redeem
# <<< volley token 0000abcd
ACL
