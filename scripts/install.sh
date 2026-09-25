#!/bin/sh
# Installs the agent-harness environment on a headless Linux or macOS machine:
# finds a release on the project's Forgejo, downloads the artefact for this
# platform, verifies its checksum when one is published, unpacks it, then runs
# `agent-harness service install`, `service start` and `service status`.
#
# The repository is private, so the releases API and the downloads need a read
# token: set AGENT_HARNESS_TOKEN to a Forgejo access token with the
# read:repository scope (git.systemtech.dev: Settings > Applications). The
# token goes to curl on stdin, never on its command line.
#
# For a container, the compose file beside this script (scripts/compose.yaml)
# runs the image the repository's Dockerfile builds, as that image's non-root
# user: the environment never runs as root, in a container or out of one.
#
# The artefact layout does not exist yet: no release publishes one. This
# script looks for a release asset named agent-harness-<os>-<arch>.tar.gz,
# <os> linux or darwin and <arch> x64 or arm64 (Node's names), holding
# bin/agent-harness at its root, and for an optional <asset>.sha256 beside it
# whose first word is the SHA-256 of the tarball. The release build must
# publish exactly that.
#
# Versions are unpacked into <data dir>/versions/<version>, under the
# environment's data directory (XDG state on Linux, Application Support on
# macOS, or --data-dir): the env spec lets nothing but the service definition
# live outside it. ADR 0007 gives the versions directory to the launcher; this
# layout is a stand-in until the launcher (phase B) takes it over. A version
# already unpacked there is reused, not downloaded again; a folder for it that
# holds no binary is replaced.

set -eu

# Temporary files, removed on any exit; INT and TERM exit as a shell killed by them would report.
work=""
partial=""
trap '[ -n "$work" ] && rm -rf "$work"; [ -n "$partial" ] && rm -rf "$partial"; :' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

NAME=agent-harness
FORGE=https://git.systemtech.dev:5526
REPOSITORY=david/agent-harness

usage() {
  cat <<USAGE
Usage: install.sh [--version <tag>] [--prefix <dir>] [--data-dir <dir>] [--port <n>] [--dry-run]

Installs the $NAME environment as a user service on this machine and starts it.

  --version <tag>   the release to install; preset: the latest release
  --prefix <dir>    where versions are unpacked; preset: <data dir>/versions
  --data-dir <dir>  the environment's data directory, passed to \`$NAME service install\`;
                    preset: \$XDG_STATE_HOME/$NAME (Linux) or ~/Library/Application Support/$NAME (macOS)
  --port <n>        the environment's port, passed to \`service install\` and \`service status\`
  --dry-run         resolve the release and print the plan; download and change nothing
                    (INSTALL_DRY_RUN=1 does the same)

Environment:
  AGENT_HARNESS_TOKEN    a Forgejo token with read:repository scope (required: the repository is private)
  INSTALL_READY_TIMEOUT  seconds to wait for the service to be ready before the final status (preset 30)
USAGE
}

usage_error() {
  printf '%s\n\n' "$1" >&2
  usage >&2
  exit 2
}

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

version=""
prefix=""
data_dir=""
port=""
dry_run=${INSTALL_DRY_RUN:-0}

while [ $# -gt 0 ]; do
  case $1 in
    --version | --prefix | --data-dir | --port)
      [ $# -ge 2 ] && [ -n "$2" ] || usage_error "$1 needs a value."
      case $1 in
        --version) version=$2 ;;
        --prefix) prefix=$2 ;;
        --data-dir) data_dir=$2 ;;
        --port) port=$2 ;;
      esac
      shift 2
      ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage_error "Unknown argument $1." ;;
  esac
done

if [ -n "$port" ]; then
  case $port in
    *[!0-9]*) usage_error "--port takes a port number from 1 to 65535; got $port." ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    usage_error "--port takes a port number from 1 to 65535; got $port."
  fi
fi

[ -n "${AGENT_HARNESS_TOKEN:-}" ] ||
  usage_error "Set AGENT_HARNESS_TOKEN to a Forgejo token with read:repository scope: the repository is private."

[ "$(id -u)" != 0 ] ||
  fail "refusing to run as root: the service runs as the user who installs it, and $NAME never runs as root. Run this as that user."

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "no artefact is built for $(uname -s); this script installs on Linux and macOS." ;;
esac
case $(uname -m) in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) fail "no artefact is built for the $(uname -m) architecture; this script installs on x64 and arm64." ;;
esac
asset="$NAME-$os-$arch.tar.gz"

command -v curl >/dev/null 2>&1 || fail "curl is needed to download the release."

# curl with the token read from stdin as a config line, so it never shows in a process listing.
forge_curl() {
  printf 'header = "Authorization: token %s"\n' "$AGENT_HARNESS_TOKEN" | curl -K - -fsSL "$@"
}

api="$FORGE/api/v1/repos/$REPOSITORY/releases"
if [ -n "$version" ]; then release_url="$api/tags/$version"; else release_url="$api/latest"; fi
release=$(forge_curl "$release_url") ||
  fail "could not read the release from $release_url; check AGENT_HARNESS_TOKEN and the version."

