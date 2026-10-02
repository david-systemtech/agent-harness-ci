# Listed and secondary Session import evidence (#1167)

All evidence uses scratch fixture state. The pinned Agent SDK is 0.3.283.

`adapters/claude/imported-history.test.ts` reads parent and subagent transcripts
through the SDK's actual directory helpers and hydrates the real Environment
store through `importSessionToStore`. A scripted query records continuation
options: the import reads the secondary directory, while both cold-login
refresh and resumed queries name the winning Account directory. Secondary
credential files remain unchanged. The interrupted-hydration fixture proves
that partial parent batches cannot become the authoritative conversation:
subagents are imported first, then one owning-store append publishes the
complete parent. Retries and concurrent reads check the store under the
config-directory queue; completed store contents take precedence.

`adapters/claude/sdk-store-resume.test.ts` also drives the real SDK's `query()`
with a recording Node executable, without contacting a Provider. After
secondary hydration, it sees the parent and subagent files in the SDK's
temporary directory, the winner's access token only, and the winner's original
credential store for refresh. The SDK removes the temporary directory after
exit. No secondary sign-in credentials are copied or used.

`state-import/sessions.test.ts` exercises two typed-wire Clients, immediate
records without eager transcript history, winner-first provider-id deduplication,
once-only lazy history across concurrent opens and restart, history before a
first continuation without a subscription, missing Workspace
replacement, explicit read-only refusal until source hydration succeeds,
continuation using the winner, authoritative store contents after continuation,
changed-memory copying beside harness edits, default-on Skills and tracked
checkout offers, and interruption after a committed source followed by retry.
A competing state import or ordinary Carry over is refused by the shared
coordinator. Session records and durable provider-id mapping evidence commit
together; purging a mapped Session never causes a state-import re-run to
recreate it. Ordinary provider listing can still name that source transcript.

Retention evidence lives in Imported session origin `sourceDirectory` and in
`state-import.item-carried` Account/Session mappings. Old origins without a
locator read the Account directory. These canonical source directories must
remain readable through lazy first opens and first continuations, including
after the source server stops. Import never deletes or changes their bytes.
Stopping a listener does not authorise deleting its directories: keep sources
and backups until David explicitly approves disposal (switch-over spec).

The fixture proof passes; real sign-in, subscription billing, keychain refresh
and deployment acceptance remain #217's work. A missing hydration seam/source
leaves affected Sessions read-only with `import_source_unavailable`, and blocks
continuation acceptance; it never falls back to secondary authentication.
