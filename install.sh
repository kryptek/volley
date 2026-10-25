#!/bin/sh
# Volley's one-command install, for macOS and Ubuntu/Debian. The usage block is usage() below.
#
#   curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh -s -- --peer
#
# Everything runs inside main(), called on the last line, so a shell reading this script from a
# pipe has read all of it before anything runs. Children get /dev/null as stdin; prompts and
# `volley setup` read the terminal (/dev/tty) instead.

set -eu

usage() {
  cat <<'EOF'
Usage: install.sh [options]          (piped: curl -fsSL <url> | sh -s -- [options])

Installs Volley's prerequisites (Homebrew on macOS; git, tmux, curl, bun, gh, mosquitto >= 2.1
and Claude Code, each only when missing; on Linux mosquitto is the snap, snapd installed with apt
first when missing, and the install stops before Volley when no mosquitto 2.1 can be put on the
machine), clones Volley at a release tag into ~/.volley/src,
writes the `volley` and `volleyd` commands into ~/.volley/bin, adds that directory to PATH in
your shell's startup file once, then runs `volley setup`. On macOS, when Homebrew resolves
Volley's tap (kryptek/volley/volley), neither --version nor --source is given and ~/.volley/bin
has no volley yet, it runs `brew install kryptek/volley/volley` instead of the clone. Rerunning
it is safe: what is already there is left alone.

Options:
  --version vX.Y.Z   Install this release tag (default: $VOLLEY_VERSION, else the latest tag)
  --source <dir>     Use this Volley checkout instead of cloning one (CI tests its own)
  --peer             This machine joins a supervisor's fleet: no broker (mosquitto is neither
                     installed nor checked), no Homebrew tap; `volley setup --peer` runs with
                     VOLLEY_BROKER=skip
  --broker container The broker runs in a container you start (docker run
                     eclipse-mosquitto:2.1-alpine): mosquitto is neither installed nor checked,
                     no Homebrew tap; `volley setup --layout container` runs
  --network <kind>   tailscale | manual | none, passed to `volley setup --network`: how this
                     machine is reached from outside your network. tailscale also installs
                     Tailscale (Linux: from Tailscale's apt repository, with the other packages;
                     macOS: brew install --cask tailscale); --check then lists it
  --network-address <host-or-ip>
                     With --network manual: this machine's address on your own VPN
  --no-setup         Stop before `volley setup`; it prints the command to run
  --check            Print each prerequisite as found or missing; exit 1 if any is missing.
                     Changes nothing
  --uninstall        Remove the services, the commands, the PATH line and ~/.volley/src.
                     Keeps volleyd's state (~/.volley/volleyd) and the broker's configuration
  --purge            With --uninstall: remove ~/.volley/volleyd too
  -h, --help         Show this help

Exit status: 0 done, 1 --check found something missing (or a step failed, or no mosquitto 2.1
could be installed), 2 a usage error or an unsupported platform.
EOF
}

REPO_URL="https://github.com/kryptek/volley.git"
# The Homebrew formula (packaging/homebrew/volley.rb), in the tap github.com/kryptek/homebrew-volley.
TAP_FORMULA=kryptek/volley/volley
TAGS_API="https://api.github.com/repos/kryptek/volley/tags?per_page=100"
VOLLEY_HOME="$HOME/.volley"
BIN="$VOLLEY_HOME/bin"
SRC_DIR="$VOLLEY_HOME/src"
# shellcheck disable=SC2016 # the line is written as it reads, for the shell to expand later
RC_LINE='export PATH="$HOME/.volley/bin:$PATH" # volley'
# Test seams (scripts/install.test.ts): which os-release, which terminal, which system directories
# installers put tools in that a fresh shell's PATH may lack.
OS_RELEASE="${VOLLEY_INSTALL_OS_RELEASE:-/etc/os-release}"
TTY="${VOLLEY_INSTALL_TTY:-/dev/tty}"
SYSTEM_DIRS="${VOLLEY_INSTALL_SYSTEM_DIRS-/opt/homebrew/bin:/usr/local/bin:/snap/bin}"
# Seconds between `snap install` tries (a snapd with no snaps yet stands by after 5 s idle, and a
# request that lands while it stops is cancelled).
SNAP_RETRY_S="${VOLLEY_INSTALL_SNAP_RETRY_S:-10}"

say() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }
die() {
  warn "install.sh: $*"
  exit 1
}
usage_error() {
  warn "install.sh: $*"
  usage >&2
  exit 2
}
have() { command -v "$1" >/dev/null 2>&1; }
tty_ok() { (: <"$TTY") 2>/dev/null; }

# ~/… for a path under HOME, for messages.
tildify() {
  # shellcheck disable=SC2088 # a message, not a path to expand
  case "$1" in
    "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Append each existing directory not already on PATH (where installers put tools a fresh shell's
# PATH may lack; what the user's PATH finds first still wins).
path_add() {
  for d in "$@"; do
    [ -d "$d" ] || continue
    case ":$PATH:" in
      *":$d:"*) ;;
      *) PATH="$PATH:$d" ;;
    esac
  done
  export PATH
}

path_add_known() {
  old_ifs=$IFS
  IFS=:
  # shellcheck disable=SC2086 # split SYSTEM_DIRS on ':'
  set -- $SYSTEM_DIRS
  IFS=$old_ifs
  path_add "$@" "$HOME/.local/bin" "$HOME/.bun/bin"
}

# ---------------------------------------------------------------------------------------------
# Platform

os_field() {
  [ -r "$OS_RELEASE" ] || return 0
  sed -n "s/^$1=//p" "$OS_RELEASE" | head -n 1 | tr -d '"'
}

unsupported() {
  warn "install.sh: this platform ($1) is not supported yet: macOS and Ubuntu/Debian."
  exit 2
}

detect_platform() {
  os=$(uname -s)
  case "$os" in
    Darwin)
      arch=$(uname -m)
      case "$arch" in
        arm64 | x86_64) PLATFORM=macos PLATFORM_NAME="macOS ($arch)" ;;
        *) unsupported "macOS on $arch" ;;
      esac
      ;;
    Linux)
      id=$(os_field ID)
      like=$(os_field ID_LIKE)
      case " $id $like " in
        *" ubuntu "* | *" debian "*) PLATFORM=linux PLATFORM_NAME=$(os_field PRETTY_NAME) ;;
        *) unsupported "${id:-a Linux without /etc/os-release}" ;;
      esac
      ;;
    *) unsupported "$os" ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# Prerequisites

MAC_TOOLS="brew bun mosquitto gh git tmux claude"
LINUX_TOOLS="git tmux curl ca-certificates bun gh mosquitto claude"

# The x.y.z `mosquitto -h` prints, else the mosquitto snap's (its broker is a service: /snap/bin
# holds only its clients), or nothing.
mosquitto_version() {
  if have mosquitto; then
    mosquitto -h 2>&1 | sed -n 's/^mosquitto version \([0-9][0-9]*\.[0-9][0-9]*[0-9.]*\).*/\1/p' | head -n 1
  else
    snap_mosquitto_version
  fi
}
snap_mosquitto_version() {
  have snap || return 0
  snap list mosquitto 2>/dev/null | sed -n 's/^mosquitto  *\([0-9][0-9]*\.[0-9][0-9.]*\) .*/\1/p' | head -n 1
}

# Whether the mosquitto on PATH is 2.1 or newer (Dynamic Security's %u in role ACLs).
mosquitto_ok() {
  v=$(mosquitto_version)
  major=${v%%.*}
  rest=${v#*.}
  minor=${rest%%.*}
  case "$major$minor" in '' | *[!0-9]*) return 1 ;; esac
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 1 ]; }
}

# The prerequisites for this platform (a peer runs no broker; `--network tailscale` adds Tailscale).
platform_tools() {
  if [ "$PLATFORM" = macos ]; then tools=$MAC_TOOLS; else tools=$LINUX_TOOLS; fi
  if [ -n "$NO_BROKER" ]; then tools=$(printf '%s' "$tools" | sed 's/ *mosquitto//'); fi
  if [ "$NETWORK" = tailscale ]; then tools="$tools tailscale"; fi
  printf '%s' "$tools"
}

# The macOS app's CLI (App Store or `brew install --cask tailscale`), when tailscale is not on PATH.
TAILSCALE_APP_CLI=/Applications/Tailscale.app/Contents/MacOS/Tailscale

