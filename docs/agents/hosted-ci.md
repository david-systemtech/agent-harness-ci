# Hosted CI

Forgejo's `ci` job relays the commit to the hosted repository. The workflow
source is `.forgejo/github-workflows/ci.yml`; install it byte for byte as
`.github/workflows/ci.yml` on the relay repository's `workflows` default branch.
Repository dispatch uses that installed copy, rather than the commit under test.
The catalogue source is `.forgejo/github-workflows/catalogue.yml`, installed
in the same way as `.github/workflows/catalogue.yml`.

The `checks` job runs directly on hosted Ubuntu 24.04 with Node 24 from
`actions/setup-node`, like the six ordinary-user suite shards. No job image
is pulled before checkout: both Docker Hub and ECR Public have rate-limited
anonymous job-container pulls before any step could recover. Setup uses the
[runner's Node cache first](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#check-latest);
if the initial setup fails, the job waits 30 seconds
and retries once. The final attempt must succeed, and the secret scan,
typecheck, lint and schema drift check still fail CI on error. Checkout and
checks share the runner user's ownership, so no `safe.directory` override is
needed. Hosted Ubuntu supplies the native build tools used by the suite too.

The `root-user` and `catalogue` jobs use
`public.ecr.aws/docker/library/node:24-bookworm`: Docker's official Node image
in [ECR Public](https://gallery.ecr.aws/docker/library/node), with Node 24
and Debian Bookworm, including the native build tools. The tag follows Node
24 updates, as the Docker Hub tag did. It is the full image, rather than
`slim`, so native dependency installation retains its build tools.
[AWS supports anonymous pulls](https://docs.aws.amazon.com/AmazonECR/latest/public/docker-pull-ecr-image.html).
No Docker Hub login, AWS login or registry secret is required. ECR Public has
its own service quotas; these pulls do not consume Docker Hub's anonymous quota.
The root job must still run as root. These remaining container jobs can still
fail at container initialization if ECR Public refuses the pull.

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
