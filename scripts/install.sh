#!/bin/sh
# Installs, starts and pairs the agent-harness environment on a Linux or macOS
# machine, as the user who runs it: one line from the Your machines card, which
# passes this environment's --channel and, when one is given, --name.
#
# It resolves the channel's newest release at run time (--version names one
# instead), downloads the artefact for this platform, checks its SHA-256
# against the digest the release publishes beside it, and unpacks it into the
# data directory's versions directory, the version's sentinel written last.
# Then it runs the version's `service install` and `service start`, waits for
# the environment's health URL to say ready, sets the channel with `update
# settings`, hands its token to the environment with `update credential
# --stdin`, and ends with the link, QR and code of `pair --preset own-client`
# (my own client's grant) on the tailnet address (or the Tailscale warning
# when only loopback is bound) and the shim's path line.
#
# Run again over a running service it downloads and unpacks nothing, since the
# launcher alone writes the versions directory while it runs: the shim's
# `service install` repairs the service definition and the launcher entry, and
# the version changes only when --version asks, through `update apply`, which
# stages it as any update.
#
# The repository is private, so the releases API and the downloads need a read
# token: AGENT_HARNESS_TOKEN, a Forgejo access token with the read:repository
# scope (git.systemtech.dev: Settings > Applications). It goes to curl and to
# `update credential` on stdin, never on a command line, and the script takes
# it out of the environment its commands inherit.
#
# A release publishes agent-harness-<os>-<arch>.tar.gz (Node's names), holding
# the version's bin/agent-harness at its root, and beside it
# <asset>.sha256, whose first word is the SHA-256 of the tarball.

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
# The environment's port when none is given, and the address it answers on for this machine.
DEFAULT_PORT=7433
LOOPBACK=127.0.0.1
# How many of the newest releases the channel is read from, as the environment reads it.
RELEASE_LIST_LIMIT=50
# A release version, SemVer 2.0.0 without the tag's v, as an extended regular expression (the contracts' RELEASE_VERSION_PATTERN).
VERSION_PATTERN='^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)([.](0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?([+][0-9a-zA-Z-]+([.][0-9a-zA-Z-]+)*)?$'

usage() {
  cat <<USAGE
Usage: install.sh [--channel <stable|beta>] [--version <version>] [--name <name>] [--data-dir <dir>] [--port <n>] [--dry-run]

Installs the $NAME environment as a user service on this machine, starts it and
prints a pairing for your client.

  --channel <c>     the release channel the environment follows, stable or beta; preset: stable
  --version <v>     the release to install, such as 0.4.2, instead of the channel's newest;
                    over a running service, the version to update to
  --name <name>     the environment's name, passed to \`service install\`
  --data-dir <dir>  the environment's data directory, passed to every command;
                    preset: \$XDG_STATE_HOME/$NAME (Linux) or ~/Library/Application Support/$NAME (macOS)
  --port <n>        the environment's port, passed to every command; preset: $DEFAULT_PORT
  --dry-run         resolve the release and print the plan; download and change nothing
                    (INSTALL_DRY_RUN=1 does the same)

Environment:
  AGENT_HARNESS_TOKEN    a Forgejo token with read:repository scope (required: the repository is private)
  INSTALL_READY_TIMEOUT  seconds to wait for the environment to say ready (preset 60)
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

channel=stable
version=""
name=""
data_dir=""
port=""
dry_run=${INSTALL_DRY_RUN:-0}

while [ $# -gt 0 ]; do
  case $1 in
    --channel | --version | --name | --data-dir | --port)
      [ $# -ge 2 ] && [ -n "$2" ] || usage_error "$1 needs a value."
      case $1 in
        --channel) channel=$2 ;;
        --version) version=$2 ;;
        --name) name=$2 ;;
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

case $channel in
  stable | beta) ;;
  *) usage_error "--channel takes stable or beta; got $channel." ;;
esac

# A version as `update apply` takes it, without the tag's v; one given with it is read without.
version=${version#v}
if [ -n "$version" ]; then
  case $version in
    *[!0-9A-Za-z.+-]*) usage_error "--version takes a release version, such as 0.4.2; got $version." ;;
  esac
  printf '%s\n' "$version" | grep -Eq "$VERSION_PATTERN" ||
    usage_error "--version takes a release version, such as 0.4.2; got $version."
fi

if [ -n "$port" ]; then
  case $port in
    *[!0-9]*) usage_error "--port takes a port number from 1 to 65535; got $port." ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    usage_error "--port takes a port number from 1 to 65535; got $port."
  fi
