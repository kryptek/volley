# Reserved SPEC numbers and names

Parallel tasks of one epic that each add to `spec/SPEC.md` would otherwise pick the same next
section number (two children both writing §4.6.18, the second to merge renumbering every
citation). The epic's first PR reserves each child's new section numbers, wave-event names and
decision kinds here, the way a migration counter reserves numbers; each child uses exactly what
it was given and removes its rows in the PR that lands them.

`bun run check:spec-refs` reads the rows whose first cell is a section number (`§N.N`): it fails
when a SPEC heading with that number carries another topic (a sibling took it) and when a number
is reserved twice. A heading matches when its title contains the topic, ignoring case. Rows that
reserve an event or a decision kind (a backticked name in the first cell) are notes for the
siblings; the SPEC lists those one per line, checked against the schemas.

| Reserved | Issue | Topic |
|---|---|---|
| `task_admission_returned` | T4 | wave event |
| `cluster_strategy_changed` | #384 | wave event |
| `train_started` | #386 | wave event |
| `train_merged` | #386 | wave event |
| `train_failed` | #386 | wave event |
| `churn_exhausted` | #387 | decision kind |
