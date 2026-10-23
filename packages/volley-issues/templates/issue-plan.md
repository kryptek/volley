# Writing a batch's issues (the issue-planning brief)

This is the brief for an agent that turns a design into a batch of GitHub issues for
`/volley-issues` to dispatch as one wave. Each issue is one task's plan: one agent implements it,
test-first, and opens one PR. The overlap planner (`wave-from-issues`) reads every issue's Files
list to decide which tasks bundle, chain or wait, so the issues you write are also the plan's
only input. Write them for both readers.

## The issue

**Title:** a task tag, then the task in a line: `T3: the churn monitor — hold and train`
(`<tag>: …`, `<tag> — …` or `<tag> - …`; one to three capitals, one to three digits, an optional
lower-case letter). The tag becomes the task id in the wave file.

**Body**, in this order:

```markdown
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

Part of <the epic, as #N>. **<tag> — <the task in a line>.** One agent, one PR.

Depends on: #101, #102

## Problem

What is wrong or missing today, in the reader's terms. Two or three short paragraphs.

## Done when

- One bullet per observable outcome: a command's output, a journaled event, a check that fails.

## Design facts

- The decisions already made that the implementer must not reopen: names, formats, defaults,
  where a value lives. Link the SPEC section by heading, not a local design doc.

## Files

- `packages/<pkg>/src/<module>.ts` (`exportedFunction`)
- `packages/<pkg>/src/<new-module>.ts` (new)
- `packages/<pkg>/test/<module>.test.ts`
- `packages/<pkg>/README.md`
- `changes/<issue>.<type>.md`

## Steps

- [ ] The failing test first (RED): what it asserts.
- [ ] The change that makes it pass (GREEN).
- [ ] Docs, the changelog fragment, the gates, the PR.

## Out of scope

- What a neighbouring task does, or what is deferred, so the implementer stops at the edge.

## Gates

The repository's gate commands, e.g. `bun install`, `bun run lint`, `bun run typecheck`,
`bun run test`. Add `changes/<issue>.<type>.md`; never edit `CHANGELOG.md`.
```

`Depends on:` is one line of `#N` references (or `Depends on: none`); the helper turns it into
the task's `after:` and rejects a line it cannot read.

## The Files list is the footprint

The planner clusters tasks by the files their lists share, bundles strongly coupled ones and
chains the rest; volleyd caps a cluster in flight by it. A footprint that is wrong plans wrong,
so write it to resolve against the release branch's tree:

- exact repository paths, one per bullet: `packages/volleyd/src/pipeline.ts`, never
  `pipeline.ts`, "the pipeline" or a path relative to a package;
- `(new)` after a file the task creates;
- globs allowed (`spec/schemas/*.json`); a directory ends in `/`;
- no identifiers or function names on their own bullet (`planWave`, `lease_pools.*.match` are
  not files and are dropped): put them in parentheses after the path,
  `packages/volleyd/src/overlap-plan.ts` (`planWave`, `explain`);
- tests and docs included: they collide too;
- `changes/<issue>.<type>.md` last.

Keep the list contiguous (a blank line, prose or a heading ends it) and complete: a file the task
will touch and the list omits is an overlap nobody planned for.

## Look before filing: `--plan-only`

Before filing, write the draft issues as JSON (`[{ "number": 1, "title": "…", "body": "…" }]`,
placeholder numbers) and run the helper with `--plan-only`: it prints the plan (`cluster …`,
`independent: …`, `expected branch updates: …`) and the `footprints:` line, and writes nothing.
Fix every unresolved entry it reports, then read the clusters.

## When to bundle at filing time

If the batch is small (≤ 8 issues) and the planner would collapse most of it into bundles, file
one issue per bundle instead: one issue whose sub-headings `T0a`, `T0b` (`## T0a: …`, each with
its own Done when and Files) hold the parts, and whose Files list is their union. Fewer
issues, one PR, one review. For a larger batch, or parts that share nothing, file one issue per
task and let the planner bundle.

## Declare the chains you mean

When two tasks share a hot file and cannot bundle, the planner chains them, bigger first. If the
order matters, write `Depends on: #<the first>` in the second: the chain is then yours, not the
planner's, and survives `--no-plan`. Never leave an order to the planner that a reviewer would
need to know.

## Public-repo hygiene

The issues of a public repository are public. Never put into a title, body or Files list: a
person's name (write "the owner" or "a maintainer"), a local username, a machine path (home
directories, temp or worktree paths: write `/path/to/repo`), a private hostname, internal domain
or IP address, or a private ticket number. Never cite a local, untracked design document by
section number; state the fact the implementer needs instead.
