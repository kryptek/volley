# install.sh test fixtures

`scripts/install.test.ts` runs `install.sh` on a private PATH: a copy of `base/` (the system tools
every machine has, stubbed), the tools a test says are already installed (copied from `tools/`),
and a few real file utilities. Every stub appends `<name> <args>` to `$STUB_LOG`.

- `base/`: `uname` (answers `$STUB_UNAME_S` / `$STUB_UNAME_M`), `sudo` (`-v` succeeds, `tee` swallows
  its input, other commands run), `bash` (runs the downloaded installer with `sh`), `apt-get`,
  `dpkg`, `systemctl` (`snapd.service` is active when `$STUB_SNAPD=active`; `snapd.socket` when it
  is `active` or `socket`, a fresh cloud image's socket-activated snapd), `snap` (`install mosquitto`
  records the snap and, as the real one, puts nothing on PATH: its broker is a service; `list
  mosquitto` then prints snapd's table with `$STUB_SNAP_MOSQUITTO_VERSION`, default 2.1.2;
  `$STUB_SNAP_FAIL=1` fails every install, `once` the first; `wait` succeeds), `launchctl`, `id` (`-u` answers
  `$STUB_UID`, default 1000). `apt-get install` provides each package's tool (`snapd` the `snap`
  stub) and exits 100 without installing anything when a package is `$STUB_APT_FAIL`. A test
  removes a base stub for a machine without it (`without(w, "snap")`).
- `tools/`: `curl` (serves the GitHub tags API, the Homebrew / bun / Claude Code installers and the
  gh keyring; a URL containing `$STUB_CURL_FAIL` fails with exit 22), `git` (a clone is a directory
  remembering its tag; the subcommand `$STUB_GIT_FAIL` fails with exit 128), `bun`, `brew` (`brew info`
  knows Volley's tap formula when `$STUB_BREW_TAP` is set; installing it puts `volley` and `volleyd`
  into `$STUB_STATE/brew/bin`, its `--prefix`), `volley` (brew's command; `bun` also logs `env VOLLEY_BROKER=<v>` first when it is set), and `tool`, the
  generic stub every other installed tool is (`mosquitto -h` prints `$STUB_MOSQUITTO_VERSION`).
- `provide <name> <dir>`: what an installer does, putting tool `<name>` into `<dir>`.
- `os-release.*`: `/etc/os-release` of the supported Linux distributions, and one unsupported.
