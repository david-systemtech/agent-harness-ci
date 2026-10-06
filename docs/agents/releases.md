# Cutting a release

Forgejo (`david/agent-harness` at `git.systemtech.dev:5526`) is the development
origin. The snapshot publisher (#1275, PR #1277) publishes a cleaned tree and
version tags to GitHub's public `david-systemtech/agent-harness` repository.
Private history and branches stay on Forgejo. GitHub builds and publishes releases;
branch pushes start no release jobs. No stored release secret is needed: the
workflow uses `GITHUB_TOKEN` with `contents: write` and `packages: write`.

The private tree stores the release workflow at `public/.github-workflows/release.yml`,
outside the root GitHub workflow directory. The snapshot publisher installs it as
`.github/workflows/release.yml` in the public repository, whose push uses a token
with `workflow` scope. Keep the private root free of GitHub workflow files: its CI
relay can push the private tree without a credential change. This publish token
is separate from the workflow's own token used to upload releases and images.

Before the first public release, complete the pre-publication secret audit and
make the GitHub repository public, as decided on #1258. GHCR packages start
private even for a public repository: the owner must make the new
`agent-harness` package public after its first publication. The workflow does
not change repository or package settings. This makes release and image reads
available without an account.

1. Choose a merged main commit with green CI. Follow the snapshot publisher's
   procedure to publish its cleaned tree to the public repository without a tag.
   Verify that snapshot includes the installed release workflow.
2. For a build rehearsal, manually dispatch GitHub's **release** workflow on
   that commit's branch. Dispatch always uses `v0.0.0-ci.<run number>`, even on
   a stable tag, and builds every server artefact, desktop installer and the
   image without publishing or logging in to GHCR. Download the `release-assets`
   workflow artifact (kept seven days), check `release.json` and its SHA-256
   sidecars, and run the desktop and service-install checklists on real machines.
   Its image digest belongs to that local build; it cannot be pulled from GHCR.
3. Tag the chosen private commit on Forgejo and push the tag to `origin`:

   ```sh
   git tag -a v1.2.3 <commit> -m "Release v1.2.3"
   git push origin v1.2.3
   ```

   Use `v1.2.3-beta.1` for a prerelease. The tag must be a semantic version
   without build metadata (`+...`), since the image uses that version as its tag.
   Use the snapshot publisher to publish that ref and version tag to the public
   repository. Its public tag points to the cleaned snapshot, not private history.
4. Wait for the public tag's GitHub **release** workflow to
   finish. Its `prepare` job checks the release is unpublished; the builds then
   run beside `verify` (typecheck, lint, schema export) and `suite`, the whole
   test suite in six shards: the versioned linux/amd64 image, the macOS zip,
   Windows NSIS setup (cross-built with Wine) and Linux Arch package, and their
   smokes. Only once `verify` and every `suite` shard have passed does `image-push`
   push the checked image to `ghcr.io/david-systemtech/agent-harness:<version>`
   and the release job write the three server artefacts, scripts, schema
   export, manifest and sidecars and publish them.
5. Verify the single GitHub release holds every manifest asset and sidecar, plus
   `release.json` and its sidecar. Prerelease tags must show **Pre-release**.
   Confirm the manifest's image reference and digest can be pulled publicly.
   Only after publishing a stable release does the workflow move `latest` to
   its exact image; prereleases leave `latest` alone.

An upload failure leaves at most a draft. Re-run the failed workflow to replace
that draft; a published release is never replaced. Tag a new version to correct
one. If publishing succeeded but moving `latest` failed, repair that alias to
`release.json`'s exact digest rather than rebuilding or replacing the release.
The Forgejo release workflow is retained for manual recovery only: it has no
push trigger. Do not dispatch it during a GitHub release, since it publishes to
Forgejo's own release and registry.

The hosted macOS replacement smoke names each awaited operation while keeping the
combined credential/update request's two-minute deadline. On a timeout it samples
the desktop PID before cleanup and records the window list, desktop stdout/stderr,
and a screenshot. CDP also records the window's visible text and accessible
names, each visible machine card's environment id, kind, phase, blocked reason
and remedy, its notices, and renderer console errors and uncaught exceptions.
An allowlisted snapshot of the window's environment projection records every
environment's id, name, kind, phase, blocked reason and action even when the
machine cards are not mounted. It includes no addresses or credentials.
It captures the window itself through CDP as a separate screenshot. Text is
truncated, form values are excluded, and diagnostic calls have separate
five-second deadlines that never recursively collect another timeout.
The `macos-update-diagnostics` failure artifact contains only
sanitized files: known credentials and credential-bearing text are redacted, and
all recognized screenshot text is masked. Raw logs and screenshots stay in the
private scratch directory and are removed. Unavailable native tools or screenshot
redaction produce explicit error files; cleanup retains the original smoke error.
Use this only on hosted runners, never a person's Mac with unattended OS prompts.

The publisher uses [GitHub's release upload API](https://docs.github.com/en/rest/releases/assets#upload-a-release-asset)
and [GHCR's workflow token authentication](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
[Hosted runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
explain the arm64 `macos-latest` runner and the x64 Ubuntu runners.
