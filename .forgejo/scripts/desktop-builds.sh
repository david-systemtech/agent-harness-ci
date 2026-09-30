#!/usr/bin/env bash
# The desktop builds' hand-over (#359), run by the release workflow's jobs
# from the checkout's root. Each desktop job builds its platform's desktop on
# a runner of its own; the release job, which lists and publishes every
# asset, takes the three from this Forgejo's generic package registry, as
# david/ci's macos template hands a Mac build on:
#
#   desktop-builds.sh put <file>                a desktop job's: put <file> in
#                                               the tag's package, replacing
#                                               one an earlier run left
#   desktop-builds.sh get <folder> <name>...    the release job's: download
#                                               each named build into <folder>
#   desktop-builds.sh remove                    the release job's, once the
#                                               release is published: delete
#                                               the tag's package
#
# The package is <owner>/generic/agent-harness-desktop/<version>, the tag's
# version. The script reads the job's GITHUB_SERVER_URL, GITHUB_REPOSITORY
# and TAG, and PACKAGES_TOKEN, a token with write:package, which it hands
# curl on stdin rather than on its command line. It runs on the Mac's own
# bash too, so it keeps to bash 3.2.
set -euo pipefail

fail() {
  echo "desktop-builds: $*" >&2
  exit 1
}

[ -n "${PACKAGES_TOKEN:-}" ] || fail "PACKAGES_TOKEN is empty: the hand-over needs a token with write:package"
tag=${TAG:-}
version=${tag#v}
[ -n "$version" ] && [ "v$version" = "$tag" ] || fail "\"$tag\" is not a v tag: the hand-over keeps a release's desktop builds under its version"
package="agent-harness-desktop $version"
base="${GITHUB_SERVER_URL%/}/api/packages/${GITHUB_REPOSITORY%%/*}/generic/agent-harness-desktop/$version"

# curl with the token's header read from its configuration on stdin, the
# response's status on stdout.
request() {
  printf 'header = "Authorization: token %s"\n' "$PACKAGES_TOKEN" | curl -sS --config - -w '%{http_code}' "$@"
}

case "${1:-}" in
  put)
    [ $# -eq 2 ] || fail "usage: desktop-builds.sh put <file>"
    file=$2
    [ -f "$file" ] || fail "$file does not exist: its desktop job built nothing to hand over"
    name=$(basename "$file")
    # A file in a package cannot be overwritten, so a re-run of the tag
    # deletes the one an earlier run put there (a 404 when there is none).
    request -o /dev/null -X DELETE "$base/$name" >/dev/null
    code=$(request -o /dev/null -X PUT --upload-file "$file" "$base/$name")
    [ "$code" = 201 ] || fail "$name was not put in the package $package ($code)"
    echo "put $name in the package $package"
    ;;
  get)
    [ $# -ge 3 ] || fail "usage: desktop-builds.sh get <folder> <name>..."
    folder=$2
    shift 2
    mkdir -p "$folder"
    for name in "$@"; do
      code=$(request -o "$folder/$name" "$base/$name")
      if [ "$code" != 200 ]; then
        rm -f "$folder/$name"
        fail "$name is not in the package $package ($code): its desktop job handed nothing over"
      fi
      echo "got $name from the package $package"
    done
    ;;
  remove)
    # The release is published by now, so a package left behind is only
    # storage: said, and the job still passes.
    code=$(request -o /dev/null -X DELETE "$base")
    case $code in
      204) echo "removed the package $package" ;;
      *) echo "::warning::The package $package was not removed ($code): delete it under the owner's packages." ;;
    esac
    ;;
  *)
    fail "usage: desktop-builds.sh put <file> | get <folder> <name>... | remove"
    ;;
esac
