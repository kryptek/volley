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
and Claude Code, each only when missing), clones Volley at a release tag into ~/.volley/src,
writes the `volley` and `volleyd` commands into ~/.volley/bin, adds that directory to PATH in
your shell's startup file once, then runs `volley setup`. Rerunning it is safe: what is already
there is left alone.

Options:
  --version vX.Y.Z   Install this release tag (default: $VOLLEY_VERSION, else the latest tag)
  --source <dir>     Use this Volley checkout instead of cloning one (CI tests its own)
  --peer             Pass --peer to `volley setup` (this machine joins a supervisor's fleet)
  --no-setup         Stop before `volley setup`; it prints the command to run
  --check            Print each prerequisite as found or missing; exit 1 if any is missing.
                     Changes nothing
  --uninstall        Remove the services, the commands, the PATH line and ~/.volley/src.
                     Keeps volleyd's state (~/.volley/volleyd) and the broker's configuration
  --purge            With --uninstall: remove ~/.volley/volleyd too
  -h, --help         Show this help

Exit status: 0 done, 1 --check found something missing (or a step failed), 2 a usage error or an
unsupported platform.
EOF
}

REPO_URL="https://github.com/kryptek/volley.git"
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

# The x.y.z `mosquitto -h` prints, or nothing.
mosquitto_version() {
  have mosquitto || return 0
  mosquitto -h 2>&1 | sed -n 's/^mosquitto version \([0-9][0-9]*\.[0-9][0-9]*[0-9.]*\).*/\1/p' | head -n 1
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

present() {
  case "$1" in
    ca-certificates) dpkg -s ca-certificates >/dev/null 2>&1 ;;
    mosquitto) mosquitto_ok ;;
    *) have "$1" ;;
  esac
}

