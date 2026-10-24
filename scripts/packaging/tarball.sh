#!/bin/sh
# The release tarball the Homebrew formula downloads: a Volley checkout with its node_modules
# (nothing is fetched at install), reproducible from the same tree.
#
#   scripts/packaging/tarball.sh <version> <checkout> <out-dir>
#
# Writes <out-dir>/volley-<x.y.z>.tar.gz (every entry under volley-<x.y.z>/, sorted by name,
# mtime $SOURCE_DATE_EPOCH (default: the checkout's HEAD commit time), owner 0/0, no .git,
# hardlinks stored as files) and <out-dir>/volley-<x.y.z>.tar.gz.sha256, then prints `file=` and
# `sha256=` lines (the release workflow appends them to $GITHUB_OUTPUT). Needs GNU tar ($TAR,
# default tar); exit 2 on a usage error, 1 when the checkout cannot be packed.

set -eu

die() {
  printf 'tarball.sh: %s\n' "$1" >&2
  exit "${2:-1}"
}

[ $# -eq 3 ] || die "usage: tarball.sh <version> <checkout> <out-dir>" 2
version=${1#v}
src=$2
out=$3
case "$version" in
  *[!0-9.]* | .* | *. | *..*) die "not a release version (x.y.z): $1" 2 ;;
esac
[ "$(printf '%s' "$version" | tr -cd . | wc -c)" -eq 2 ] || die "not a release version (x.y.z): $1" 2
[ -d "$src" ] || die "$src is not a directory" 2
[ -d "$src/node_modules" ] || die "$src has no node_modules: run bun install --frozen-lockfile first"

tar=${TAR:-tar}
"$tar" --version 2>/dev/null | grep -q 'GNU tar' || die "$tar is not GNU tar (set TAR, e.g. TAR=gtar)"

epoch=${SOURCE_DATE_EPOCH:-}
if [ -z "$epoch" ]; then
  epoch=$(git -C "$src" log -1 --format=%ct 2>/dev/null) || die "set SOURCE_DATE_EPOCH: $src has no git commit"
fi

name="volley-$version"
mkdir -p "$out"
file="$(cd "$out" && pwd)/$name.tar.gz"
tmp="$file.tmp"
"$tar" -C "$src" --create --file=- \
  --exclude=.git --sort=name --format=gnu \
  --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
  --mode='u+rwX,go+rX,go-w' --hard-dereference \
  --transform="s,^\\.,$name,S" . | gzip -n -9 >"$tmp"
mv "$tmp" "$file"

if command -v sha256sum >/dev/null 2>&1; then
  sha=$(sha256sum "$file" | cut -d ' ' -f 1)
else
  sha=$(shasum -a 256 "$file" | cut -d ' ' -f 1)
fi
printf '%s  %s\n' "$sha" "$name.tar.gz" >"$file.sha256"
printf 'file=%s\nsha256=%s\n' "$file" "$sha"