tailscale_ok() {
  have tailscale || { [ "$PLATFORM" = macos ] && [ -x "$TAILSCALE_APP_CLI" ]; }
}

present() {
  case "$1" in
    ca-certificates) dpkg -s ca-certificates >/dev/null 2>&1 ;;
    mosquitto) mosquitto_ok ;;
    tailscale) tailscale_ok ;;
    *) have "$1" ;;
  esac
}

check() {
  say "Platform: $PLATFORM_NAME"
  missing=0
  for t in $(platform_tools); do
    if present "$t"; then
      where=$(command -v "$t" 2>/dev/null || true)
      [ "$t" = tailscale ] && [ -z "$where" ] && where=$TAILSCALE_APP_CLI
      [ "$t" = mosquitto ] && where="$(mosquitto_version), ${where:-(snap)}"
      [ "$t" = ca-certificates ] && where="(dpkg)"
      printf '  found    %-16s %s\n' "$t" "$(tildify "$where")"
    else
      missing=1
      note=''
      if [ "$t" = mosquitto ] && have mosquitto; then
        note="$(mosquitto_version) on PATH; Volley needs 2.1 or newer"
      elif [ "$t" = mosquitto ] && [ -n "$(snap_mosquitto_version)" ]; then
        note="the snap is $(snap_mosquitto_version); Volley needs 2.1 or newer"
      fi
      printf '  missing  %-16s %s\n' "$t" "$note"
    fi
  done
  if [ -x "$BIN/volley" ]; then
    say "Volley: $(tildify "$BIN/volley")"
  elif brew_volley; then
    say "Volley: $(tildify "$(brew --prefix)/bin/volley") (brew $TAP_FORMULA)"
  else
    say "Volley: not installed"
  fi
  return "$missing"
}

# Download an installer and run it with bash (`tty`: on the terminal, for its prompts).
run_installer() {
  tmp=$(mktemp "${TMPDIR:-/tmp}/volley-install.XXXXXX")
  if ! curl -fsSL "$1" -o "$tmp"; then
    rm -f "$tmp"
    die "could not download $1"
  fi
  if [ "${2:-}" = tty ] && tty_ok; then
    bash "$tmp" <"$TTY" && ok=0 || ok=$?
  else
    NONINTERACTIVE=1 bash "$tmp" && ok=0 || ok=$?
  fi
  rm -f "$tmp"
  [ "$ok" -eq 0 ] || die "the installer from $1 failed (exit $ok)"
  path_add_known
}

install_claude() {
  have claude && return 0
  say "Installing Claude Code (its native installer)..."
  run_installer https://claude.ai/install.sh
}

brew_formula() {
  case "$1" in
    bun) printf 'oven-sh/bun/bun' ;;
    *) printf '%s' "$1" ;;
  esac
}

# Whether Volley's formula is installed with brew.
brew_volley() {
  [ "$PLATFORM" = macos ] && have brew && brew list --versions "$TAP_FORMULA" >/dev/null 2>&1
}

# Sets BREW (Volley comes from the tap) when brew resolves the formula, no tag or checkout was
# asked for (the formula is the newest release) and no curl-path install is there to shadow it;
# the formula brings bun, mosquitto, gh, git, tmux. A failed brew install stops the install.
install_brew_volley() {
  BREW=''
  # A peer's checkout is at the supervisor's tag; the formula would bring a broker too.
  [ -z "$NO_BROKER" ] || return 1
  [ -z "$SOURCE$VERSION" ] || return 1
  [ ! -e "$BIN/volley" ] || return 1
  brew info "$TAP_FORMULA" >/dev/null 2>&1 || return 1
  if brew_volley; then
    say "Volley is installed with brew ($TAP_FORMULA); \`brew upgrade $TAP_FORMULA\`, then \`volley setup\`, updates it."
  else
    say "brew install $TAP_FORMULA"
    brew install "$TAP_FORMULA" || die "brew install $TAP_FORMULA failed; rerun once it is fixed."
  fi
  BREW=1
}

