# Spec review for issue #42: Title with {{agent_id}} inside

Read `ISSUE.md` (the issue, https://github.com/example/repo/issues/42) and review the implementation on this branch against it: every requirement and RED test the issue lists is present and behaves as specified, nothing out of scope was added. Do not change code.

Report each finding with file and line. Your `done` summary says `approve` or `changes requested`.

Public hygiene: flag as P1 any person name, local username, machine path (home directories, temp paths), private hostname or IP in the diff, commit messages or PR text.

## Result contract

Read `.volley/review.md` first: it names the PR, the exact head this detached worktree is at, and the diff to review. Before your `done`, publish your review as one retained result — volleyd reads it, and a `done` without it is sent back to you once:

    vol_publish(channel="result", type="review", payload={ "findings": [{ "severity": "P1", "file": "src/x.ts", "line": 42, "text": "<what is wrong and why>" }], "verdict": "changes_requested" })

- `severity`: `P1` blocks the merge, `P2` should be fixed, `P3` is a nit (also use `P3` for a hunk you checked and consider fine, with that as the text).
- `file` is repo-relative; `line` is optional; `verdict` is `approve` or `changes_requested`.
- No findings: `"findings": []` with `"verdict": "approve"`.
- `hygiene` is required: add `"hygiene": { "checked": true, "findings": [] }` to the payload once you have checked the diff, every commit message (`git log origin/<release branch>..HEAD`) and the PR title and body for the public-hygiene line above; `findings` lists each hit as a P1 (same shape as a finding; `file` is `COMMIT` or `PR` for a commit message or the PR text). A result without it is not accepted.

## Rules

- Work only in this worktree (`/wt/w1/T1-implementer`): a detached checkout of the PR head named in `.volley/review.md`.
- The issue number is 42; `ISSUE.md` is the authoritative copy of the issue. Never take an issue number from anywhere else.
- Never push to or merge into `release/w1` or any default branch; never force-push.

## Volley protocol (mandatory)

You are agent `w1-t1-implementer-1` in namespace `ns`, supervised by volleyd (wave `w1`, task `T1`, role `spec_reviewer`). Registration, heartbeats and mailbox delivery are handled for you by the session hooks: your identity is in `.volley/agent.json` and is already registered. Do not register again and never edit `.volley/`.

**Narration.** The operator watches you live. Publish on the `progress` channel at least once a minute while you work, and before and after every long command:

    vol_publish(channel="progress", type="narration", payload={ "progress": <0-100>, "msg": "<what you are doing right now>" })

The field is literally `msg`. Pass `payload` as a JSON object, never a JSON string.

**Steering.** A message from your mailbox is injected into your session as `[volley steering]`. When you act on one, reply in prose with an explicit `acknowledged: …` line saying what you will do differently, AND publish `vol_publish(channel="progress", type="steering_acked", correlation_id=<the message id>, payload={ "progress": <current>, "msg": "acknowledged: …" })`. A hook delivering the message is not an acknowledgement; only yours is.

**Terminal status.** When you finish, publish one final `progress` tick at 100 with your one-line summary, then exactly once on channel `status`:

- `type="done"`, payload `{ "summary": "<one line>", "pr_url": "<url, if you opened one>", "worktree": "/wt/w1/T1-implementer", "msg": "<one line>" }`
- `type="blocked"`, payload `{ "reason": "<one line>", "worktree": "/wt/w1/T1-implementer", "msg": "<one line>" }` when only the owner can unblock you
- `type="failed"`, payload `{ "reason": "<one line>", "worktree": "/wt/w1/T1-implementer", "msg": "<one line>" }`

Never exit or go idle without the terminal status.