# The release JSON, one member per line. Values the script reads (the tag and
# download URLs) hold no commas or braces; a quote inside a string value is
# escaped, so no line from the release notes can match the patterns below.
members=$(printf '%s\n' "$release" | tr ',{}[]' '\n\n\n\n\n')
member() {
  printf '%s\n' "$members" | sed -n "s|^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\"[[:space:]]*\$|\\1|p"
}
tag=$(member tag_name | head -n 1)
[ -n "$tag" ] || fail "the release at $release_url names no tag."
asset_pattern=$(printf '%s' "$asset" | sed 's/\./\\./g')
asset_url=$(member browser_download_url | grep "/$asset_pattern\$" | head -n 1) || true
[ -n "$asset_url" ] || fail "release $tag has no $asset: nothing is built for $os on $arch in it."
checksum_url=$(member browser_download_url | grep "/$asset_pattern\\.sha256\$" | head -n 1) || true

release_version=${tag#v}
# The version names a folder the script replaces, so it must be a plain name.
case $release_version in
  "" | .* | *[!A-Za-z0-9._+-]*) fail "release tag $tag does not name a version this script can unpack." ;;
esac

# The data directory `serve` would choose (the environment's defaultDataDirectory), unless --data-dir names one.
if [ -z "$data_dir" ]; then
  if [ "$os" = darwin ]; then
    environment_dir="$HOME/Library/Application Support/$NAME"
  else
    case ${XDG_STATE_HOME:-} in
      /*) environment_dir="$XDG_STATE_HOME/$NAME" ;;
      *) environment_dir="$HOME/.local/state/$NAME" ;;
    esac
  fi
else
  environment_dir=$data_dir
fi
versions=${prefix:-$environment_dir/versions}
target="$versions/$release_version"
bin="$target/bin/$NAME"

# The service verbs, with the options that were given.
service_install() {
  set -- service install
  [ -z "$data_dir" ] || set -- "$@" --data-dir "$data_dir"
  [ -z "$port" ] || set -- "$@" --port "$port"
  "$bin" "$@"
}
service_status() {
  set -- service status
  [ -z "$data_dir" ] || set -- "$@" --data-dir "$data_dir"
  [ -z "$port" ] || set -- "$@" --port "$port"
  "$bin" "$@"
}

# A value for the printed plan: quoted when a shell would otherwise split it.
plan_word() {
  case $1 in
    *[!A-Za-z0-9_/.:=@%+,-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

if [ "$dry_run" = 1 ]; then
  install_line="$bin service install"
  [ -z "$data_dir" ] || install_line="$install_line --data-dir $(plan_word "$data_dir")"
  [ -z "$port" ] || install_line="$install_line --port $port"
  status_line="$bin service status"
  [ -z "$data_dir" ] || status_line="$status_line --data-dir $(plan_word "$data_dir")"
  [ -z "$port" ] || status_line="$status_line --port $port"
  printf 'Release: %s\n' "$tag"
  printf 'Download: %s\n' "$asset_url"
  printf 'Checksum: %s\n' "${checksum_url:-none published}"
  printf 'Unpack into: %s\n' "$target"
  printf 'Then run:\n  %s\n  %s\n  %s\n' "$install_line" "$bin service start" "$status_line"
  printf 'Dry run: nothing was downloaded or changed.\n'
  exit 0
fi

if [ -x "$bin" ]; then
  printf '%s %s is already unpacked in %s.\n' "$NAME" "$release_version" "$target"
else
  work=$(mktemp -d)
  printf 'Downloading %s %s.\n' "$asset" "$tag"
  forge_curl -o "$work/$asset" "$asset_url" || fail "could not download $asset_url."

  if [ -n "$checksum_url" ]; then
    forge_curl -o "$work/$asset.sha256" "$checksum_url" || fail "could not download $checksum_url."
    expected=$(awk 'NR == 1 { print $1 }' "$work/$asset.sha256")
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$work/$asset" | awk '{ print $1 }')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$work/$asset" | awk '{ print $1 }')
    else
      fail "neither sha256sum nor shasum is here to verify the published checksum."
    fi
    [ "$actual" = "$expected" ] ||
      fail "the checksum of $asset is $actual, not the published $expected; nothing was installed."
    printf 'Checksum verified.\n'
  else
    printf 'No checksum is published for %s; installing it unverified.\n' "$asset"
  fi

  # Unpacked beside the target and moved into place, so a failed unpack never
  # leaves a half version; the EXIT trap removes the partial folder on any failure.
  (umask 077 && mkdir -p "$versions")
  partial=$(mktemp -d "$versions/.$release_version.XXXXXX")
  tar -xzf "$work/$asset" -C "$partial" || fail "could not unpack $asset."
  [ -x "$partial/bin/$NAME" ] || fail "$asset holds no bin/$NAME."
  # A folder for this version without a binary is what an interrupted install left: replace it.
  rm -rf "$target"
  mv "$partial" "$target"
  partial=""
  printf 'Unpacked %s %s into %s.\n' "$NAME" "$release_version" "$target"
fi

service_install
"$bin" service start

# Wait for readiness, then end with the status and its exit code.
timeout=${INSTALL_READY_TIMEOUT:-30}
waited=0
until service_status >/dev/null 2>&1; do
  [ "$waited" -lt "$timeout" ] || break
  sleep 1
  waited=$((waited + 1))
done
service_status