install_macos() {
  if ! have brew; then
    say "Installing Homebrew. Its installer asks for your password: the only sudo this install needs."
    run_installer https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh tty
    have brew || die "Homebrew is installed but brew is not on PATH; open a new terminal and rerun."
  fi
  if install_brew_volley; then
    install_claude
    return 0
  fi
  formulas=''
  for t in $(platform_tools); do
    case "$t" in brew | claude | tailscale) continue ;; esac
    have "$t" || formulas="$formulas $(brew_formula "$t")"
  done
  if [ -n "$formulas" ]; then
    say "brew install$formulas"
    # shellcheck disable=SC2086 # one word per formula
    brew install $formulas
  fi
  install_tailscale_macos
  install_claude
}

# `--network tailscale` on macOS: the app (its CLI comes with it), unless one is there.
install_tailscale_macos() {
  [ "$NETWORK" = tailscale ] || return 0
  tailscale_ok && return 0
  say "brew install --cask tailscale"
  brew install --cask tailscale || die "brew install --cask tailscale failed; rerun once it is fixed."
}

# Tailscale's apt repository for this distribution: `<ubuntu|debian>/<codename>` (a derivative
# reads as the distribution it is like).
tailscale_dist() {
  id=$(os_field ID)
  like=$(os_field ID_LIKE)
  case " $id $like " in
    " ubuntu "* | *" ubuntu "*)
      code=$(os_field UBUNTU_CODENAME)
      [ -n "$code" ] || code=$(os_field VERSION_CODENAME)
      printf 'ubuntu/%s' "$code"
      ;;
    *) printf 'debian/%s' "$(os_field VERSION_CODENAME)" ;;
  esac
}

