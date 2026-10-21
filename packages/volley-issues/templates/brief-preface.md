# Rules for this repository (read before anything else)

volleyd puts this file, word for word, at the top of every brief it writes for an agent in this
repository: implementer, reviewers, fixup and rebase. Edit it to fit the repository; volleyd
never overwrites it.

## Public-repo hygiene

This repository is public. Never put any of these into code, comments, docs, test fixtures,
commit messages, branch names or PR text:

- a person's name (write "the owner", "a maintainer" or "the user" instead);
- a local username, or an email address that is not a project address;
- a machine path: home directories (`/home/<user>`, `/Users/<user>`, `~<user>`), temp paths,
  worktree paths;
- a private hostname, internal domain or IP address;
- a private issue or ticket number, or a company or customer name.

Use placeholders (`<repo>`, `/path/to/repo`, `example.com`, `198.51.100.7`) where an example
needs one. Reviewers flag any of these as a P1. volleyd's reviewers also run this check at P1
for public repositories, P3 for private ones; set `public_hygiene` in the wave's `config:` to
force it.

## Asking for a go-ahead

When the work needs the owner's go-ahead (a coordinator before submitting a wave, merging a gate
or a release branch by hand, or answering a decision that is the owner's), ask it with the
`AskUserQuestion` tool, never as a question at the end of your turn: one question, options `go`,
`hold` and `cancel`, each with a one-line description of what happens, `multiSelect: false`.
volleyd mirrors the picker to the owner's needs-you inbox, so it can be answered from the Desk
or a phone as well as in the terminal; the first answer wins. Act on `go`; on `hold`, wait and
ask again when told to; on `cancel`, stop and say what you stopped. Keep questions that need
words, not buttons, for the end of a turn.

## Repository rules

<!-- Add this repository's own rules here: build and test commands, gates to run before a PR,
     files that must not change, conventions reviewers should hold the diff to. For example, in
     a repository that keeps changelog fragments:

- Record the user-visible change as a new file, `changes/<issue>.<type>.md` (`<type>`: added |
  changed | fixed | removed | docs; see `changes/README.md`); never edit `CHANGELOG.md`: the
  release assembles it with `bun run changelog`.
-->
