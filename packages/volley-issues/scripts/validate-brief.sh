#!/bin/bash
# Hard gate: refuse to launch a Volley spawn brief that lacks the mandatory
# narration contract (verified against volley-dash). Call this from the agent
# launcher BEFORE exec'ing `claude`, so a deficient brief can never start an agent.
# It also serves as volleyd's brief gate ($VOLLEYD_HOME/brief-gate): volleyd's briefs carry the
# same narration contract, and their session hooks register the agent, so for them an "already
# registered" statement stands in for the vol_register step.
# A hand-written brief whose vol_register step carries no `title` (on its line or the three after)
# still passes, with a warning on stderr: the Desk then names the window after the bare agent id.
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
check 'progress:? *100|progress`? tick at 100'           'final progress:100 tick before terminal status'
check 'vol_register|already registered'                'vol_register step 1 (or, in a volleyd brief, "already registered" by the session hooks)'
if [ "$fail" -ne 0 ]; then
  echo "validate-brief: '$f' FAILS the Volley narration contract — NOT dispatching." >&2
  echo "  Fix: append brief/NARRATION_BLOCK.txt (in the volley-issues skill directory) to the brief," >&2
  echo "  with vol_register as step 1 (a volleyd brief must not ask to register: keep its protocol block)." >&2
  exit 1
fi
if ! grep -qi 'already registered' "$f" && grep -qi 'vol_register' "$f" \
  && ! grep -i -A3 'vol_register' "$f" | grep -qiE '\btitle *[=:]'; then
  echo "WARNING: vol_register without title — add title=\"#<N> <issue title> — <role>\" (scripts/brief-title.ts) so the Desk can name the agent's window." >&2
fi
echo "validate-brief: OK — '$f' satisfies the Volley narration contract."
