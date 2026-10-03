# Accepting window gallery captures

Use this recipe when a deliberate GUI change produces reviewed pixel differences in a pull request.

1. Work in the pull request's worktree with its current head checked out. Wait for the hosted gallery comment for that head. Review every baseline/capture/difference triplet and any new scene image; confirm the captures show the intended change.
2. Resolve every geometry failure in the layout or measurement expectations. Baseline acceptance changes pixel comparisons; geometry checks continue to block immediately.
3. Run `bash scripts/gallery-accept.sh <pr-number>`. It downloads the current head's captures into `packages/gui/gallery/baselines/`, validates the downloads before writing, and refuses a different working-tree head. It prints each accepted filename and the exact staging, commit and branch push commands.
4. Review the baseline changes, then run the printed commands. They commit the accepted images and push them to the pull request's branch.
5. Wait for the new head's gallery check. Acceptance is complete when the committed captures match and the check is green. Review any remaining differences before accepting again.

Captures run on hosted CI. Local acceptance downloads existing captures and launches no browser. If the script reports no captures for the current head, wait for its gallery run and comment before retrying.

Pixel differences remain advisory until the shell wave (#1343–#1347) lands, then the hosted `GALLERY_PIXEL_BLOCKING` variable enables the pixel gate. Geometry failures block throughout. Each discovered scene has light and dark captures at 1400 × 900 and 1024 × 768; scene names reserve the generated `-narrow` suffix.

A scene may export a fixed geometry array or a function receiving `{ width, height }` from the capture viewport. The mount resolves that function before marking the scene ready. Keep control dimensions fixed and compute available column widths from the frame contract. A `minimumHeight` check is available for content that grows beyond its viewport floor; exact `height` checks still apply where the scene fixes its height.

The hosted workflow and both relay publishers allow at most 600 PNGs, 24 MiB of expanded payload (including report JSON), and a 32 MiB ZIP. The report publisher also allows its two JSON entries. Capture filenames must be flat scene names ending in `.light.png` or `.dark.png`; reports may additionally contain their baseline and difference PNGs. Duplicate names, unexpected entries and invalid PNG signatures are refused before a comment is created.

A capture-only artifact from an earlier hosted run can be recovered without rebuilding its commit. Download that run's `window-gallery` ZIP, then use the trusted checkout's `bash .forgejo/scripts/gallery-comment.sh <archive.zip> <full-head-sha>` with `FORGEJO_URL`, `FORGEJO_REPOSITORY`, `FORGEJO_PR` and `FORGEJO_TOKEN` set. It validates the complete archive before uploading, and posts only while the destination PR is open and still has that head. Inspect an old artifact locally when the PR's head has moved.

## Retries, failures and retention

Each completed report stores immutable capture bytes in the `window-gallery` generic package under version `<head>-<comment-id>`. Repeating a hosted run on the same head creates another report version, so a retry cannot replace bytes in an earlier review. The comment manifest records the version, exact package download URL and SHA-256 of each capture. Acceptance selects the latest completed manifest for the current head and verifies its hashes before writing any baseline. Existing head-only manifests remain downloadable for compatibility.

Attachment or package upload failures finalize the comment with the failed stage, HTTP status when available, and instructions to rerun the gallery job or check write permissions. A failed report carries no acceptance manifest. If tracker connectivity also prevents finalizing the comment, the relay log explicitly reports that failure.

Capture versions expire 30 days after their package creation time, except every version referenced by a relay-authored gallery manifest in an open pull request and every version belonging to an open pull request's current head. This includes earlier reviewed heads and the head-only versions created before per-report versioning. Unfinished uploads that no longer belong to an open PR's current head receive the same 30-day grace period. The `window-gallery` package is reserved for this repository's gallery captures; other package names and types are untouched. Closing a PR releases its captures for cleanup once their creation time is past the retention period.

Cleanup runs daily in the `gallery-retention` workflow, can be dispatched manually, and also runs after each completed report. It reads every page of open PRs and package versions, and each complete comment thread, before deleting anything; unreadable or invalid API listings stop cleanup. Acceptance and cleanup only use reports authored by Forgejo’s reserved Actions identity. A modern version must match the head and the containing comment’s own ID; older head-only reports from that identity remain supported. Copied markers in ordinary discussion and malformed examples are ignored. A concurrent cleanup's already-deleted version is harmless. Cleanup errors leave completed reports usable and emit a workflow warning; rerun the retention workflow after restoring API access. Authenticated manual cleanup uses `FORGEJO_URL`, `FORGEJO_REPOSITORY` and `FORGEJO_TOKEN` with `python3 scripts/gallery-retention.py`.

The workflows use the repository job token for PRs and comments and the existing `PACKAGES_TOKEN` secret (with package read/write access) for owner-scoped capture storage, inventory and deletion. For manual cleanup, `FORGEJO_TOKEN` may be a user token with both repository and package access, or set `PACKAGES_TOKEN` separately. Acceptance likewise needs a user token with package read access.
