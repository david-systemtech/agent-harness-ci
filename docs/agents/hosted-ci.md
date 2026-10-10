# Hosted CI

Forgejo's `ci` job relays the commit to the hosted repository. The workflow
source is `.forgejo/github-workflows/ci.yml`; install it byte for byte as
`.github/workflows/ci.yml` on the relay repository's `workflows` default branch.
Repository dispatch uses that installed copy, rather than the commit under test.
The catalogue source is `.forgejo/github-workflows/catalogue.yml`, installed
in the same way as `.github/workflows/catalogue.yml`.

The `checks`, `root-user` and `catalogue` jobs use
`public.ecr.aws/docker/library/node:24-bookworm`: Docker's official Node image
in [ECR Public](https://gallery.ecr.aws/docker/library/node), with Node 24
and Debian Bookworm, including the native build tools. The tag follows Node
24 updates, as the Docker Hub tag did. It is the full image, rather than
`slim`, so native dependency installation retains its build tools.
[AWS supports anonymous pulls](https://docs.aws.amazon.com/AmazonECR/latest/public/docker-pull-ecr-image.html).
No Docker Hub login, AWS login or registry secret is required. ECR Public has
its own service quotas; these pulls do not consume Docker Hub's anonymous quota.
The six ordinary-user suite shards continue to use hosted Ubuntu and
`actions/setup-node` with Node 24. The root job must still run as root, and
container initialization failure still fails CI.

When changing either workflow, read the current installed copy first, retain
unrelated changes and update only its matching workflow on `workflows`.
Read the installed bytes back and compare them with the source. Then record
a hosted run using the installed workflow commit, including the `checks`,
`root-user` and cleanup results, in the pull request's verification evidence.
`test/hosted-ci-workflow.test.ts` covers the container image choices.

These are CI job containers. The release image and packaged application are
unchanged; the release smoke workflows continue to exercise those artifacts.
