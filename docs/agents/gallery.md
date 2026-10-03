# Accepting window gallery captures

Use this recipe when a deliberate GUI change produces reviewed pixel differences in a pull request.

1. Work in the pull request's worktree with its current head checked out. Wait for the hosted gallery comment for that head. Review every baseline/capture/difference triplet and any new scene image; confirm the captures show the intended change.
2. Resolve every geometry failure in the layout or measurement expectations. Baseline acceptance changes pixel comparisons; geometry checks continue to block immediately.
3. Run `bash scripts/gallery-accept.sh <pr-number>`. It downloads the current head's captures into `packages/gui/gallery/baselines/`, validates the downloads before writing, and refuses a different working-tree head. It prints each accepted filename and the exact staging, commit and branch push commands.
4. Review the baseline changes, then run the printed commands. They commit the accepted images and push them to the pull request's branch.
5. Wait for the new head's gallery check. Acceptance is complete when the committed captures match and the check is green. Review any remaining differences before accepting again.

Captures run on hosted CI. Local acceptance downloads existing captures and launches no browser. If the script reports no captures for the current head, wait for its gallery run and comment before retrying.

Pixel differences remain advisory until the shell wave (#1343–#1347) lands, then the hosted `GALLERY_PIXEL_BLOCKING` variable enables the pixel gate. Geometry failures block throughout. Each discovered scene has light and dark captures at 1400 × 900 and 1024 × 768; scene names reserve the generated `-narrow` suffix.

The hosted workflow and both relay publishers allow at most 600 PNGs, 24 MiB of expanded payload (including report JSON), and a 32 MiB ZIP. The report publisher also allows its two JSON entries. Capture filenames must be flat scene names ending in `.light.png` or `.dark.png`; reports may additionally contain their baseline and difference PNGs. Duplicate names, unexpected entries and invalid PNG signatures are refused before a comment is created.

A capture-only artifact from an earlier hosted run can be recovered without rebuilding its commit. Download that run's `window-gallery` ZIP, then use the trusted checkout's `bash .forgejo/scripts/gallery-comment.sh <archive.zip> <full-head-sha>` with `FORGEJO_URL`, `FORGEJO_REPOSITORY`, `FORGEJO_PR` and `FORGEJO_TOKEN` set. It validates the complete archive before uploading, and posts only while the destination PR is open and still has that head. Inspect an old artifact locally when the PR's head has moved.
