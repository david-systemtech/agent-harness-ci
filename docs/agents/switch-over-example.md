# Switch-over: synthetic acceptance exercise

Deployment labels, identities, paths and observations here are examples. Keep the
actual inventory, version pins and operator approvals in a private acceptance record.

A filled example for the [record](switch-over-acceptance.md) and
[runbook](switch-over-runbook.md). **Every machine detail, path, head, result,
observation and date below is invented.** `example-*` identifiers are not live
resources. No installation, sign-in, import, deployment, webhook, Bank landing,
Routine enable, restart or deletion was performed. “Pass” below means a fixture
satisfies the written gate; it certifies no live operation. The real owner's
tracker links assign work only and are not fixture evidence.

## Complete fixture record

- Record: `example-record`; evidence: the local anchors in this document.
- Complete fixture inventory/operators confirmed by simulated David: 2030-04-01;
  exactly four rows below, no other David/Milo machine or terminal folder.
- Switch-over day/zone: 2030-04-02 / UTC; cut-over completed 18:00 UTC.
- Release/head: `example-release` / `example-release-head`; artefact/container:
  `example-artefact-digest` / `example-container-digest`.
- Contract CI: [fixture CI and platform results](#ci-and-platforms), pass on that head.
- Backup owner/operator: `example-david` for server, David desktop and Hermes;
  `example-milo` for Milo desktop. Restore-tested snapshots: [saved inputs](#saved-inputs).
- Normal use: 2030-04-02 18:00 through 2030-05-01 12:00, [daily log](#daily-use).
  Earliest one-week sign-off: 2030-04-09 18:00. Actual gate evaluation:
  2030-05-01 12:00, after the slower scheduled Firing.
- Decision: **eligible for David's signature in the complete fixture only**.
  Live record remains unsigned/unexecuted; simulated operators cannot sign for David.

The invented folder convention below makes every retained location explicit:
`/example/<row>/source`, `/terminal`, `/winner`, `/secondary`, `/harness`,
`/banks/notebook` and `/banks/meadowstudios` all sit under that row's prefix.
There are no real credentials, transcript contents or signed request bodies here.

| Machine / Environment id | OS user / boundary | Folders | Accounts / identity / winner | Operator / backup owner | Detection / preview | Application | Repairs | Bank heads | Pairings / scopes / Ceiling / reference | Enabled Routines | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SAMPLE-SERVER/container / example-server | example-service (non-root); example-david on host | /example/server/{source,terminal,winner,secondary,harness,banks/notebook,banks/meadowstudios} | example-claude-david / example-david-identity / winner; secondary uses winner credential | example-david | example-server-detect/final-preview | example-server-apply/import-1 | Forge/Key manager repaired | example-notebook-land; example-team-land | example-client: all scopes/bypassPermissions; example-butler: program read,sessions:write,runs:drive/bypassPermissions; locator personal/harness/example-butler (no value) | example-watch, example-monthly | [import](#import-and-set-up), [retirement](#retirement) |
| David desktop / example-david-env | example-david; Linux desktop | /example/david/{source,terminal,winner,secondary,harness,banks/notebook,banks/meadowstudios} | example-claude-david / example-david-identity / winner | example-david | example-david-detect/final-preview | example-david-apply/import-2; terminal marker done | saved Connection repaired by fresh Pairing | example-notebook-land; example-team-land | example-david-client all scopes/bypassPermissions; example-browser fresh local Pairing, no imported secret | none | [Clients](#clients), [platform](#ci-and-platforms) |
| Milo desktop/terminal / example-milo-env | example-milo; Windows desktop | /example/milo/{source,terminal,winner,secondary,harness,banks/notebook,banks/meadowstudios} | example-claude-milo / example-milo-identity / winner | example-milo | example-milo-detect/final-preview | example-milo-apply/import-3; terminal marker done | missing Workspace replaced; ambiguous pin resolved | example-notebook-land; example-team-land | example-milo-client all scopes/bypassPermissions; example-browser fresh local Pairing | none | [Clients](#clients), [import](#import-and-set-up) |
| EXAMPLE-VM Hermes / example-no-local-environment | example-butler; Linux host; connects to example-server | no source/terminal/adopted/secondary/Bank folder by detection; /example/hermes/deployment retained; no local harness data | borrows example-claude-david on example-server, same identity | example-david | example-hermes-detect: no source | inapplicable: no local Environment/source, detection proved | none required | remotely uses example-server Banks at the two landing heads | example-butler credential reference above; no second Pairing | none locally | [Hermes](#hermes), [retirement](#retirement) |

## Saved inputs

Fixture backups `example-server-snapshot`, `example-david-snapshot`,
`example-milo-snapshot` and `example-hermes-snapshot` cover every row's source,
terminal, harness state, clean Bank branches/heads, startup/updater and schedule
configuration. The Hermes snapshot includes deployment and credential reference
without a credential value. Restore checks all pass on copies at 2030-04-01.
Sources, backups and lazy-history folders remain readable; deletion approval is
not given. Shared adopted directories have a single turn owner throughout.

## Import and Set up

Fixture source schedules and turns are quiesced at 2030-04-02 08:00 before final
previews at 09:00 and applications at 10:00. Source Provider processes stopped;
no concurrent turn against winner sign-in directories. Source bytes stayed stable.
Each application has a correlated completion record and healthy last-import check.

For all three source rows: `carried` includes one mapped Account, Sessions,
archive/pins/Groups/drafts, Forge/Key-manager records, two Banks, disabled local
Routines where present, Skills/Instructions and page policy. Account inventory:
4 Sessions (1 archived), 1 secondary source, 1 memory folder, 1 Skill source.
First-open primary/secondary history loads once, continuation uses the winner
without secondary credentials, and re-run preserves edited Groups/pins/drafts.
Server has no ambient sign-in; listed directory adoption is the source.

Final `failed` is empty. `reEnter` originally names Forge, Key manager and saved
Connection: fixture repairs at 08:30 complete Forges/Key manager and fresh Your
machines Pairing, followed by clean previews. `notCarried` initially contains
Milo's ambiguous pin and missing Workspace; mapping/replacement resolves them.
Browser Pairing omission is intentional, replaced by fresh Browser Pairing on both
desktops. `later` contains `example-other-provider`, deferred to milestone 2 under
[#94][94]'s provider boundary, never represented as adopted. Client-local values
apply only on the proven local desktop; server CLI reports unapplied values.

Terminal history/snippets and completion markers commit once on David/Milo;
re-runs add no duplicate. After-edit text stays inert until explicitly saved with
`/check`. All imported Routines stay disabled through Bank landing.

For each of `example-server`, `example-david-env`, `example-milo-env`, fixture
checks register/call/subscribe all eleven in order: account, carry-over,
your-machines, forges, key-manager, memory-bank, skills, instructions, browser,
permissions, appearance. Budgets/cadences/triggers and declared skip checks match
[#1192][1192]'s contract. All Health results pass; no required stub or unrun check.
EXAMPLE-VM has no local Environment and owes remote Program acceptance instead.

## CI and platforms

`example-ci-result`: contract CI passes on `example-release-head`, including
session fields, queue/parity, all eleven Steps, schemas and four-command contracts.
Fixture manual results on that same head pass for Linux desktop/server/container,
Windows desktop/service/keychain/Git/tools/junctions/camera/Chrome, packaged desktop,
launcher trial/rollback, parked prompts and host updater. Browser fixtures record
headless sandboxed launch and honest availability per deployment, extension/
relay/snapshot/page-set/dock/port-rewrite/reload and local QR camera checks.

macOS is **platform inapplicable** in this fixture: the complete simulated inventory
has no macOS deployment and simulated David approved that scope on 2030-04-01.
Its checklist is not marked passed. The live inventory is still David's input;
this invented exclusion cannot waive a real macOS machine. No required check is
unrun in the complete fixture. Real open builds/confirmations are not closed here.

## Clients

Fixture David and Milo observe identical Groups/pins/archive/drafts in two Clients;
reconnect keeps the live Run and replay/receipts are stable. Outbox/recovery passes,
with immediate offline drive refusal and both Clients showing capability reasons
and import notices. Workspace directory/worktree/scratch and missing recovery,
repository identity and Account-scoped auto memory pass on fixture checkouts.

Fixture Milo's tmux, incremental transcript, editor/diff and default keys pass.
`-p` text/JSON/stream-json, selector/exit/cancellation/broken-output cases and live
`ls` directory/remote/all/order/archive/empty cases pass. Both Clients offer guarded
file `/undo`, matching refreshed transcript/diffs, and `/check` show/set/off/now,
coalesced automatic edited-turn checks and explicit failure-send offers.

Anchored fork leaves the source running and carries the correct draft/organisation;
rewind hides history, conversation undo ends when another Run starts, live rewind
refuses; read-now consumes the whole queue once and withdraw restores unread draft,
refusing late withdrawal. TUI Esc/Ctrl+C/Ctrl+Enter/empty Up/row w,f/rewind undo pass.
Fresh GUI Esc preserves the Run, Ctrl+C copies and cannot bind to stop, Stop/palette
work. Seven Panes/native shell/shortcut Settings and seven-seed, three-theme picker,
swatches/clamps, preview/cancel/import/export/notice propagation pass. Appearance
confirmation decisions are supplied in this fixture; no claim closes [#435][435]/[#640][640].

Permissions fixture proves Ceiling clamps, unattended denial/review, Trust gate and
containment for both deployed OSes; signed-in auto availability and git-write limits
are recorded as labelled capability reasons, not silently represented as supported.
Skills sync/Readiness, imported scopes/copies/trusted loading and stable Bank-aware
Instructions pass. Key-manager repaired references/child-token permissions/renewal/
revocation, locked-screen keychain, scrub checks and tool minimums pass for the
providers actually deployed in this fixture. Bitwarden is not selected/enabled;
its [#1122][1122] debt cannot be silently applied to a required deployed connection.

## Hermes

Fixture operator `example-david`, 2030-04-02 11:00: butler alone switched to
example-server; the selected receiver version, same example-david Claude subscription identity,
librarian parked. Live-model **fixture response** selects
`example-claude-david/example-model`, Account-qualified, not a saved id.
Program scopes read/sessions:write/runs:drive and bypassPermissions Ceiling pass;
credential lives by reference in OpenBao agents. Other Programs use acceptEdits.

Streaming/two-turn/tool-result round trips keep credential, Session and matching
tool_call_id; fresh scratch without sessionId, supported thinking/systemPrompt/
ignoreUnsupported/attended:false and model/effort routing pass. Compression and
auxiliary overrides tested independently; titles remain off. `/keep` and `/save`
pass. No Hermes profile/memory/cron import; notebook remains durable memory.

Delivery-only route accepts valid signed payload and rejects missing/wrong
signature, modified body and timestamps outside ±300 seconds. Correct fixture
room `example-room` gets `example-message-1`; a lost-ack 5xx retry at +1 minute
keeps `example-webhook-1`, refreshes timestamp/signature and yields exactly one
message. Failure is a Client notice, no-change/silence yield no Matrix message.
Matrix rooms stay unchanged; example alert routes stay disabled and all controlled
fault injection is removed. These observations are invented, not [#1009][1009] execution.

| Accepted pinned-Hermes gap | Fixture observed result (example-david, 2030-04-02) | Decision / tracking |
| --- | --- | --- |
| Deduplication lost across restart | example-webhook-2 accepted; receiver restart; retry 200 posts a second example-room message, example-message-2b. | Example maintainer acceptance applies only to this named behavior and selected receiver version; fixture upstream locator example-upstream-restart. |
| Failed Matrix send counted as delivered on retry | example-webhook-3 initial Matrix send fails, HTTP 502; retry +1 minute answers 200 duplicate, history delivered but no room message. | Example maintainer acceptance applies only to this named behavior and selected receiver version; fixture upstream locator example-upstream-send. |

## Banks

| Bank | Clean source / branches | Prepared PR / approval | team owner heads-up | Landing / validator | Synced evidence |
| --- | --- | --- | --- | --- | --- |
| notebook | example-notebook-source; no unreconciled branch | example-notebook-pr; personal owner example-david reviews and merges by hand | inapplicable: personal Bank | 2030-04-02 14:00 / example-notebook-land; example-notebook-validation green on that head | all attached checkouts at example-notebook-land; read/search and reviewed write example-notebook-write-pr pass |
| meadowstudios | example-team-source; example-open-work reconciled | example-team-pr; sole manifest owner example-david reviews and merges by hand | example-heads-up, 2030-04-01; team owner receives moves/day/open-work effects | 2030-04-02 14:10 / example-team-land; example-team-validation green on that head | all attached checkouts at example-team-land; read/search and reviewed write example-team-write-pr pass |

Counts/names/links, converted manifests/topics/orientation and green vendored
validators pass; owner rules, stricter merge rule and non-author approval cases
pass in fixture contract CI. BankService handlers/five card methods/scopes/read
exemption/credentials/helper/review reads pass. CLI `bank` verbs with terminal
Claude local grant replace cerebro; source checkouts/PR locators retained.

## Scheduled Firings

Both fixture Routines revalidate Account, Workspace, actual Ceiling, permissions,
skills and delivery before deliberate manual enable; source schedules remain disabled.

| Environment / Routine | Enable / schedule / zone / next due | Scheduled Firing / history / Session / outcome | Remaining wait |
| --- | --- | --- | --- |
| example-server / example-watch | 2030-04-02 15:00; Monday 09:00 UTC, next 2030-04-08 | 2030-04-08 09:00; example-watch-history / example-watch-session, success | none; one scheduler, no duplicate Monday |
| example-server / example-monthly | 2030-04-02 15:00; first of month 09:00 UTC, next 2030-05-01 | 2030-05-01 09:00; example-monthly-history / example-monthly-session, success | none only after May 1; April 9 was too early |

Pre-check/no-change, silence, kept output/delivery pass in fixture results.
A separate Run-now delivery probe exists but does not count for either row.

## Retirement

| Row | Source absence / disabled restart paths | Restart and post-restart exchange | Retention |
| --- | --- | --- | --- |
| example-server | source listener, desktop/server/Provider processes and scheduler absent; source service/autostart and host updater disabled | 2030-04-02 17:00 container/host-path check, still absent; example-client and butler exchanges succeed | source/secondary/history and example-server-snapshot readable |
| example-david-env | source listener/process/Provider/scheduler absent; desktop logon/autostart/updater disabled | 17:10 reboot/logon, still absent; Client to local/server and butler exchanges succeed | source/secondary/history and example-david-snapshot readable |
| example-milo-env | source listener/process/Provider/scheduler absent; source Windows startup/task/updater disabled | 17:20 reboot/logon, still absent; TUI/GUI and server/butler exchanges succeed | source/secondary/history and example-milo-snapshot readable |
| example-no-local-environment | detection/process/startup inventory proves no source listener/process/scheduler or source autostart/updater; Hermes remains running | 17:30 Hermes host restart, source still absent; butler streaming/tools with server succeed, librarian parked | saved Hermes deployment/config/reference readable |

No preparation pause is counted as retirement. Matrix preservation and
example alert-route state rechecked afterwards. No folder is deleted.

## Daily use

Fixture daily log covers each date April 2–May 1: David uses server/desktop Sessions,
Milo uses TUI/tmux and editor/diff plus all four commands, shared GUI/TUI parity and
Hermes remain functional. At least one week elapses after cut-over; the monthly
Routine delays gate evaluation until May 1. There are no unresolved unexpected
notCarried/reEnter entries, external failures or required unrun checks.

## Filled workstream matrix

Each row uses the full criteria from the blank record. All results refer to
example-release-head, the fixture operators and April 2–May 1 above; owner links
are inherited from the template, not evidence. The only platform exclusion is
approved macOS absence under [CI and platforms](#ci-and-platforms).

| Workstream | Linked fixture evidence / result | Owed evidence in fixture | Inapplicability |
| --- | --- | --- | --- |
| [#78][78] | [saved inputs](#saved-inputs), [platforms](#ci-and-platforms), [Clients](#clients), [retirement](#retirement): pass | none | macOS outside fixture inventory |
| [#79][79] | [import/Set up](#import-and-set-up), [Clients](#clients): pass | none | none |
| [#80][80] | [Clients](#clients): pass | none | none |
| [#81][81] | [Clients](#clients), [daily use](#daily-use): pass | none | none |
| [#82][82] | [import](#import-and-set-up), [Hermes](#hermes): pass; winner/reuse/billing/queue | none | none |
| [#83][83] | [Clients](#clients), [Hermes](#hermes): pass with labelled platform reasons | none | macOS outside fixture inventory |
| [#84][84] | [Clients](#clients), [platforms](#ci-and-platforms): pass | none | macOS outside fixture inventory |
| [#85][85] | [Clients](#clients), [import](#import-and-set-up): pass | none | none |
| [#86][86] | [platforms](#ci-and-platforms), [retirement](#retirement): pass | none | macOS outside fixture inventory |
| [#87][87] | [Banks](#banks), [Clients](#clients): pass; fixture primary Forge/release channel reachable | none | macOS outside fixture inventory |
| [#88][88] | [import/Set up](#import-and-set-up), [CI](#ci-and-platforms), [Banks](#banks): pass | none | no local Environment on Hermes host |
| [#89][89] | [Clients](#clients), [import](#import-and-set-up): pass | none | macOS outside fixture inventory |
| [#90][90] | [Banks](#banks): pass | none | none |
| [#91][91] | [Clients](#clients), [platforms](#ci-and-platforms): pass | none for selected providers; other-provider debt retained | macOS outside fixture inventory; Bitwarden not deployed |
| [#92][92] | [scheduled Firings](#scheduled-firings), [Hermes](#hermes): pass with two named accepted gaps | none; both gap observations recorded | none |
| [#93][93] | [platforms](#ci-and-platforms), [import](#import-and-set-up): pass | none | macOS outside fixture inventory |
| [#94][94] | [daily use](#daily-use), [retirement](#retirement), all ledgers above: fixture eligible | none in fixture; all live execution still owed | no-source import proved on Hermes host |

Rollback not invoked in the complete fixture. Saved inputs have restore proof;
rollback order is harness Routines off, saved Hermes deployment/reference restored,
shared-directory Runs/Provider processes stopped **before** source resumes, reviewed
Bank revert PRs/validators/synced heads. New harness Sessions retained, no reverse
import. Deletion approval: not given. Acceptance signature: **unsigned, David only**.

## Incomplete fixture variants

Change just the indicated observation in the complete fixture. Each decision is
blocked until the missing condition is supplied; no other passing row can replace it.

| Variant | First failed gate | Expected decision |
| --- | --- | --- |
| David cannot confirm whether another terminal folder exists | Unknown inventory coverage | blocked; enumerate/confirm, including no-source rows |
| Only an [#831][831] link, no packaged desktop result | Required evidence missing | blocked; owner link is not an observed result |
| Required Windows service check marked not run because no machine available | Required platform evidence unrun | blocked; unavailable is not inapplicable |
| A Step is registered but its handler/Health result is a stub | Required eleven-Step contract | blocked; registry alone is insufficient |
| Evaluate on April 9 before example-monthly fires; only Run-now exists | Every enabled Routine needs a scheduled Firing | blocked until May 1 scheduled Firing, even after one week |
| Two days of normal use only | At least one week after cut-over | blocked even if all schedules already fired |
| Wrong-signature delivery accepted, or lost-ack retry duplicates | External signature/retry failure beyond the two [#1009][1009] gaps | blocked; the example two-gap acceptance does not cover it |
| Known gaps have recorded acceptance, but their required probes were not run | Required known-gap observations missing | blocked; accepted limitation still needs recorded observation |
| Forge sign-in or secondary continuation still fails; unexpected notCarried/reEnter remains | Unresolved repair/external failure | blocked; cannot rename it a milestone-2 provider |
| Only notebook lands, or a validator ran on a pre-reconciliation head | Both same-day reviewed migrations/landing-head validation | blocked; record partial state and rollback decision |
| Source stopped for apply but updater/autostart remains, no restart proof | Final retirement and post-restart exchange | blocked; preparation pause is insufficient |
| No-source Hermes host omitted from final restart checks | Coverage/retirement | blocked; no-source does not remove operational checks |

This exercise verifies the template's decisions, not any real deployment. All live
inventory, checks, dates, observations and David's signature remain owed.

[78]: https://git.systemtech.dev:5526/david/agent-harness/issues/78
[79]: https://git.systemtech.dev:5526/david/agent-harness/issues/79
[80]: https://git.systemtech.dev:5526/david/agent-harness/issues/80
[81]: https://git.systemtech.dev:5526/david/agent-harness/issues/81
[82]: https://git.systemtech.dev:5526/david/agent-harness/issues/82
[83]: https://git.systemtech.dev:5526/david/agent-harness/issues/83
[84]: https://git.systemtech.dev:5526/david/agent-harness/issues/84
[85]: https://git.systemtech.dev:5526/david/agent-harness/issues/85
[86]: https://git.systemtech.dev:5526/david/agent-harness/issues/86
[87]: https://git.systemtech.dev:5526/david/agent-harness/issues/87
[88]: https://git.systemtech.dev:5526/david/agent-harness/issues/88
[89]: https://git.systemtech.dev:5526/david/agent-harness/issues/89
[90]: https://git.systemtech.dev:5526/david/agent-harness/issues/90
[91]: https://git.systemtech.dev:5526/david/agent-harness/issues/91
[92]: https://git.systemtech.dev:5526/david/agent-harness/issues/92
[93]: https://git.systemtech.dev:5526/david/agent-harness/issues/93
[94]: https://git.systemtech.dev:5526/david/agent-harness/issues/94
[435]: https://git.systemtech.dev:5526/david/agent-harness/issues/435
[640]: https://git.systemtech.dev:5526/david/agent-harness/issues/640
[831]: https://git.systemtech.dev:5526/david/agent-harness/issues/831
[1009]: https://git.systemtech.dev:5526/david/agent-harness/issues/1009
[1122]: https://git.systemtech.dev:5526/david/agent-harness/issues/1122
[1192]: https://git.systemtech.dev:5526/david/agent-harness/issues/1192
