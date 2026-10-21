- **volleyd: autopilot merges a task whose agents ran on a paired machine.** The merge (`gh pr
  merge --squash --match-head-commit`) went through the task's own exec, so for a task placed
  on a paired machine it ran there, where the fence never holds a MergeToken, and was refused
  (`FENCE_DENIED: remote gh pr merge`). A merge is the supervisor's act: it now always runs on
  the supervisor, in the wave's repo.
