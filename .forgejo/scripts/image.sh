#!/usr/bin/env bash
# The container image's job (launcher-update spec, "The release"; #357), run
# by the `image` jobs on the `build` runner from the checkout's root:
#
#   image.sh build     a pull request's: build the Dockerfile and throw the
#                      image away
#   image.sh publish   a v tag's: build it, push it to the project's registry
#                      tagged with the tag's exact version and nothing else,
#                      and write its reference and digest to the step's
#                      outputs for the release workflow
#
# The image is built from the repository's Dockerfile for linux/amd64 only.
# It reads the job's GITHUB_* variables; publish reads PACKAGES_TOKEN, a
# token with write:package, and gives it to `docker login` on stdin.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
repository=${GITHUB_REPOSITORY,,}
registry=${GITHUB_SERVER_URL#https://}
source_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY"

fail() {
  echo "image: $*" >&2
  exit 1
}

# The release version a tag's ref names (refs/tags/v0.5.0 is 0.5.0): a
# semantic version, the contracts' ReleaseVersion, less the build metadata a
# Docker tag cannot hold (a tag takes letters, digits, _, . and -).
version_of() {
  local ref=$1 n='(0|[1-9][0-9]*)' id='(0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)'
  local version=${ref#refs/tags/v}
  if [ "$ref" != "refs/tags/v$version" ]; then
    fail "$ref is not a v tag of a release version (v0.5.0, v1.0.0-beta.2): nothing is built or pushed"
  elif [[ $version == *+* ]]; then
    fail "the version $version has build metadata, which a Docker tag cannot hold: tag the release without it"
  elif ! [[ $version =~ ^$n\.$n\.$n(-$id(\.$id)*)?$ ]]; then
    fail "${ref#refs/tags/} is not a v tag of a release version (v0.5.0, v1.0.0-beta.2): nothing is built or pushed"
  fi
  echo "$version"
}

# Builds the Dockerfile as $1 for linux/amd64, with the source and revision
# labels and any further labels given, and checks the platform it came out as.
build() {
  local tag=$1
  shift
  local labels=(--label "org.opencontainers.image.source=$source_url" --label "org.opencontainers.image.revision=$GITHUB_SHA")
  local label
  for label in "$@"; do labels+=(--label "$label"); done
  docker build --pull --platform linux/amd64 --provenance=false --sbom=false \
    -f "$root/Dockerfile" -t "$tag" "${labels[@]}" "$root"
  local platform
  platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$tag")
  [ "$platform" = linux/amd64 ] || fail "the image built as $platform, not linux/amd64"
}

case "${1:-}" in
  build)
    # A name without the registry's host, so this image is never pushed there.
    local_tag="$repository:${GITHUB_SHA::12}"
    trap 'docker image rm "$local_tag" >/dev/null 2>&1 || true' EXIT
    build "$local_tag"
    ;;
  publish)
    version=$(version_of "$GITHUB_REF")
    [ -n "${PACKAGES_TOKEN:-}" ] || fail "PACKAGES_TOKEN is empty: publishing needs a token with write:package"
    reference="$registry/$repository:$version"
    push_log=$(mktemp)
    login_tried=false
    trap 'rm -f "$push_log"; [ "$login_tried" = false ] || docker logout "$registry" >/dev/null 2>&1 || true; docker image rm "$reference" >/dev/null 2>&1 || true' EXIT
    build "$reference" "org.opencontainers.image.version=$version"
    login_tried=true
    printf '%s\n' "$PACKAGES_TOKEN" | docker login "$registry" -u "$GITHUB_REPOSITORY_OWNER" --password-stdin
    # This one tag and no other: no latest, main, commit or channel tag.
    docker push "$reference" | tee "$push_log"
    # The registry's digest for what was pushed, from docker's last line:
    # "0.5.0: digest: sha256:<hex> size: <bytes>".
    digest=$(sed -n 's/^.*: digest: \(sha256:[0-9a-f]\{64\}\) size: [0-9]*$/\1/p' "$push_log")
    [ -n "$digest" ] || fail "the push of $reference named no digest, so the release could not pull it by one"
    printf 'reference=%s\ndigest=%s\n' "$reference" "$digest" >> "$GITHUB_OUTPUT"
    ;;
  *)
    fail "usage: image.sh build|publish"
    ;;
esac
