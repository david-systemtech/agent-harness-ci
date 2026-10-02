#!/usr/bin/env bash
# The image's registry fetch. The Dockerfile mounts /pnpm/store as a
# persistent cache, including packages saved before a failed build.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)

# Two nine-minute attempts, with at most 30 seconds to kill each process
# group and one ten-second pause: at most 19m10s, leaving the 30-minute
# image job time to compile and assemble. pnpm's request timeout alone
# did not bound the stalled SDK tarball's download.
for attempt in 1 2; do
  echo "image dependencies: fetch attempt $attempt/2" >&2
  if timeout --kill-after=30s 540s node "$root/scripts/image-sdk-cache.mjs" fetch \
    --frozen-lockfile --store-dir=/pnpm/store \
    --verify-store-integrity=true \
    --network-concurrency=8 \
    --fetch-timeout=120000 --fetch-retries=3 \
    --fetch-retry-factor=2 \
    --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=30000; then
    exit 0
  else
    status=$?
  fi
  echo "image dependencies: fetch attempt $attempt/2 failed (exit $status)" >&2
  if [ "$attempt" = 2 ]; then
    echo "image dependencies: fetch exhausted; completed packages remain cached for the next build" >&2
    exit "$status"
  fi
  sleep 10
done
