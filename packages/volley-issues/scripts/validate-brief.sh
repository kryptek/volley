#!/bin/bash
# Hard gate: refuse to launch a Volley spawn brief that lacks the mandatory
# narration contract (verified against volley-dash). Call this from the agent
# launcher BEFORE exec'ing `claude`, so a deficient brief can never start an agent.
#   usage: validate-brief.sh <brief-file>
f="$1"
[ -f "$f" ] || { echo "validate-brief: no such brief file: $f" >&2; exit 2; }
fail=0
check() { # <regex> <human-name>
  grep -qiE "$1" "$f" || { echo "  MISSING: $2" >&2; fail=1; }
}
check 'channel="progress"'                              'narration on the progress channel (channel="progress")'
check '\bmsg\b'                                         'msg field (the dashboard ignores message/milestone)'
check 'type="narration"'                               'ad-hoc type="narration" ticks'
check 'once every 60|once a minute|every 60 ?sec|at least once every' 'the >=1/minute frequent-narration rule'
check 'progress:? *100'                                'final progress:100 tick before terminal status'
check 'vol_register'                                   'vol_register step 1'
if [ "$fail" -ne 0 ]; then
  echo "validate-brief: '$f' FAILS the Volley narration contract — NOT dispatching." >&2
  echo "  Fix: append brief/NARRATION_BLOCK.txt (in the volley-issues skill directory) to the brief." >&2
  exit 1
fi
echo "validate-brief: OK — '$f' satisfies the Volley narration contract."
