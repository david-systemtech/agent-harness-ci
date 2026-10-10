# Account recovery smoke workflow installation (#2088)

The selected main commit is `531ab91de3031a081b4fe8d2a2204ebfbdd7790e`,
which includes #2083 / PR #2086. Its release smoke could not dispatch a
hosted build because the installed release workflow differed from the source.
This rollout installs the landed workflow unchanged; it adds no product code.

## Reproduction and installation

A live comparison of the source and installed files failed before installation:

| Workflow | Source Git blob | Installed Git blob before | Bytes equal before |
| --- | --- | --- | --- |
| Release | `5bd7dccc3cac5f0bc2f6b9542cdd6501e4e6b3b3` | `41f7429b7fa2e53dc9ba6bc7b8677d6d72eb3e3f` | No |
| Smoke | `9fcb787bc02ada811e4b59c8eceb1e40cb836dd6` | `9fcb787bc02ada811e4b59c8eceb1e40cb836dd6` | Yes |

Installed `public/.github-workflows/release.yml` at
`.github/workflows/release.yml` on the hosted relay's `workflows` branch.
Installation commit: `0831196ebf12021ed8a0cda71675c2aa7ebea6b3`.
The smoke copy comes from `.forgejo/github-workflows/smoke.yml`.

The relay's mismatch refusal remains intact. The installed release file retains
all platform smoke assertions, including the packaged account recovery check on
Windows, macOS and Linux. This installation publishes no source history,
release, tag or image.

## Verification

After installation, both files match the selected main commit by decoded bytes
and Git blob SHA (live assertion exit status changed from 1 to 0).
The original failed smoke is run 13350 (API run 15157), job 20486.
The selected main smoke was dispatched as run 13351 (API run 15158),
job 20487. It relays to hosted run 38076154030 after passing the installed-copy
checks. Both hosted and relay runs completed successfully on 2026-10-10.
The image, native Windows compilation, all three desktop builds and all three
platform smokes passed. Verification, suite and publishing jobs were skipped
as expected for a main smoke dispatch.

Scoped regression checks passed: 38 relay/release-workflow tests and 30
packaged account recovery/platform-wiring tests. Nine PowerShell-only tests
skipped on the Linux builder. Source workflows and platform assertions were
installed without modification.
