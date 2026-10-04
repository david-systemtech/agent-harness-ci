# Accepting window gallery captures

Use this recipe when a deliberate GUI change produces reviewed pixel differences in a pull request.

1. Work in the pull request's worktree with its current head checked out. Wait for the hosted gallery comment for that head. Review every baseline/capture/difference triplet and any new scene image; confirm the captures show the intended change.
2. Resolve every geometry failure in the layout or measurement expectations. Baseline acceptance changes pixel comparisons; geometry checks continue to block immediately.
3. Run `bash scripts/gallery-accept.sh <pr-number>`. It downloads the current head's captures into `packages/gui/gallery/baselines/`, validates the downloads before writing, and refuses a different working-tree head. It prints each accepted filename and the exact staging, commit and branch push commands.
   To accept a reviewed subset, append exact capture filenames, for example `bash scripts/gallery-accept.sh <pr-number> settings-browser.light.png settings-browser-narrow.light.png`. Only those images are downloaded, written and included in the printed staging command; unrelated baselines remain untouched. Name each reviewed ladder and viewport explicitly. A missing filename refuses the whole acceptance.
4. Review the baseline changes, then run the printed commands. They commit the accepted images and push them to the pull request's branch.
5. Wait for the new head's gallery check. Acceptance is complete when the committed captures match and the check is green. Review any remaining differences before accepting again.

Captures run on hosted CI. Local acceptance downloads existing captures and launches no browser. If the script reports no captures for the current head, wait for its gallery run and comment before retrying.

The shell wave has landed: missing baselines, pixel differences beyond the 0.05% budget (pixelmatch threshold 0.1), and geometry failures block. Every discovered scene has dark captures at 1400 × 900 and 1024 × 768; the light subset follows `look.md §16`. Scene names reserve the generated `-narrow` suffix.

A scene may export a fixed geometry array or a function receiving `{ width, height }` from the capture viewport. The mount resolves that function before marking the scene ready. Keep control dimensions fixed and compute available column widths from the frame contract. A `minimumHeight` check is available for content that grows beyond its viewport floor; exact `height` checks still apply where the scene fixes its height.

Desktop and phone captures have separate reports, each capped at 400 rows. Desktop scenes retain every existing ladder and width. Each phone scene normally costs eight rows (four profiles × two ladders); the shared Continue scene costs six. The current 354 desktop and 46 phone rows leave 46 desktop slots and 354 phone slots, enough for all seven leaf owners to add six dedicated scenes each (336 rows). Owners add uniquely named `phone-*` scene modules and their baselines; the capture planner refuses a report above its allocation before any screenshots run.

For rollout compatibility, captures with at most 400 total rows still emit the earlier combined report. Larger galleries emit both reports, which travel in one `window-gallery` artifact and one immutable review manifest. Each report allows 1200 PNGs and 48 MiB of expanded payload; the combined artifact allows 2400 PNGs, 2402 entries including `report.json` and `geometry.json`, 96 MiB expanded, and a 128 MiB ZIP. The publisher validates each report's rows, membership and bytes before posting; shared report and geometry JSON count toward each report's expanded byte budget. Install `.forgejo/github-workflows/gallery.yml` on the relay repository’s `workflows` branch when this change reaches main, before leaf captures exceed 400 total rows. Single-report and earlier capture-only artifacts retain their 400-row, 1200-PNG, 48-MiB and 64-MiB limits. Flat filenames, duplicate-name checks, complete comparison triplets, PNG signatures and phone viewport checks still apply.

Baseline acceptance reads both reports from the latest completed manifest for the current head, checks each report's 400-row and 48-MiB bounds, and downloads and validates every selected image before writing any baseline. A subset may span both reports. Both reports share the comment-bound package version, so a retry cannot mix desktop captures from one run with phone captures from another. Retention protects all captures in both reports, including reviewed earlier heads.


A capture-only artifact from an earlier hosted run can be recovered without rebuilding its commit. Download that run's `window-gallery` ZIP, then use the trusted checkout's `bash .forgejo/scripts/gallery-comment.sh <archive.zip> <full-head-sha>` with `FORGEJO_URL`, `FORGEJO_REPOSITORY`, `FORGEJO_PR` and `FORGEJO_TOKEN` set. It validates the complete archive before uploading, and posts only while the destination PR is open and still has that head. Inspect an old artifact locally when the PR's head has moved.


