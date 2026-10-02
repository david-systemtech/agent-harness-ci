# Listed-directory import seam evidence (#1166)

The pinned `@anthropic-ai/claude-agent-sdk` is `0.3.283` (the Environment
package's exact dependency). All evidence below uses temporary fixture
folders, never a user's provider directory.

`accounts/import-directory.test.ts` exercises the Account owner's
`observeDirectory` against the real Claude adapter. It reads cached
`oauthAccount.emailAddress` and optional `organizationName` from the listed
directory's `.claude.json`, leaving `.credentials.json` unopened and
unchanged. A scripted command runner throws if any provider process starts.
Cached identity is metadata, not evidence of current authentication: listed
adoption leaves authentication/model reads to ordinary startup or refresh.

`adapters/claude/session-listing.test.ts` exercises the pinned SDK's real
`listSessions` through the adapter's config-directory queue. Listing every
project requires neither a provider process nor sign-in; source bytes remain
unchanged. `state-import/accounts.test.ts` proves the same seam over typed
wire, including an unadopted directory with Session, memory and skill counts,
zero Account/import events during preview, and source-byte equality.

The audited profile writer is `packages/core/src/profiles/store.ts` in the
source checkout: its version constants (lines 70–82), parser (637–752), and
whole-document writer (547–551). Version 2 writes `{version: 2, profiles}`;
rows name `id`, `label`, `providerId`, `configDir`, `publicEnv` and optional
creation/modification times. Version 1 names `configDirName`, resolved below
the source data folder's `profiles/`. The desktop preference writer is
`apps/desktop/renderer/src/state/store.ts`, `savePrefs` (2320–2326), which
persists `activeProfileId`. Fixtures follow these writers; credential and
environment bundles are never imported.

There is no profile last-use timestamp in that writer. The latest listed
transcript's `lastModified` is the persisted source-use evidence used to
choose a duplicate identity's directory. Empty directories tie. Ties use
ascending source IDs, independent of source list order. Existing registered
Accounts take precedence and retain their directory and label. Canonical
secondary directories persist in the Account mapping's `sourceDirectory`,
so later source-profile edits cannot redirect a mapped import source.

`carryOver.inventory {source: "state-import"}` returns per-directory previews
beside failures and later-provider rows; its existing `{accountId}` selector
and result remain supported. The strict selector union accepts no path. This
extends query schemas to unions of object shapes without changing command or
stream shape requirements. `StateImportReport` is unchanged. Card and CLI
callers can use the same typed query; rendering and CLI commands belong to
#1170–#1172. Session/history application and continuation belong to #1167;
this evidence proves identity/listing, not secondary continuation.

Verification: named fixture tests only, with `--maxWorkers=2`; the builder's
handoff records the final typecheck/lint/test results.
