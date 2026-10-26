# Installing Volley

One command installs Volley on a Mac or on Ubuntu/Debian, then runs its guided setup:

```sh
curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh
```

The command never changes: the script installs the latest release tag unless you name another.
Rerunning it is safe: whatever is already in place is left alone. This page says what the
installer and `volley setup` do, every flag, how to check and how to uninstall, the Linux notes,
the Homebrew path, and how to add a second machine. The README's
[Quickstart](../README.md#quickstart) is the short version.

- [What the installer does](#what-the-installer-does)
- [What `volley setup` does](#what-volley-setup-does)
- [Flags](#flags)
- [Checking an install: `--check`](#checking-an-install---check)
- [Uninstalling: `--uninstall`](#uninstalling---uninstall)
- [Linux notes](#linux-notes)
- [The Homebrew path](#the-homebrew-path)
- [Add a bare machine](#add-a-bare-machine)
- [Updating](#updating)
- [From a clone (contributors)](#from-a-clone-contributors)
- [The broker it sets up](#the-broker-it-sets-up)

## What the installer does

It installs only what is missing, side by side:

| | macOS (arm64, x86_64) | Ubuntu / Debian |
| --- | --- | --- |
| Package manager | Homebrew, with its own installer when `brew` is missing. That installer asks for your password: the only sudo on a Mac | apt. After printing every reason it needs sudo (the apt packages, GitHub's apt repository for gh, snapd when it is missing, the mosquitto snap), it checks once whether sudo needs a password (`sudo -n true`) and asks for it once only when it does; none on a cloud image's password-less sudo. `volley setup` then runs the snap broker's steps through sudo too (it says why first; [Linux notes](#linux-notes)), within sudo's timestamp, so nothing else asks |
| Tools | `brew install` for whichever of bun, mosquitto, gh, git and tmux is missing | `apt-get install -y` for whichever of git, tmux, curl and ca-certificates is missing (unzip too when bun is); bun with its own installer (into `~/.bun`); gh from GitHub's apt repository |
| Broker | mosquitto from Homebrew (2.1 or newer) | a mosquitto 2.1 or newer already on `PATH`; else the snap, installing snapd with apt first when it is missing; else the install stops with the fix ([Linux notes](#linux-notes)) |
| Claude Code | its native installer, when `claude` is missing | the same |
| Volley | the Homebrew formula when Homebrew resolves Volley's tap ([below](#the-homebrew-path)), else the clone below | a clone of the release tag into `~/.volley/src`, then `bun install --frozen-lockfile` |
| Services (by setup) | launchd agents | `systemd --user` units |

Then, for the clone:

1. **The commands.** `~/.volley/bin/volley` and `~/.volley/bin/volleyd`: small `sh` scripts that run
   the checkout with the full path of your bun, byte for byte what `volley setup` writes, so its
   Services step finds them in place. A file of your own at either path is moved aside to
   `<path>.volley-backup-<timestamp>`, never deleted.
2. **`PATH`.** One line, `export PATH="$HOME/.volley/bin:$PATH" # volley`, added once to your
   shell's startup file: `~/.zshrc` for zsh (or `$ZDOTDIR/.zshrc`); for bash `~/.bashrc` on Linux
   and `~/.bash_profile` on a Mac. fish gets the `fish_add_path $HOME/.volley/bin` line printed
   instead, any other shell the line to add. New terminals pick it up; the setup that follows
   runs without it.
3. **Setup.** `volley setup` on your terminal (the piped script reads your answers from
   `/dev/tty`, not from the pipe). With no terminal (a CI job, an ssh command) it prints the
   command to run instead.
4. **Getting started.** Setup ends with a one-time admin link to the Desk; opening it lands in
   the Desk's **Getting started** wizard (Welcome → This computer → Your machines → Repos →
   People → Access → You're good to go!), the same setup seen from a browser: this machine's
   checks, your other computers paired, repositories added, people invited, the private network
   chosen and the coordinator's always-on machine picked. Each step shows what it will change
   before it applies it. The Desk's README has
   [every step](../packages/volley-desk/README.md#getting-started).

## What `volley setup` does

Ten steps; each prints what it found and what it would change, diffs included, **before**
changing anything, and is safe to rerun (a rerun reports each step `already done`). The volley-cli
README's [`volley setup`](../packages/volley-cli/README.md#volley-setup) has every detail.

1. **Broker**: finds mosquitto, refusing one older than 2.1.
2. **Security**: the Dynamic Security broker config (the old file backed up), a restart, then a
   check that both listeners refuse anonymous clients.
3. **Accounts**: the `volleyd`, `desk` and `coordinator` logins and their credential files, the
   coordinator's login in the macOS keychain on a Mac, and a one-time admin token for the Desk.
4. **Network**: how you reach this machine from outside your network: Tailscale (installed and
   signed in, its private name and address recorded), your own VPN's address, or none
   ([below](#reach-it-from-outside-your-network)).
5. **Sign-ins**: Claude Code and GitHub, each in your browser when signed out; and, when git has
   no commit identity here, one from your GitHub account (its name, its noreply address).
6. **Claude Code**: your coordinator name; the volley MCP server registered at user scope with
   **no password in it** (it logs in with `coordinator.json` from the auth dir it names; a
   registration from before v0.13.0 that still carries a broker login is re-registered without
   it, shown as a change like any other, the password never printed); the `/volley`,
   `/volley-issues` and `/wait` skills; the Volley hooks.
7. **Terminal**: where volleyd starts agents here: cmux on a Mac that has it, else tmux.
8. **Services**: volleyd and the Desk (`http://localhost:5199`) as services.
9. **Phone**: a one-time sign-in QR for the Desk on your phone, when you let your network reach
   the broker's WebSocket listener.
10. **Test wave**: a 1-issue wave on a scratch private repository, `volley-hello-<4>`, followed
   until volleyd merged its PR (at most 15 minutes). The end prints the `gh repo delete …` line
   that removes it.

**What it asks.** Four questions, each with a default, so Enter alone answers it:

| Question | Enter means | Decided up front by |
| --- | --- | --- |
| Let devices on your network reach the WebSocket listener (the Desk on a phone)? | yes | `--lan` / `--no-lan` (`--yes` alone: no) |
| `Reach this machine from outside this network? [Tailscale (recommended) / my own VPN / no]` | Tailscale | `--network tailscale\|manual\|none` (`--yes` alone: no) |
| `Coordinator name [coord-<this machine>]:` | the default shown | `--yes` takes the default |
| `Run a 1-issue test wave now?` | yes | `--yes` runs it, `--no-first-wave` skips it |

and two sign-ins, Claude Code (`claude auth login`) and GitHub (`gh auth login --web`), each
in your browser and only when signed out. Before applying a step's changes it also asks
`Apply these <n> changes (<step>)? [y/N]` (`Apply this change (<step>)?` for one): type `y`;
Enter answers no and stops setup with nothing changed. `volley setup --yes` asks nothing. You copy no
secret by hand: the services and the MCP server read their logins from files setup writes, and
the Desk signs you in through a one-time link.

**When it finishes** it prints `Setup complete in <m> m <s> s (<n> questions, <n> sign-ins, <n>
sudo)`, then the test wave's PR, and the run's numbers go to `~/.volley/volleyd/setup-metrics.json`.
Two things are yours:

- **The Desk.** Under *One-time admin token* setup printed `Open the Desk with it on this machine:
  http://localhost:5199/#signin=…`: open that link within 10 minutes (single use;
  `volley auth token` prints another). Your phone signs in by scanning the QR. The link opens
  **Getting started** (above) until you finish or skip it; Settings › Setup & Security reopens it.
- **Claude Code.** A session started after setup has `/volley` and the volley MCP server. One that
  was already open does not: exit it and start `claude` again (MCP servers are read when a
  session starts). Then `/volley list` shows your session.

**Your coordinator name** is saved in `~/.volley/volleyd/setup.json`: `volleyd run` without
`--owner` owns a wave by it, and the MCP server registers your session with it
(`VOLLEY_COORDINATOR`), so your waves stay yours across session restarts. A shell on this machine
needs nothing exported: `volley wait`, `volley sub`, `volley repo add` and `volleyd` find the
coordinator login setup saved, and `volley auth status` shows which login a shell uses, where it
came from and whether the broker accepts it (never the password). `VOLLEY_AUTH_USERNAME` /
`VOLLEY_AUTH_PASSWORD` are for another machine's broker only.

## Flags

Pass flags through the pipe with `sh -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh -s -- --check
```

| Flag | What it does |
| --- | --- |
| `--version vX.Y.Z` | Install this release tag (default: `$VOLLEY_VERSION`, else the latest tag). A rerun with another tag moves `~/.volley/src` to it |
| `--source <dir>` | Use this Volley checkout instead of cloning one (CI tests its own) |
| `--peer` | This machine joins a supervisor's fleet: no broker (mosquitto is neither installed nor checked), no Homebrew tap; runs `volley setup --peer` ([Add a bare machine](#add-a-bare-machine)) |
| `--broker container` | The broker runs in a container you start (`docker run eclipse-mosquitto:2.1-alpine`, see `examples/mosquitto-auth/`): mosquitto is neither installed nor checked, no Homebrew tap; runs `volley setup --layout container` |
| `--network <kind>` | `tailscale`, `manual` or `none`, passed to `volley setup --network` ([Reach it from outside your network](#reach-it-from-outside-your-network)). `tailscale` also installs Tailscale: on Linux from Tailscale's apt repository (`pkgs.tailscale.com`), under the same `sudo` as the other packages; on macOS `brew install --cask tailscale`. `--check` then lists `tailscale` too |
| `--network-address <host-or-ip>` | With `--network manual`: this machine's address on your own VPN, passed to `volley setup` |
| `--no-setup` | Stop before `volley setup`; it prints the command to run |
| `--check` | Print each prerequisite as found or missing, and where Volley is; exit 1 if anything is missing. Changes nothing |
| `--uninstall` | Remove the services, the commands, the `PATH` line and `~/.volley/src` ([below](#uninstalling---uninstall)) |
| `--purge` | With `--uninstall`: also remove volleyd's state, `~/.volley/volleyd` |
| `-h`, `--help` | The usage |

Exit status: 0 done, 1 `--check` found something missing (or a step failed), 2 a usage error or
an unsupported platform (anything but macOS and Ubuntu/Debian, which it says before changing
anything).

## Reach it from outside your network

At home, your phone reaches the Desk over your Wi-Fi. Away from it, Volley uses a private network
you set up once, never a public listener, a relay or Tailscale Funnel:

- **Tailscale** (the default): `install.sh --network tailscale` (or `volley setup --network
  tailscale`) installs Tailscale and signs this machine in through a link it prints. Do the same
  on every machine you pair (`install.sh --peer --network tailscale`), and install the Tailscale
  app on your phone, signed in to the same account. Setup records this machine's Tailscale name
  and address, then its Services step serves the Desk on your tailnet with `tailscale serve`:
  HTTPS at the machine's name, with a certificate Tailscale issues (turn on HTTPS certificates in
  the Tailscale admin console, DNS › HTTPS Certificates, once). The end prints both addresses,
  `Desk: http://<lan>:5199 · https://<name>.<tailnet>.ts.net`, and sign-in links use the private
  one. Two loopback-only targets are added, the Desk (`https://<name>` → `127.0.0.1:5199`) and
  the broker's WebSocket listener (`https://<name>:8443` → `127.0.0.1:9001`); nothing is public
  (never Funnel) and your other serves are left alone. On Linux `tailscale serve` needs `sudo`.
  A machine that serves only the Desk does the same with `volley desk install --tailscale`.
- **Your own VPN**: `volley setup --network manual --network-address <host-or-ip>`, the address
  your VPN gives this machine (it must be one of this machine's addresses). Nothing is installed.
- **Neither**: `--network none` (what `--yes` alone means) keeps the Desk on this network.

The same choice, wherever you make it:

| Where | Tailscale | Your own VPN | Neither |
| --- | --- | --- | --- |
| The installer | `--network tailscale` (also installs Tailscale) | `--network manual --network-address <host-or-ip>` | `--network none` |
| `volley setup` | `--network tailscale` | `--network manual --network-address <host-or-ip>` | `--network none` |
| The Desk | Getting started › Access › **Tailscale** | **I'll VPN in to the network `<machine>` is on** | **This network only** |
| A Desk-only machine | `volley desk install --tailscale` | | |

`volley setup --step network` reruns only that step. Once the private network is up, pick an
always-on machine for the **coordinator** (Getting started › Access, or Settings › Machines'
Coordinator card): volleyd keeps a Claude Code Remote Control session alive there, which you
open from the Claude app on your phone or with `volley coordinator open`
([the coordinator role](../packages/volleyd/README.md#the-coordinator-role)). When a command
cannot reach the supervisor from away, it says which rung failed (internet, private network,
tunnel, broker, volleyd), prints the fix and exits 69
([When the supervisor does not answer](../packages/volley-cli/README.md#when-the-supervisor-does-not-answer)).

`volley peer doctor` reports the choice as `network.private` (a warning when nothing is set up or
Tailscale is signed out; the fix is `volley setup --step network`).

## Checking an install: `--check`

Two checks, neither changes anything:

```sh
curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh -s -- --check
volley setup --check          # one row per setup step: done, pending, blocked or skipped
volley setup --check --json   # the same as JSON, for CI
```

The installer's `--check` lists the platform, each prerequisite (mosquitto with its version;
one older than 2.1 counts as missing) and where `volley` is. `volley setup --check` plans every
step without asking anything and exits 0 only when nothing is pending or blocked; a pending row
lists the changes a run would make. A healthy install is all `done` (the Phone row is `skipped`
with LAN access off).

## Uninstalling: `--uninstall`

```sh
curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh -s -- --uninstall
```

It stops and removes the services (launchd's `systems.volley.volleyd`, `systems.volley.desk` and
`systems.volley.peer`; or `volleyd.service`, `volley-desk.service` and `volley-peer.service`
under `systemd --user`), removes `~/.volley/bin/volley` and `volleyd` (only the ones setup or
the installer wrote), the `PATH` line from `~/.zshrc`, `~/.bashrc` and `~/.bash_profile`, and
`~/.volley/src`; on the Homebrew path it runs `brew uninstall kryptek/volley/volley`. It keeps
volleyd's state (`~/.volley/volleyd`: journals, credentials, the setup log; `--purge` removes it
too), the broker and its configuration, the prerequisites it installed, and the volley entry in
Claude Code (`claude mcp remove -s user volley` removes it). The test wave's scratch repository
stays on GitHub: `gh repo delete <you>/volley-hello-… --yes`.

## Linux notes

- **Ubuntu and Debian only for now**, any release with apt (CI runs Ubuntu 24.04 and Debian 13);
  other distributions exit 2 before changing anything.
- **sudo at most once.** The installer prints why it needs sudo, then checks whether sudo needs a
  password (`sudo -n true`). When sudo is password-less, as on a cloud image, nothing is asked;
  otherwise it asks once at your terminal (`sudo -v`) and reuses it. Without a terminal it stops
  before asking and says so: run the one command from a terminal. It needs no sudo when everything
  is there or when it runs as root.
- **mosquitto 2.1 or newer.** Distribution packages may still be 2.0, which Volley refuses
  (broker auth uses Dynamic Security roles with `%u`, which 2.0 does not substitute). The
  installer takes a 2.1 already on `PATH`, else installs the mosquitto snap. snapd counts when
  it runs or is socket-activated (a fresh Ubuntu cloud image); when the `snap` command is
  missing (Debian's cloud image, a minimal Ubuntu) the installer adds `snapd` to its one
  `apt-get install`, waits for snapd's first seed (`snap wait system seed.loaded`), then
  installs the snap (up to three tries, 10 s apart: a snapd with no snaps yet stands by after
  5 s idle and cancels a request that lands while it stops). The snap's broker is a service, so no `mosquitto` command appears on `PATH`; the
  installer, its `--check` and `volley setup` read its version from `snap list mosquitto`. When no mosquitto 2.1 can be put on the machine (an older one on `PATH`,
  snapd that cannot be installed, a failed snap install), the install **stops with exit 1
  before cloning Volley** and prints the fix; it never says "Volley is installed" without a
  broker. When the snap command is there but snapd is not running, it says so and names the fix
  (`sudo systemctl enable --now snapd.socket`). Fix it and rerun the one command; or run the
  broker in a container and install with `--broker container`, which neither installs nor
  checks mosquitto and runs `volley setup --layout container`:

  ```sh
  sudo apt-get remove mosquitto               # an older mosquitto holds 1883 and shadows the snap
  docker run eclipse-mosquitto:2.1-alpine     # examples/mosquitto-auth/
  curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh -s -- --broker container
  ```

  `--peer` installs no broker and is unaffected.

  A 2.0 broker already installed holds port 1883 and shadows the newer binary: remove it first
  (`sudo apt-get remove mosquitto`).
- **The snap's config is root's.** Its files live under `/var/snap/mosquitto/common/` (and
  `/etc/mosquitto/`'s are root's too), so the broker steps need root. `volley setup` run as you
  takes care of it: before its Security step it prints `sudo is needed to:` with each reason
  (write the config and create the state file, restart the broker, create the Volley auth dir)
  and the command, then runs Broker, Security and Accounts through sudo and continues as you.
  On a cloud image's password-less sudo (or right after `install.sh` asked for the password on
  the same terminal) nothing is asked; otherwise sudo asks for your password once, at the
  terminal. From a script with no terminal, when sudo needs a password, setup stops before
  Security, changes nothing, and prints the two commands to run in a terminal instead:

  ```sh
  sudo ~/.volley/bin/volley setup --step detect --step security --step accounts --yes --no-lan
  volley setup
  ```

  Under sudo, setup gives the Volley auth dir (`/var/snap/mosquitto/common/volley`: `admin.json`,
  `coordinator.json`, the account registries) to you, as it does `~/.volley/volleyd/dynsec-admin.json`, so the second run
  and your CLIs can read them; the broker's own files stay root's. Run as root with no sudo user,
  it stays root's.
- **Services** are `systemd --user` units. To keep volleyd and the Desk running while you are
  logged out, `loginctl enable-linger` (setup says so when it starts them). A container without
  systemd needs a stand-in: `scripts/install-tests/systemctl-stand-in.sh` is the one CI uses.
- **Agents** start in tmux (setup's Terminal step stops with `sudo apt-get install -y tmux` when
  it is missing).
- **Wording.** Where a Mac guide says the keychain, Linux has `coordinator.json` in the auth dir
  alone; where it says Cmd-Q, exit the Claude Code session and start `claude` again.

## The Homebrew path

On a Mac you can install with Homebrew instead, in two commands:

```sh
brew install kryptek/volley/volley
volley setup
```

The formula installs the release tarball (Volley with its `node_modules`, checksummed) and
brings bun, mosquitto, gh, git and tmux. The one command takes this path itself when Homebrew
resolves the tap, neither `--version` nor `--source` is given and `~/.volley/bin` has no
`volley` yet. Updating is `brew upgrade kryptek/volley/volley`, then `volley setup`. How the tap
is published: [`packaging/README.md`](../packaging/README.md).

## Add a bare machine

A second machine (macOS or Ubuntu/Debian, reachable over ssh) joins the supervisor's fleet with
one command on the supervisor's machine:

```sh
volley machine add you@box-a
```

or from the Desk, Settings › Machines › **Add a bare machine…**, or the
**Your machines** step of Getting started (**SSH key**, or **Username and password**, which is
exchanged for a key and forgotten; **Pairing code** for a machine that already has Volley). It
installs Volley on the box in peer mode at the supervisor's release (no broker, no Desk), pairs it, signs it in to GitHub and
Claude (sign-ins only when signed out) and runs the doctor, ending with one `ready ✓` row. sudo
on the box is asked only when git, tmux, curl or gh (Linux) or Homebrew (Mac) are missing, and
announced first. Details: the volley-cli README's
[`volley machine add`](../packages/volley-cli/README.md#volley-machine-add).

By hand on the box, the same is the one command with `--peer`, then the pairing code from
Settings › Machines › **+ Add a machine** (`volley peer join <code> --to <you@supervisor>`):

```sh
curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh -s -- --peer
```

## Updating

On the supervisor's machine, `volley deploy v<X.Y.Z>` moves the services' checkout to a release
tag, rebuilds the Desk, restarts volleyd and the Desk, health-checks them (rolling back on
failure), then every paired machine. Rerunning the one command with `--version v<X.Y.Z>` moves
`~/.volley/src` too; follow it with `volley setup --repair`.

## From a clone (contributors)

To work on Volley itself, run setup from your clone instead: the services and the MCP server then
run your checkout.

```sh
git clone https://github.com/<your-fork>/volley.git
cd volley
bun install
bun packages/volley-cli/src/cli.ts setup
```

Volley supports Bun **1.3 and 1.4** (`engines.bun` is `>=1.3 <1.5`). The manual broker path,
step by step, is [`volley auth init`](../packages/volley-cli/README.md#volley-auth); the
container layout and the migration from an older `password_file` / `acl_file` setup:
[`examples/mosquitto-auth/`](../examples/mosquitto-auth/README.md).

## The broker it sets up

Two listeners on `127.0.0.1`, both requiring a login:

- **`1883`** (raw MQTT): `volley-mcp`, `volley-cli`, volleyd and any native MQTT client.
- **`9001`** (MQTT over WebSocket): the Desk, since browsers cannot speak raw MQTT. With LAN
  access on (`volley setup --lan`) `9001` also listens on your network; `1883` never does.

> **Why a password on localhost?** Agents run with permission prompts skipped and obey their
> mailbox. A localhost broker is reachable by every local process, and by **any web page you
> visit** (browsers let pages open a WebSocket to `127.0.0.1:9001`). Without auth, a malicious
> page could steer your agents or rewrite the supervisor's config. The ACL also stops one agent
> from steering another. Identities and ACL rules: [`examples/mosquitto-auth/`](../examples/mosquitto-auth/README.md).

> **LAN traffic is not encrypted.** Logins are required from the LAN too, but until a TLS
> listener exists (`mqtts://` / `wss://`) passwords cross the network readable: open the
> listener only on a network you trust, and never copy this config to a public host. Start at
> the [mosquitto auth methods doc](https://mosquitto.org/documentation/authentication-methods/).

> **Queued mailbox messages.** Mail for an offline agent waits in its persistent session on the
> broker ([SPEC §4.4](../spec/SPEC.md#44-mailbox-message-types)). mosquitto flushes persistence
> every `autosave_interval` seconds (1800 by default), so the config setup writes sets
> `autosave_interval 30` and `autosave_on_changes false`; add both to a config of your own.
> volleyd's journal stays the source of truth. Sessions expire after 7 days by default (the
> tunable `mailbox.session_expiry_s`; a change applies to new connections only).

> **Upgrading from an earlier setup?** Do not re-copy `examples/mosquitto-localhost.conf` (it is
> the Dynamic Security config, and without its state file and admin the broker refuses every
> client): run `volley setup --repair`, or `volley auth migrate --coordinator-file
> --volleyd-file` from a `password_file` / `acl_file` setup, then restart mosquitto as it says.
