# Agent briefs

One template per role volleyd spawns: `implementer`, `spec_reviewer`, `quality_reviewer`,
`fixup`, `rebase`, plus `rebase-merge.md.tmpl`, the rebase role's brief when its step runs under
`branch_update: merge` (merge the release branch in, a normal push, never a force-push), and
`flake-fixer.md.tmpl`, the implementer's brief for a synthetic flake-fixer task (no issue: its
`ISSUE.md` is the root-cause brief, `src/autopilot/flake-brief.ts`). At
spawn, `src/brief.ts` renders `<role>.md.tmpl` (or that variant) into the agent's
`.volley/brief.md`, below the repo's brief preface (if any); `launch.sh` passes that file to
`claude` as its prompt, so the brief never appears in an argv.

## Placeholders

`{{name}}` placeholders are filled in a single pass (text substituted in, like an issue title
that itself contains `{{…}}`, is never expanded again). An unknown placeholder is an error.

| Placeholder | Value |
|---|---|
| `agent_id`, `namespace` | the agent's literal id and Volley namespace (also in `.volley/agent.json`) |
| `wave`, `task`, `role` | where the agent sits in the wave |
| `issue`, `issue_title`, `issue_url` | from `gh issue view`, for the number in the wave file (a flake fixer: `0`, `Fix flaky test <test>` and its first failing run) |
| `model` | the task's model |
| `repo`, `release_branch`, `branch`, `worktree` | the repo root, the base branch, the agent's branch and worktree |
| `extra` | repo-specific notes (below), or empty |
| `hygiene_rule`, `hygiene_contract` | reviewer briefs: the hygiene check line and its result-contract bullet for the wave's hygiene level (`reviews.ts` `hygieneText`: P1 for a public repository, P3 for a private one, empty under `public_hygiene: off`) |

## The protocol block

Every template ends with the same protocol block. Keep it in all seven when you edit one:

- **No registration step.** The session hooks register the agent (with its model), send
  heartbeats and deliver mailbox mail; the brief must never ask the agent to call `vol_register`.
- **Narration** on the `progress` channel with `payload.progress` and `payload.msg`, at least
  once a minute.
- **Steering acknowledgement**: an explicit prose `acknowledged: …` line *and* a `progress`
  publish of type `steering_acked` carrying the mailbox message's `correlation_id`. A hook
  delivering a message is not compliance; this ack is.
- **Terminal status**, exactly once: `done` / `blocked` / `failed` on the `status` channel.

`test/brief.test.ts` checks each rendered template for these rules.

## Pipeline inputs and the result contract

Pipeline roles get their inputs as files the spawn writes into `.volley/` before launch:
`review.md` (reviewers: the PR, the exact head of their detached worktree, the diff command),
`findings.md` + `findings.json` (fixup: every finding, numbered `S1…`/`Q1…`, the trivial-only
rule and the push line), `rebase.md` (rebase: the commands and the one lease-guarded push;
under `branch_update: merge`, the merge and its normal push).
Reviewers and the fixup publish a retained `result` before `done` — `type: "review"` with
`{ findings, verdict, hygiene?: { checked: true, findings } }`, `type: "fixup"` with
`{ resolved: [{ finding, how }] }` (`spec/schemas/review-result.schema.json`); the templates
spell out that contract. Both reviewer templates carry the hygiene check through
`{{hygiene_rule}}` / `{{hygiene_contract}}`, whatever the repo's preface says: for a public
repository (or one whose visibility could not be read) the P1 line (`reviews.ts`
`HYGIENE_CHECK`: person names, local usernames, machine paths, private hostnames or IPs in the
diff, commit messages or PR text are P1s, the `hygiene` block required); for a private one a
non-blocking P3 note; nothing under `public_hygiene: off`. `test/reviews.test.ts` holds both
templates to it. Keep the placeholders in both when you edit one.

## Repo preface, extras and the brief gate

- `<repo>/.volley/brief-preface.md` (or the wave file's `brief_preface:`) — the repo's
  **rules**, put verbatim at the very top of every brief, above the template and a `---` rule.
  No placeholder is expanded in it. Capped at `brief_preface_max_bytes`. Public-repo hygiene
  rules belong here; `/volley-issues` creates the file from its template when it is missing.
- `<repo>/.volley/brief-extra.md` — the repo's **notes**: appended to every brief for that repo
  as a "Repository notes" section (build commands, gates), through `{{extra}}`. `.volley/` is
  kept out of git through the repo's `info/exclude`.
- `$VOLLEYD_HOME/brief-gate` — an executable run as `brief-gate <path to brief.md>` before any
  launch; a non-zero exit refuses the spawn with `SPAWN_BRIEF_REJECTED` (stderr is journaled).
  Use it to enforce house rules on briefs. It is a local file, never a tunable: tunables can be
  changed over the broker, and a gate is a program.
