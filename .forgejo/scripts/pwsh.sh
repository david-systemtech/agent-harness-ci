#!/usr/bin/env bash
# Puts PowerShell 7 (`pwsh`) on a ci job's PATH, for test/install-ps1-script.test.ts,
# which runs scripts/install.ps1 under it (#352). The `ci` runners' image,
# node:24-bookworm, has no PowerShell, and Microsoft's Debian packages are for
# amd64 alone, while the `ci` label takes in an arm64 runner (mba-ci-1). So this
# takes PowerShell's own tarball for the runner's architecture from its GitHub
# release, pinned by version and by the SHA-256 the release's hashes.sha256
# lists, checks it before unpacking it, and adds the folder to $GITHUB_PATH.
#
# The tarball is kept in PWSH_CACHE (preset ~/.cache/agent-harness-pwsh), which
# the job caches keyed by this file, and is checked again at every run, so a
# damaged cache costs a download, never another binary. The runners' image has
# no ICU either, so pwsh runs with DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1, as
# the tests run it.
set -euo pipefail

version=7.6.6
case $(uname -m) in
  x86_64) arch=x64 sha256=ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc ;;
  aarch64) arch=arm64 sha256=924829e54c983648f6f1419a2dc7f9433c861b2fb5bd57736ff096c24f133729 ;;
  *) echo "pwsh: no PowerShell tarball is pinned for $(uname -m)" >&2; exit 1 ;;
esac

name="powershell-$version-linux-$arch.tar.gz"
cache=${PWSH_CACHE:-$HOME/.cache/agent-harness-pwsh}
tarball="$cache/$name"
mkdir -p "$cache"
if ! echo "$sha256  $tarball" | sha256sum --check --status 2>/dev/null; then
  curl -fsSL --retry 3 -o "$tarball.part" "https://github.com/PowerShell/PowerShell/releases/download/v$version/$name"
  echo "$sha256  $tarball.part" | sha256sum --check --status || {
    echo "pwsh: $name is not the pinned $sha256" >&2
    rm -f "$tarball.part"
    exit 1
  }
  mv "$tarball.part" "$tarball"
fi

folder="${RUNNER_TEMP:-/tmp}/pwsh-$version"
rm -rf "$folder"
mkdir -p "$folder"
tar -xzf "$tarball" -C "$folder"
chmod +x "$folder/pwsh"
DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 "$folder/pwsh" -NoProfile -NonInteractive -Command '"PowerShell $($PSVersionTable.PSVersion) at $PSHOME"'
echo "$folder" >> "$GITHUB_PATH"
