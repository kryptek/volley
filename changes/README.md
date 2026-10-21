# Changelog fragments

Every PR records its changelog entry here, as a new file. **Never edit `CHANGELOG.md`; releases
run `bun run changelog`.** One shared section that every PR appends to conflicts every time a
sibling merges first; two new files with different names never do.

## The file name

`changes/<issue>.<type>.md`, where `<issue>` is the GitHub issue number the PR closes and
`<type>` is one of:

| type      | section in the release |
| --------- | ---------------------- |
| `added`   | `### Added`            |
| `changed` | `### Changed`          |
| `fixed`   | `### Fixed`            |
| `removed` | `### Removed`          |
| `docs`    | `### Docs`             |

- A PR that closes two issues writes two files, or picks the primary one.
- A change with no issue uses the PR number with a `pr` prefix: `changes/pr123.fixed.md`.
- A second fragment for the same issue and type adds a slug (`[a-z0-9-]+`):
  `changes/194.fixed.hooks.md`, so two tasks on one epic do not collide.

## The body

One or more Markdown bullets in the house style of `CHANGELOG.md`:

- `- **<package>: <headline>.** <detail> (#<issue>)`, or the short form
- `- <package>: <sentence>. (#<issue>)`

Wrap a long bullet with continuation lines indented two spaces. The `(#<issue>)` reference is
appended to a bullet that lacks it. Optional YAML front matter may give `issue:` and `type:`;
when present they must agree with the file name.

`changes/194.fixed.md`:

```markdown
- **volleyd: a retire ends the agent's session, and cleanup stops its process.** After a retire
  volleyd closes the agent's workspace. (#194)
```

`changes/pr123.docs.md`:

```markdown
- docs: the release steps name `bun run changelog`.
```

## At release time

`bun run changelog --version <v> --date <YYYY-MM-DD> --commit` assembles every fragment into one
`## <v> — <date>` section at the top of `CHANGELOG.md` (types in the order above, issues
ascending inside a type, `pr` entries last), deletes the fragments (this README stays) and
commits the result as `release: changelog for <v>`. Without `--commit` it leaves the working tree
to you; `--check` writes nothing, prints the section and exits 1 on a malformed fragment. A second
run is a no-op. The version bump of the `package.json` files is a separate commit in the same
release PR (a volley-cli test ties the newest section to the root version).

## What CI checks

- A PR that touches `packages/` or `spec/` adds at least one fragment here, unless it carries
  the `no-changelog` label.
- A commit that changes `CHANGELOG.md` is a release commit: its subject starts with `release:`
  or `chore(release):` (in any case). The check runs on pushes to and PRs into `release/**`.
- The release steps in `packages/volley-issues/SKILL.md` pass both by construction: the
  release-prep PR into the release branch is titled `release: <v> — <theme>` and labelled
  `no-changelog` (`bun scripts/changelog-ci.ts labels --ensure` creates the label when the
  repository lacks it), the PR into `main` is titled `release: <date> — <theme>`, and both
  squash with `--subject "release: …"`. Adding or removing a label re-runs the check.
