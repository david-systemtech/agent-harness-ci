#!/usr/bin/env bash
# The setup's NSIS wrapper and ARM64-filtered 7z payload need a current reader.
# Print the verified reader's path; callers retain its extraction exit status.
set -euo pipefail

version=26.03
case $(uname -m) in
  x86_64) arch=x64 sha256=dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695 ;;
  aarch64) arch=arm64 sha256=2389ba20e4d8295e8709c20b6263b69bd1ec4972fe38a04ad7a1badbf595b996 ;;
  *) echo "7zip: no reader is pinned for $(uname -m)" >&2; exit 1 ;;
esac

name="7z${version//./}-linux-$arch.tar.xz"
cache=${SEVENZIP_CACHE:-$HOME/.cache/agent-harness-7zip}
tarball="$cache/$name"
mkdir -p "$cache"
part=""
trap 'if [ -n "$part" ]; then rm -f "$part"; fi' EXIT
if ! printf '%s  %s\n' "$sha256" "$tarball" | sha256sum --check --status 2>/dev/null; then
  part=$(mktemp "$tarball.part.XXXXXX")
  curl -fsSL --retry 3 --retry-all-errors --connect-timeout 10 --max-time 120 \
    -o "$part" "https://7-zip.org/a/$name"
  printf '%s  %s\n' "$sha256" "$part" | sha256sum --check --status || {
    echo "7zip: $name is not the pinned archive" >&2
    exit 1
  }
  mv "$part" "$tarball"
  part=""
fi

folder=$(mktemp -d "${RUNNER_TEMP:-/tmp}/7zip-$version.XXXXXX")
tar -xJf "$tarball" -C "$folder"
test -x "$folder/7zz"
printf '%s\n' "$folder/7zz"
