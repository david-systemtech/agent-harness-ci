# Hosted CI

Forgejo's `ci` job relays the commit to the hosted repository. The workflow
source is `.forgejo/github-workflows/ci.yml`; install it byte for byte as
`.github/workflows/ci.yml` on the relay repository's `workflows` default branch.
Repository dispatch uses that installed copy, rather than the commit under test.
The catalogue source is `.forgejo/github-workflows/catalogue.yml`, installed
in the same way as `.github/workflows/catalogue.yml`.

The `checks` job runs directly on hosted Ubuntu 24.04 with Node 24 from
`actions/setup-node`, like the six ordinary-user suite shards. No job image
is pulled before checkout: Docker Hub and ECR Public have both refused
anonymous job-container pulls before any step could recover. Setup uses the
[runner's Node cache first](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#check-latest);
if the initial setup fails, the job waits 30 seconds
and retries once. The final attempt must succeed, and the secret scan,
typecheck, lint and schema drift check still fail CI on error. Checkout and
checks share the runner user's ownership, so no `safe.directory` override is
needed. Hosted Ubuntu supplies the native build tools used by the suite too.

The `root-user` and `catalogue` jobs use
`mcr.microsoft.com/devcontainers/javascript-node:24-bookworm` with
`options: --user root`: Microsoft's Node devcontainer image in the
[Microsoft Artifact Registry](https://mcr.microsoft.com/en-us/artifact/mar/devcontainers/javascript-node),
built on Docker's official Node 24 Bookworm image, so it keeps Node 24,
Debian Bookworm, corepack and the native build tools. The tag follows Node
24 updates. The image runs as root by default, but its devcontainer user is
`node`, so the jobs set the container user to root explicitly; the root job
must still run as uid 0.
MCR serves anonymous pulls without a pull or data quota, so no login or
registry secret is required. These jobs used ECR Public's copy of the
official image until 2026-10-13, when ECR Public began refusing the pull
with `toomanyrequests: Data limit exceeded`, its anonymous data-transfer
quota for the hosted runners' shared egress, which a retry within the job
does not clear (#2141, #2186). A container job can still fail at container
initialization if MCR itself is unavailable.

When changing either workflow, read the current installed copy first, retain
unrelated changes and update only its matching workflow on `workflows`.
Read the installed bytes back and compare them with the source. Then record
a hosted run using the installed workflow commit, including the `checks`,
`root-user` and cleanup results, in the pull request's verification evidence.
`test/hosted-ci-workflow.test.ts` covers the image choices, the container-free
checks job and its bounded Node setup retry. For the checks job, verify that
the hosted log has no `Initialize containers`, registry pull or rate-limit
failure, and that the secret scan, typecheck, lint and schema drift check pass.

The release smoke workflows exercise packaged artifacts independently of
the hosted CI runner setup.
