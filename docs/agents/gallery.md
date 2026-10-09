# Accepting window gallery captures

Every pull request gets a `gallery / gallery` result. The trusted relay compares
the entire PR head to its merge base against main, including earlier commits.
Changes under `packages/gui/` (scenes, baselines and bundled fonts included),
`packages/theme/`, `packages/client-runtime/`, `packages/contracts/` or
`packages/browser/` render,
as do gallery scripts and workflows, the root dependency manifests/lockfile and
`tsconfig.base.json`. The path rule lives in `.forgejo/scripts/gallery-needed.py`.
Other changes succeed with `no GUI change: gallery skipped`, without dispatching
a hosted render or posting a screenshot comment. Add the `gallery` label to
force a render; adding or removing that label reevaluates the decision.

Events for the same PR head queue in Forgejo instead of cancelling one another.
Forgejo publishes cancellation statuses outside the relay script; cancelling an
older run could otherwise overwrite a replacement's success on the same head.
Each new head has its own queue and hosted capture group, so queued work for an
older head cannot cancel a newer head's captures. Label changes can wait for the
active gallery to finish before their result appears.

The hosted gallery workflow remains unchanged and installed byte for byte on
the relay repository. The decision happens before dispatch. A PR changing this
rule must render because gallery machinery is an input; `pull_request_target`
uses the trusted base's rule, so live skip verification needs a non-GUI PR after
the rule lands. Then verify a GUI change (including one in an earlier commit)
still renders and posts screenshots, and the label forces a non-GUI render.

Use this recipe when a deliberate GUI change produces reviewed pixel differences in a pull request.

## Pull request checks

The gallery check selects GUI and gallery-tooling changes in
`.forgejo/workflows/gallery.yml`. Review its captures using the recipe below.

The `image / image` check compares the complete PR head with its merge base
against `main`, including earlier commits in the PR. It builds for changes to
CLI/environment workspace dependencies, the GUI bundle staged into the image,
container/build scripts, compose and release inputs, root build configuration
or workspace manifests and lockfiles. The dependency set is read from the
workspace manifests so a new workspace dependency is included automatically.
Non-GUI tests, PNG gallery captures, desktop source and docs skip the build;
the job still succeeds with `no image input changed: build skipped`.
GUI source, web assets and wizard copy currently enter the image through the
Dockerfile's GUI build and staging step, so they require an image build.
GUI tests and gallery text require a build too: Tailwind scans those files
for utility classes that can change the staged production CSS. PNG captures are
binary and do not contribute utility classes.

Add the PR label `image` to force a build, including on a head whose check
already skipped. Other labels neither launch nor cancel an image build.
Releases, manual release builds and main's release smoke still build the image
unconditionally. A PR changing the image workflow or selector itself builds
the image too; its skip path is covered by the selector's fixture tests.

## Accept captures

1. Work in the pull request's worktree with its current head checked out. Wait for every hosted gallery shard comment for that head. Review every baseline/capture/difference triplet and any new scene image; confirm the captures show the intended change.
2. Resolve every geometry failure in the layout or measurement expectations. Baseline acceptance changes pixel comparisons; geometry checks continue to block immediately.
3. Run `bash scripts/gallery-accept.sh <pr-number>`. It downloads the current head's captures into `packages/gui/gallery/baselines/`, validates the downloads before writing, and refuses a different working-tree head. It prints each accepted filename and the exact staging, commit and branch push commands.
   To accept a reviewed subset, append exact capture filenames, for example `bash scripts/gallery-accept.sh <pr-number> settings-browser.light.png settings-browser-narrow.light.png`. Only those images are downloaded, written and included in the printed staging command; unrelated baselines remain untouched. Name each reviewed ladder and viewport explicitly. A missing filename refuses the whole acceptance.
4. Review the baseline changes, then run the printed commands. They commit the accepted images and push them to the pull request's branch.
5. Wait for the new head's gallery check. Acceptance is complete when the committed captures match and the check is green. Review any remaining differences before accepting again.

