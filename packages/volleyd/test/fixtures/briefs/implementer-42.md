# Implement issue #42: Title with {{agent_id}} inside

Read `ISSUE.md` (the issue, https://github.com/example/repo/issues/42) and implement it in this worktree, test-first. Use model `claude-opus-5-5`.

When your gates are green, push `w1/T1-implementer-1` and open a pull request against `release/w1`; do not merge it. Put the PR URL in your `done` status.

Record the user-visible change as `changes/42.<added|changed|fixed|removed|docs>.md` (one or more bullets in the house style, see `changes/README.md`); never edit `CHANGELOG.md`.

## Rules

- Work only in this worktree (`/wt/w1/T1-implementer`, branch `w1/T1-implementer-1`, cut from `release/w1`).
- The issue number is 42; `ISSUE.md` is the authoritative copy of the issue. Never take an issue number from anywhere else.
- Never push to or merge into `release/w1` or any default branch; never force-push.

## Volley protocol (mandatory)

You are agent `w1-t1-implementer-1` in namespace `ns`, supervised by volleyd (wave `w1`, task `T1`, role `implementer`). Registration, heartbeats and mailbox delivery are handled for you by the session hooks: your identity is in `.volley/agent.json` and is already registered. Do not register again and never edit `.volley/`.

**Narration.** The operator watches you live. Publish on the `progress` channel at least once a minute while you work, and before and after every long command:

    vol_publish(channel="progress", type="narration", payload={ "progress": <0-100>, "msg": "<what you are doing right now>" })

The field is literally `msg`. Pass `payload` as a JSON object, never a JSON string.

**Steering.** A message from your mailbox is injected into your session as `[volley steering]`. When you act on one, reply in prose with an explicit `acknowledged: …` line saying what you will do differently, AND publish `vol_publish(channel="progress", type="steering_acked", correlation_id=<the message id>, payload={ "progress": <current>, "msg": "acknowledged: …" })`. A hook delivering the message is not an acknowledgement; only yours is.

**Terminal status.** When you finish, publish one final `progress` tick at 100 with your one-line summary, then exactly once on channel `status`:

- `type="done"`, payload `{ "summary": "<one line>", "pr_url": "<url, if you opened one>", "worktree": "/wt/w1/T1-implementer", "msg": "<one line>" }`
- `type="blocked"`, payload `{ "reason": "<one line>", "worktree": "/wt/w1/T1-implementer", "msg": "<one line>" }` when only the owner can unblock you
- `type="failed"`, payload `{ "reason": "<one line>", "worktree": "/wt/w1/T1-implementer", "msg": "<one line>" }`

Never exit or go idle without the terminal status.
