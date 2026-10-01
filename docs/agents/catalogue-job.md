# Catalogue job

The `catalogue` workflow checks the shipped skills catalogue and readiness
overlay against upstream default branches every Monday at 04:17 UTC, on
changes to either data module or its reader, and by manual dispatch. Forgejo
relays the commit to GitHub; the network check runs there separately from the
unit-test suite. Repositories shared by entries are shallow-cloned once.

The script uses the environment's skill reader, including the root-skill
rule. It reports each entry's expected and found count and names, invalid
members, clone failures, and overlay folders that disappeared. An overlay
entry marked `removedUpstream` must remain absent; a returned folder is also
a failure, so that declaration can be reconsidered.

Run from the workspace root with Node 24 and installed dependencies:

```sh
pnpm exec tsx --conditions=@agent-harness/source packages/environment/scripts/check-catalogue.ts
```

For a local smoke test, pass `--catalogue <json>` and `--overlay <json>`.
Both files use their contracts' schema shapes. A fixture's HTTPS URLs can
be rewritten to local bare repositories through git's `url.<file-url>.insteadOf`;
set `GIT_ALLOW_PROTOCOL=file` to prevent any network access. The script's
tests do this and exercise a layout change between runs. Checkouts are
temporary and removed even after failure. The unit suite never invokes the
script against the shipped upstream URLs.

## Installing the GitHub workflow

Before enabling the Forgejo relay, install the source file
`.forgejo/github-workflows/catalogue.yml` as `.github/workflows/catalogue.yml`
on the `workflows` default branch of `david-systemtech/agent-harness-ci`.
GitHub reads `repository_dispatch` workflows from that branch, rather than
from the commit the relay sends. The existing `GH_CI_TOKEN` and the relay's
secret scan and temporary-ref cleanup serve this job too. Future workflow
changes must update that installed copy as well as this source file.
