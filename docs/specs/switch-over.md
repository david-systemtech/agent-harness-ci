# Spec: Switch-over: state import, Hermes cut-over, Milo on the TUI, the existing server stopped

Milestone 1, phase D. Date: 2026-10-02. Implements ADRs 0017, 0015, 0021, 0022, 0036 and 0037, with the owning decisions in ADRs 0003, 0004, 0006, 0008, 0010, 0013, 0016, 0018, 0020 and 0027 to 0035. Ticket: [#94](https://git.systemtech.dev:5526/david/agent-harness/issues/94).

Inputs: #94, #34, #29, #56, #39, #152, #88 and #90, including comments, Resolutions and corrections; all sixteen peer specifications and Further Notes, contracts and seams at main `1410d314ceb30f26aabdf7a39fe3f52d4490136c`, command contracts rechecked at `9228bd71d31e9e839447b09bb77531a68a71065c`; Hermes inventory and surfaces audit; private operational inventory, switch-over decisions and routine records. Verify observations live.

## Problem Statement

David needs a verifiable switch-over. Desktop preferences, terminal preferences and provider tags split organisation state. The surfaces audit (#11) found invisible Routine sessions, two schedulers and no Connection ceiling; Hermes inventory (#9) found unexecuted client tools and uncertain auxiliary calls. Default-directory-only import misses SAMPLE-SERVER's listed Claude directories (#56, ADR 0036). Daily use requires visible omissions, recoverable import, readable lazy history and per-machine acceptance before stopping the existing server.

## Solution

Carry over detects source data and terminal state on each machine. David previews four report groups, imports through owning services, finishes Set up and enables Routines manually. Adopted accounts keep their directories; Imported sessions appear immediately with history loaded on first open. Re-runs add new items and retry failures without overwriting harness edits.

The Hermes butler alone switches to SAMPLE-SERVER, retaining its Claude billing identity and bypass Ceiling; the librarian stays parked. Milo gets all four phase-D commands, with `/undo` and `/check` in both Clients. Reviewed notebook and meadowstudios migrations land on switch-over day after the team owner's heads-up; CLI `bank` verbs replace cerebro. Acceptance records daily workflows, health, contract checks and stopping evidence. David supplies the day and operators.

## User Stories

1. As David, I want source detection on each Environment, so that a headless install offers the same import as a desktop.
2. As David, I want a dry run with carried, re-enter, arriving in milestone 2 and not carried groups, so that omissions are visible.
3. As David, I want every listed Claude directory considered, so that no Sessions are missed.
4. As David, I want directories sharing an Account identity mapped to one Account, so that credentials are used from one chosen directory.
5. As David, I want secondary transcripts retained as import sources, so that their history survives without using their credentials.
6. As David, I want archive, pins and Groups imported once, so that every Client sees the same organisation state.
7. As David, I want Credential sources mapped without copying plaintext secrets, so that sign-in has an explicit repair step.
8. As David, I want imported Routines disabled, so that two schedulers cannot fire the same work.
9. As Milo, I want a one-time import of prompt history, snippets and after-edit commands, so that terminal habits remain available.
10. As Milo, I want my pins and drafts owned by the Environment, so that the GUI sees changes immediately.
11. As David, I want anchored fork, rewind and undo in both Clients, so that recovery works on the Claude Adapter.
12. As David, I want read-now and withdraw to preserve queued text, so that messages survive.
13. As David, I want the GUI to ship without a default stop key, so that Esc and copying do not stop a Run.
14. As the Hermes butler, I want SAMPLE-SERVER with my current Claude billing identity and bypass Ceiling, so that routing changes without changing my Account.
15. As the Hermes butler, I want client-tool round trips and auxiliary calls verified, so that chat is functional beyond a greeting.
16. As David, I want the librarian to remain parked, so that switch-over does not revive work I disabled.
17. As David, I want signed webhook delivery proved independently, so that a Routine result can reach Hermes when configured.
18. As a team owner, I want a heads-up issue before the team Bank moves, so that shared work can be reconciled.
19. As a Bank owner, I want reviewed migrations and green vendored validators, so that links survive.
20. As Set up, I want all eleven Steps registered with working Health checks, so that skipped features remain honest.
21. As David, I want a record of the existing server stopped on every covered machine, so that milestone 1 has one auditable done.
22. As Milo, I want `-p` to print one answer without a screen, so that shell pipelines work.
23. As Milo, I want `ls` to list stored Sessions here or across directories, so that I can select one from the shell.
24. As Milo, I want `/undo` in both Clients to restore the last agent file change safely, so that my own subsequent edits survive.
25. As Milo, I want `/check` in both Clients to run project checks after edits and offer failures, so that I choose what to send back.
26. As David, I want a week of normal use and every enabled Routine to fire on schedule before sign-off, so that acceptance covers real operation.
27. As David, I want all sources and backups kept until I approve deletion, so that recovery and lazy history remain available.

## Implementation Decisions

### Ownership, contracts and report

The source reader detects/normalises stores and returns typed records with scrubbed diagnostics, never credentials or raw documents; detection names remain inside ADR 0036's exception. The coordinator plans mappings/deduplication. Account, Carry over, Session state, Forge, Key manager, Bank, Routine, Skills, Instructions and Browser services own validation/writes. CLI and Clients invoke them (#56, #88).

Keep built `stateImport.detect`: a `read` query with empty params, nullable `dataFolder` (path/holdings) and `terminalFolder` (path); absent-store counts are zero, unreadable-store counts null. Follow reader precedence: environment override, desktop folder, headless folder; no unrelated scanning. `stateImport.run` is a prepared `admin` command requiring `commandId` and `dryRun`, returning `StateImportReport`; `no_source` and `import_in_progress` are `conflict` reasons. Register its handler before advertising `stateImport`, removing the owed-handler entry. Detection remains callable without that flag; the card requires flag and source (#581, #94).

Retain report names/shapes: `carried` counts Accounts, archive, pins, Groups, Forge accounts, Key-manager connections, Banks, Routines, Instructions, Skill sources, always-on skills, drafts and dev sites. `reEnter` names items/repair Steps; `later` deferred providers; `notCarried` category/count/replacement Step or null; `failed` item/reason. `clientLocal` returns mode, font size, conversation width, show-thinking and mapped settings row; `dryRun` identifies preview. Per-account `carryOver.inventory`/`carryOver.run` supply Session/memory/skills counts beside the report, including unadopted-Account previews (#88, ADRs 0021/0036).

Each application appends `state-import.finished` on the Environment stream as the initiating client session, with the registered report payload excluding `clientLocal`/`dryRun`, including partial failures. Dry runs append none. Carry over's last-import Health check needs attention for failures or unfinished attempts; an empty failure list clears import failure. Forges, Key manager and Memory bank check their repairs separately. `setup.check` runs checks; `setup` subscribes results (ADR 0031, #581).

### Preview, application and re-run

Choose one coordinator per Environment, including dry runs; states: preparing, applying, finished, failed. Before application append unlisted `state-import.started` with `importId` (parent command id) and canonical-folder `sourceKey`; item/finished events correlate that id. After restart an unmatched start needs attention until re-run finishes. Dry runs use the same exclusion/read-only plan: no adoption, credential refresh, copies, preferences, import events or completion markers; only normal receipt bookkeeping. Application replans; preview reserves nothing (#56).

Read stores before target transactions. Missing optional stores are empty; malformed, unsupported or unreadable stores fail independently. Snapshot each store's bytes; a change before application fails that part pending another preview. Use owning filesystem/git/provider bounds, without indefinite retry (ADRs 0021/0036).

Persist mappings by canonical folder, store kind and source id; id-less entries use natural identity (Forge origin/Group name), never list position. Deterministic child commands commit target events and mapping evidence together, sequentially under the parent prepared command before its report transaction. Earlier success survives later failure. Register unlisted `state-import.item-carried` with `sourceKey`, `kind`, `targetId`, `importId`, origin `import`, no secrets; its projection rebuilds mappings. Parent/child receipt ids differ (#56).

Mapped items stay held despite source changes, preserving harness pins, drafts, flags and Instructions; deleted targets remain absent. Failures have no mapping and retry; new ids are offered. Carry over retains provider-session deduplication/changed-memory copying. A fresh parent `commandId` requests a new report; receipt retries retain no result (#111). Recheck target conditions and service exclusions at commit.

### Accounts, Imported sessions and organisation state

List source-declared Claude directories only. Put other providers' profiles/Sessions/archive in `later` for milestone 2. Resolve Account identity without sign-in/copying credentials; reuse registered directory/identity. Duplicates choose latest source use, ties source-id order. Unreadable identity fails. Preserve labels with numeric suffixes within label limits. Map active profile to default Account; failure preserves existing default (ADR 0036).

Add internal listed-directory adoption; do not widen ambient `accounts.adopt` into unrestricted path adoption. Preserve adopted-directory lifecycle. Add internal Carry over secondary-source reads under the winning Account and optional source-directory locator on Imported session origin in contracts. Listing/lazy history use it; credentials use only the winning directory. The Adapter hydrates its Session store from source transcripts for continuation without secondary authentication/copying sign-in. Prove the pinned SDK seam before rollout; failure leaves affected Sessions read-only and blocks acceptance (ADRs 0018/0021/0036).

Run Carry over per adopted Account and each secondary source, with the Skills tick on by default when items exist, preserving the tracked-checkout offer. History is appended once on first open, including subagent transcripts; missing Workspaces remain listed and read-only until replaced. Keep source directories readable for pending lazy history and first continuation after stopping the existing server (#39, #56).

After provider-session mapping, union archive tags/source keys; import program/bridge ledger origins, ephemeral connection Workspaces archived. Routine firings nobody continued import archived; a firing whose SDK-reported first prompt is a person’s later prompt imports active, with no extra transcript reads (#756, David’s 2026-10-02 decision). Union desktop Account-qualified pins and terminal bare ids. Qualified keys use Account mapping; bare ids require one imported Session. Unknown/ambiguous references are not carried. Merge normalised Group names, preserving source order and appending after existing Groups without reordering. Use shelf companions/import timestamps. Fill only empty drafts, rechecked at commit; distinguish held/ambiguous/invalid reports (ADRs 0003/0036).

### Other state and local presentation

Group credentials by canonical Forge origin (ADR 0020); Key-manager references win without resolving secrets. Encrypted-only credentials yield source `none` and Forges repair; plaintext tokens never copy and require repair too. Name discarded competing Banks without values. Aliases need same-identity verification. Carry Key-manager address, CA, auth method, username and connection ids unsigned-in. Incompatible occupied ids fail without retargeting references; credentials require the Key manager Step (ADR 0036, #56).

Register each Bank at its existing checkout through `banks.register`, preserving role, mapped Account scopes, source default and `importedFrom`. An unresolved scope must not become all Accounts: fail it for repair. A missing `BANK.md` remains needs attention pending migration. The master memory switch and follow-ups-as-issues flag are not carried. Bank secrets follow the Forge and Key-manager rules, not a second vault (#90).

Use `routines.import` disabled on each source machine, converting connection-pinned Workspaces to local requests. Absent/deferred Accounts, unresolved Workspaces and unsupported schedules fail without runnable guesses. Preserve schedule/time zone; deduplicate upstream watch from its reviewed workstream document. History/pre-check baselines do not carry. Manual enable revalidates Account, permissions, skills, delivery and actual Connection Ceiling, never silently source bypass (ADRs 0008/0036).

Custom prompts and overridden built-ins become owned Instructions with mapped scope and enabled state; untouched built-ins and dismissed suggestions are dropped. Tracked repositories become Skill sources with branch or pin; apply known always-on names per mapped Account and report unknown names. Dev sites and evaluate-everywhere enter the local page policy through its owning settings seam. Browser Pairing secrets and saved server Connections never carry; link to Browser and Your machines (ADRs 0029, 0030, 0036).

Return client-local fields only to the initiating Client. Apply after real import only with platform proof of the source machine's local Environment identity; otherwise show unapplied. Map settings addresses through the total map. CLI prints unapplied values (#88, ADR 0027).

Choose `agent-harness state-import [--dry-run] [--json]` using local grant/typed wire; text prints per-account inventory and four groups, JSON the report. Exit 0 success, 1 failed item, 2 usage. `agent-harness tui --import-terminal-state` reads detected local terminal state before mounting: history by timestamp/text occurrence, Session ids only when Environment-held, snippets by name with existing names winning, after-edit commands into unset entries. Atomically persist per-source completion with local documents; partial invalid data is reported/only successful parts marked. Retain history bounds; execute nothing during import. Pins/drafts go through Environment import. Composer seeds, Session model choices, layouts and file frecency are not carried (ADR 0036).

### Phase-D commands and parity

All four ship in milestone 1 phase D (David, 2026-10-02), superseding both specs' deferrals. Chosen parity default: `/undo`/`/check` share runtime actions/projections and both slash menus. Print/list are terminal-only because stdout, pipelines and exits are their surface; they add no GUI Session verb. Update the parity contract. Add `fileUndo`/`workspaceChecks` capability flags only with working handlers; both Clients show absent-with-reason without them.

**Printing:** `agent-harness tui -p <prompt>` (alias `--print`) mounts no Ink screen. Accept existing `--environment`, `--session`, `-c`, `--cwd`, plus `--model`, `--mode`, `--effort` and `--output-format text|json|stream-json` (default `text`); reject incompatible Session selectors, empty prompts and unknown formats with exit 2. Reuse TUI Environment and new-Session selection (`projections.newSession`); `-c` selects the latest non-archived Session in that Environment and directory from `sessions.list`, updated time descending, id ascending on ties, failing if none. Resolve Account/model through the current selection and `GET /v1/models`.

Printing calls existing `POST /v1/chat/completions` (ADR 0015): selected credential, user message, streaming/usage, `agent-harness` fields `sessionId`, fresh `workspace`, `permissionMode`, `thinking`, `attended: false`. Programs keep this same surface and client-tool passthrough; printing declares no caller tools, adds no endpoint/Provider/tool host, and preserves unattended decisions/Ceiling clamps. `sessions.get`/`projections.session` track preflight/delivery: refuse a live Session; a racing start follows completions' queue rules.

Text mode writes only assistant content deltas to stdout, once, and a final newline. Activity, clamps and failures go to stderr. JSON prints one final object with `type: result`, `environmentId`, nullable `sessionId`/`runId`, `text`, nullable `CompletionUsage`, `durationMs`, `reason`, nullable `error` message string; unresolved Environment id is null. `stream-json` prints each parsed completion chunk as one JSON line, then that result, excluding SSE heartbeats and `[DONE]`. Preserve the built `agent-harness.ended.reason`; early failures use `error`. Denials/clamps stay diagnostic; a completed turn still exits 0. Never invent usage/cost. A valid JSON format emits a result even on usage/transport failure. Exit 0 only for a completed turn without a waiting message, 1 for error/non-completed turn/unread queued input, 2 for usage, 130 for SIGINT; SIGINT withdraws this caller's unread message through `runs.withdraw`, or interrupts only the Run that read it through `runs.interrupt`, then disconnects. Broken stdout exits 1 without retrying the prompt.

**Listing:** `agent-harness ls [--environment <name-or-id>] [--cwd <path>] [--all] [--json]` uses the same Environment selection and `sessions.list` under `read`, never source files. Default is the current directory on that Environment; `--all` removes the directory filter, not the Environment boundary. Compare normalised absolute Workspace paths on the Environment; a remote invocation must give its directory or `--all`. Include archived/Settled/Snoozed Sessions, exclude deleted ones, and sort updated time descending then id ascending. Text has columns `id`, `updated` (UTC ISO timestamp), `branch`, `title`, using the recorded worktree branch or `-`, flattening title newlines. JSON is one `{environmentId, summary}` row per line with the built `SessionSummary`; zero rows prints nothing and exits 0. Exit 1 on unreachable/refused/read failure, 2 on usage; diagnostics go to stderr. This uses the same summaries as `projections.sessionList`, with no cached data silently presented as live.

**File undo:** `/undo` restores the last successful agent file-change record, one file at a time, newest completion first; a multi-file call uses reverse path order for ties. It neither rewinds conversation nor calls `sessions.undoRewind`. Existing `diffs.session`, `diffs.workingTree`, `files.read` and `projections.session` show changes but cannot restore them. Add `files.undo`, a prepared `terminal` command with `commandId` and `sessionId`, returning `{changeId, path, action}` where action is `restored` or `deleted`. Both Clients call it through `requests.call` and invalidate diff queries on success or `files.undo-finished`; extend `diffs.session` to exclude consumed change records.

The Environment owns bounded pre-images for Claude Edit/MultiEdit/Write/NotebookEdit, captured through blocking `PreToolUse`/`PostToolUse` Adapter hooks before/after successful writes, composed with the existing tool gate. Keep 50 changes, 2 MiB per file and 16 MiB total per Session; unknown, binary, oversized and imported-history edits are unrestorable. Unobserved shell edits supply no undo record; later disk changes still fail the hash guard. Retain explicit absence for a newly created file. Refuse any live Run sharing the Workspace; use `conflict` reasons `run_active`, `workspace_missing`, `unsafe_path`, `nothing_to_undo`, `snapshot_unavailable` or `file_changed`; never skip an unrestorable newest record to undo an older one. Serialise workspace writes, compare the current file with the post-image immediately before restoring, preserve file mode and leave git index/stash untouched. Keep pre-images private to the Environment, never in events. Persist them and a prepared-operation journal: restart recognises an applied restore, records completion without repeating it, and refuses intervening edits. Append unlisted `files.undo-finished` with change id, path and action, no file contents; extend `projections.session` to render its row in both Clients. Success consumes that record; refusal writes nothing. No redo.

**Checks:** `/check` shows the current directory's command; `/check <command>` saves the shell text verbatim; `/check off` clears it; `/check now` runs it even without an edit, reporting an unset command instead of executing nothing. Choose Environment-owned configuration keyed by canonical Workspace directory, shared across Sessions and Clients and persisted across restart. Add `checks.get` query and `checks.set`/`checks.run` prepared commands, all under `terminal`, taking `sessionId`, commands also `commandId`; set takes nullable `command`, run returns `terminalId`. Get/set return `{workspace, command}` with nullable command; unset run is `conflict: check_unset`, busy manual run `conflict: check_running`. An unlisted Environment notice `checks.changed` with Workspace path and nullable command invalidates the shared runtime `projections.checks(environmentId, sessionId)` query view. Imported Client-local after-edit text stays inert until the user explicitly saves it with `/check`; do not enable shell execution during import.

The Environment schedules one check after each completed Run with a successful recognised file edit, deduplicated by Run id across Clients/replay. Persist configuring client session identity and deduplication/pending state; recheck its `terminal` grant before automatic execution, showing revocation; manual checks use the caller's grant. On restart, finish interrupted checks as failures without replaying shell work. Use the existing `terminals.run` execution seam, shell/cwd semantics and `terminals.subscribe` output via `subscriptions.terminal`; no renderer runs a local shell for a remote Workspace. Serialise directory checks; coalesce busy edits into one follow-up attributed to the latest edited Session. Off/change cancels pending work and stale failure offers, not running checks; their rows remain. After 120 seconds close through `terminals.close`; record timeout and exit null. Retain at most 64 KiB scrubbed output, marking truncation; close exited terminals after retaining results. Register unlisted Session events `checks.started` and `checks.finished` carrying terminal id, command, source Run id (null for manual), output, truncation, exit and timeout on finish; `projections.session` renders the same `$` row and status in both Clients. Missing Workspace/refused launch is an explicit failure. Nonzero exit or timeout offers output for sending, never sends automatically: Enter with an empty composer or Send failure explicitly uses the shared send action. Identical command/output/exit failures are offered once until a pass, changed command, off or manual now resets deduplication. Checks never run agent turns themselves.

Session snapshots carry each check as a `check` transcript item at its `checks.started` sequence, with `terminalId`, verbatim `command` and nullable `sourceRunId`. Its `state` is `running` with `result: null`, or `finished` with a result holding `output`, `truncated`, `exitCode`, `signal`, `timedOut` and `failure`. A later finish updates the same item, including one carried by a compaction or hidden in a rewind. Both Clients read the item and the two events through the shared session projection and draw the same `$` row and status; a check is separate from its source Run's turn.

### Hermes cut-over and Bank migration

Pair only the butler on SAMPLE-SERVER as `program` with `read`, `sessions:write`, `runs:drive` and #29's `bypassPermissions` Ceiling. Store its credential in the configured OpenBao connection's base. Preserve current Claude Account identity/subscription billing; verify identity and Account-qualified id with live `GET /v1/models`, never saved settings. Scopes do not limit model discovery to one Account; model selection identifies the borrowed Account. Other programs keep `acceptEdits` (ADRs 0015/0006).

Update deployment code to SAMPLE-SERVER's harness URL and built `agent-harness` namespace, without inventing an alias. Set `permissionMode: bypassPermissions`, supported `thinking`, appended `systemPrompt`, required `ignoreUnsupported`, `attended: false`. Preserve fresh scratch Sessions where no `sessionId` is sent. Hermes runs caller tools and returns matching `tool_call_id` on the same `agent-harness.sessionId`/credential, never as fresh user messages. Prove streaming, tool round trip, two-turn chat, model/effort routing, `/keep` and `/save` (#29, #9).

Configure compression/auxiliary calls explicitly; overrides need not inherit. Keep title generation off until effort/unsupported parameters pass. Retain the privately recorded Hermes version pin, butler-only scope and parked librarian; verify deployment inventory live. Notebook remains durable memory; Hermes profiles/memory/cron are not imported. Retirement/native Matrix/Slack remain milestone 3 (#29).

A configured Routine webhook uses the built Standard Webhooks signature and a delivery-only Hermes route. Prove signature verification, Matrix destination and idempotent retries. Preserve existing alert routes in their configured state and preserve Matrix rooms. Record deployment-specific selections in the private acceptance record.

Record clean Bank heads/reconcile branches. `banks.migrate {bankId, dryRun}` previews then prepares reviewed PRs. Notebook gains org metadata, manifest, renamed keys, repository identities, topics and orientation pointers. Meadowstudios uses team org, brands as projects, systems as areas, holding facts under holding; `SYSTEM.md` becomes `AREA.md`. Preserve memory names/pointers, remove generated indexes/obsolete keys, vendor validation for each forge (ADR 0037, #90).

Before meadowstudios lands, its heads-up issue tells the team owner moves/day/open-work effects. Both PRs need owner review and green vendored validation on landing heads. Land together on switch-over day, sync checkouts, prove harness read/search/reviewed write. Replace cerebro with CLI `bank`, including terminal Claude's local grant; retain source checkouts/PR links (#90).

### Operational order and milestone-1 done

Acceptance rows per machine/Environment: OS user, folders, Accounts, operator, preview/application reports, repairs, Bank heads, Pairings, enabled Routines, evidence links. David supplies complete coverage/operators: SAMPLE-SERVER/container, all David/Milo desktops/terminal folders, EXAMPLE-VM Hermes. Include no-source machines; unknown coverage blocks done (ADR 0017).

Order: inventory/backups; preview/repair; quiesce source work/schedulers; final preview/apply; finish Set up/prepare Bank PRs; switch/prove Hermes; Client acceptance; land reviewed Bank migrations that day; manually enable Routines with source schedules disabled; stop existing desktop/server, disable autostart/updaters, verify after restart. Preparation pauses do not count as retirement. Preserve source/lazy-history folders; no concurrent turns against shared adopted sign-in.

Rollback disables harness Routines, restores saved Hermes deployment/credential reference, and resumes source only after shared-directory harness Runs/Provider processes stop. Bank recovery uses reviewed revert PRs. New harness Sessions remain; no reverse import. Keep source folders, backups and lazy-history sources until David explicitly approves deleting them; no automatic deletion, even after sign-off.

Each workstream owes acceptance evidence; historical build debts require reconciliation:

| Workstream | What acceptance still owes |
| --- | --- |
| #78 Environment | Non-root installation, identity across restart, Pairing/revocation, replay and receipts; reconnecting Clients keep live Runs. |
| #79 Session state | ADR 0003 session-field contract, Groups/pins/archive/drafts seen identically by two Clients; lazy import and re-run preserve edits. |
| #80 Client runtime | Outbox and recovery evidence; drive commands fail immediately offline; capability reasons and import notices reach both Clients. |
| #81 TUI | Milo's terminal/tmux acceptance; build all four phase-D commands (`-p`, `ls`, `/undo`, `/check`), print/list exits and formats, file guards/check offers and GUI parity; defaults, incremental rendering, editor/diff workflows and labelled gaps. |
| #82 Claude Adapter | Listed-directory adoption, secondary-source history and continuation, process reuse, subscription billing, client-tool round trips and queue operations. |
| #83 Permissions | Ceiling clamps, unattended denials/review, Trust gate and containment on deployed platforms; signed-in `auto` availability and known git-write gaps recorded. |
| #84 GUI/Desktop shell | Seven Panes and native shell checks per deployed OS, shortcut Settings, no default stop key, `/undo` and `/check` parity, and the phase-D theme picker. |
| #85 Workspace picker | Directory/worktree/scratch and missing-workspace recovery; repository identity and account-scoped auto memory resolved on real checkouts. |
| #86 Launcher/update | Server artefact and service installation, desktop packaging, trial/rollback, parked prompts, container and host-updater checklists on deployed platforms. |
| #87 Forge | Origins/aliases, helper injection under containment, Bank git credentials and owner-review reads; primary Forge and release channel reachable. |
| #88 Set up | Contract check for all eleven `STEP_ORDER` ids registered, budgets/cadences/triggers/skip checks; Health checks callable and results subscribed per Environment. |
| #89 Skills/Instructions | Source sync and Readiness, imported copies/scopes, trusted repository loading and stable instruction composition including Banks. |
| #90 Banks | BankService handlers and five Set up card methods, scope seams/read exemption, reviewed notebook and meadowstudios migrations, each Bank's vendored validator green, CLI `bank` replacement. |
| #91 Key managers | Re-entered sign-ins, references, child-token permissions and renewal/revocation, locked-screen/keychain behavior, scrub checks and CLI minimums. |
| #92 Routines | Disabled import and deliberate enable, pre-check/no-change, silence, kept output/delivery; upstream-watch hand-off with one scheduler and no duplicate Monday. |
| #93 Browser | Fresh local Pairing, real-Chrome extension/relay and snapshot checklist, headless availability by deployment and imported page policy; completions defaults remain honest. |
| #94 Switch-over | Per-machine dry run with nothing unexpected under not carried, completed application/repair, Hermes acceptance, one week of normal use, each enabled Routine firing on schedule, and existing server stopped everywhere covered. |

The eleven ordered ids are `account`, `carry-over`, `your-machines`, `forges`, `key-manager`, `memory-bank`, `skills`, `instructions`, `browser`, `permissions`, `appearance`. Check every Step; declared optional skips pass, stubs for required features do not (#88).

In both TUI and GUI on Claude, demonstrate fork from a user-message anchor while its source continues, draft and organisation inheritance, rewind with later history hidden, undo before another Run, and refusal during a live Run. Demonstrate read-now consuming the whole queue exactly once and withdraw returning unread text to the Session draft; late withdrawal is refused. Check the TUI's Esc/Ctrl+C defaults, Ctrl+Enter and empty-composer Up, row `w`/`f`, and `/rewind undo`. In a fresh GUI configuration Esc leaves a Run running and Ctrl+C copies; Stop and its palette action work, and Ctrl+C cannot be bound to stop. ADR 0022's parity contract must name these behaviors (#152 corrections).

Prove David's daily Sessions across the inventory and Milo's normal TUI workflow, including four commands/GUI parity. Final sign-off follows one week of normal use after cut-over and at least one scheduled Firing of each enabled Routine. Run-now does not substitute; wait past the week for schedules still unfired. Resolve not-carried/re-enter entries; deferred providers belong to milestone 2. Record release-head CI/manual checks and inapplicable platforms; required unrun checks block done. Prove no source listener/process/scheduler, disabled restart paths and successful harness Client/Hermes exchange afterwards. David signs acceptance; the spec completes no deployment.

### What this workstream does not decide

The acceptance table names each owning workstream. #94 specifies import orchestration/actions, four phase-D commands with Client/runtime/Adapter/Environment hand-offs, operational order and acceptance. Implement through those owners' seams; do not bypass peer contracts.

## Testing Decisions

Use Vitest at the typed wire, projections and CLI, observing fixture bytes/results rather than private mappings. Primary seam: in-process Environment, scratch directory, loopback port 0, scripted fake Provider/manual clock, typed client over real WebSocket. Use fixture stores, git Banks, fake Forge and signed loopback receiver, never user data.

Cover detection precedence, absent/malformed/unreadable stores, terminal-only sources, flags/scopes; unchanged preview/application counts and zero preview domain writes; replanning/changed-store refusal; SAMPLE-SERVER without ambient sign-in; duplicate identities/ties, secondary history/continuation; ambiguous references, archived program/Routine Sessions, empty-only drafts and preserved Groups/edits.

Crash after an item commits, restart and re-run: no duplicate target appears. Inject a service failure; retain earlier success and retry failures. Concurrent Clients get `import_in_progress`. Receipt retries do nothing; fresh commands report the plan. Deleted mapped targets stay deleted. Read lazy history from the secondary fixture exactly once with credentials supplied only from the winning Account.

Assert secret-free references/repairs, non-widening scopes, disabled Routines/inert after-edit imports and deduplicated upstream watch. Remote/local presentation must follow machine identity. TUI file fixtures cover malformed history, collisions, retention, write failure and atomic markers.

Ink/runtime/scripted Environment and GUI/jsdom harnesses cover report groups, repairs, parity/stop defaults, undo success/refusals, check get/set/off/now, status/truncation and explicit failure sending without automatic prompts. The wire seam covers pre-image capture before writes, multi-file order, created-file deletion, external edits, path/symlink guards, unavailable snapshots, bounds, restart/receipt recovery and diff invalidation. Provider/manual-clock cases cover completed edited turns only, two Clients/replay producing one check, busy coalescing, timeout, revoked grants, command persistence, duplicate failures and reset conditions. A fake terminal executor supplies output/exit without running project commands. CLI HTTP/SSE/wire fixtures cover formats, one result, chunk fragmentation, clamps, unattended denials, failures, selectors, SIGINT/broken output; list tests cover directory/all/remote filtering, filing states, ordering, empty lists, JSON rows and exit codes. Assert printing uses the existing completions path and starts no Provider directly. A scripted Hermes HTTP caller exercises streaming, tool result continuation with the same credential and Session id, clamp reporting and auxiliary parameters. Fake deployment/Forge/Bank seams prove butler-only changes and review/validator/heads-up gates.

Contract tests register new import/undo/check schemas/events, one scope per method, both Clients' shared verbs, all eleven Steps and no `stateImport` flag with an owed handler. Regenerate schema exports when building contracts. Allow one lower bound/volume seam against in-memory SQLite. Prior art: T3 Code's `buildAppUnderTest`, `withWsRpcClient`, OrchestrationEventStore, RpcAuthorization and TestProviderAdapter; audited host/run-claim/remote and 57 Ink suites (#11). Service managers, keychains, terminals, Chrome, packaged desktops and Hermes/Matrix need user-machine acceptance.

## Out of Scope

Milestone 2 owns other adapters/carry-over, Bots/roster, bot-cron transfer, Hand-off, web Client and new Routine triggers. Milestone 3 owns native chat adapters and Hermes retirement; milestone 4 owns model placement. Continuous synchronisation, reverse import, automatic file restoration during conversation rewind, imported browser Pairing secrets and automatic source-data disposal are excluded.

## Further Notes

Chosen defaults: serial imports, item mappings/child receipts, source-byte consistency, source-id ties, numeric label suffixes, omitted ambiguous ids, preserved Groups/deleted targets, CLI formats/exits and atomic import markers. Parity: both Clients offer `/undo`/`/check` with Environment-owned execution/config; print/list are terminal-only stdout/exit forms, printing through existing completions. Undo/check contracts above are new additions. Use the built `agent-harness` namespace.

Before building, verify pinned-SDK listed-directory/secondary-source continuation without credential copies and blocking pre/post tool hooks for undo; derive source fixtures from audited writers; reconcile Bank handler/review/credential debts, interrupted-import health and atomic TUI persistence. Before execution, prove Hermes auxiliary overrides, continuation, `/keep`/`/save` and pinned deployment. Failures block acceptance.

David decided on 2026-10-02: build all four commands in phase D; switch only the butler to SAMPLE-SERVER using its current Claude billing identity and bypass Ceiling, checking model ids live; require one week of normal use and a scheduled Firing of every enabled Routine before sign-off; retain sources, backups and lazy history until his deletion approval, never automatically.

Research: Notebook archives #9/#11. No installs, builds, tests, browsers or live actions were run.

Still David's before live actions: switch-over date (both Bank migrations land that day) and complete machine inventory/operators. Live actions await that record.