fi

ready_timeout=${INSTALL_READY_TIMEOUT:-60}
# A leading zero is refused: shell arithmetic reads 010 as octal and 08 as an error.
case $ready_timeout in
  "" | *[!0-9]* | 0?*) usage_error "INSTALL_READY_TIMEOUT takes a number of seconds; got $ready_timeout." ;;
esac

[ -n "${AGENT_HARNESS_TOKEN:-}" ] ||
  usage_error "Set AGENT_HARNESS_TOKEN to a Forgejo token with read:repository scope: the repository is private."
# The token reaches curl and `update credential` on stdin only, never a command's environment.
token=$AGENT_HARNESS_TOKEN
unset AGENT_HARNESS_TOKEN

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
versions="$environment_dir/versions"
shim_dir="$environment_dir/bin"
environment_url="http://$LOOPBACK:${port:-$DEFAULT_PORT}"

# curl to the forge, with the token read from stdin as a config line, so it never shows in a process listing.
forge_curl() {
  printf 'header = "Authorization: token %s"\n' "$token" | curl -K - -fsSL "$@"
}

# The release JSON, one member per line. The values read here (tags, download
# URLs, booleans) hold no commas or braces, and a quote inside a string value is
# escaped, so no line from the release notes matches the patterns below.
members_of() {
  printf '%s\n' "$1" | tr ',{}[]' '\n\n\n\n\n'
}

