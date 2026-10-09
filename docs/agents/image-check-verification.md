# Live image check verification

Ticket #2010 verified the image selector and workflow landed in #2003
(merge `bb1a09017c473db26ee82ba1dea977233cc12b84`). Temporary PR #2012 ran
all three phases below and was closed without merging on 2026-10-09.

| Complete PR diff | Head | API run (display run) | Job | Job duration | `image / image` |
| --- | --- | --- | --- | --- | --- |
| Docs only | `02fd487e6454d65e921357ce83ca3dfbd4fcc888` | 13928 (12275) | 18936 | 30 seconds | success, skipped build |
| Docs and Dockerfile comment | `aee47af8ef8144affd10de7f979f8c50a799cc71` | 13934 (12281) | 18943 | 3 minutes 42 seconds | success, full build |
| Dockerfile comment reverted | `180836e08124e12ac15ebc288d742579c40835f2` | 13942 (12286) | 18954 | 26 seconds | success, skipped build |

Both skip jobs checked out the exact head, logged
`no image input changed: build skipped`, and completed without running the
image build step. These durations measure the jobs, excluding queue time.

The middle job logged `image input changed: build required`, built and
exported the image, and logged `Image web routes and version matched.`
Its successful [build script](../../.forgejo/scripts/image.sh) also required
`linux/amd64` and the exact CLI version `agent-harness 0.0.0` before running
the [web smoke](../../scripts/image-web-smoke.mjs). The smoke starts an
ordinary-user environment and checks the packaged pages, script assets,
health route and agreement between the client and environment versions.

After reverting the comment, the complete merge-base diff contained only
this documentation file; Dockerfile matched the base despite the earlier
image-input commit remaining in history. The third job therefore proves the
selector uses the current complete diff rather than any earlier push's files.

The `image` override label was absent throughout. Adding `bot-1` to the PR
produced a separate skipped `image / other-label` status while preserving the
canonical `image / image` success on the first head.

No production code or release workflow changed. Releases and main's release
smoke continue to build images unconditionally. This live experiment
complements the real-Git fixtures in
[test/image-inputs.test.ts](../../test/image-inputs.test.ts) and the workflow
and build-script tests in [test/image-script.test.ts](../../test/image-script.test.ts).
See the [contributor rule](gallery.md#pull-request-checks) for input selection.
