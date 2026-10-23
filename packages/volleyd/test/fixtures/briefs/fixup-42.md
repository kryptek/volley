# Fix-up for issue #42: Title with {{agent_id}} inside

Read `ISSUE.md` (the issue, https://github.com/example/repo/issues/42) and the review findings you were given, and address each one on this branch, test-first. When the gates are green, push to the PR branch as `.volley/findings.md` says; do not merge.

## Result contract

`.volley/findings.md` lists every finding of both reviewers (ids `S1…` for spec, `Q1…` for quality) and the rule: apply every P1; apply a P2 or P3 only if the change is trivial. This worktree starts at the reviewed head on its own branch; publish your commits to the PR branch with the `git push origin HEAD:<pr branch>` line given there (a fast-forward, never a force-push). Before your `done`, publish how each finding was handled:

    vol_publish(channel="result", type="fixup", payload={ "resolved": [{ "finding": "S1", "how": "<what you changed, or why not>" }] })

When `.volley/findings.md` opens with **Directive: the PR head moved**, the PR head was pushed outside the pipeline after a gate and the owner sent it to you: that directive (CI on the new head, its failed jobs and failing tests, the diff since the gated head) is your first job, and it is resolved in `resolved` like a finding (`CI`, or `MOVE` when CI was green).

When it opens with **Directive: CI failed on your head**, CI failed on the head the pipeline pushed and you are sent to make it green: the failed jobs, the failing tests and the tail of the failed runs' log are your only job (there are no review findings to apply). Fix the cause without undoing what the PR intends, and resolve it as `CI` in `resolved`.

volleyd then verifies the push, the PR and CI on the new head before anything moves on.

When a fix changes user-visible behaviour, amend the task's changelog fragment, `changes/42.<type>.md` (or add one; see `changes/README.md`); never edit `CHANGELOG.md`.

## Rules

- Work only in this worktree (`/wt/w1/T1-implementer`, branch `w1/T1-implementer-1`, cut from the reviewed PR head named in `.volley/findings.md`).
- The issue number is 42; `ISSUE.md` is the authoritative copy of the issue. Never take an issue number from anywhere else.
- Never push to or merge into `release/w1` or any default branch; never force-push.

## Volley protocol (mandatory)

You are agent `w1-t1-implementer-1` in namespace `ns`, supervised by volleyd (wave `w1`, task `T1`, role `fixup`). Registration, heartbeats and mailbox delivery are handled for you by the session hooks: your identity is in `.volley/agent.json` and is already registered. Do not register again and never edit `.volley/`.

**Narration.** The operator watches you live. Publish on the `progress` channel at least once a minute while you work, and before and after every long command:

    vol_publish(channel="progress", type="narration", payload={ "progress": <0-100>, "msg": "<what you are doing right now>" })

The field is literally `msg`. Pass `payload` as a JSON object, never a JSON string.

**Steering.** A message from your mailbox is injected into your session as `[volley steering]`. When you act on one, reply in prose with an explicit `acknowledged: …` line saying what you will do differently, AND publish `vol_publish(channel="progress", type="steering_acked", correlation_id=<the message id>, payload={ "progress": <current>, "msg": "acknowledged: …" })`. A hook delivering the message is not an acknowledgement; only yours is.

**Terminal status.** When you finish, publish one final `progress` tick at 100 with your one-line summary, then exactly once on channel `status`:

- `type="done"`, payload `{ "summary": "<one line>", "pr_url": "<url, if you opened one>", "worktree": "/wt/w1/T1-implementer", "msg": "<one line>" }`
- `type="blocked"`, payload `{ "reason": "<one line>", "worktree": "/wt/w1/T1-implementer", "msg": "<one line>" }` when only the owner can unblock you
- `type="failed"`, payload `{ "reason": "<one line>", "worktree": "/wt/w1/T1-implementer", "msg": "<one line>" }`

Never exit or go idle without the terminal status.
