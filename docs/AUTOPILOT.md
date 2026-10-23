# Autopilot: the owner's guide

Autopilot is how a volleyd wave runs while you sleep. You submit a wave at night, close the
laptop, and in the morning read one digest: what shipped, what volleyd handled on its own, and
the few things only you can answer. This page is the map; each piece links to its reference.

## Before the first unattended wave

- **A coordinator name.** Set `VOLLEY_COORDINATOR` (e.g. `coord-main`) in the volley MCP
  registration's `env` and in your shell profile (root README, Quickstart step 4). The wave is
  owned by the name, not by the session, so the session can end and any later session with the
  same name answers for it.
- **`/volley-issues`, or `volleyd run <wave.yaml> --owner "$VOLLEY_COORDINATOR"`.** The skill
  writes `merge: auto` and `branch_update: merge` into the wave file by default and leaves once
  the wave is submitted ([volley-issues README](../packages/volley-issues/README.md)).
- **Optional: a release playbook**, `.volley/release.yaml` in the repository, for what turns a
  merged release branch into a release (version bump, changelog, staging, smoke, notes). Without
  one the wave simply completes. ([The release train](../packages/volleyd/README.md#the-release-train))
- **A phone that gets the Desk's notifications** (open the Desk on it once and allow
  notifications), or `volley notify` with a webhook to a push service.

## What runs unattended

| What | How volleyd handles it | Reference |
|---|---|---|
| Routine decisions | Answered from a reviewable policy table (a relaunch, a second nudge, a disputed P1 treated as a blocker, a spawn-budget raise), within per-wave budgets; every answer is journaled `decision_auto_resolved`. `volleyd policy` prints the table. | [Autopilot](../packages/volleyd/README.md#autopilot) |
| Red CI | Classified first: own change (a fixup agent with the CI result as its directive), flake (a dedicated `fix-<test>` task whose merge unblocks every PR that waited on it), or infra incident (held and re-checked; never re-run). | [Self-healing CI](../packages/volleyd/README.md#self-healing-ci) |
| Merging | Under `merge: auto`, each gated PR is squash-merged at exactly the reviewed head, through the authority fence, journaled `merged_by_supervisor`. A transient GitHub refusal (`Merge already in progress`, a 5xx, a rate limit) is retried with backoff, not escalated. | [Autopilot merging](../packages/volleyd/README.md#autopilot-merging) |
| Merge order and conflicts | The merge queue: dependency order, one merge in flight per release branch, each branch brought up to date (a merge, never a force-push) before its turn. | [The merge queue](../packages/volleyd/README.md#the-merge-queue) |
| Releasing | Once every task is merged, the playbook's stages run one at a time, each in a supervised agent's shell and verified afterwards. | [The release train](../packages/volleyd/README.md#the-release-train) |
| Crashed or stalled agents | Relaunched or respawned once, on their own branch and PR. | [Autopilot](../packages/volleyd/README.md#autopilot) |
| A dropped coordinator | Its waves keep running; a reconnecting session reclaims them by name. | [Ownership and claim](../packages/volleyd/README.md#ownership-and-claim) |

Agents never merge, push to the release branch outside a release stage, or force-push: their
briefs forbid it and the fence enforces it for volleyd itself.

## What still asks you

- **Owner-only decisions** (`autopilot.owner_only`; by default `plan_change`, `repo_untrusted`,
  `model_switch`, `release_go` and `stage_go`). Autopilot never answers these. Production is
  always yours: a deploy-shaped release stage says `gate: owner`, and the train ends on
  `release_go`.
- **Escalations**: a decision no rule answers, one whose budget is spent, or one whose answer
  could not be applied. The question starts `Autopilot could not resolve this (<why>): `.
- **Questions from sessions**: a Claude picker (`AskUserQuestion`) in any session and a
  coordinator turn that ends on a question.

**Held decisions** do not ask you. A decision you leave open on purpose while something else
lands (a `ci_failed` whose red check is a flake another task is fixing) can be held on that task,
PR or issue: `volleyd hold <decision-id> --on T4` (or `#194`, `issue#7`), or **Hold · waiting on…**
on its Needs-you row. A held item is amber (`Held · waiting on T4 (#194) · 3 h`), never escalated
and never pulsing, and the digest lists it under `## Held`. volleyd releases it when the blocker
lands (the task done or cancelled, the PR merged or closed, the issue closed) and it asks you again
from then; `volleyd release <decision-id>` lifts a hold by hand. Autopilot holds a red head on its
flake's fixer itself.

Each of these is one item in the **needs-you inbox** and rings your phone once. Answer it
wherever is closest: the Desk's **Needs you** window (desktop or phone; from any Desk login: the
owner on any screen), `volleyd inbox answer
<id> <answer>`, `volleyd resolve`, or the terminal the question is on. The first answer wins;
any later one is refused with where it was answered (`already answered on desk·phone`).
([Needs-you inbox](../packages/volleyd/README.md#needs-you-inbox),
[the Desk's Needs you window](../packages/volley-desk/README.md#needs-you))

## Opting out, per wave or everywhere

| To | In the wave file | With `/volley-issues` | Everywhere |
|---|---|---|---|
| Merge every PR yourself | `merge: manual` | `--merge manual` | `volleyd config set autopilot.merge manual` |
| Answer every decision yourself | `config: { autopilot: { enabled: false } }` | `--autopilot off` | `volleyd config set autopilot.enabled false` |
| Rebase (force-push) instead of merging the release branch in | `config: { branch_update: rebase }` | `--branch-update rebase` | `branch_update` (the global default is `rebase`; the skill writes `merge` per wave) |
| Skip the release train | `playbook: none` | | remove `.volley/release.yaml` |
| Always answer a decision kind yourself | `config: { autopilot: { owner_only: [...] } }` | | Settings › Autopilot on the Desk |

A change to the autopilot tunables takes effect at the next decision.

## Reading the digest

One digest per wave, retained on `volley/_waves/<wave>/digest`, with **one push** when it is
published: when the wave completes or stops, when `release_go` opens, and on an escalation (at
most once per `autopilot.digest_min_interval_s`). The push reads like:

```text
w1 complete: 27 shipped, 3 flakes fixed, 2 conflicts resolved, 1 waiting for you (release_go)
```

`volleyd digest <wave>` prints it in full, and the Desk shows it as a card in the wave window:

- **Shipped**: each merged task with its PR, merge commit and who merged it (`supervisor`,
  `operator` or `github`).
- **Handled by autopilot**: decisions answered, flakes fixed (the test, its fixer and the PRs it
  released), conflicts resolved, retries, merges.
- **Waiting for you**: the open decisions, owner-only ones marked; the release train's stages;
  cancelled tasks and why. Start here: each one is also in the Needs you window.

For the full story of one decision, `volleyd events <wave>` has every journaled event, and
`volleyd status <wave>` prints `autopilot: on · N auto-resolved · M escalated` under the header.
([The morning digest](../packages/volleyd/README.md#the-morning-digest))

## Overlap-aware waves

Tasks that touch the same files collide when they merge: each merge moves the release branch
under the PRs still waiting, and each of those pays a branch update, a CI run and a review round.
`/volley-issues` plans around it before you submit, from each issue's Files list (its
footprint), and volleyd watches it while the wave runs. How to write issues the planner can read
is in the skill's **Planning a batch** section
([SKILL.md](../packages/volley-issues/SKILL.md)); the mechanics are in the volleyd README
([Footprints and the overlap plan](../packages/volleyd/README.md#footprints-and-the-overlap-plan)).

**The plan lines.** The skill prints them before it submits (and `--plan-only` prints only
them); `volleyd validate` and `volleyd run` print them again, and the wave file starts with them:

```text
cluster A: 3 tasks share src/daemon.ts (11k lines, 3 tasks) → 1 bundle (T1), 1 chain (T1 → T4), cap 4 in flight
independent: T2, T5
expected branch updates: ≤ 2 (was ≤ 5 one at a time)
footprints: 5 listed, 1 guessed (#313); 1 entry unresolved (T4: helpers.ts)
```

- A **cluster** is a group of tasks sharing source files. Inside it, a **bundle** is several
  issues done as one task (one agent, one PR, one review; the digest ships them as
  `#310 + #312 (one PR)`); a **chain** makes one task wait for another (`after:` marked
  `# chained by the planner`); a **cap** limits how many of the cluster run at once.
- **Independent** tasks share nothing and run as usual.
- **Expected branch updates** is what the plan should cost, against one task per issue.
- **Footprints** says how well the issues' Files lists resolved. A `guessed` or unresolved one
  plans worse: fix the issue's Files list before you submit.

**A hold and a train.** If a cluster churns anyway (its members keep updating their branches, or
gated PRs pile up without merging), volleyd switches its strategy, at most once per 30 minutes:

- **hold**: one member at a time; the rest wait until the gated ones merge. The Desk badges the
  cluster's nodes `A · hold`, its row in the wave window's **Clusters** panel reads `hold` with
  why, and a waiting task's reason is `cluster A (hold): 1 in flight or gated (i315)`.
- **train**: the merge queue integrates several gated PRs of the cluster onto one branch, gates
  it once and merges it once (`autopilot.merge_train`, on by default). The merge-queue line in
  the wave window leads with it, `train-1 (i310, i312, i315) integrating`, linking the train's
  PR; each member PR reads as merged, and the digest ships each member under its own PR.
- **planned**: back to the plan once nothing is gated and nobody updated a branch in the window.

Each switch is in the wave's feed (`cluster A → hold: <why>`) and in `volleyd status` on the
plan line (`plan: cluster A (hold; in flight: i315): …`).

**Churn, and `churn_exhausted`.** Branch updates, the re-reviews they cause, trains and retries
are **churn**: they never spend the wave's spawn budget, so a churning wave never stops on
`spawn_budget_exhausted`. The Desk's wave title carries a `churn 12` chip, `volleyd status` prints
`spawns: 52 productive / 156 budget · 141 churn (…)`, and the digest's **Handled by autopilot**
counts them. When one task churns far past its pipeline (more than 3× its roles), its cluster
goes on hold; if it churns again, one `churn_exhausted` decision asks: `hold cluster` (one at a
time until the gated ones merge), `continue` (let it run as it is) or `cancel` (cancel the task).
Autopilot answers `hold cluster` once per task; the next one is yours, in **Waiting for you** and
the Needs you window.

**The two overrides.** The supervisor runs the wave file as written:

- **Edit the wave file** before submitting: delete a chained `after:` to run two tasks in
  parallel, or remove a task's `issues:` (giving each issue its own task back) to split a bundle.
  `volleyd validate` prints a `note:` where the planner would have planned differently, and keeps
  your version.
- **`--no-plan`** on `/volley-issues` writes one task per issue with the footprints but no
  bundle, chain or cap. A `Depends on:` in an issue still orders its task.