# Download $1 whole to $2 (as root), or stop: a broken keyring or list would fail every later
# `apt-get update`.
fetch_as_root() {
  tmp=$(mktemp "${TMPDIR:-/tmp}/volley-install.XXXXXX")
  if ! curl -fsSL "$1" -o "$tmp" || [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    die "could not download $1"
  fi
  as_root tee "$2" <"$tmp" >/dev/null
  rm -f "$tmp"
}

SUDO_OK=''
as_root() {
  if [ -n "$SUDO_OK" ]; then sudo "$@"; else "$@"; fi
}

# snapd can install a snap: running, or socket-activated (a fresh cloud image: snapd.service starts
# on the first `snap` call).
snapd_usable() {
  have snap && have systemctl &&
    { systemctl is-active --quiet snapd.socket 2>/dev/null ||
      systemctl is-active --quiet snapd.service 2>/dev/null; }
}

# No mosquitto 2.1 could be put on the machine: stop before Volley, with the fix (a machine
# without a broker is not installed; rerunning once it is fixed is the designed path).
broker_missing() {
  v=$(mosquitto_version)
  if [ -n "$v" ] && have mosquitto; then
    warn "mosquitto $v is on PATH; Volley needs 2.1 or newer. Stop and remove it first (its broker"
    warn "holds port 1883, and its binary would shadow a newer one):  sudo apt-get remove mosquitto"
  elif [ -n "$v" ]; then
    warn "the mosquitto snap is $v; Volley needs 2.1 or newer:  sudo snap refresh mosquitto"
  elif have snap && ! snapd_usable; then
    warn "snapd is installed but not running:  sudo systemctl enable --now snapd.socket"
  else
    warn "mosquitto 2.1 or newer could not be installed (see the output above)."
  fi
  warn "Volley needs mosquitto 2.1 or newer. Fix it, then rerun the install:"
  warn "  curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh"
  warn "or run the broker in a container and install Volley for that:"
  warn "  docker run eclipse-mosquitto:2.1-alpine"
  warn "  curl -fsSL https://raw.githubusercontent.com/kryptek/volley/main/install.sh | sh -s -- --broker container"
  die "stopped before installing Volley: no mosquitto 2.1."
}

install_linux() {
  apt_pkgs=''
  for p in git tmux curl ca-certificates; do
    present "$p" || apt_pkgs="$apt_pkgs $p"
  done
  # bun's installer unpacks a zip.
  if ! have bun && ! have unzip; then apt_pkgs="$apt_pkgs unzip"; fi
  need_gh=''
  have gh || need_gh=1
  # `--network tailscale`: Tailscale's own apt repository, while sudo is held for the rest.
  need_ts=''
  if [ "$NETWORK" = tailscale ] && ! tailscale_ok; then need_ts=1; fi
  # Only when no mosquitto is there: a snap broker next to an older one cannot bind 1883. No snap
  # command (Debian's cloud image, a minimal Ubuntu): snapd from apt first.
  need_snap='' need_snapd=''
  if [ -z "$NO_BROKER" ] && [ -z "$(mosquitto_version)" ]; then
    if ! have snap; then
      need_snapd=1 need_snap=1
    elif snapd_usable; then
      need_snap=1
    fi
  fi

  if [ -n "$apt_pkgs$need_gh$need_snap$need_ts" ] && [ "$(id -u)" != 0 ]; then
    have sudo || die "sudo is needed to install the missing packages, and it is not installed."
    reasons=''
    [ -n "$apt_pkgs" ] && reasons="$reasons
  - apt-get install$apt_pkgs"
    [ -n "$need_snapd" ] && reasons="$reasons
  - apt-get install snapd (for the mosquitto snap)"
    [ -n "$need_gh" ] && reasons="$reasons
  - add GitHub's apt repository (cli.github.com) and install gh"
    [ -n "$need_snap" ] && reasons="$reasons
  - snap install mosquitto"
    [ -n "$need_ts" ] && reasons="$reasons
  - add Tailscale's apt repository (pkgs.tailscale.com) and install tailscale"
    say "sudo is needed to:$reasons"
    # `sudo -n true` runs a command as the installer will (the last matching sudoers entry), so it
    # passes on a cloud image's NOPASSWD user, where `sudo -v` would still ask (verifypw=all).
    if sudo -n true 2>/dev/null; then
      :
    elif tty_ok; then
      sudo -v || die "sudo failed; rerun when you can sudo."
    else
      die "sudo needs your password and there is no terminal to ask on; run the install from a terminal."
    fi
    SUDO_OK=1
  fi

  # snapd goes into the one apt-get call (its own reason line above).
  [ -n "$need_snapd" ] && apt_pkgs="$apt_pkgs snapd"
  if [ -n "$apt_pkgs" ]; then
    say "apt-get install -y$apt_pkgs"
    as_root apt-get update
    # shellcheck disable=SC2086 # one word per package
    if ! as_root apt-get install -y $apt_pkgs; then
      # apt's own failure first (any package may be the cause); without snapd there is no broker
      # either, so stop with that fix too rather than at the next step.
      [ -n "$need_snapd" ] && ! have snap && {
        warn "apt-get install -y$apt_pkgs failed."
        broker_missing
      }
      die "apt-get install failed; rerun once it is fixed."
    fi
  fi

  if ! have bun; then
    say "Installing bun (its installer, into ~/.bun)..."
    run_installer https://bun.sh/install
  fi

  if [ -n "$need_gh" ]; then
    say "Installing gh from GitHub's apt repository..."
    keyring=/etc/apt/keyrings/githubcli-archive-keyring.gpg
    key_url=https://cli.github.com/packages/githubcli-archive-keyring.gpg
    # Downloaded whole before anything is written: a broken keyring or list would fail every
    # later `apt-get update`.
    tmp=$(mktemp "${TMPDIR:-/tmp}/volley-install.XXXXXX")
    if ! curl -fsSL "$key_url" -o "$tmp" || [ ! -s "$tmp" ]; then
      rm -f "$tmp"
      die "could not download $key_url"
    fi
    as_root mkdir -p -m 755 /etc/apt/keyrings
    as_root tee "$keyring" <"$tmp" >/dev/null
    rm -f "$tmp"
    as_root chmod go+r "$keyring"
    printf 'deb [arch=%s signed-by=%s] https://cli.github.com/packages stable main\n' \
      "$(dpkg --print-architecture)" "$keyring" |
      as_root tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    as_root apt-get update
    as_root apt-get install -y gh
  fi

  if [ -n "$need_ts" ]; then
    dist=$(tailscale_dist)
    say "Installing tailscale from Tailscale's apt repository ($dist)..."
    as_root mkdir -p -m 755 /usr/share/keyrings
    fetch_as_root "https://pkgs.tailscale.com/stable/$dist.noarmor.gpg" \
      /usr/share/keyrings/tailscale-archive-keyring.gpg
    fetch_as_root "https://pkgs.tailscale.com/stable/$dist.tailscale-keyring.list" \
      /etc/apt/sources.list.d/tailscale.list
    as_root apt-get update
    as_root apt-get install -y tailscale
  fi

  if [ -n "$need_snap" ]; then
    # A fresh snapd seeds itself first; `snap install` before that fails.
    [ -n "$need_snapd" ] && { as_root snap wait system seed.loaded || true; }
    say "Installing mosquitto with snap..."
    # A snapd with no snaps stands by after 5 s idle, and a request that lands while it stops is
    # cancelled ("context canceled"; Debian 13 right after apt): try again after a pause.
    tries=1
    until as_root snap install mosquitto; do
      if [ "$tries" -ge 3 ]; then
        warn "snap install mosquitto failed."
        break
      fi
      tries=$((tries + 1))
      sleep "$SNAP_RETRY_S"
      as_root snap wait system seed.loaded || true
    done
    path_add /snap/bin
  fi

  install_claude

  [ -n "$NO_BROKER" ] || mosquitto_ok || broker_missing
}

# ---------------------------------------------------------------------------------------------
# Volley itself

latest_tag() {
  curl -fsSL "$TAGS_API" |
    sed -n 's/.*"name": *"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' |
    sort -t . -k 1.2,1n -k 2,2n -k 3,3n | tail -n 1
}

# Sets ROOT (the checkout the commands run) and CHANGED (it moved: bun install again).
install_source() {
  CHANGED=''
  if [ -n "$SOURCE" ]; then
    [ -d "$SOURCE" ] || die "--source $SOURCE is not a directory"
    ROOT=$(cd "$SOURCE" && pwd)
  else
    ROOT=$SRC_DIR
    if [ -z "$VERSION" ]; then
      VERSION=$(latest_tag) || true
      [ -n "$VERSION" ] || die "could not read the latest tag from $TAGS_API; pass --version vX.Y.Z"
    fi
    if [ -d "$SRC_DIR/.git" ]; then
      current=$(git -C "$SRC_DIR" describe --tags --exact-match 2>/dev/null) || current=''
      git -C "$SRC_DIR" fetch --tags || warn "install.sh: could not fetch Volley's tags; going on with what is there."
      if [ "$current" != "$VERSION" ]; then
        say "Moving $(tildify "$SRC_DIR") from ${current:-an untagged commit} to $VERSION"
        git -C "$SRC_DIR" checkout --quiet "$VERSION"
        CHANGED=1
      fi
    elif [ -e "$SRC_DIR" ]; then
      die "$(tildify "$SRC_DIR") exists and is not a git checkout; move it away and rerun."
    else
      say "Cloning Volley $VERSION into $(tildify "$SRC_DIR")"
      mkdir -p "$VOLLEY_HOME"
      git clone --depth 1 --branch "$VERSION" "$REPO_URL" "$SRC_DIR"
      CHANGED=1
    fi
  fi
  if [ -n "$CHANGED" ] || [ ! -d "$ROOT/node_modules" ]; then
    (cd "$ROOT" && bun install --frozen-lockfile)
  fi
}

# `volley setup`'s quoting (shQuote in packages/volley-cli/src/setup/services.ts).
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Byte for byte what `volley setup` writes (commandScript in packages/volley-cli/src/setup/
# services.ts), so its services step finds the commands already in place.
command_script() {
  cat <<EOF
#!/bin/sh
# Written by \`volley setup\`: this checkout's command, run with the bun setup found, so it works on any
# PATH (a non-interactive ssh session's too). Rerun \`volley setup --step services\` to update it.
exec $(sh_quote "$1") $(sh_quote "$2") "\$@"
EOF
}

# Whether the file at $1 is a command script `volley setup` (or this script) wrote.
# shellcheck disable=SC2016 # the backquotes are literal
ours() { [ -f "$1" ] && [ ! -L "$1" ] && sed -n 2p "$1" | grep -q '^# Written by `volley setup`'; }

write_command() {
  path="$BIN/$1"
  tmp="$path.volley-tmp"
  command_script "$2" "$3" >"$tmp"
  if [ -f "$path" ] && [ ! -L "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 0
  fi
  if { [ -e "$path" ] || [ -L "$path" ]; } && ! ours "$path"; then
    backup="$path.volley-backup-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$path" "$backup"
    say "Moved the existing $(tildify "$path") aside to $(tildify "$backup")"
  fi
  chmod 755 "$tmp"
  mv "$tmp" "$path"
  say "Wrote $(tildify "$path")"
}

write_commands() {
  bun=$(command -v bun) || die "bun is not on PATH"
  mkdir -p "$BIN"
  write_command volley "$bun" "$ROOT/packages/volley-cli/src/cli.ts"
  write_command volleyd "$bun" "$ROOT/packages/volleyd/src/cli.ts"
}

rc_file() {
  shell=${SHELL:-}
  case "${shell##*/}" in
    zsh) printf '%s' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$PLATFORM" = macos ]; then printf '%s' "$HOME/.bash_profile"; else printf '%s' "$HOME/.bashrc"; fi ;;
  esac
}

add_path_line() {
  shell=${SHELL:-}
  if [ "${shell##*/}" = fish ]; then
    say "fish: put Volley's commands on your PATH with:  fish_add_path \$HOME/.volley/bin"
    return 0
  fi
  rc=$(rc_file)
  if [ -z "$rc" ]; then
    say "Add this line to your shell's startup file:  $RC_LINE"
    return 0
  fi
  if [ -f "$rc" ] && grep -qxF "$RC_LINE" "$rc"; then return 0; fi
  if [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ]; then printf '\n' >>"$rc"; fi
  printf '%s\n' "$RC_LINE" >>"$rc"
  say "Added ~/.volley/bin to PATH in $(tildify "$rc") (new terminals pick it up)."
}

# Runs (or names) `volley setup` with the command at $1.
chain_setup() {
  cmd=$1
  shown=$(tildify "$cmd")
  set -- setup
  [ -n "$PEER" ] && set -- "$@" --peer
  [ -n "$BROKER" ] && set -- "$@" --layout "$BROKER"
  [ -n "$NETWORK" ] && set -- "$@" --network "$NETWORK"
  [ -n "$NETWORK_ADDRESS" ] && set -- "$@" --network-address "$NETWORK_ADDRESS"
  if [ -z "$SETUP" ]; then
    say "Volley is installed. Next: $shown $*"
  elif tty_ok; then
    say "Running $shown $*"
    # A peer's setup has no broker to find (its broker is the supervisor's, through the tunnel).
    [ -n "$PEER" ] && export VOLLEY_BROKER=skip
    exec "$cmd" "$@" <"$TTY"
  else
    say "Volley is installed. No terminal to run setup on; run: $shown $*"
  fi
}

# ---------------------------------------------------------------------------------------------
# Uninstall

remove_units() {
  if [ "$PLATFORM" = macos ]; then
    uid=$(id -u)
    for label in systems.volley.volleyd systems.volley.desk systems.volley.peer; do
      plist="$HOME/Library/LaunchAgents/$label.plist"
      [ -e "$plist" ] || continue
      launchctl bootout "gui/$uid/$label" 2>/dev/null || true
      rm -f "$plist"
      say "Removed $label"
    done
  else
    dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    removed=''
    for unit in volleyd.service volley-desk.service volley-peer.service; do
      [ -e "$dir/$unit" ] || continue
      systemctl --user disable --now "$unit" 2>/dev/null || true
      rm -f "$dir/$unit"
      removed=1
      say "Removed $unit"
    done
    if [ -n "$removed" ]; then systemctl --user daemon-reload 2>/dev/null || true; fi
  fi
}

uninstall() {
  cmd="$BIN/volley"
  brewed=''
  if brew_volley; then
    brewed=1
    [ -x "$cmd" ] || cmd="$(brew --prefix)/bin/volley"
  fi
  if [ -x "$cmd" ] && "$cmd" setup --help 2>/dev/null | grep -q -- '--uninstall'; then
    say "Removing the services with volley setup --uninstall"
    if tty_ok; then "$cmd" setup --uninstall <"$TTY"; else "$cmd" setup --uninstall; fi
  else
    remove_units
  fi
  for name in volley volleyd; do
    if ours "$BIN/$name"; then
      rm -f "$BIN/$name"
      say "Removed $(tildify "$BIN/$name")"
    elif [ -e "$BIN/$name" ]; then
      say "Left $(tildify "$BIN/$name") alone: volley setup did not write it."
    fi
  done
  rmdir "$BIN" 2>/dev/null || true
  for rc in "${ZDOTDIR:-$HOME}/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile"; do
    if [ ! -f "$rc" ] || ! grep -qxF "$RC_LINE" "$rc"; then continue; fi
    tmp="$rc.volley-tmp"
    grep -vxF "$RC_LINE" "$rc" >"$tmp" || true
    cat "$tmp" >"$rc"
    rm -f "$tmp"
    say "Removed the PATH line from $(tildify "$rc")"
  done
  if [ -e "$SRC_DIR" ]; then
    rm -rf "$SRC_DIR"
    say "Removed $(tildify "$SRC_DIR")"
  fi
  if [ -n "$brewed" ]; then
    say "brew uninstall $TAP_FORMULA"
    brew uninstall "$TAP_FORMULA"
  fi
  if [ -n "$PURGE" ]; then
    rm -rf "$VOLLEY_HOME/volleyd"
    say "Removed $(tildify "$VOLLEY_HOME/volleyd")"
  elif [ -e "$VOLLEY_HOME/volleyd" ]; then
    say "Kept volleyd's state in $(tildify "$VOLLEY_HOME/volleyd") (--purge removes it)."
  fi
  say "The broker and its configuration are untouched."
}

# ---------------------------------------------------------------------------------------------

main() {
  MODE=install SETUP=1 PEER='' BROKER='' PURGE='' SOURCE='' NETWORK='' NETWORK_ADDRESS=''
  VERSION="${VOLLEY_VERSION:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) MODE=check ;;
      --uninstall) MODE=uninstall ;;
      --purge) PURGE=1 ;;
      --peer) PEER=1 ;;
      --broker)
        [ $# -ge 2 ] || usage_error "--broker needs a kind (container)"
        BROKER=$2
        shift
        ;;
      --broker=*) BROKER=${1#*=} ;;
      --no-setup) SETUP='' ;;
      --network)
        [ $# -ge 2 ] || usage_error "--network needs a kind (tailscale, manual or none)"
        NETWORK=$2
        shift
        ;;
      --network=*) NETWORK=${1#*=} ;;
      --network-address)
        [ $# -ge 2 ] || usage_error "--network-address needs a host or IP"
        NETWORK_ADDRESS=$2
        shift
        ;;
      --network-address=*) NETWORK_ADDRESS=${1#*=} ;;
      --source)
        [ $# -ge 2 ] || usage_error "--source needs a directory"
        SOURCE=$2
        shift
        ;;
      --source=*) SOURCE=${1#*=} ;;
      --version)
        [ $# -ge 2 ] || usage_error "--version needs a tag (vX.Y.Z)"
        VERSION=$2
        shift
        ;;
      --version=*) VERSION=${1#*=} ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) usage_error "unknown option: $1" ;;
    esac
    shift
  done
  [ -n "$PURGE" ] && [ "$MODE" != uninstall ] && usage_error "--purge goes with --uninstall"
  case "$BROKER" in
    '' | container) ;;
    *) usage_error "--broker must be container (got $BROKER)" ;;
  esac
  [ -n "$BROKER" ] && [ -n "$PEER" ] && usage_error "--broker goes without --peer (a peer runs no broker)"
  # No broker of our own to install or check: a peer's is the supervisor's; a container's, yours.
  NO_BROKER=$PEER$BROKER
  case "$NETWORK" in
    '' | tailscale | manual | none) ;;
    *) usage_error "--network must be tailscale, manual or none (got $NETWORK)" ;;
  esac
  [ -n "$NETWORK_ADDRESS" ] && [ "$NETWORK" != manual ] &&
    usage_error "--network-address goes with --network manual"

  detect_platform
  path_add_known
  case "$MODE" in
    check) check ;;
    uninstall) uninstall ;;
    install)
      say "Installing Volley on $PLATFORM_NAME"
      BREW=''
      if [ "$PLATFORM" = macos ]; then install_macos; else install_linux; fi
      if [ -n "$BREW" ]; then
        chain_setup "$(brew --prefix)/bin/volley"
      else
        install_source
        write_commands
        add_path_line
        chain_setup "$BIN/volley"
      fi
      ;;
  esac
}

main "$@" </dev/null
