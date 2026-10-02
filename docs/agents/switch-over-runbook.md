# Switch-over: operator runbook

The day-of path for [#94][94], specified in [Switch-over](../specs/switch-over.md)
and ADRs [0017](../adr/0017-milestone-1-is-the-switch-over-built-in-four-phases.md),
[0036](../adr/0036-the-state-import-adopts-listed-provider-directories-in-place-and-carries-environment-state-through-the-owning-services.md)
and [0037](../adr/0037-every-bank-is-org-project-area-a-team-bank-is-created-on-any-forge-reviewed-by-its-owners-and-joined-from-a-preview.md).
This document prepares operations; writing it performs none. Live execution is
[#1197][1197]. David supplies the complete machine/folder inventory, operators
and switch-over day, and alone signs acceptance.

Copy the [acceptance record](switch-over-acceptance.md) before execution. The
[synthetic example](switch-over-example.md) shows the gates without live evidence.
Each step below adds dated, sanitized evidence to that record. An issue link is
an evidence owner, not proof of execution. Check the current release head and
tracker before starting: open implementation, confirmation or required manual
checks remain owed. Never substitute an automated fixture for a deployed check.

## 1. Inventory and save rollback inputs

1. David confirms coverage of SYSTEM-SERVER/container, every David/Seth desktop
   and terminal-state folder, and SYSTEM-MNL Hermes. Record one row per
   machine/Environment, including OS user, the container's host/operator boundary
   and no-source machines. Split rows for multiple Environments/users. List every
   source data folder, listed Claude directory, secondary transcript source,
   terminal folder, Bank checkout and harness data folder. Unknown coverage stops
   execution and blocks done; absence of a source needs an observed detection result.
2. Assign an operator and backup owner per row. Save source stores and terminal
   state, harness state, clean Bank heads/branches, service/autostart/updater and
   scheduler definitions, and the current Hermes deployment/configuration and
   credential **reference**. Record snapshot locators and restore checks, never
   credentials or private transcripts. Keep a way to recover every affected row.
3. Capture the current butler's Claude Account identity and subscription billing,
   pin `v2026.9.24`, auxiliary overrides and parked librarian. Record Matrix room
   ids/Tuwunel deployment and disabled netdata routes as preservation checks.
   Keep sources, backups and lazy-history folders readable. No automatic deletion,
   during preparation or after acceptance: only David's explicit deletion approval
   permits it.

## 2. Preview and repair

1. On each Environment, observe `stateImport.detect` and the advertised
   `stateImport` capability. Preview with `agent-harness state-import --dry-run
   --json`, or the Carry over card's preview. No-source rows keep the detection
   evidence and mark application inapplicable with a reason, rather than running
   an import which reports `no_source`.
2. Save all four groups (`carried`, `reEnter`, `later`, `notCarried`), `failed`,
   client-local unapplied values and per-Account `carryOver.inventory` counts.
   Check every listed directory, winning Account identity/directory, secondary
   source, archive/pins/Groups/drafts, Banks, Routines, Skills and page policy.
   Do not rely on ambient sign-in on SYSTEM-SERVER. Secondary credentials must
   not be copied or used; prove lazy history/continuation through the winner.
3. Re-enter sign-ins/references through Forges and Key manager; repair Bank
   manifests/scopes, missing Workspaces, unknown skills and ambiguous references
   through their owning Steps. Record repairs and a fresh preview. Resolve each
   unexpected `notCarried` and every `reEnter` entry; intentional omissions need
   the replacement Step and its outcome. `later` providers are milestone 2 debt,
   not a claim that they imported. Failed required continuation or any unresolved
   external failure blocks acceptance.
4. Keep imports serial within an Environment and use fresh prepared command ids
   for a new report. A preview reserves nothing; changed stores require another
   preview. Verify crash/re-run and preserved harness edits through the linked
   implementation evidence, not by experimenting on live user data.

## 3. Quiesce source work and schedulers

1. Agree a pause with the operators, finish or stop source turns and disable all
   source schedules on each covered machine, including upstream watch's hand-off
   under [#988][988]. Record processes and schedule state before application.
2. Prevent concurrent turns against a shared adopted sign-in directory. Stop
   source Provider processes that could use it before harness turns begin. A
   second program refreshing the same credentials is not safe overlap.
3. Keep rollback inputs and source folders. A preparation pause is not retirement:
   final listener/process checks and disabled restart paths come in step 10.

## 4. Final preview and application

1. With source work/schedules quiescent, take a final preview on every source row.
   Compare it with the repaired plan and record changed-store refusals before
   retrying. Apply through `agent-harness state-import --json` or the card, then
   save the application report, import id and completion/Health evidence.
2. Run Carry over for each adopted Account and secondary source; retain readable
   lazy-history locations. Verify listing, first-open history and continuation,
   missing-Workspace repair, archive/pins/Groups/empty drafts and re-run preservation.
   Record failures item by item; partial success does not finish a row.
3. On each terminal-source machine use `agent-harness tui --import-terminal-state`
   once. Verify history/snippets and atomic completion; imported after-edit text
   remains inert until explicitly saved with `/check`. Client-local presentation
   applies only with proof of local Environment identity, never from a preview.
4. Imported Routines remain disabled. Browser Pairing secrets and saved server
   Connections never carry: pair afresh through Browser and Your machines.

## 5. Finish Set up and prepare reviewed Bank PRs

1. Run `setup.check` and subscribe to its results per Environment. Record all
   eleven ordered ids: `account`, `carry-over`, `your-machines`, `forges`,
   `key-manager`, `memory-bank`, `skills`, `instructions`, `browser`,
   `permissions`, `appearance`. [#1192][1192] owns registry/handler, budget,
   cadence, trigger, skip-check and subscription proof. A declared optional skip
   needs its state/reason; a stub or unrun required Health check cannot pass.
2. Follow [#1042][1042]/[#1043][1043] for `banks.migrate {bankId, dryRun}` previews
   and preparation of cortex/brandsolidate migration PRs. Record clean source
   heads, reconcile open branches, preserve memory names/links/counts, and get
   David's approval of topics and orientation. Record Albert's heads-up issue
   with the moves, agreed day and open-work effects **before** brandsolidate lands.
3. Use [#1032][1032]'s reviewed path: non-author manifest-owner approval for a
   multi-owner team Bank; the personal or sole team owner merges by hand. Keep
   both PRs prepared/unmerged until step 8. A missing handler, owner-review read,
   Bank credential or Set up card method stays a blocker in the evidence matrix.

## 6. Switch and prove only the Hermes butler

1. The assigned operator switches the butler on SYSTEM-MNL to SYSTEM-SERVER's
   harness URL and the built `agent-harness` namespace, retaining `v2026.9.24`.
   Leave the librarian parked. Pair as `program` with `read`, `sessions:write`,
   `runs:drive` and `bypassPermissions` Ceiling; other programs keep `acceptEdits`.
   Store the credential in OpenBao's agents namespace and record only its locator.
2. Read live `GET /v1/models`; select the Account-qualified model for the saved
   current Claude identity/subscription billing. Scopes do not restrict discovery
   to that Account; a cached setting does not prove billing identity. Record live
   selection and routing, without a credential value.
3. Prove streaming and two-turn chat; caller tool execution returns matching
   `tool_call_id` on the same `agent-harness.sessionId` and credential, not a fresh
   user message. Check model/effort routing, `permissionMode: bypassPermissions`,
   supported `thinking`, appended `systemPrompt`, required `ignoreUnsupported`
   and `attended: false`. No `sessionId` still creates a fresh scratch Session.
   [#1193][1193] owns scripted request proof; live checks are separately owed.
4. Configure/test compression and all auxiliary overrides explicitly: they need
   not inherit the main model/effort. Keep title generation off until its effort
   and unsupported-parameter checks pass. Prove `/keep` and `/save`. Do not import
   Hermes profiles, memory or cron; cortex remains durable memory.
5. Follow [the delivery checklist](../routines/hermes-delivery.md) and [#1009][1009]
   for the signed delivery-only route, Matrix destination and stable-id retries.
   The newer David decision on [#1009][1009] overrides older checklist wording for exactly
   two `v2026.9.24` gaps: deduplication lost across Hermes restart, and a failed
   Matrix send counted as delivered on retry. Record what each live probe observes
   and David's explicit acceptance dated 2026-10-02; see the record's gap rows.
   Live checks and upstream reports remain owed. [#1196][1196] owns the checklist
   clarification; do not patch its document or deployment here.
6. Require valid-signature delivery, rejection of wrong/missing signatures,
   altered bodies and old/future timestamps (300-second window), the correct
   Matrix room, and a lost-ack retry with one message. Any other signature or
   retry failure blocks acceptance. Keep netdata routes disabled; do not interpret
   older “confirm netdata still delivers” wording as authority to enable them.
   Preserve existing Matrix rooms and Tuwunel. Remove controlled fault injection
   and restore any chat settings reset by deployment rendering.

## 7. Prove Client acceptance

Use the matrix's existing owners and [desktop](desktop-checklist.md),
[service/install](service-install-checklist.md) and [browser](browser-checklist.md)
checklists on the deployed release head. Record per-platform passed/failed/not-run
results; explicitly justify any platform outside David's confirmed inventory.
An unavailable machine is an owed check, not platform inapplicability.

1. Demonstrate David's daily Sessions across the inventory and Seth's terminal/
   tmux, incremental rendering, editor/diff and normal TUI workflows.
2. [#1180][1180]/[#1181][1181]: `-p`/`--print` text, JSON and stream-json,
   selectors, exact exits and safe cancellation/broken stdout; `ls` live directory,
   remote-directory/`--all` boundaries, ordering, archived entries and empty output.
3. [#1185][1185]/[#1186][1186]: `/undo` in both Clients, file guards/refusals,
   latest-change restore/deletion and shared transcript/diff updates. This file
   undo is separate from conversation rewind. [#1189][1189]/[#1190][1190]: `/check`
   show/set/off/now, Environment-owned execution, coalesced automatic checks after
   edits, bounded failures and explicit send offers; no automatic failure prompt.
4. [#1191][1191]: fork at a user-message anchor while the source continues, draft/
   organisation inheritance; rewind hides later history, conversation undo before
   another Run, and live-Run refusal. Read-now consumes the whole queue exactly
   once; withdraw restores unread text to the draft and refuses late withdrawal.
   TUI Esc/Ctrl+C defaults, Ctrl+Enter, empty-composer Up, row `w`/`f` and
   `/rewind undo` work. Fresh GUI Esc leaves the Run running, Ctrl+C copies and
   cannot bind to stop, while Stop and its palette action work.
5. [#1194][1194]: Appearance's seven-seed picker, three themes, swatches/clamps,
   preview/cancel, import/export and saved-theme propagation, alongside seven
   Panes/native shell and shortcut Settings. Record labelled capability gaps and
   release-head contract CI plus required manual results; open build tickets do
   not prove these workflows.

## 8. Land both reviewed Bank migrations that day

Recheck owner approvals and green vendored validators on the **actual landing
heads**, including any reconciled commits. Land cortex and brandsolidate on the
agreed switch-over day, under the owner rules from step 5; record both merge
heads/PRs and Albert's earlier heads-up. If either cannot land, stop progression
and record the partial state for rollback; do not call a one-Bank day complete.
Sync every attached checkout and compare heads. Prove harness read/search and a
reviewed write with its landed files/head. Replace cerebro with [#1044][1044]'s
CLI `bank` verbs, including terminal Claude's local grant. Retain source
checkouts and PR links; do not delete or write Bank checkouts directly.

## 9. Enable Routines deliberately

Confirm source schedules remain disabled, then enable each chosen harness Routine
by hand after revalidating Account, Workspace, permissions, skills, delivery and
actual Connection Ceiling. Preserve schedule/time zone. Record every enabled id,
next due time and eventual scheduled Firing. [#988][988] owns upstream-watch service
accounts/time zone and one-scheduler/no-duplicate-Monday proof; do not reset its
ledger to force a result. Check pre-check/no-change, silence and kept output/
delivery. Run-now may prove delivery but cannot satisfy scheduled-Firing acceptance.

## 10. Retire source desktop/server and verify restart

Stop source desktop/server listeners, Provider processes and schedulers on every
covered row. Disable their autostart services, logon/startup paths and updaters;
record their definitions/state and observed absence, not just a preparation pause.
Restart each relevant machine/container or logon path, check again for source
listeners/processes/schedulers and updater relaunch, and then prove a successful
harness Client and Hermes exchange. Reconfirm librarian parked, netdata routes
disabled and Matrix/Tuwunel preserved. Keep retained source/lazy-history folders
readable even though their executables no longer start.

## 11. Observe normal use, then obtain acceptance

Keep a dated daily-use record for at least one week after cut-over, covering
David's inventory and Seth's TUI. Wait longer if any enabled Routine has not yet
had a scheduled Firing; skipped due times and Run-now are insufficient. Review all
machine rows, seventeen workstreams, repairs, external failures and release-head
CI/manual checks. Only explicitly inapplicable platforms and the two named [#1009][1009]
gaps may remain under their recorded decisions. Record deferred providers as
milestone 2. David signs only after every required gate passes. A prepared or
synthetic record cannot certify a live switch-over.

## Rollback

Invoke rollback when a required gate fails or David chooses it; record trigger,
operator, time and the last passed step. Retain logs and partial-success reports.

1. Disable harness Routines and verify no further Firings can start.
2. Restore the saved Hermes deployment/configuration and credential reference;
   verify its saved routing, butler billing identity and parked librarian. Do not
   expose credentials or change Matrix/Tuwunel or netdata route state.
3. Stop harness Runs and Environment-owned Provider processes using shared
   adopted sign-in directories **before** resuming source work or source schedules.
   Confirm no concurrent turns remain; only then restore saved source startup/
   scheduler definitions as needed and verify source operation.
4. Recover landed Banks with reviewed revert PRs, green validators and synced
   checkouts; record both Banks and any partial landing. Never reset a live Bank
   head or edit its checkout to bypass review.
5. Retain new harness Sessions: no reverse import. Keep sources, backups and
   lazy-history folders until David explicitly approves deletion, never automatically.

[94]: https://git.systemtech.dev:5526/david/agent-harness/issues/94
[988]: https://git.systemtech.dev:5526/david/agent-harness/issues/988
[1009]: https://git.systemtech.dev:5526/david/agent-harness/issues/1009
[1032]: https://git.systemtech.dev:5526/david/agent-harness/issues/1032
[1042]: https://git.systemtech.dev:5526/david/agent-harness/issues/1042
[1043]: https://git.systemtech.dev:5526/david/agent-harness/issues/1043
[1044]: https://git.systemtech.dev:5526/david/agent-harness/issues/1044
[1180]: https://git.systemtech.dev:5526/david/agent-harness/issues/1180
[1181]: https://git.systemtech.dev:5526/david/agent-harness/issues/1181
[1185]: https://git.systemtech.dev:5526/david/agent-harness/issues/1185
[1186]: https://git.systemtech.dev:5526/david/agent-harness/issues/1186
[1189]: https://git.systemtech.dev:5526/david/agent-harness/issues/1189
[1190]: https://git.systemtech.dev:5526/david/agent-harness/issues/1190
[1191]: https://git.systemtech.dev:5526/david/agent-harness/issues/1191
[1192]: https://git.systemtech.dev:5526/david/agent-harness/issues/1192
[1193]: https://git.systemtech.dev:5526/david/agent-harness/issues/1193
[1194]: https://git.systemtech.dev:5526/david/agent-harness/issues/1194
[1196]: https://git.systemtech.dev:5526/david/agent-harness/issues/1196
[1197]: https://git.systemtech.dev:5526/david/agent-harness/issues/1197