check() {
  say "Platform: $PLATFORM_NAME"
  if [ "$PLATFORM" = macos ]; then tools=$MAC_TOOLS; else tools=$LINUX_TOOLS; fi
  missing=0
  for t in $tools; do
    if present "$t"; then
      where=$(command -v "$t" 2>/dev/null || true)
      [ "$t" = mosquitto ] && where="$(mosquitto_version), $where"
      [ "$t" = ca-certificates ] && where="(dpkg)"
      printf '  found    %-16s %s\n' "$t" "$(tildify "$where")"
    else
      missing=1
      note=''
      if [ "$t" = mosquitto ] && have mosquitto; then
        note="$(mosquitto_version) on PATH; Volley needs 2.1 or newer"
      fi
      printf '  missing  %-16s %s\n' "$t" "$note"
    fi
  done
  if [ -x "$BIN/volley" ]; then
    say "Volley: $(tildify "$BIN/volley")"
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

install_macos() {
  if ! have brew; then
    say "Installing Homebrew. Its installer asks for your password: the only sudo this install needs."
    run_installer https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh tty
    have brew || die "Homebrew is installed but brew is not on PATH; open a new terminal and rerun."
  fi
  # The brew path (a Volley formula in a tap) slots in here: when `brew info` resolves it, install
  # that instead of the source checkout below.
  formulas=''
  for t in bun mosquitto gh git tmux; do
    have "$t" || formulas="$formulas $(brew_formula "$t")"
  done
  if [ -n "$formulas" ]; then
    say "brew install$formulas"
    # shellcheck disable=SC2086 # one word per formula
    brew install $formulas
  fi
  install_claude
}

SUDO_OK=''
as_root() {
  if [ -n "$SUDO_OK" ]; then sudo "$@"; else "$@"; fi
}

snapd_active() {
  have snap && have systemctl && systemctl is-active --quiet snapd 2>/dev/null
}

mosquitto_options() {
  v=$(mosquitto_version)
  if [ -n "$v" ]; then
    say "mosquitto $v is on PATH; Volley needs 2.1 or newer. Stop and remove it first (its broker"
    say "holds port 1883, and its binary would shadow a newer one), e.g.  sudo apt-get remove mosquitto"
  else
    say "mosquitto is not installed."
  fi
  say "Install mosquitto 2.1 or newer, either way (then rerun, or let \`volley setup\` check):"
  say "  sudo snap install mosquitto               (needs snapd)"
  say "  docker run eclipse-mosquitto:2.1-alpine"
  say "\`volley setup\`'s Broker step stops with the same advice until one of them runs."
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
  # Only when no mosquitto is there: a snap broker next to an older one cannot bind 1883.
  need_snap=''
  if ! have mosquitto && snapd_active; then need_snap=1; fi

  if [ -n "$apt_pkgs$need_gh$need_snap" ] && [ "$(id -u)" != 0 ]; then
    have sudo || die "sudo is needed to install the missing packages, and it is not installed."
    reasons=''
    [ -n "$apt_pkgs" ] && reasons="$reasons
  - apt-get install$apt_pkgs"
    [ -n "$need_gh" ] && reasons="$reasons
  - add GitHub's apt repository (cli.github.com) and install gh"
    [ -n "$need_snap" ] && reasons="$reasons
  - snap install mosquitto"
    say "sudo is needed to:$reasons"
    sudo -v || die "sudo failed; rerun when you can sudo."
    SUDO_OK=1
  fi

  if [ -n "$apt_pkgs" ]; then
    say "apt-get install -y$apt_pkgs"
    as_root apt-get update
    # shellcheck disable=SC2086 # one word per package
    as_root apt-get install -y $apt_pkgs
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

  if mosquitto_ok; then
    :
  elif [ -n "$need_snap" ]; then
    say "Installing mosquitto with snap..."
    as_root snap install mosquitto
    path_add /snap/bin
    mosquitto_ok || mosquitto_options
  else
    mosquitto_options
  fi

  install_claude
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

chain_setup() {
  set -- setup
  [ -n "$PEER" ] && set -- "$@" --peer
  if [ -z "$SETUP" ]; then
    say "Volley is installed. Next: ~/.volley/bin/volley $*"
  elif tty_ok; then
    say "Running ~/.volley/bin/volley $*"
    exec "$BIN/volley" "$@" <"$TTY"
  else
    say "Volley is installed. No terminal to run setup on; run: ~/.volley/bin/volley $*"
  fi
}

# ---------------------------------------------------------------------------------------------
# Uninstall

remove_units() {
  if [ "$PLATFORM" = macos ]; then
    uid=$(id -u)
    for label in systems.volley.volleyd systems.volley.desk; do
      plist="$HOME/Library/LaunchAgents/$label.plist"
      [ -e "$plist" ] || continue
      launchctl bootout "gui/$uid/$label" 2>/dev/null || true
      rm -f "$plist"
      say "Removed $label"
    done
  else
    dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    removed=''
    for unit in volleyd.service volley-desk.service; do
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
  if [ -x "$BIN/volley" ] && "$BIN/volley" setup --help 2>/dev/null | grep -q -- '--uninstall'; then
    say "Removing the services with volley setup --uninstall"
    if tty_ok; then "$BIN/volley" setup --uninstall <"$TTY"; else "$BIN/volley" setup --uninstall; fi
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
  MODE=install SETUP=1 PEER='' PURGE='' SOURCE=''
  VERSION="${VOLLEY_VERSION:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) MODE=check ;;
      --uninstall) MODE=uninstall ;;
      --purge) PURGE=1 ;;
      --peer) PEER=1 ;;
      --no-setup) SETUP='' ;;
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

  detect_platform
  path_add_known
  case "$MODE" in
    check) check ;;
    uninstall) uninstall ;;
    install)
      say "Installing Volley on $PLATFORM_NAME"
      if [ "$PLATFORM" = macos ]; then install_macos; else install_linux; fi
      install_source
      write_commands
      add_path_line
      chain_setup
      ;;
  esac
}

main "$@" </dev/null
