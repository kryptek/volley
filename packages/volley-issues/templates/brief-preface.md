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
needs one. Reviewers flag any of these as a P1.

## Repository rules

<!-- Add this repository's own rules here: build and test commands, gates to run before a PR,
     files that must not change, conventions reviewers should hold the diff to. -->
