# v0.8.0 owner smoke: repositories

The release-level smoke for **repositories** (machines as a compute pool, SPEC §4.6.21): one
paired machine, two GitHub repositories added once by `owner/name`, one wave on each, a deploy,
and a removal, on real machines. Run it on the release head before tagging, top to bottom, and
record the results at the end. The automated twin is
`packages/volleyd/test/fleet-repos.test.ts` (the same scenarios on fakes); this script is what
fakes cannot show: real clones, real ssh, the Desk.

What it covers, in order:

1. a paired machine, and a legacy `hosts.<name>.repo` migrating by itself;
2. adding two repositories from the Desk: one on every machine, one on the paired machine only;
3. `volley repo status` against the Desk's chips;
4. one wave on each repository, each placed where its repository is ready;
5. a repository's missing tool keeping its waves off that machine, and only its waves;
6. `volley deploy` keeping every repository green;
7. removing one repository (its clones stay).

Each step says what to run and what you should see. Tick the box only when you saw it.

---

## 0. What you need

- [ ] **The supervisor's machine** ("the Mac": volleyd and the Desk running this release head, an
  admin Desk session, the coordinator's skills installed) as in [`SMOKE.md`](../SMOKE.md) Plan 12.
- [ ] **A second machine** ("the box", `box-a` below) with bun, claude (signed in), gh
  (authenticated), git, tmux and a volley checkout of this release head, reachable from the Mac
  by key-based ssh. If it was paired before this release with a bare `--repo <path>`, keep it
  paired: §1 checks its migration.
- [ ] **Two throwaway GitHub repositories** you can open PRs and merge into, `<you>/smoke-a`
  and `<you>/smoke-b`, each with one small open issue and a pushed release branch
  (`release/<yyyy-mm-dd>-smoke`). Give `smoke-a` a `pom.xml` (an empty `<project/>` is enough):
  it then needs `java`, which §5 uses. `smoke-b` needs nothing beyond git.
- [ ] Shell variables in each terminal on the Mac: `A=<you>/smoke-a`, `B=<you>/smoke-b`,
  `BOX=box-a`.

---

## 1. The paired machine

