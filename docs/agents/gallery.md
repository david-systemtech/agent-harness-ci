# Accepting window gallery captures

Use this recipe when a deliberate GUI change produces reviewed pixel differences in a pull request.

1. Work in the pull request's worktree with its current head checked out. Wait for the hosted gallery comment for that head. Review every baseline/capture/difference triplet and any new scene image; confirm the captures show the intended change.
2. Resolve every geometry failure in the layout or measurement expectations. Baseline acceptance changes pixel comparisons; geometry checks continue to block immediately.
3. Run `bash scripts/gallery-accept.sh <pr-number>`. It downloads the current head's captures into `packages/gui/gallery/baselines/`, validates the downloads before writing, and refuses a different working-tree head. It prints each accepted filename and the exact staging, commit and branch push commands.
4. Review the baseline changes, then run the printed commands. They commit the accepted images and push them to the pull request's branch.
5. Wait for the new head's gallery check. Acceptance is complete when the committed captures match and the check is green. Review any remaining differences before accepting again.

Captures run on hosted CI. Local acceptance downloads existing captures and launches no browser. If the script reports no captures for the current head, wait for its gallery run and comment before retrying.

Pixel differences remain advisory until the shell wave (#1343–#1347) lands, then the hosted `GALLERY_PIXEL_BLOCKING` variable enables the pixel gate. Geometry failures block throughout. Each scene has a 1400 × 900 capture and a 1024 × 768 narrow capture; scene names reserve the generated `-narrow` suffix.