Captures run on hosted CI. Local acceptance downloads existing captures and launches no browser. If the script reports no captures for the current head, wait for its gallery run and comment before retrying.

The capture serves the built gallery at one fixed origin, `http://127.0.0.1:5180` (`packages/gui/gallery/serve.ts`), never a free port: a scene that shows the page's own origin captures the same pixels on every run (#1763). If that port is taken the capture fails rather than moving.

The shell wave has landed: missing baselines, pixel differences beyond the 0.05% budget (pixelmatch threshold 0.1), and geometry failures block. Every discovered desktop scene has dark captures at 1400 × 900 and 1024 × 768; the light subset follows `look.md §16`. The scenes `LAPTOP_SCENES` names in `gallery/capture-plan.ts` (the sign-in dialog, #1690; the session window, #1790; the status line beside a docked side pane, #1892) are also mounted at 1280 × 800 and 1280 × 700 with their wide dark capture, and their geometry measured there without a screenshot, so a dialog's header and footer are checked inside a short laptop window while the published captures keep their two sizes; a failure there names the window. Scene names reserve the generated `-narrow` suffix.

A scene may export a fixed geometry array or a function receiving `{ width, height }` from the capture viewport. The mount resolves that function before marking the scene ready. Keep control dimensions fixed and compute available column widths from the frame contract. A `minimumHeight` check is available for content that grows beyond its viewport floor; exact `height` checks still apply where the scene fixes its height.

The hosted workflow and both relay publishers allow at most 1200 PNGs, 48 MiB of expanded payload (including report JSON), and a 64 MiB ZIP. The report publisher allows up to 400 capture rows: the required dark/light ladder cases at two widths, each with a capture/baseline/difference triplet. Its entry bound is 1202: the PNG bound plus `report.json` and `geometry.json`. Capture filenames must be flat scene names ending in `.light.png` or `.dark.png`; reports may additionally contain their baseline and difference PNGs. Duplicate names, unexpected entries and invalid PNG signatures are refused before a comment is created. Baseline acceptance allows the same 400 captures and 48 MiB per report; retention protects valid manifests with up to 400 captures, including reviewed versions from earlier heads of an open PR.

A capture-only artifact from an earlier hosted run can be recovered without rebuilding its commit. Download that run's `window-gallery` ZIP, then use the trusted checkout's `bash .forgejo/scripts/gallery-comment.sh <archive.zip> <full-head-sha>` with `FORGEJO_URL`, `FORGEJO_REPOSITORY`, `FORGEJO_PR` and `FORGEJO_TOKEN` set. It validates the complete archive before uploading, and posts only while the destination PR is open and still has that head. Inspect an old artifact locally when the PR's head has moved.


Capture readiness includes a fresh placement of the focused dialog's tooltip after layout stabilizes. A stationary popper rectangle can retain a cached initial position; fonts being ready and several identical frames do not prove placement is current. The capture gate requests the update through the dialog and the scroll-locked body, then waits for stable placement again. A dialog surface with visible overflow has no overflow-ancestor listener of its own; the body receives the update for both the trigger and its tooltip portal, including after a sign-in ending replaces the waiting content. Keep these notifications off the window: a window-wide resize dismisses open Select menus.

The #1537 hosted probe (run 37178192474, PR #1538) repeated restore captures eight times for each viewport and ladder. The old gate accepted eight stale positions out of 32, reproducing the reported 536/542-pixel differences. The narrow tooltip stayed at (661, 405) instead of (662, 406), and the wide tooltip at (849, 471) instead of (850, 472). Focus, reference rectangles, tooltip dimensions and animation state were unchanged. Allowing screenshot animations produced the same failures; refreshing placement corrected all 32 captures to zero differences. The full hosted gallery also matched all 342 scenes without changing baselines or budgets.

## Retries, failures and retention

Each completed report stores immutable capture bytes in the `window-gallery` generic package under version `<head>-<comment-id>`. Repeating a hosted run on the same head creates another report version, so a retry cannot replace bytes in an earlier review. The comment manifest records the version, exact package download URL and SHA-256 of each capture. Acceptance selects the latest reported shard group (or legacy single report) for the current head and verifies its hashes before writing any baseline. Existing head-only manifests remain downloadable for compatibility.

The trusted Unix publisher bounds each complete API request (including response reads and reused-package verification) to 60 seconds. The report-set budget scales with the validated workload: one second per attachment, capture-storage request, possible reused-package verification and comment write, with a ten-minute minimum. The relay bounds the complete job to 55 minutes. Socket activity does not extend either deadline. A termination signal also finalizes an active report as interrupted. If comment creation committed but its response was lost, a unique attempt marker recovers the matching relay-authored comment from the bounded thread before finalizing it. Recovery and failure finalization each get a fresh 60-second request budget.

Attachment or package upload failures finalize the comment with the failed stage, HTTP status when available, and instructions to rerun the gallery job or check write permissions. A failed report carries no acceptance manifest. If tracker connectivity also prevents finalizing the comment, the relay log explicitly reports that failure.

Capture versions expire 30 days after their package creation time, except every version referenced by a relay-authored gallery manifest in an open pull request and every version belonging to an open pull request's current head. This includes earlier reviewed heads and the head-only versions created before per-report versioning. Unfinished uploads that no longer belong to an open PR's current head receive the same 30-day grace period. The `window-gallery` package is reserved for this repository's gallery captures; other package names and types are untouched. Closing a PR releases its captures for cleanup once their creation time is past the retention period.

Cleanup runs daily in the `gallery-retention` workflow and can be dispatched manually. It runs separately from gallery publication so a repository-wide inventory scan cannot invalidate clean reports or consume their relay deadline. It reads every page of open PRs and package versions, and each complete comment thread, before deleting anything; unreadable or invalid API listings stop cleanup. Acceptance and cleanup only use reports authored by Forgejo’s reserved Actions identity. A modern version must match the head and the containing comment’s own ID; older head-only reports from that identity remain supported. Copied markers in ordinary discussion and malformed examples are ignored. A concurrent cleanup's already-deleted version is harmless. Cleanup errors leave completed reports usable and fail the retention job; rerun the retention workflow after restoring API access. Authenticated manual cleanup uses `FORGEJO_URL`, `FORGEJO_REPOSITORY` and `FORGEJO_TOKEN` with `python3 scripts/gallery-retention.py`.

The workflows use the repository job token for PRs and comments and the existing `PACKAGES_TOKEN` secret (with package read/write access) for owner-scoped capture storage, inventory and deletion. For manual cleanup, `FORGEJO_TOKEN` may be a user token with both repository and package access, or set `PACKAGES_TOKEN` separately. Acceptance likewise needs a user token with package read access.

## Verifying hosted publication

When the hosted workflow changes, install `.forgejo/github-workflows/gallery.yml` as `.github/workflows/gallery.yml` on the relay repository’s `workflows` default branch; repository dispatch uses that installed copy.

When publication limits change, verify a gallery triggered on an open PR after the change reaches trusted main. The `pull_request_target` workflow checks out the event's base SHA; the PR head supplies the captures, not the publisher. A run started before the main merge does not prove the new publisher, even if it finishes afterward. Reuse an existing qualifying run rather than replaying a merged PR, which the publisher refuses.

Check the event's base SHA and the relay checkout log, then confirm the completed report is authored by the reserved Actions identity (user ID `-2`). Its immutable version must be `<head>-<comment-id>`. Count the manifest captures, download every capture through its authenticated `api_url`, and verify each SHA-256, PNG signature and viewport dimensions. Check capture totals against 400 rows per shard and 48 MiB combined, and the hosted artifact's ZIP size against 64 MiB. A successful trusted publisher also proves its complete archive passed the sharded 2400-PNG, 2402-entry and 48-MiB expanded-payload guards. Report publication separately from geometry and pixel results.

### Hosted verification, 2026-10-03 (#1496)

The first gallery event based on main containing #1483 was PR #1465's run 6830 (API run ID 7812, job 11042). Its event and checkout log both identify trusted base `9b21e4d28ffa27393cf0eb238d6d9f41229c3fee`, the merge of #1483. The PR was open and unmerged at that event. The relay job and hosted capture run 37133303594 succeeded.

- Captured head: `62713a6d447ede6142d4c24306987275becbb625`.
- Completed report: comment 31034, authored by Actions user ID `-2`; version `62713a6d447ede6142d4c24306987275becbb625-31034`.
- Manifest: 288 unique captures, exceeding the former 200-row limit and within the 400-row allowance.
- Downloads: all 288 package URLs returned HTTP 200; every capture matched its manifest SHA-256 and PNG signature. Wide captures were 1400 × 900 and narrow captures 1024 × 768, across light and dark ladders.
- Capture bytes: 18,171,336 total, largest capture 136,944 bytes; within the 48-MiB allowance. The complete report archive passed the trusted publisher's expanded-payload and entry guards.
- Hosted artifact: `window-gallery`, artifact ID 11277344267, ZIP size 16,722,992 bytes; within the 64-MiB transport allowance.
- Geometry passed; pixel differences were advisory. Neither prevented publication. Inline attachment requests from this lane returned HTTP 401 behind web authentication; the authenticated package URLs used for acceptance were usable.

No publication failure was found, so no additional publisher or baseline change was needed. These checks downloaded published bytes without launching a local browser or accepting baselines.

## Report shards

Filename discovery creates desktop and phone shards with at most 400 captures each.
The hosted workflow discovers the matrix from `gallery/plan.ts`, with `gallery/shards.ts` as a fallback for earlier heads, captures each
shard with `GALLERY_SHARD`, and uploads `window-gallery-<shard-id>`. Every shard
keeps the 1,200 PNG, 48 MiB expanded payload and 64 MiB transport limits, geometry
checks and blocking pixel comparison. Add a uniquely named `phone-*.tsx` scene
with web platform mode and its own geometry; no shared registry or workflow edit
is needed. Capture names and baseline paths stay unchanged.

The relay publishes one immutable version per shard comment. Each manifest names
its shard, position, total shard count and hosted run/attempt group. Acceptance
requires every shard of the newest reported group, rejects duplicate captures
across shards, and validates each report's downloads before writing any baseline.
A partial newer run cannot borrow shards from an older run. Exact filename
selection works across the complete set, with the same image, hash and origin
checks. Older single-report manifests remain supported.

Deploy the hosted gallery workflow and trusted relay together when this change
lands. The relay uses the trusted base checkout; a PR cannot replace its publisher.

Earlier heads from the allocation rollout still publish one artifact containing
two bounded family reports. The hosted matrix uses a legacy entry for heads
without `gallery/shards.ts`; their existing allocation, transport and image
validation remain enforced. The relay and acceptance retain that report format
while every new matrix artifact remains bounded to 400 captures and 1,200 PNGs.

Numbered reports from the earlier shard rollout remain readable. Their run, index,
count and total metadata still enforces complete sets of up to sixteen 400-row
reports. Named reports use the hosted run/attempt group and retain the 100-shard
artifact listing bound. Both formats reject duplicate indices and filenames,
unfinished retries and mixed runs before writing baselines. Acceptance stages
capture bytes on disk and validates each report's 48 MiB bound. Acceptance and
retention read complete comment threads with a 64 MiB bound; individual capture
and report limits remain unchanged.

The hosted plan uploads its exact matrix as `gallery-plan` (`matrix.json`). The
trusted relay validates this bounded artifact and waits for `plan` and every
`gallery (<shard>)` job named by the matrix, including captures not yet present
in the jobs listing. Once they finish, it downloads the complete planned report
set, validates each report against the matrix, and publishes before returning
its capture verdict. Queued or failed hosted cleanup does not delay publication
or change that verdict. Geometry, pixel differences, incomplete artifacts and
publication failures still fail. The hosted cleanup job and scheduled ref sweep
continue removing temporary `ci/*` branches. During workflow rollout, a run
without the plan artifact retains the whole-run completion path.