Capture readiness includes a fresh placement of the focused dialog's tooltip after layout stabilizes. A stationary popper rectangle can retain a cached initial position; fonts being ready and several identical frames do not prove placement is current. The capture gate requests the update through the dialog's overflow-ancestor resize listener and waits for stable placement again. Keep this notification on the dialog: a window-wide resize dismisses open Select menus.

The #1537 hosted probe (run 37178192474, PR #1538) repeated restore captures eight times for each viewport and ladder. The old gate accepted eight stale positions out of 32, reproducing the reported 536/542-pixel differences. The narrow tooltip stayed at (661, 405) instead of (662, 406), and the wide tooltip at (849, 471) instead of (850, 472). Focus, reference rectangles, tooltip dimensions and animation state were unchanged. Allowing screenshot animations produced the same failures; refreshing placement corrected all 32 captures to zero differences. The full hosted gallery also matched all 342 scenes without changing baselines or budgets.

## Retries, failures and retention

Each completed report stores immutable capture bytes in the `window-gallery` generic package under version `<head>-<comment-id>`. Repeating a hosted run on the same head creates another report version, so a retry cannot replace bytes in an earlier review. The comment manifest records the version, exact package download URL and SHA-256 of each capture. Acceptance selects the latest completed manifest for the current head and verifies its hashes before writing any baseline. Existing head-only manifests remain downloadable for compatibility.

Attachment or package upload failures finalize the comment with the failed stage, HTTP status when available, and instructions to rerun the gallery job or check write permissions. A failed report carries no acceptance manifest. If tracker connectivity also prevents finalizing the comment, the relay log explicitly reports that failure.

Capture versions expire 30 days after their package creation time, except every version referenced by a relay-authored gallery manifest in an open pull request and every version belonging to an open pull request's current head. This includes earlier reviewed heads and the head-only versions created before per-report versioning. Unfinished uploads that no longer belong to an open PR's current head receive the same 30-day grace period. The `window-gallery` package is reserved for this repository's gallery captures; other package names and types are untouched. Closing a PR releases its captures for cleanup once their creation time is past the retention period.

Cleanup runs daily in the `gallery-retention` workflow, can be dispatched manually, and also runs after each completed report. It reads every page of open PRs and package versions, and each complete comment thread, before deleting anything; unreadable or invalid API listings stop cleanup. Acceptance and cleanup only use reports authored by Forgejo’s reserved Actions identity. A modern version must match the head and the containing comment’s own ID; older head-only reports from that identity remain supported. Copied markers in ordinary discussion and malformed examples are ignored. A concurrent cleanup's already-deleted version is harmless. Cleanup errors leave completed reports usable and emit a workflow warning; rerun the retention workflow after restoring API access. Authenticated manual cleanup uses `FORGEJO_URL`, `FORGEJO_REPOSITORY` and `FORGEJO_TOKEN` with `python3 scripts/gallery-retention.py`.

The workflows use the repository job token for PRs and comments and the existing `PACKAGES_TOKEN` secret (with package read/write access) for owner-scoped capture storage, inventory and deletion. For manual cleanup, `FORGEJO_TOKEN` may be a user token with both repository and package access, or set `PACKAGES_TOKEN` separately. Acceptance likewise needs a user token with package read access.

## Verifying hosted publication

When publication limits change, verify a gallery triggered on an open PR after the change reaches trusted main. The `pull_request_target` workflow checks out the event's base SHA; the PR head supplies the captures, not the publisher. A run started before the main merge does not prove the new publisher, even if it finishes afterward. Reuse an existing qualifying run rather than replaying a merged PR, which the publisher refuses.

Check the event's base SHA and the relay checkout log, then confirm the completed report is authored by the reserved Actions identity (user ID `-2`). Its immutable version must be `<head>-<comment-id>`. Count the manifest captures, download every capture through its authenticated `api_url`, and verify each SHA-256, PNG signature and viewport dimensions. Check each report against 400 rows and 48 MiB, and the two-report artifact against the aggregate 128-MiB ZIP, 2400-PNG, 2402-entry and 96-MiB expanded-payload guards. Single-report artifacts retain the earlier bounds. Report publication separately from geometry and pixel results.

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
