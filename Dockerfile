# The agent-harness environment as a container image (permissions spec,
# "Never root"; ADR 0006, ADR 0007; #141). From a checkout:
#
#   docker build -t agent-harness .
#   AGENT_HARNESS_IMAGE=agent-harness docker compose -f scripts/compose.yaml up -d
#
# `agent-harness serve` refuses root, in a container as anywhere else, so the
# image runs it as its own user, `agent-harness` (uid and gid 10001), which
# owns /data (the data directory) and /work (the repositories runs work in)
# and has a home of its own. The install script's compose file
# (scripts/compose.yaml) runs the same user on named volumes, which Docker
# creates owned by it. Nothing here sets IS_SANDBOX or CLAUDE_CODE_BUBBLEWRAP:
# nothing runs as root, so Claude's root check never applies, and the Claude
# adapter strips both from the provider's environment anyway.
#
# A release publishes this image: on a `v` tag the release workflow
# (.forgejo/workflows/release.yml, #357) builds it for linux/amd64 only and
# pushes it to the project's registry as
# git.systemtech.dev:5526/david/agent-harness:<version>, that exact version
# and no other tag, and a pull request's build (image.yml) is thrown away.
# The compose file's default image is the release's, which the release
# workflow writes in (#358), so a checkout's build is named with
# AGENT_HARNESS_IMAGE.

FROM node:24-bookworm AS build
ENV CI=true
RUN corepack enable
WORKDIR /opt/agent-harness
COPY . .
# Checkout builds stay at 0.0.0; release jobs supply their prepared version.
ARG HARNESS_VERSION=0.0.0
# Completed downloads survive failed builds and later checkouts on this
# builder. Keep fetching and installing in one cache-mounted instruction:
# if the cache is evicted, the next build fetches it again before going
# offline. The bounded fetch leaves time for compilation in the image job.
# A job may supply the SDK archive after checking the lockfile integrity.
# The public build has no archive and fetches the same pin from npm instead.
# node-pty compiles with this image's python3, make and g++.
RUN --mount=type=cache,id=agent-harness-pnpm-linux-amd64,target=/pnpm/store,sharing=shared \
  bash scripts/image-deps.sh \
  && pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store \
  && pnpm exec tsc -b packages/cli \
  && pnpm --filter @agent-harness/contracts build-validator \
  && HARNESS_VERSION="$HARNESS_VERSION" pnpm --filter @agent-harness/gui build \
  && node scripts/stage-web-client.mjs \
  && pnpm install --frozen-lockfile --offline --store-dir=/pnpm/store --prod --config.confirmModulesPurge=false \
  && node scripts/image-version.mjs "$HARNESS_VERSION" \
  && node scripts/image-sdk-cache.mjs check \
  && rm -rf .image-sdk-cache

FROM node:24-bookworm-slim
# git for the workspace and the provider's runs; bubblewrap and socat so a
# workspace containment level can be enforced where the container's seccomp
# profile allows user namespaces (Docker's default does not, and then only
# `off` is offered; permissions spec, "Containment"); openssh-client so the
# skill probe clones an ssh or scp URL no forge account covers over ssh as
# written, as on every other install (#874; skills spec, "Further Notes"). The
# user's keys are not in the image: mounted into its home they authenticate,
# and without them ssh's refusal is answered as `authentication`, not the
# shell's `ssh: not found`.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git bubblewrap socat openssh-client \
  && rm -rf /var/lib/apt/lists/*
# The non-root user, and the mount points of the two volumes given to it
# before they are declared, so a named volume starts with its owner.
RUN groupadd --gid 10001 agent-harness \
  && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/agent-harness --shell /bin/bash agent-harness \
  && mkdir -p /data /work \
  && chown agent-harness:agent-harness /data /work
COPY --from=build /opt/agent-harness /opt/agent-harness
RUN printf '#!/bin/sh\nexec node /opt/agent-harness/packages/cli/dist/main.js "$@"\n' > /usr/local/bin/agent-harness \
  && chmod 0755 /usr/local/bin/agent-harness
USER agent-harness
WORKDIR /work
VOLUME ["/data", "/work"]
# The environment's port (DEFAULT_PORT). It binds loopback and the tailnet
# address, never the wildcard address, so the compose file shares the Linux
# host's network rather than publishing this. The detector reads tailscale0
# without a tailscale CLI or daemon socket; host setup is in compose.yaml.
EXPOSE 7433
ENTRYPOINT ["agent-harness"]
CMD ["serve", "--data-dir", "/data"]
