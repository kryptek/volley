# Packaging

Volley ships two ways besides a checkout: `install.sh` (the curl path, which clones a release tag)
and a Homebrew formula in a tap. This directory holds the formula; the release workflow
(`.github/workflows/release.yml`) builds what it downloads and publishes it.

## The Homebrew formula

`packaging/homebrew/volley.rb` is a template: `@VERSION@` and `@SHA256@` are filled in for a tag by

```sh
bun scripts/packaging/formula.ts render --version 0.11.0 --sha256 <hex> --out volley.rb
```

The formula downloads `volley-<x.y.z>.tar.gz` from the tag's GitHub release, installs it into
`libexec` and writes two wrappers, `bin/volley` and `bin/volleyd`, that `exec` bun (the
`oven-sh/bun/bun` formula) on `libexec/packages/volley-cli/src/cli.ts` and
`libexec/packages/volleyd/src/cli.ts`. It depends on bun, mosquitto, gh, git and tmux; Claude Code
is not a formula, so `install.sh` (or the user) installs it. The caveats say to run `volley setup`
next. Users install it with

```sh
brew install kryptek/volley/volley
```

and `install.sh` on macOS does the same when `brew info kryptek/volley/volley` resolves (and no
`--version` or `--source` was given), instead of cloning into `~/.volley/src`.

Out of scope for now: signing or notarising, bottles, Linuxbrew (the tarball carries the macOS
natives only).

## The release tarball

`scripts/packaging/tarball.sh <version> <checkout> <out-dir>` packs a checkout that already has its
`node_modules` (nothing is downloaded at install) into `volley-<x.y.z>.tar.gz`, with every entry
under `volley-<x.y.z>/`, sorted by name, the mtime of `$SOURCE_DATE_EPOCH` (default: the HEAD
commit's time), owner `0/0`, no `.git`, hardlinks stored as files, gzip without a timestamp. The
same tree gives the same bytes. It writes `volley-<x.y.z>.tar.gz.sha256` next to it and prints
`file=` and `sha256=`. It needs GNU tar (`TAR=gtar` on a Mac).

## The release workflow

On a `v*` tag push, `release.yml`:

1. runs `bun install --frozen-lockfile --os darwin --cpu '*'` (the lockfile's tree, with the
   native packages of both Mac architectures), `tarball.sh`, and uploads the tarball and its
   `.sha256` to the tag's release (creating the release if there is none);
2. renders the formula with the tarball's sha256 and runs `brew style` on it on `macos-latest`;
3. clones the tap, writes `Formula/volley.rb`, commits `volley <x.y.z>` and pushes — only when the
   `HOMEBREW_TAP_TOKEN` secret is set. Without it (a fork, or before the owner sets it up) the step
   is skipped with a notice and the rest of the release still runs.

CI's `Homebrew formula (brew style, macOS)` job runs `scripts/packaging/formula.test.ts` on every
PR with `brew style` required.

## Creating the tap (once, by the owner)

1. Create the public repository `kryptek/homebrew-volley` (the `homebrew-` prefix is what makes
   `brew install kryptek/volley/volley` find it), with a `README.md` and an empty `Formula/`
   directory (a `Formula/.keep`). The repository variable `HOMEBREW_TAP_REPO` on this repository
   overrides the name (`owner/homebrew-name`).
2. Create a fine-grained personal access token: resource owner `kryptek`, repository access
   **only** `kryptek/homebrew-volley`, repository permission **Contents: Read and write** (Metadata:
   read-only comes with it), nothing else. Set an expiry and a reminder to rotate it.
3. Save it on this repository as the Actions secret `HOMEBREW_TAP_TOKEN`
   (`gh secret set HOMEBREW_TAP_TOKEN --repo kryptek/volley`, which reads it from the terminal).
4. Push a tag (or rerun the last release's `Release` workflow): the tap job pushes the formula.
   Check it with `brew install kryptek/volley/volley && volley --version`.

The token never appears on a command line: the workflow hands it to git through
`gh auth setup-git`.
