# install.sh test fixtures

`scripts/install.test.ts` runs `install.sh` on a private PATH: a copy of `base/` (the system tools
every machine has, stubbed), the tools a test says are already installed (copied from `tools/`),
and a few real file utilities. Every stub appends `<name> <args>` to `$STUB_LOG`.

- `base/`: `uname` (answers `$STUB_UNAME_S` / `$STUB_UNAME_M`), `sudo` (`-v` succeeds, `tee` swallows
  its input, other commands run), `bash` (runs the downloaded installer with `sh`), `apt-get`,
  `dpkg`, `systemctl` (`snapd` is active when `$STUB_SNAPD=active`), `snap`, `launchctl`, `id` (`-u` answers `$STUB_UID`, default 1000).
- `tools/`: `curl` (serves the GitHub tags API, the Homebrew / bun / Claude Code installers and the
  gh keyring; a URL containing `$STUB_CURL_FAIL` fails with exit 22), `git` (a clone is a directory
  remembering its tag; the subcommand `$STUB_GIT_FAIL` fails with exit 128), `bun`, `brew`, and `tool`, the
  generic stub every other installed tool is (`mosquitto -h` prints `$STUB_MOSQUITTO_VERSION`).
- `provide <name> <dir>`: what an installer does, putting tool `<name>` into `<dir>`.
- `os-release.*`: `/etc/os-release` of the supported Linux distributions, and one unsupported.