# The newest release in the listed members that is not a draft and whose tag is
# v and a release version, by SemVer precedence, as the environment reads the
# channel: stable takes the newest without a prerelease part, beta (or any) the
# newest of all. Of two equal in precedence the first listed wins. Prints its
# tag, or nothing. The C locale makes awk compare identifiers byte by byte, the
# ASCII order SemVer asks for, where a POSIX awk would otherwise collate.
newest_tag() {
  LC_ALL=C awk -v channel="$1" -v pattern="$VERSION_PATTERN" '
    function numbers(a, b) {
      if (length(a) != length(b)) return length(a) < length(b) ? -1 : 1
      return (a "") < (b "") ? -1 : ((a "") > (b "") ? 1 : 0)
    }
    function identifiers(a, b,   an, bn) {
      an = a ~ /^[0-9]+$/
      bn = b ~ /^[0-9]+$/
      if (an && bn) return numbers(a, b)
      if (an != bn) return an ? -1 : 1
      return (a "") < (b "") ? -1 : ((a "") > (b "") ? 1 : 0)
    }
    function precedence(a, b,   ac, bc, ap, bp, x, y, n, m, i, order) {
      sub(/[+].*/, "", a); sub(/[+].*/, "", b)
      ac = a; ap = ""; if ((i = index(a, "-")) > 0) { ac = substr(a, 1, i - 1); ap = substr(a, i + 1) }
      bc = b; bp = ""; if ((i = index(b, "-")) > 0) { bc = substr(b, 1, i - 1); bp = substr(b, i + 1) }
      split(ac, x, "."); split(bc, y, ".")
      for (i = 1; i <= 3; i++) if ((order = numbers(x[i], y[i])) != 0) return order
      if (ap == "" || bp == "") return (ap == "") - (bp == "")
      n = split(ap, x, "."); m = split(bp, y, ".")
      for (i = 1; i <= n && i <= m; i++) if ((order = identifiers(x[i], y[i])) != 0) return order
      return n - m
    }
    function settle(   v, core) {
      if (tag == "" || draft) return
      v = substr(tag, 2)
      if (tag !~ /^v/ || v !~ pattern) return
      core = v; sub(/[+].*/, "", core)
      if (channel == "stable" && index(core, "-") > 0) return
      if (best == "" || precedence(v, best) > 0) { best = v; best_tag = tag }
    }
    /^[ \t]*"tag_name"[ \t]*:/ {
      settle()
      tag = $0
      if (!sub(/^[ \t]*"tag_name"[ \t]*:[ \t]*"/, "", tag) || !sub(/"[ \t]*$/, "", tag) || tag ~ /["\\]/) tag = ""
      draft = 0
      next
    }
    /^[ \t]*"draft"[ \t]*:[ \t]*true[ \t]*$/ { draft = 1 }
    END { settle(); if (best_tag != "") print best_tag }
  '
}

# The release's download URL of the asset named $2 under the tag $1, if it publishes one.
download_url() {
  awk -v want="/releases/download/$1/$2" '
    /^[ \t]*"browser_download_url"[ \t]*:/ {
      url = $0
      sub(/^[ \t]*"browser_download_url"[ \t]*:[ \t]*"/, "", url)
      sub(/"[ \t]*$/, "", url)
      if (length(url) >= length(want) && substr(url, length(url) - length(want) + 1) == want) { print url; exit }
    }
  '
}

# A word of the printed plan: quoted when a shell would otherwise split it.
plan_word() {
  case $1 in
    *[!A-Za-z0-9_/.:=@%+,-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Runs a command; in a dry run, prints it as a line of the plan instead.
step() {
  if [ "$dry_run" = 1 ]; then
    printf ' '
    for word in "$@"; do printf ' %s' "$(plan_word "$word")"; done
    printf '\n'
  else
    "$@"
  fi
}

# Runs the CLI at $cli with the options every verb takes after the verb's own.
cli_verb() {
  [ -z "$data_dir" ] || set -- "$@" --data-dir "$data_dir"
  [ -z "$port" ] || set -- "$@" --port "$port"
  step "$cli" "$@"
}

# Waits up to $ready_timeout seconds for the health URL to say ready; else fails, naming the service's log.
wait_until_ready() {
  health="$environment_url/health"
  if [ "$dry_run" = 1 ]; then
    printf '  wait up to %s seconds for %s to say ready\n' "$ready_timeout" "$health"
    return 0
  fi
  printf 'Waiting up to %s seconds for %s to say ready.\n' "$ready_timeout" "$health"
  deadline=$(($(date +%s) + ready_timeout))
  while :; do
    answer=$(curl -fsS --max-time 5 "$health" 2>/dev/null) || answer=""
    if printf '%s' "$answer" | grep -q '"status"[[:space:]]*:[[:space:]]*"ready"'; then
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] ||
      fail "the environment did not say ready at $health within $ready_timeout seconds; its log is $environment_dir/logs/service.log."
    sleep 1
  done
}

# `text` inside a double-quoted shell word, where a backslash, a quote, $ and a backquote would otherwise act.
double_quoted() {
  printf '%s' "$1" | sed 's/[\\"$`]/\\&/g'
}

# Finds the release to install, the channel's newest or the one --version names,
# and sets tag, release_version and the download URLs of the artefact and its digest.
resolve_release() {
  api="$FORGE/api/v1/repos/$REPOSITORY/releases"
  if [ -n "$version" ]; then
    # Read by its tag, as the environment reads a pin; a draft there is none.
    release_url="$api/tags/v$version"
    release=$(forge_curl "$release_url") ||
      fail "could not read release v$version from $release_url: no such release is published, or AGENT_HARNESS_TOKEN cannot read it."
    members=$(members_of "$release")
    tag=$(printf '%s\n' "$members" | newest_tag any)
    [ "$tag" = "v$version" ] || fail "release v$version is a draft, not published; nothing was installed."
  else
    listing="$api?limit=$RELEASE_LIST_LIMIT"
    listed=$(forge_curl "$listing") ||
      fail "could not read the releases from $listing; check AGENT_HARNESS_TOKEN."
    members=$(members_of "$listed")
    tag=$(printf '%s\n' "$members" | newest_tag "$channel")
    [ -n "$tag" ] || fail "no release is published on the $channel channel."
  fi
  release_version=${tag#v}
  asset_url=$(printf '%s\n' "$members" | download_url "$tag" "$asset")
  [ -n "$asset_url" ] || fail "release $tag has no $asset: nothing is built for $os on $arch in it."
  checksum_url=$(printf '%s\n' "$members" | download_url "$tag" "$asset.sha256")
  [ -n "$checksum_url" ] ||
    fail "release $tag publishes no digest for $asset ($asset.sha256), so it cannot be verified; nothing was installed."
}

# Downloads the release's artefact, checks its SHA-256 against the published
# digest and unpacks it into the versions directory, its sentinel written last;
# a complete version already there is reused. Sets bin, the version's CLI.
unpack_release() {
  target="$versions/$release_version"
  bin="$target/bin/$NAME"
  if [ "$dry_run" = 1 ]; then
    printf 'Release: %s\nDownload: %s\nDigest: %s\nUnpack into: %s\n' "$tag" "$asset_url" "$checksum_url" "$target"
    return 0
  fi
  if [ -f "$target/.complete" ]; then
    printf '%s %s is already unpacked in %s.\n' "$NAME" "$release_version" "$target"
    return 0
  fi
  work=$(mktemp -d)
  printf 'Downloading %s %s.\n' "$asset" "$tag"
  forge_curl -o "$work/$asset" "$asset_url" || fail "could not download $asset_url."
  forge_curl -o "$work/$asset.sha256" "$checksum_url" || fail "could not download $checksum_url."
  expected=$(awk 'NR == 1 { print $1 }' "$work/$asset.sha256")
  case $expected in
    "" | *[!0-9a-f]*) fail "$checksum_url holds no SHA-256 for $asset; nothing was installed." ;;
  esac
  [ ${#expected} = 64 ] || fail "$checksum_url holds no SHA-256 for $asset; nothing was installed."
  if command -v sha256sum >/dev/null 2>&1; then
    actual=$(sha256sum "$work/$asset" | awk '{ print $1 }')
  elif command -v shasum >/dev/null 2>&1; then
    actual=$(shasum -a 256 "$work/$asset" | awk '{ print $1 }')
  else
    fail "neither sha256sum nor shasum is here to verify the published digest."
  fi
  [ "$actual" = "$expected" ] ||
    fail "the SHA-256 of $asset is $actual, not the published $expected; nothing was installed."
  printf 'Verified the SHA-256 of %s.\n' "$asset"

  # Unpacked beside the target and moved into place, so a failed unpack never
  # leaves a half version; the EXIT trap removes the partial folder on any failure.
  (umask 077 && mkdir -p "$versions")
  partial=$(mktemp -d "$versions/.$release_version.XXXXXX")
  tar -xzf "$work/$asset" -C "$partial" || fail "could not unpack $asset."
  [ -x "$partial/bin/$NAME" ] || fail "$asset holds no bin/$NAME."
  # A folder for this version without the sentinel is what an interrupted install left: replace it.
  rm -rf "$target"
  mv "$partial" "$target"
  partial=""
  # The sentinel, written last: only now is the folder a version.
  : >"$target/.complete"
  printf 'Unpacked %s %s into %s.\n' "$NAME" "$release_version" "$target"
}

# Whether the service runs, as its own `service status` says. Only a service
# installed with the launcher has the shim, which runs its active version.
shim="$shim_dir/$NAME"
running=0
if [ -x "$shim" ]; then
  cli=$shim
  # A read, so a dry run runs it too.
  status=$(dry_run=0; cli_verb service status --json 2>/dev/null) || :
  if printf '%s\n' "$status" | grep -q '"running"[[:space:]]*:[[:space:]]*true'; then running=1; fi
fi

if [ "$running" = 1 ]; then
  # While the launcher runs it alone writes the versions directory: a new version comes through `update apply`.
  printf 'The %s service is running, so nothing is downloaded or unpacked.\n' "$NAME"
else
  resolve_release
  unpack_release
  cli=$bin
fi
[ "$dry_run" = 0 ] || printf 'Then:\n'

if [ -n "$name" ]; then cli_verb service install --name "$name"; else cli_verb service install; fi
[ "$running" = 1 ] || step "$cli" service start
wait_until_ready
cli_verb update settings --channel "$channel"
printf '%s\n' "$token" | cli_verb update credential --stdin
if [ "$running" = 1 ] && [ -n "$version" ]; then cli_verb update apply --version "$version"; fi

if [ "$dry_run" = 1 ]; then
  # pair's own plan line, the options it would take included.
  printf '%s, or the Tailscale warning when only loopback is bound\nDry run: nothing was downloaded or changed.\n' "$(cli_verb pair --preset own-client)"
  exit 0
fi

# A pairing on the tailnet address, which `pair` builds its link on; with only loopback bound no other machine could use one.
discovery=$(curl -fsS --max-time 5 "$environment_url/.well-known/$NAME/environment" 2>/dev/null) || discovery=""
if printf '%s' "$discovery" | grep -q '"authPolicy"[[:space:]]*:[[:space:]]*"tailnet"'; then
  # My own client's grant (ADR 0025): every scope and the top ceiling, since every client paired is the same person.
  cli_verb pair --preset own-client
else
  printf '\nNo Tailscale address found. This machine is reachable only from itself. Install Tailscale to reach it from your other devices.\n\n'
fi

printf "The shim %s runs the active version. To put it on your PATH, add this line to your shell's profile:\n" "$shim"
printf '  export PATH="%s:$PATH"\n' "$(double_quoted "$shim_dir")"
