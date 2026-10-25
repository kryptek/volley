# volley-sim — fake `claude`, `gh` and `tailscale` for installed-mode runs

`packages/volley-sim` holds three executables, `bin/claude`, `bin/gh` and `bin/tailscale`, that
stand in for Claude Code, the GitHub CLI and Tailscale when `VOLLEY_SIMULATED=1`. With them first on PATH, an **installed**
Volley — real volleyd, real tmux or cmux, real git, a real broker — runs a whole wave without a
Claude account or a GitHub repository, and without spending any Claude usage. They behave like
the in-process soak fleet in volleyd's tests (`packages/volleyd/test/helpers/soak-world.ts` and
`fake-agents.ts`), driven from separate processes instead.

## Turning it on

```sh
eval "$(volley sim env)"   # the fakes first on PATH, VOLLEY_SIM_HOME, VOLLEY_SIMULATED=1
volley sim reset           # clear the simulated world
```

`volley sim env` prints
`export PATH='<repo>/packages/volley-sim/bin':"$PATH" VOLLEY_SIM_HOME='<dir>' VOLLEY_SIMULATED=1`.
The world lives in `$VOLLEY_SIM_HOME` (default `~/.volley/sim`).

Outside `VOLLEY_SIMULATED=1` the fakes hand the call, argv and stdio unchanged, to the next real
`claude` / `gh` / `tailscale` on PATH, so the directory left on a PATH by accident fakes nothing. The services'
PATH (`stableServicePath` in volley-cli's `setup/service-path.ts`) and the installer
(`install.sh`, `packaging/`) never include this package's `bin`; `test/guard.test.ts` greps both.
volleyd started as a service therefore runs the real programs: a simulated wave runs a volleyd
started from the shell that ran the `eval`.

## What is faked, what is real

| Real                                              | Faked                                                       |
| ------------------------------------------------- | ----------------------------------------------------------- |
| volleyd, its fence, the journal                   | `gh`: PRs, issues, labels, CI runs, the GitHub sign-in      |
| the broker (mosquitto; Aedes stays test-only)     | `claude`: sign-ins, MCP registrations, the agent's work     |
| tmux / cmux panes and `.volley/launch.sh`         | `tailscale`: `version`, `status --json` (Running, as `sim-machine.example.ts.net` at 100.64.0.2), `ip -4`, `up` (its sign-in link once, then exit 0) |
| git: commits, pushes, a local bare origin, merges |                                                             |

### The world file

`$VOLLEY_SIM_HOME/world.json` is the one state every `gh` and `claude` process reads and writes,
under an advisory lock (`world.json.lock`, created with `O_EXCL`, holding the pid; a lock whose
process is gone is taken over) and written atomically (a temp file renamed over it). It keeps
what GitHub adds on top of git: repositories, PRs, issues, labels, CI runs, the merges it made, and
the `gh` and `claude` sign-ins. Commits stay in git: a PR's head is read from its branch on the
origin, so a push moves it the way it does on GitHub, and `gh pr merge` writes the merge into the
origin with `git merge-tree` and `git commit-tree` (a squash: one commit on the base; `--merge`:
a merge commit, which also marks every open PR whose head it contains as merged).

A repository is the checkout's `origin` remote: a local bare repository is adopted as
`volley-sim/<name>`; `gh repo create <name> --private --clone` makes one under
`$VOLLEY_SIM_HOME/origins/` and clones it. `gh repo delete` removes only an origin it made.

### `gh`

Every argv shape volleyd's fence allows (the header of `packages/volleyd/src/fence.ts`) and those
`volley setup` and the install steps use:

- `auth status` (signed out until `auth login`), `auth login --web --git-protocol https`,
  `auth setup-git`, `api user [--jq .login]` (the account's `login`, `id` 1 and `name` "Volley Sim": setup derives git's identity from them)
- `repo view [<slug>] --json …`, `repo create <name> --private|--public|--internal [--clone]`,
  `repo delete <slug> --yes`
- `issue create | view | list | edit --add-label/--remove-label | comment | close`;
  `label list [--search …] | create`. An issue the world has no record of reads like the soak's
  (`Soak task #<n>`).
- `pr create [--draft]`, `pr view | list --head …`, `pr ready`, `pr checks --json …`,
  `pr merge <n> --squash|--merge [--match-head-commit <sha>] [--delete-branch]` (a moved head is
  refused with GitHub's own message)
- `run list --commit <sha> | --branch <b>`, `run view <id> [--json jobs | --log-failed]`,
  `run watch <id> [--exit-status]`,
  `api repos/{owner}/{repo}/actions/runs?head_sha=…` (CI is computed once per head: green), and
  `…/actions/runs?status=queued` (the CI queue: always empty)
- the release train's tag check: `api repos/{owner}/{repo}/git/matching-refs/tags/<prefix>
  [--paginate --slurp]` and `api repos/{owner}/{repo}/git/tags/<sha>`, read from the bare origin

`--json <fields>` and the two `--jq` forms Volley uses (a path such as `.login`, and
`[.<list>[] | {a, b}]`) are honoured. Anything else — another verb, flag, JSON field or jq
program — exits 1 with `unknown argv: gh …` on stderr and is appended to
`$VOLLEY_SIM_HOME/unknown.jsonl`, the list of what a run needed and the simulator lacks.

### `claude`

- `claude --version` prints a plausible version (`2.1.0 (Claude Code)`).
- `claude auth status` (JSON, as Claude Code prints it) reports signed out until
  `claude auth login` ran once for that profile (`CLAUDE_CONFIG_DIR`, else the default);
  `auth logout` signs it out.
- `claude mcp add-json [-s user|local|project] <name> <json>`, `mcp list`, `mcp get <name>`,
  `mcp remove [-s …] <name>` keep `mcpServers` in `$CLAUDE_CONFIG_DIR/.claude.json` (else
  `~/.claude.json`), the way `volley peer`'s provision step reads it.
- Launched the way volleyd's `.volley/launch.sh` launches it — in a worktree holding
  `.volley/agent.json` — it runs a simulated agent (`src/agent.ts`).
- Any other argv is an unknown argv, as for `gh`.

### The simulated agent

It reads the worktree's identity (`.volley/agent.json`) and brief, connects with the identity's
own broker login through volley-mcp's client (its will armed, as the MCP server's), and
publishes what the MCP server and the session hooks would: `spawning`, its registry entry,
`working` and a SessionStart heartbeat. Then its role:

- **implementer**: commits `src/<task>.ts`, pushes its branch to the origin, opens the PR against
  the release branch the brief names through the fake `gh`, and reports `done` with the PR URL;
- **spec_reviewer / quality_reviewer**: a `result` of type `review` (approve, no findings);
- **fixup**: a commit pushed to the PR branch `.volley/findings.md` names, and a `fixup` result;
- **rebase**: rebases (or, when `.volley/rebase.md` says to merge, merges) onto the release
  branch and pushes to the PR branch; a conflict reports `blocked`;
- **integrator**: cuts the train branch `.volley/integrate.md` names, merges its members,
  pushes it and opens the train's PR;
- **release**: its stage `result`.

A failure reports `failed` with the reason. After its terminal status it stays connected like an
idle session — acknowledging any mailbox message — until SIGTERM, SIGINT or SIGHUP, and then
disconnects cleanly (so its will never fires). `VOLLEY_SIM_AGENT_LINGER=0` makes it exit at once.

## Running a wave by hand

```sh
eval "$(volley sim env)"
volley sim reset

# A repository with a local bare origin (git is real).
mkdir -p /path/to/sim && cd /path/to/sim
gh repo create demo --private --clone        # $VOLLEY_SIM_HOME/origins/volley-sim/demo.git
cd demo && git commit --allow-empty -m root && git push origin HEAD:main

gh auth login --web --git-protocol https     # the fake GitHub sign-in
claude auth login                            # the fake Claude sign-in

# volleyd from this shell (not the service), so it finds the fakes on PATH.
VOLLEYD_HOME=/path/to/volleyd-home volleyd daemon &
volleyd run /path/to/wave.yaml               # a wave whose repo is /path/to/sim/demo

gh pr list --state all --json number,title,state
cat "$VOLLEY_SIM_HOME/unknown.jsonl"         # anything the fakes could not answer
```

## Tests

```sh
cd packages/volley-sim
bun run test        # vitest: gh, claude, the agent (against Aedes), the lock, the guard
bun run typecheck
```
