# Spec: Session organisation state and client sync

Milestone 1 (Switch-over), phase A (the spine). Written 2026-09-23 from map ticket 79 of `david/agent-harness`. Decisions it implements: ADR 0003 (clients hold no organisation state; every user-set session field is a command, an event and a projection), with ADR 0002 (organisation events live until the session is deleted), ADR 0004 (renderers are projections of one client runtime), ADR 0005 (repository identity on the session, no Project object), ADR 0006 (a parked prompt blocks auto-settle), ADR 0012 (pull-request status so settle-on-merge works) and ADR 0017 (phase, placeholder name). It builds on the environment-service specification (`docs/specs/env.md`, ticket 78), which fixes the wire, the event envelope, command receipts, the subscription mechanics (replay from `afterSequence`, the replay bound, snapshot, `synchronized`, overflow) and the event log; none of that is re-decided here. Peers read: T3 Code at 96c4bfa0 (the thread schema, the decider, the settlement policy and reactor, the deletion reactor, the client runtime's thread sort, the thread-sidebar guide), Artemis at 443cf2e (the desktop and terminal UI preferences, the protocol's session summary, the renderer store's group verbs, the remote bridge). The product name is the placeholder `agent-harness` throughout.

## Problem Statement

David archived a session and put others into groups on one machine, and on his other machine neither had happened. The surfaces audit (section 4.2) traced it to three causes, one per piece of state. Groups and pins were fields of the desktop renderer's own store, saved to a per-machine `prefs.json` and keyed by a profile id minted at random on each machine, so no code path sent them anywhere and a copied file would not even have matched. Archive rode the one field a provider store offers, a tag, so it reached a second client only where the adapter could write a tag (Codex could not) and only in the client mode that forwarded it (Remote mode stubbed it out and dropped it from every listed row). The terminal UI kept a third store of pins with no groups. Titles were the provider's, tags did not exist beyond the one word used for archive, and there was no manual order. Each was user state with no home on any environment, and each client invented one. Artemis's own ADR that moved archive onto the tag was followed by a regression, because nothing enforced it.

## Solution

Every user-set field of a session lives on the environment that owns the session: archived, pinned and its order, manual order, title, tags, group membership, settled and snoozed. Groups are objects the environment owns. Each field is changed by one command, recorded as one event on the log and read back from one projection. Every client subscribes to the environment's session list and renders it, holding nothing of its own. Archive a session on the laptop and it is archived in the desktop window on SYSTEM-SERVER and in the terminal within the second, or at the next reconnect; pin, group, rename and reorder work the same way, on any client, for any provider. A deleted session can be restored for thirty days, then it is gone. Finished sessions settle themselves after a fortnight of quiet, and any session can be snoozed until a chosen time. Two environments that each have a group called "Brandsolidate" show as one heading with a badge on every row saying which machine the session is on; the heading is a view the client draws, not a thing either environment stores. A contract test refuses a session field with no command and a lint refuses a client store named after one, so the Artemis bug cannot be written again.

## User Stories

1. As David, I want to archive a session on my laptop and find it archived in the desktop window and the terminal UI on SYSTEM-SERVER, so that I file a conversation once.
2. As David, I want to pin a session from any client and see the same pinned block everywhere, so that what I am working on is on top wherever I sit and stays where I dragged it.
3. As David, I want to arrange my active sessions by hand and have new sessions appear above the ones I arranged, so that arranging is stable and new work is still visible.
4. As David, I want to rename a session and see the name everywhere, including in `claude --resume` on that machine, so that one name is the name.
5. As David, I want an unnamed session to carry a readable title taken from my first message, replaced by the provider's summary when one arrives, so that the list is never a column of "New session".
6. As David, I want several free-form tags on a session and a filter by tag, so that "wip", "review" and "seth" cut across groups.
7. As David, I want named groups on an environment with a session in at most one, so that unrelated sessions that belong together sit together and no session shows twice.
8. As David, I want two environments that each have a group of the same name to show as one heading with a badge on every row, so that work that spans machines reads as one heading.
9. As David, I want a deleted session to vanish at once, come back if I restore it within a grace period, and be purged after, so that deletion is reversible for a while and final after.
10. As David, I want the provider's transcript kept when I delete a session unless I ask for it to go too, so that the harness never destroys a file another tool made.
11. As David, I want a finished session to settle itself after a fortnight of quiet, never while a run is going or a prompt is parked, so that my active list is what I am actually working on.
12. As David, I want to settle and unsettle by hand at any time, with an unsettled session staying active until I use it again, so that auto-settle never fights me.
13. As David, I want a session settled when its pull request merges, if I turn that on, so that finished work files itself.
14. As David, I want to snooze a session until Tuesday morning from any client and have it come back on its own, and earlier if its run ends or errors, so that "later" has a date and a session that raises its hand is not hidden.
15. As David, I want edits made in the terminal on a train to apply exactly once when I am back on the tailnet, so that offline edits are neither lost nor doubled.
16. As David, I want an offline edit to a session someone deleted meanwhile to give me a one-line notice rather than a resurrected session, so that conflicts are visible and simple.
17. As David, I want an unreachable environment to still show its sessions and groups as I last saw them, marked unreachable, with my edits queued as pending, so that a sleeping machine does not empty my sidebar.
18. As Seth, I want the terminal UI's pins, archive and groups to be the environment's, so that what I pin in the terminal is pinned in the desktop window.
19. As a routine, I want the session I create to carry a tag naming me, so that my firings can be filtered and cleared like any other session.
20. As the setup checklist, I want the auto-settle rules to be two ordinary environment settings under a registered step, so that the step registry's contract test passes and the rules are editable where settings live.
21. As a provider adapter, I want to hand the environment a generated title and never be asked to store an archive, a pin or a tag, so that organisation never depends on what my provider can hold.
22. As a build session, I want to drive every organisation command through a real client against an in-process environment and assert the event and the summary change, so that every story above is a test that runs in seconds.
23. As a build session, I want a contract test that fails when a summary field has no command and a lint that fails when a client package names a store after session state, so that the Artemis regression cannot be typed.
24. As a client developer in another language, I want every session-list event to carry the summary fields it changed and order keys that compare as plain strings, so that my client applies patches and sorts without re-implementing the environment's rules.

## Implementation Decisions

Every rule below cites ADR 0003 unless another decision is named.

### Modules and ownership

- The **contracts package** gains the session summary, group and event payload schemas; the `sessions`, `groups` and `settings` registry entries with their scopes; the `list` flag on event types; the summary field table the contract test reads; the two auto-settle settings keys; the ordering module every client imports, which validates and generates order keys and implements the sort and shelf membership of "Ordering: fractional keys".
- The **environment package** gains the session-organisation module: command handlers for the session and group aggregates (a pure decider in T3 Code's sense: projection plus command gives events or a typed refusal), the session-list projector that writes the read models and the summary patch, the maintenance sweep (auto-settle, snooze expiry, purge) and the title fallback.
- The **client runtime** (ticket 80) gains no state of its own for these fields; its obligations here are the reduction rules (apply patches, sort by keys, merge headings by name).

### The session summary

The one shape every client renders a list row from, with who writes each field:

- Identity: `id` (a UUID the creating client mints and the environment validates, so offline creation can chain commands; the provider's resume id is never the session id), `createdAt`, `updatedAt` (last organisation change), `lastActivityAt` (last run start, run end, user message or prompt answer).
- Title: `title` (always non-empty: the user's title, else the generated title, else "New session") and `titleSource` (`user`, `generated`, `default`).
- Filing: `archivedAt`; `pinnedAt` and `pinOrderKey`; `activeOrderKey`; `tags` (a sorted array); `groupId` (a group on the same environment, or null).
- Shelf: `settledAt`, `settledOverride` (null, `settled` or `active`), `settledBy` (`user`, `auto-idle`, `auto-merge` or null), `unsettledAt`; `snoozedUntil`, `snoozedAt`.
- Place (ADR 0005), both written by `sessions.create`: `workspace` (kind and path; the workspace workstream's, phase A fills kind `directory` from the creating command) and `repositoryIdentity` (the canonical remote URL; `sessions.create` writes null until that workstream resolves it).
- Activity, written by the adapter's and permissions workstream's run and prompt events: `activity` (`idle`, `starting`, `running` or `parked`, with `since`), `parkedPromptCount`, `accountId` and `model`.
- Forge (ADR 0012), written by the forge workstream's events, empty in phase A: `pullRequests`, each with url, state (`open`, `closed`, `merged`), `mergedAt`, `closedAt`.
- Composer: `draft`, the text typed in the composer and not sent, never empty, or null; written by `sessions.setDraft`, so a draft follows the session between clients (conflict X3). It is not an organisation change and does not move `updatedAt`.

Deleted sessions are not in the list; `deletedAt` and `purgeAt` appear only on the deleted-sessions query. Environment id is not a field: the client runtime knows which connection a summary came from and attaches the badge.

### Group

A **Group** is an aggregate with its own `group` stream: `id` (client-minted UUID), `name` (trimmed to 1 to 80 characters, then internal whitespace collapsed; unique per environment ignoring case), `orderKey` (a fractional key or null), `createdAt`, `updatedAt`. Membership lives on the session as `groupId`, never as a list on the group, so a session is in at most one group by construction and last writer wins per session. Whether a heading is collapsed is client-local presentation (ADR 0004), keyed by heading name in the client runtime's allowlisted presentation module, because a merged heading spans environments and no single environment could own the flag.

### Commands

Every command is a registry method with scope `sessions:write` unless stated, takes a `commandId`, answers with its receipt, and produces its events in one transaction with the projection write.

- `sessions.create`: `id`, optional `title`, `tags`, `groupId`, plus the account, model, mode and workspace parameters the adapter, permissions and workspace workstreams define and validate in their own modules. Registered here because the summary is born here.
- `sessions.rename`: `sessionId`, `title` (1 to 200 characters) or null to revert to the generated fallback.
- `sessions.archive`, `sessions.unarchive`: `sessionId`.
- `sessions.pin` (`sessionId`, optional `orderKey`), `sessions.unpin`, `sessions.reorderPinned` (`sessionId`, `orderKey`; `conflict` with reason `not_pinned` on an unpinned session, so a reorder that raced an unpin never resurrects the pin).
- `sessions.reorderActive`: `sessionId`, `orderKey`; `conflict` with reason `not_active` on a pinned, settled or archived session. A snoozed session keeps its active slot and may be reordered, as in T3 Code, since it returns to the active list when it wakes.
- `sessions.tag`, `sessions.untag`: `sessionId`, `tag` (trimmed, 1 to 40 characters, no control characters; unique per session ignoring case with the latest casing kept; at most 64 per session, one more is `conflict` with reason `too_many_tags`).
- `sessions.setDraft`: `sessionId`, `draft` (up to 65,536 characters, or null; an empty string is null). An absolute setter: the value sent replaces the stored draft, so a client's outbox keeps only the latest queued for a session; the client runtime debounces it one second.
- `sessions.setGroup`: `sessionId`, `groupId` or null; `not_found` with data kind `group` when the group is not on this environment.
- `sessions.settle`, `sessions.unsettle`: never refused for lifecycle reasons.
- `sessions.snooze`: `sessionId`, `until` (absolute UTC, after now, at most one year ahead). `sessions.unsnooze`.
- `sessions.delete` (`sessionId`, optional `deleteProviderTranscript`, preset false), `sessions.restore` (within the grace period), `sessions.purge` (only on a deleted session; ends the grace now).
- `groups.create` (`id`, `name`, optional `orderKey`), `groups.rename`, `groups.reorder`, `groups.delete` (every member's `groupId` becomes null in the same transaction, one `session.group-set` per member with the group event as causation; a deleted session in its grace period is a member too). A name clash ignoring case is `conflict` with reason `name_taken`; a group id used before is `conflict` with reason `exists`; a command on a group not on this environment is `not_found` with data kind `group`. The chosen defaults behind these are listed under Further Notes.
- Queries, scope `read`: `sessions.list`, `sessions.get`, `sessions.listDeleted`, `groups.list`.
- Settings: `settings.get` (scope `read`) and `settings.update` (scope `admin`) are the harness's generic key-value settings methods, registered here as the first phase-A workstream to need a setting; each key has a schema in the contracts package and later workstreams add keys, never methods. The keys: `sessions.autoSettleAfterIdle` (null, or an amount and a unit of `days`, `weeks` or `months`; preset 14 days) and `sessions.autoSettleOnMerge` (boolean, preset false).

A repeated `commandId` returns the stored receipt (environment specification). A fresh command that changes nothing (archive an archived session, add a present tag) is accepted with no event; its receipt carries the head sequence and `changed: false`. Every command except `sessions.restore` and `sessions.purge` is rejected on a deleted session with status `rejected`, reason `not_found`; the client shows a one-line notice and drops it.

### Events

Stream kind `session`, stream id the session id: `session.created`, `session.title-set` (title or null, source `user`), `session.title-generated` (title, source `prompt` or `provider`), `session.archived`, `session.unarchived`, `session.pinned` (pinnedAt, optional pinOrderKey), `session.unpinned`, `session.pin-reordered`, `session.active-reordered`, `session.tagged`, `session.untagged`, `session.draft-set` (draft or null), `session.group-set`, `session.settled` (settledAt, by; sets `settledOverride` to `settled`), `session.unsettled` (unsettledAt, reason `user` or `activity`), `session.snoozed`, `session.unsnoozed` (reason `user`, `expired`, `activity` or `settled`), `session.deleted` (deletedAt, purgeAt, deleteProviderTranscript), `session.restored`, `session.purged`. Reserved for the forge workstream, payload fixed here so the summary field has an owner from phase A: `session.pull-request-linked`, `session.pull-request-unlinked`, `session.pull-request-synced` (url, state, mergedAt, closedAt). Stream kind `group`: `group.created`, `group.renamed`, `group.reordered`, `group.deleted`. The envelope, whose actor answers "who archived this", is the environment specification's.

Companion events, appended in the same transaction with the command's id as causation:

- Settle (manual or automatic) sets `settledOverride` to `settled`, unpins, clears the active order key and wakes a snooze (reason `settled`), as in T3 Code: a settled session has no slot in the live lists.
- Pin unsettles a settled session (reason `user`) and wakes a snooze: a pin is a promotion to the top now.
- Unsettle stamps `unsettledAt` and sets `settledOverride` to `active`, which blocks auto-settle until the next activity clears it to null (the auto flag ticket 17's Resolution says unsettle clears).
- A run starting on an archived, settled or snoozed session unarchives, unsettles (reason `activity`) and wakes it; a run ending or erroring wakes a snoozed session. The session-organisation module produces these from the adapter's run events in the same transaction, the only way run events touch organisation fields.
- Delete stops the session's provider process and closes its terminals (obligations on the adapter and terminal workstreams, triggered by `session.deleted`); restore touches neither.

### The list stream and the summary patch

Every event type that changes a summary or a group is flagged `list` in the registry: all `session.*` and `group.*` events, and the run and prompt events of the adapter and permissions workstreams that change `activity`, `parkedPromptCount`, `lastActivityAt`, `accountId` or `model` (their names are those workstreams' to confirm). When the projector applies a flagged event it writes the resulting change (the fields that changed with their new values, or a removal) as a **summary patch** into the event's metadata in the same transaction. A flagged event that changes nothing a client lists carries no patch: the one case is a `session.group-set` that ungroups a deleted session when its group is deleted, which is on the list stream by its type and is skipped by a client for having no patch. A client applies patches and never re-derives a field from a payload; a client in another language needs only the summary schema and the patch rule. The payload stays for audit and rebuild.

### Subscriptions

- `sessions.subscribe` (scope `read`, stream): the session list. Snapshot `{sequence, sessions, groups}` with every non-deleted summary and every group; replay and live are the flagged events with their patches.
- `sessions.subscribeSession` (scope `read`, stream): `sessionId`, `afterSequence`. Snapshot `{sequence, summary, transcript}`, the transcript shape being the adapter workstream's; replay and live are every event of that stream. On deletion it delivers `session.deleted` and ends with reason `deleted`; an unknown or purged id is `not_found`.

Clients keep a snapshot and `lastSequence` per subscription, advance the cursor only after an update applies, and read from cache offline.

### Ordering: fractional keys

Order keys are strings over `a` to `z`, compared as plain strings, never empty and never ending in `a` (so a key can always be generated before any key), as in T3 Code's client runtime. A move writes one key to one session on its own environment and touches no neighbour, so lists from several environments merge without agreement. Key generation is a client obligation: the key between the rendered neighbours, or evenly spread keys for the section when a neighbour has none, one command per session. The contracts package's ordering module generates both and sorts; every client imports it. Sorting, identical in every client:

- Pinned block: keyed sessions ascending by `pinOrderKey`, then keyless by `pinnedAt` ascending (the terminal UI's oldest pin first).
- Active list: keyless sessions first, by the latest of `lastActivityAt`, `unsettledAt` and `createdAt`, newest first (Artemis's order, ADR 0004's parity default); then keyed sessions ascending by `activeOrderKey`. New and unsettled sessions appear above the arranged run; arranging a session takes it out of the activity order.
- Settled shelf by `settledAt` newest first; snoozed shelf by `snoozedUntil` soonest first; archived by `archivedAt` newest first; groups keyed ascending then keyless by `createdAt`.
- Ties: the environment's position in the client's connection list, then id.

Shelf membership: hidden if deleted; else archived; else settled; else snoozed (`snoozedUntil` in the future by the environment's time, offset from `hello`); else pinned; else active.

### Title fallback

The generated title is set once from the first user message: its first non-empty line, whitespace collapsed, cut to 80 characters (`session.title-generated`, source `prompt`). When the adapter reports a provider-generated title (ADR 0015), the environment records it as the generated title (source `provider`) unless the user has set one; a user title always wins. When the adapter declares the capability, the environment mirrors a user title to the provider's own title field after commit, best-effort and never read back; the provider's tag field is never written.

### Merged groups by name: a client obligation

Groups never span environments as state. The client runtime merges groups from every connected environment whose names are equal after trimming, collapsing whitespace and ignoring case into one heading, whose text is the casing on the client's primary environment (else the first connected environment that has it). Headings follow the primary environment's group order; headings found only on other environments come after, in connection order, then by key. Inside a heading sessions sort by the rules above across environments, and every row carries the environment badge. Moving a session into a merged heading is `sessions.setGroup` on the session's own environment, preceded in the outbox by `groups.create` there with a client-minted id when that environment has no group of that name. Renaming a merged heading is one `groups.rename` per environment; a refusal on one splits the heading, which is accepted. Deleting one is one `groups.delete` per environment, confirmed once. The by-repository view is the same kind of view over `repositoryIdentity` (ADR 0005).

### Sync semantics: outbox, last writer wins, unreachable environments

The client runtime implements the outbox (ticket 80); its semantics are fixed here. Commands issued while an environment is unreachable queue per environment in issue order with their command ids and replay in order on reconnect. Until the command's receipt arrives, the client shows the effect as a pending overlay derived from the outbox; the cache is written only by events and snapshots. An accepted receipt retires the outbox entry and its overlay, whether it produced an event (which arrives on the list stream at or before the receipt's sequence) or was a no-op with `changed: false`, in which case the projection already shows the result. Conflicts resolve as last writer wins per field by log sequence, no merge logic: an offline pin replayed after another client's unpin wins because it lands later. A rejected receipt drops the command with a one-line notice naming the session and the reason. An unreachable environment shows its cached sessions and groups under its name with an "unreachable since" marker; organisation commands queue as pending; starting runs is disabled.

### Deletion, grace and purge

`sessions.delete` appends `session.deleted` with `purgeAt` thirty days out (a constant, not a setting, so no step registry entry is owed). The session vanishes from the list at once; within the grace period `sessions.restore` brings it back unchanged and `sessions.listDeleted` shows what can be restored. The sweep purges every session whose `purgeAt` has passed: it deletes the session's events, transcript snapshots, projection rows and tags, appends one `session.purged` event as the only event left on that stream (a tombstone, so a client replaying from an older cursor learns the id is gone), and, when the deleted event asked for it and the adapter offers the capability, has the adapter delete the provider's transcript, recording the outcome in the tombstone. Otherwise the provider's transcript is untouched. `sessions.purge` runs the same purge now.

### Auto-settle: rules and settings

The sweep runs every five minutes, at startup, and when either setting changes. A candidate is not deleted, not archived, has `settledOverride` null, no run starting or running, no parked prompt or open question (ADR 0006; the permissions workstream names the events), and is not snoozed. Idle rule: the anchor is the latest of `lastActivityAt`, `unsettledAt` and, after a snooze, its `snoozedUntil`, so a session snoozed until Tuesday gets a full span from Tuesday; a candidate whose anchor is older than the span (calendar months when the unit is months) is settled with `settledBy: auto-idle`. Merge rule: with the setting on, a candidate one of whose pull requests moved to `merged` at or after its anchor is settled with `settledBy: auto-merge`; a pull request closed without merging settles nothing. Changing a rule never reopens a settled session. Session fields are not settings and have no wizard step (ticket 79). The two auto-settle keys register in the step registry under the Appearance step's entry, in a "Sessions" band of its settings pane, with a health check that passes on any valid value, so ADR 0016's contract test holds without a new step; the Set up workstream may re-home them.

### Snooze expiry

The sweep appends `session.unsnoozed` (reason `expired`) for every session whose `snoozedUntil` has passed; a client treats a past `snoozedUntil` as awake to cover the sweep's latency.

### Projections

Read models in the environment's SQLite database, written in the same transaction as the events and rebuilt from the log by the environment's rebuild command: a sessions table with a column per summary field plus the user and generated titles, `deletedAt`, `purgeAt` and the transcript-deletion flag; a session-tags table unique on session and lowercased tag; a groups table unique on lowercased name. The list snapshot is read from these tables.

### The contract test and the lint

**Contract test**, in the contracts package: a field table maps every key of the summary schema to its owning command (`draft` to `sessions.setDraft`) or, for a field written by a system event (`activity`, `pullRequests`, `lastActivityAt`), to the `list`-flagged event type that writes it. It fails when a key is missing from the table, a named command is not in the registry, or a named event type is not flagged. Its behavioural half runs through the primary seam: for every user-set field it issues the owning command through a real client and asserts the event, its patch and the changed summary.

**Lint**, a rule in the repository's lint configuration run in CI with a fixture test proving it fires: in every client package (client runtime, terminal UI, GUI, web) it forbids a store, atom, slice, reducer key, preferences key, settings key or web-storage key whose name contains `archive`, `pin`, `order`, `group`, `tag`, `settle`, `snooze`, `title`, `rename` or `draft`, ignoring case, outside the client runtime's projection cache module, its outbox module and one allowlisted presentation module whose keys are enumerated (`collapsedHeadings`, pane layout, sidebar width). Adding a presentation key means adding it to that list, a review event rather than a lint error.

### What this workstream does not decide

- 78 env: the frame, envelope, receipts, replay bound, snapshot mechanics, transcript compaction, the rebuild command, pairing and scopes.
- 80 client runtime: the outbox's implementation, cache retention, the connection registry, capability flags, the desktop-shell interface; this spec fixes what those must do for session state.
- 81 tui and 84 gui: rendering, the badge design, drag, undo notices, shortcuts (every Artemis shortcut keeps working, ADR 0004), search over cached summaries.
- 82 claude-adapter: run and transcript events and their names, the transcript snapshot, provider titles, the transcript-deletion capability, stopping the provider process on delete. 83 permissions: which prompt and question events count as pending, and their TTLs.
- 85 workspace-picker: workspace kinds, the repository identity value, the by-repository view. 87 forge: producing the reserved pull-request events. 88 setup: the registry entry's pane and check. 92 routines: how a firing tags and files its session. 94 switch-over and ticket 56: the import, which uses these commands.
- 86 launcher-update, 89 skills-instructions, 90 banks, 91 key-managers, 93 browser: nothing here.

## Testing Decisions

A good test drives a real client against an environment and asserts what a client sees: a receipt, an event with its patch, a summary in a snapshot, a subscription ending with a reason. It never reads a table or a private structure, save the one lower seam where the behaviour is the bound itself.

- **Primary seam: an in-process environment and a real client.** The environment specification's helper starts an environment on a temporary data directory, bound to loopback on port 0, with the adapter contract satisfied by a scripted fake provider that can start and end runs and report a title, and hands back the thin typed client built from the contracts package over a real WebSocket; this workstream adds an injectable clock so the sweep can be advanced. Through this seam: every command's event, patch and summary change, the no-op receipt and each refusal; group delete ungrouping in one transaction; the companion events of settle, pin, unsettle, run start and run end; the title fallback in order and the mirror recorded by the fake adapter; two clients seeing the same list, and last writer wins when a second client's commands land later; the list and per-session subscriptions with replay, snapshot, `synchronized` and the `deleted` end; restore within grace, then purge past `purgeAt` leaving one tombstone; auto-settle at 14 days with every exclusion, the override after unsettle, a full span after a snooze wakes, calendar months, and settle on merge only with the setting on; snooze expiry; a rebuild giving the same snapshot. Prior art: T3 Code's server test suite with `buildAppUnderTest` and `withWsRpcClient`, its orchestration engine integration test with `TestProviderAdapter`, and Artemis's port-0 helper in its run-stream claim tests.
- **Two environments in one process** for the merge rules, in the client runtime's suite (ticket 80): one heading, its text and order, one command per environment on rename and delete, the create-then-set chain on a move, the merged sort; this spec supplies the expected orders.
- **Lower seam: the projector against in-memory SQLite** for the purge (events, snapshots, rows and tags gone, the tombstone present, receipts untouched) and a rebuild after a simulated projection bug. Prior art: T3 Code's event store and projection pipeline tests, and its decider tests for pins, settled, snoozed, active order and delete.
- **Contract tests in the contracts package**: the field table covers the summary schema and every owner exists (modelled on T3 Code's authorization test of one scope per method); every `list`-flagged event has a patch schema; the lint's fixture fails on a store `pinnedSessions`, a preferences key `sessionGroups` and a web-storage key `archived`, and passes the allowlisted keys.
- **Framework**: Vitest, serial files where a listener is bound.
- **Not tested here**: drag and rendering (81, 84), the Artemis import (56), the forge sync that produces merge events (87).

## Out of Scope

- Everything named under "What this workstream does not decide": the outbox and cache (80), rendering (81, 84), run and prompt events (82, 83), workspaces (85), pull-request sync (87), the settings pane (88), firing tags (92), the Artemis import (56, phase D).
- Hand-off between environments (ADR 0005, milestone 2); paging the archive and transcript search (later); a per-client group order, a per-session collapse and tags on groups (not planned).

## Further Notes

Chosen defaults not decided on a ticket, listed for review:

- Deletion grace 30 days as a constant; `sessions.purge` to skip it; the sweep every five minutes, at startup and on a settings change.
- Group name 1 to 80 characters, unique per environment ignoring case. The length is measured after trimming and before internal whitespace is collapsed, since the contracts' `GroupName` is a pattern (which the JSON Schema export keeps) and a pattern cannot collapse: 81 trimmed characters that would collapse to 80 are refused. Case is folded with `toLowerCase`, the environment's `groupNameKey`; the client merge (#127) should import the same function from the contracts package.
- A group id used before, even by a group since deleted, is `conflict` with reason `exists`, as a session id is.
- `name_taken` data carries the requested `name`, the holder's stored `heldName` and its `groupId`, so a client can re-point a queued `sessions.setGroup` at the group that holds the name.
- A rename to the group's own name once normalised changes nothing; a rename that changes only its case is a rename, not a clash with itself.
- Every group command on a group never created or deleted is `not_found` with data kind `group`, `groups.delete` of a deleted group included.
- Deleting a group also ungroups its deleted members still in their grace period, so a restore never brings back a `groupId` naming a group that is gone. The ungrouping is an organisation change and moves the deleted row's `updatedAt`; a restored session comes back as deletion left it except for that ungrouping. Its event carries no patch, since no client lists a deleted session.
- Tag 1 to 40 characters, unique per session ignoring case, at most 64, and one more `conflict` with reason `too_many_tags`; user title up to 200 characters; generated title 80 characters from the first prompt line; snooze at most one year ahead.
- The composer draft is a session field (conflict X3, resolved by ticket 115): `draft` on the summary, `sessions.setDraft` an absolute setter, `session.draft-set` its `list`-flagged event, following the `session.*-set` pattern. Up to 65,536 characters; an empty draft is stored as null; setting it does not move `updatedAt`, since typing is not organisation. Sending a message does not clear it here; that is the adapter workstream's to decide with its send method.
- `sessions.pin` on a pinned session: with no key or its own key it changes nothing; with another key it appends `session.pin-reordered`, keeping `pinnedAt`, so an outbox's pin still sets the key it carried.
- `settledAt` is what makes a session settled for shelf membership; unsettling clears it.
- The order-key alphabet and the sort rules of the Ordering subsection; the companion events of the Events subsection.
- Group collapse is client-local presentation keyed by heading name, on the lint's allowlist.
- Client-minted version 4 UUIDs for sessions and groups; no-op commands accepted with no event and `changed: false`.
- `settings.get` and `settings.update` as the generic settings methods; the auto-settle keys under the Appearance step's entry.
- A user title mirrored to the provider's title field when the adapter can; the provider's tag never written.
- Snooze expiry as an event; the summary patch in event metadata as the client's only reduction input.

Things a build session must verify first:

- That the environment specification's receipt allows an accepted command with zero events and a `changed` flag, and that event metadata may carry the summary patch; if either is refused, the patch moves to a sibling field of the list-stream message and the no-op becomes a one-event re-emission as in T3 Code.
- The names of the adapter's and permissions workstream's run and prompt events to flag `list`, and which prompt kinds count as pending.
- The step registry's shape from the Set up specification, so the two keys register under Appearance as assumed.
- Whether the pinned Claude SDK exposes a session title write and a transcript delete, and their stable names.
- That the environment specification's test helper accepts an injectable clock, or add it there first.
- That the Artemis import (ticket 56) can chain `groups.create` and `sessions.setGroup` with client-minted ids.