- [ ] **Already paired with a legacy `repo`.** On the Mac, `volleyd config get hosts.$BOX`
  shows `repo: <path>` before this release's first heartbeat. Within a minute of the box's next
  heartbeat (the release's `volley peer run` reports its clone's origin), the same command shows
  `repos: { <owner/name>: <path> }` and no `repo:` key; `volleyd config get repos` has the box
  under that repository's `machines`; `grep config_changed
  "${VOLLEYD_HOME:-$HOME/.volley/volleyd}/waves/_system/journal.jsonl"` ends with one by
  `volleyd`. A wave on that repository still spawns there (§4 covers it if
  it is `smoke-a` or `smoke-b`).
- [ ] **Not paired yet.** Settings › Machines › **+ Add a machine**, run the copied
  `volley peer join <code> --to <you@mac>` on the box (or `volley peer invite` on the Mac and
  `volley peer join … --repo $A` on the box). The card goes green: `ready for agents`.

## 2. Add two repositories from the Desk

- [ ] Settings › Repositories › **Add repository…**: `smoke-a`'s `owner/name`, every machine
  checked. **Add**. The Mac's chip reads `blocked: … gh repo clone <you>/smoke-a <path>`: volleyd
  never clones on its own machine. Run that command on the Mac; within a doctor run (or after
  **Add** again) the Mac's chip turns `ready`. The box's chip goes `cloning…`, then `ready` (it
  cloned under `~/.volley/repos/<you>/smoke-a`), or `blocked: java not installed (needed by …)`
  when the box has no java (keep it so for §5, or install java and wait for the next doctor run).
- [ ] **Add repository…** again: `smoke-b`, only the box checked. The form's terminal twin reads
  `volley repo add <you>/smoke-b --machine box-a`. The box's chip goes `cloning…`, then `ready`.
  The Mac has no `smoke-b` chip.
- [ ] Neither add asked to trust a folder: the box's agents never stop on the trust question for
  these clones (Settings › Machines shows both repositories on the box's card).

## 3. `volley repo status` reads like the Desk

- [ ] On the Mac:
  ```sh
  volley repo status
  ```
  prints each repository, then one line per machine it is assigned to, `<machine>: <state> (<why
  or path>)`. Each line's state is its chip's in Settings › Repositories, and a blocked line's
  first reason is the chip's text after `blocked: `. `volley repo status $B --json` lists the box
  only.

## 4. One wave on each repository

- [ ] Clone `smoke-b` anywhere on the Mac (`gh repo clone $B /path/to/smoke-b`): volleyd needs
  its own checkout of every wave's repository, but `smoke-b` is not assigned to the Mac, so the
  wave names that checkout by path. Write two wave files:
  ```yaml
  # wave-a.yaml
  wave: smoke-a-1
  repo: <you>/smoke-a                  # an owner/name: the Mac's managed clone
  release_branch: release/<yyyy-mm-dd>-smoke
  placement: auto
  tasks:
    T1: { issue: <n> }
  # wave-b.yaml
  wave: smoke-b-1
  repo: /path/to/smoke-b
  release_branch: release/<yyyy-mm-dd>-smoke
  placement: auto
  tasks:
    T1: { issue: <n> }
  ```
  `volleyd run wave-a.yaml`, then `volleyd run wave-b.yaml`.
- [ ] `smoke-b-1`'s T1 runs on the box. Its machine chip's tooltip shows the Mac's candidate line,
  `ineligible: no ready clone of <you>/smoke-b (blocked: <you>/smoke-b is not assigned to <mac>:
  …)`, and the Mac's card in Settings › Machines lists `smoke-b` blocked with the same reason.
- [ ] `smoke-a-1`'s T1 runs on whichever machine is ready for `smoke-a` and scores best (both
  candidates eligible when the box has java). Its agent's cwd is a worktree under
  `~/.volley/worktrees/<you>/smoke-a/` on that machine.

## 5. A missing tool keeps one repository's waves off a machine

Skip if the box has java; or move java off its `PATH` for this step (and restore it after).

- [ ] Settings › Repositories: the box's `smoke-a` chip reads `blocked: java not installed
  (needed by <you>/smoke-a)` and the toolchain column `needs java on box-a`; the box's card still
  says `ready for agents` and its `smoke-b` is `ready`.
- [ ] Submit another `smoke-a` wave (`wave: smoke-a-2`, `placement: auto`, `placement_prefer:
  [box-a]`): its T1 runs on the Mac, and the box's candidate line reads `ineligible: no ready clone
  of <you>/smoke-a (blocked: java not installed (needed by <you>/smoke-a))`. A new `smoke-b` wave
  still runs on the box.

## 6. `volley deploy` keeps both repositories green

- [ ] With no task running on the box (the deploy restarts its `volley peer run`), on the Mac:
  ```sh
  volley deploy --only $BOX           # the tag the Mac already runs; or volley deploy v<tag>
  ```
  The box's health line is `box-a: v<tag> ✓ eligible`, followed by
  `· <you>/smoke-a blocked: tool.java (…)` while §5's java is still missing (a repository's check
  never makes the machine ineligible).
- [ ] Within a heartbeat, `volley repo status` shows both repositories as before the deploy on
  every machine (`ready`, or §5's `blocked` reason), and Settings › Repositories agrees.

## 7. Remove one repository

- [ ] Settings › Repositories › `smoke-b` › **Remove…**: the sheet names the box's clone path
  and says it stays on disk. Confirm. The row disappears; `volley repo status` no longer lists
  `smoke-b`; `volley repo list` lists `smoke-a` only; `ssh box-a ls ~/.volley/repos/<you>/smoke-b`
  still lists the clone.
- [ ] A new `smoke-b` wave (`placement: auto`, from `/path/to/smoke-b`) runs on the Mac: a
  repository config no longer names is the supervisor's own again, as before repositories, and
  the box (no `smoke-b` in its `peer.json` any more) is `absent` for it.

## Teardown

Stop any smoke wave (`volleyd stop <wave> --by desk`), remove `smoke-a` too if you no longer want
it (`volley repo remove $A`), and delete the clones by hand on both machines if you no longer want
them (`~/.volley/repos/<you>/…`, `/path/to/smoke-b`): volleyd never deletes a clone.

---

## Results

```
RESULTS (<date>, release head <sha>):
  1. paired machine (legacy migration / fresh join):
  2. add smoke-a (all) / smoke-b (box only), no trust question:
  3. volley repo status == Desk chips:
  4. smoke-b on the box, Mac blocked "not assigned"; smoke-a placed (where, why):
  5. java missing: smoke-a off the box, smoke-b still there:
  6. deploy: box eligible, both repositories as before:
  7. remove smoke-b: clone kept, new smoke-b wave on the Mac:
  Issues found:
```
