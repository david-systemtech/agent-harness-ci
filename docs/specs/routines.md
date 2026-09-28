# Spec: Routines

Milestone 1 (Switch-over), phase C (the organs). Written 2026-09-28 from map ticket 92 of `david/agent-harness`. Implements ADR 0008 (routines environment-owned and quiet by construction; one scheduler per environment; every firing a session; delivery targets; the two-tap move; YAML without secrets; bots own routines in milestone 2), with ADRs 0006 (the unattended default, ceilings, containment per routine), 0007 (idle and drain), 0009 (skills and standing instructions), 0011 and 0028 (injection per routine), 0017 (phase, placeholder), 0020 (forge injection), 0027 (the Routines and bots band) and 0031 (health); decision tickets #22, #29 and #31 with their Resolution comments. It builds on the six phase-A specs and today's phase-B specs (workspace-picker, launcher-update, forge) and uses the names of the code on `main` at df17c83. Peers read: Hermes Agent at d3b25b5 (cron's pre-check, the autonomous silence rule, the catch-up policy, the webhook adapter's signature check), the hermes-inventory and surfaces port-audit write-ups, `docs/routines/upstream-watch.md`, and the memories `agent-harness-routines-and-bots-decided-2026-09-23`, `agent-harness-hermes-plan-decided-2026-09-23` and the write-up on the upstream watch routine on the routines server. The product name is the placeholder `agent-harness`.

## Problem Statement

David runs unattended work on two schedulers today and trusts neither. The desktop's fires only while its window is open. The server's delivers nothing (the headless host has "no notifications"), never records a firing in the session ledger, so its transcript cannot be opened over the wire, and opens in `bypassPermissions` unless told otherwise, while any connection token may create a routine and run it at once (surfaces audit, section 3). A routine with nothing to do still pays for a model run. Hermes has what those schedulers lack (a pre-check whose unchanged output skips the model, silence suppression, delivery to a room, per-routine skills, kept output), so the bots' schedules live there and the coding ones stay on those two schedulers, in two formats, with no way to move a routine off a machine that is down. The weekly upstream watch (#31) runs as a routine on the routines server with no pre-check, so every quiet Monday costs an Opus call, and its only delivery is the issue it files.

## Solution

Each environment owns its routines and one scheduler that fires them with no client connected. A routine is a named definition: a schedule or run now, instructions, a workspace request, an account by identity, model and effort, a mode within the ceiling of the client that last saved it, containment, skills, a pre-check, a silence marker and delivery targets. At a due time the pre-check runs first; if its output is unchanged since the last firing that completed, nothing else happens and the list says "no change". Otherwise the firing is a session tagged with the routine, whose run carries the instructions and what the pre-check found and never waits on a prompt. A final text that is the silence marker delivers nothing and settles the session; any other result goes to the delivery targets: a notice on every connected client, or a signed webhook POST to a named endpoint, which is how Hermes relays it to Matrix. Every client lists every connected environment's routines grouped by environment, edits them through commands that queue offline, and moves one elsewhere in two taps. Routines export to YAML without secrets and import anywhere. The upstream watch is the first routine the harness runs on itself.

## User Stories

1. As David, I want each environment to fire its routines with no client connected, so that a routine on SYSTEM-SERVER runs at 03:00 whether my laptop is open or not.
2. As David, I want schedules of manual, hourly, daily, weekdays, weekly, some days, monthly or cron in a named time zone, so that I say when in my own words.
3. As David, I want to run a routine now from any client, so that I can test it or get its result early.
4. As David, I want a pre-check before each firing that skips the model when its output is unchanged, so that an idle routine costs nothing.
5. As David, I want a firing that answers with the silence marker to deliver nothing and settle its session, so that quiet routines stay quiet.
6. As David, I want every firing to be a session tagged with its routine, so that I can open, continue, search and filter any result.
7. As David, I want a result delivered as a notice on every client I have open, so that I see it wherever I am.
8. As David, I want a result posted to a signed webhook, so that Hermes relays it to Matrix and anything else can receive it.
9. As David, I want each target to take successes, failures or both, so that failures reach me loudly and successes only where I want them.
10. As David, I want a webhook endpoint named once per environment with its secret kept there, so that routines share a Hermes route and none holds a secret.
11. As David, I want a failed delivery retried and, on final failure, raised as a notice, so that a down Hermes never silently loses a result.
12. As David, I want a routine's mode clamped to the ceiling of the client that last saved it, so that a phone paired low can never make a bypass routine.
13. As David, I want each routine to choose its skills, containment and credential injection, so that it has exactly the reach it needs.
14. As David, I want the list to show next firing, last outcome, failure streak and attention, grouped by environment with its badge, so that one glance tells me my routines are healthy.
15. As David, I want a history of firings and skips with kept text and pre-check output, so that "did last night's routine work" has an answer after its session is gone.
16. As David, I want to move a routine to another environment in two taps even when its own is down, so that a machine that is down does not stop my Monday routine.
17. As David, I want a moved routine's workspace re-resolved by repository identity, else scratch, the copies linked and a move back reusing the original, so that it lands in the right checkout and loses no history.
18. As David, I want routines to export to YAML without secrets and import with warnings for what the target lacks, so that they are files I can keep in a repository.
19. As David, I want a routine missed while its environment was down to fire once when it is back, within seven days, unless I say skip, so that a sleeping laptop catches up but never replays a week.
20. As David, I want a firing cut by an update continued and delivered once, so that updating costs a routine nothing.
21. As David, I want a maximum duration per firing, so that a looping model does not run all night.
22. As David, I want two firings of one routine never to overlap, so that a slow firing does not stack.
23. As David, I want the upstream watch on the harness with its pre-check, so that quiet Mondays cost no model call and the routines-server routine retires.
24. As Seth, I want `/routines` to list, run, enable, move and edit routines as YAML in my editor, so that I manage them without the desktop.
25. As Seth, I want a client-notice delivery on the activity line and in `/notices`, so that a result reaches the terminal.
26. As a routine, I want my firing started through the same run start as a person's, as my own actor with my name and saved ceiling, so that the Unattended review shows what I did.
27. As a routine, I want my session made by the same workspace resolver as any session, a worktree per firing when I ask, so that I run where a person would.
28. As the launcher, I want the scheduler to stop at a drain and a pre-check to count as a run starting, so that an update never loses a due time or cuts a pre-check.
29. As Hermes, I want the Standard Webhooks signature my route already verifies and a stable id per delivery, so that I relay each result once.
30. As a client developer in another language, I want the schedule maths, the silence rule and the YAML format as pure functions with published cases and schemas, so that my client agrees with the environment.
31. As a build session, I want every behaviour a test through an in-process environment with a manual clock, real scripts and a loopback webhook receiver, so that no test waits a real minute or needs Hermes.
32. As the setup checklist, I want routines to add no step and no settings key, so that the registry's contract holds and the Routines row shows its own health.

## Implementation Decisions

### Modules

- **contracts**: the routine definition and listed state; the schedule union with pure maths (validate, describe, next due time, due times between two instants); the silence rule; the YAML codec; the webhook payload and signature; the methods, events and notices below; each with a case table.
- **environment**: the **routine store** (a projector over the `routine` streams), the **scheduler**, the **firing engine** (pre-check runner, session and run start, run-end follower, duration timer, start pass), the **delivery worker**, the **endpoint store** (secrets in the vault) and the methods.
- **client runtime**: `projections.routines`, `projections.routineHistory`, `commands.moveRoutine`, the move settlement, two notice rows. **Renderers**: the GUI's Routines pane and the terminal UI's `/routines`.

### The routine

The **definition** is what YAML carries:

- `name`: the Tag rule (1 to 40 characters trimmed, no control or format character), unique per environment ignoring case, so it is also a valid tag.
- `schedule` (below) and `timezone` (IANA; preset the environment's zone at creation); `ifMissed`: `run-once` (preset) or `skip`.
- `instructions`: 1 to 100,000 characters.
- `workspace`: a workspace-picker request (`directory`, `worktree` or `scratch`; never `session`) with `repositoryIdentity`, what it resolved to when saved, for the move.
- `account`: an account identity (provider, email, organisation), or null for the default account at each firing (ADR 0008); `model` and `effort` as `sessions.create` and `runs.start` take them, or null for `accounts.defaultModelFamily` and `accounts.defaultEffort`.
- `mode`: one of the four, or null for `permissions.unattended.mode`; `containment`: a level, or null for `permissions.containment.default`, reaching the resolver as a session's own level does (ADR 0006; permissions spec, #133).
- `injection`: `inherit` (preset), `allow` or `deny`, ADR 0011's per-routine override, which also keeps or removes the forge variables and credential helper (ADR 0020).
- `skills`: names from the skill set, loaded always-on for the firing's runs as the composer's extra always-on names (skills-instructions workstream; Hermes's skill preload).
- `preCheck`: null, `{kind: script, path, timeoutSeconds}` or `{kind: url, url}`; `silenceMarker`: 1 to 64 characters, preset `[SILENT]`; `maxDurationMinutes`: 1 to 1,440, preset 60.
- `delivery`: up to eight targets, `{kind: client-notice, on}` or `{kind: webhook, target, on}` with `target` an endpoint's name and `on` one of `success`, `failure`, `both`; preset one client notice on `both`.
- `enabled`.

The **state** is the environment's, never exported: the id (a UUID the client mints, so a create can queue offline); `savedUnderCeiling`, the ceiling of the client session whose create, edit, import or enable last touched it (the permissions spec's name; disable and delete widen nothing and record nothing); who saved it; created and edited times; `movedFrom` and `movedTo` (environment, routine, when); the pre-check baseline; `handledThrough`; the live firing; the last outcome; the failure streak.

Structural problems refuse a save (`invalid_params` with paths). What the environment lacks does not: a routine can be saved before its script, account or endpoint exists, and shows it as attention.

### Schedules

- Schedule kinds, with named days: `manual` (run now only), `hourly {minute}`, `daily {at}`, `weekdays {at}`, `weekly {day, at}`, `days {days, at}`, `monthly {day, at}` (a month without the day is skipped, as cron does) and `cron {expression}`: five fields, `*`, lists, ranges, steps, month and day names, both day fields restricted combining with OR (Vixie cron's rule), no seconds or `@` forms. `at` is `HH:MM`.
- Minute resolution in the routine's zone. A local time a clock change skips fires at the first minute after the gap; a repeated one fires once, at its first occurrence.
- **The five-minute floor**: a schedule whose due times can fall under five minutes apart is refused, since every due time leaves a record.
- A **due time** is handled exactly once, as a firing or a **skip**. `handledThrough` is the latest handled, moved to the save time when a routine is created, enabled, or its schedule or zone edited, so no earlier due time is owed.

### The scheduler

- **One per environment**, in the environment process (ADR 0008; the desktop's is gone), armed by the start pass: one timer for the earliest due time, re-armed on every change, and a check every 60 seconds on the environment's clock that catches a sleeping machine or a clock jump.
- **Overlap**: while a firing of the routine is live, from its pre-check to its end, its due time is skipped `overlap`.
- **Concurrency**: at most four firings in a pre-check or run per environment; later due times wait in memory, in order.
- **Missed**: due times after `handledThrough` found over two minutes late collapse to the latest (Hermes collapses a backlog too). With `run-once` and that due time within seven days (chosen default), it fires now with trigger `catch-up`; otherwise it is skipped `missed`. Either record says how many due times it stands for.

### Pre-checks

- **Script**: a path relative to the environment's scripts directory (in the data directory, 0700) that stays inside it with links followed (as Hermes requires); a regular executable file (on Windows by extension). No arguments, stdin closed; the scrubbed base environment plus `AGENT_HARNESS_ROUTINE_ID`, `AGENT_HARNESS_ROUTINE_NAME`, `AGENT_HARNESS_DUE_AT`, `AGENT_HARNESS_TRIGGER` and the injection the firing's run would get (forge variables and helper; the key-manager block once 91 is built). Working directory: the directory the workspace request names, else the scripts directory. `timeoutSeconds` (1 to 600, preset 60) kills the process tree. Output up to 1 MiB, else `output_too_large`; the last 8 KiB of standard error kept for a failure.
- The scripts directory stays under the data directory's denylist preset (unlike the scratch and worktree roots), so no run writes a pre-check unless a person allows it. A pre-check is the environment's own process, like its git, and is not contained (permissions spec, #212): the OS user's script, placed by the OS user.
- **URL**: an `http` or `https` GET, up to five redirects, 30 seconds, a body up to 1 MiB; every host checked against the denylist's hosts, at save and at each firing (`denylisted`). A status other than 2xx is a failure.
- **Comparison**, as Hermes's cron makes it: SHA-256 of the exact output bytes, no normalisation, against the baseline. Unchanged: skipped `no-change`, with no session, model, delivery or notice. Changed, or no baseline: a firing. A failure: skipped `pre-check-failed`, delivered to failure targets, the baseline untouched.
- **The baseline** is the hash and output (scrubbed, first 64 KiB) of the pre-check of the latest firing that ended `succeeded` or `silent`, so a failed firing leaves the change for the next due time (Hermes advances at detection; a failure here retries rather than losing the change).
- **What the firing is told**: after the instructions, a fenced block, introduced as data the pre-check produced and not instructions (the wrapping ADR 0008 gives milestone 2's webhook payloads), holding a unified line diff against the baseline (at most 4,000 characters) and the output (at most 8,000; Hermes's caps), or a note that this is the first observation.
- **Run now** skips the pre-check unless asked (`withPreCheck`); a firing without one leaves the baseline alone. `routines.testPreCheck` runs one and records nothing.

### Silence

- **The rule**, Hermes's autonomous one as a pure function: silent when the first non-blank line, the last non-blank line or the whole text, each at most 64 characters, equals the marker once case is folded, inner white space collapsed and edge punctuation other than brackets removed; or when a bracketed marker opens the trimmed text (`[SILENT] nothing new`). A marker mid-sentence is delivered; empty text is not silence.
- The final text is the last firing run's `resultText` (`run.ended`), else its last assistant text.
- A silent firing delivers nothing and its session is settled at once with `settledBy` `routine`, a new `SettledBy` value, so quiet firings leave the active list.

### A firing

- **Start** (a changed or absent pre-check, a catch-up, run now): the account identity must resolve to a signed-in account here (null: the default account), the model be one it offers, each skill be in the skill set; else skipped `cannot-start` with the reason, a failure. The workspace resolver runs next (workspace-picker spec; a worktree request makes one per firing); a refusal is `cannot-start` `workspace_unusable`. Then one transaction, as the completions surface's turn is: the session created through `sessions.create`'s path as actor `routine:<id>`, the firing id its command id so a retry after a crash makes nothing twice, titled "<name> <yyyy-mm-dd HH:MM>" in the routine's zone, tagged `routine` and the routine's name, with its account, model and mode; `routine.firing-started`; and the run through the environment's `startRun` seam (#131) as actor kind `routine` with the routine's name and `savedUnderCeiling` as ceiling (for run now, the lower of that and the caller's). The seam's request gains effort, containment, the injection override and skills. A start refused there rolls the transaction back and is `cannot-start`, so no firing session lacks a run.
- **The first message**: a header (the routine, the environment, the due time, that nobody is present and prompts are answered automatically, and that answering with the marker alone sends nothing), the instructions, the pre-check block.
- **Unattended** (permissions spec: nothing marks a routine attended): prompts never park, denials are recorded, and the Unattended review lists the run under the routine's name. Standing instructions compose as for any run (ADR 0009); a bot's persona layer is empty until milestone 2.
- **The firing's runs** are its first and any the environment starts to continue it (an update's, origin `update`); a person's message into the session starts attended runs that are theirs.
- **Duration**: `maxDurationMinutes` after the start, the live run is interrupted with a new interrupt cause, `timeout`.
- **End**, read by a log subscriber from its runs' `run.ended`: `completed` is `silent` or `succeeded` (empty text succeeds, body "The firing finished without a final message."); `error` fails `run_error`; cause `timeout` fails `timed_out`, cause `restart` fails `restart`; a person's interrupt is `cancelled`, and so is `disposed` when the session was deleted (else it fails `restart`); `drained` waits, following the continuation when `run.update-interrupted` says `continued` (`routine.firing-continued`), failing `drained` with its reason on any other outcome, and failing so at the start pass when the drain was no update's.
- `routine.firing-ended` records outcome, reason, final text (at most 16,000 characters), usage, duration and whether the baseline advanced; deliveries follow. A routine deleted meanwhile ends its firing `cancelled`, the run going on as the session's; one edited or disabled meanwhile finishes under the definition it started with, whose targets `routine.firing-started` recorded.
- **Failure streak**: consecutive failed firings and failing skips (`pre-check-failed`, `cannot-start`), reset by `succeeded`, `silent` or `no-change`.

### Delivery targets

- `succeeded` goes to targets on `success` or `both`; a failed firing or failing skip to `failure` or `both`; `silent`, `cancelled`, `no-change`, `missed` and `overlap` to none.
- **Client notice**: `routine.delivered` on the environment stream once the end commits: routine id and name, the firing or skip, the session (null for a skip), outcome, a summary (the text's first non-blank line, at most 200 characters, or the failure's reason) and a body (at most 4,000). Every connected client raises it; one reconnecting from a held cursor raises it as news (client-runtime spec), within the environment stream's replay bound.
- **Signed webhook**: a POST of JSON (`type` `routine.result`, `version` 1, the environment's and routine's id and name; `entry`: its id, `kind` `firing` or `skip`, trigger, due time, start and end times (a skip's both its record's time), outcome (`succeeded` or `failed`), reason, and session (null for a skip); `summary`; and `text` up to 16,000 characters, a skip's being its failure's detail) with Standard Webhooks headers: `webhook-id` (entry and target, stable across retries so a receiver dedupes), `webhook-timestamp`, and `webhook-signature` `v1`, a base64 HMAC-SHA256 over id, timestamp and body keyed by the endpoint's secret (a `whsec_` secret's decoded bytes, else its bytes), which Hermes's adapter verifies within its 300-second replay window. Ten-second timeout, no redirects; 2xx delivers; a network error, timeout, 408, 429 or 5xx retries after 1, 5 and 30 minutes; any other status, or a missing endpoint or secret, fails at once. Each attempt is `routine.delivery-attempted`; pending retries survive a restart; a final failure raises `routine.delivery-failed`.
- **Webhook endpoints**, environment-owned: a name (lower-case letters, digits and hyphens, 1 to 40, unique); a URL, `https`, or `http` only to loopback, `localhost`, a private or tailnet IP address or a `.ts.net` name, so a result sent in the clear never crosses the internet, with no userinfo, its host checked against the denylist's hosts; and a secret, pasted (sent once in `routines.endpoints.set` over the paired connection, kept in the vault, never returned: ADR 0020's rule for tokens) or a key-manager reference resolved per delivery through 91's registry (`unsupported` until 91 is built). A client may generate a `whsec_` secret locally to paste into both ends.

### Methods on the wire

One scope each (env spec); commands take a `commandId`.

- **Queries at `read`**: `routines.list` (every routine with definition, state, next due time, live firing, last outcome, streak, effective mode and clamp, and attention: `account_missing`, `account_signed_out`, `model_unavailable`, `skill_unknown`, `script_missing`, `endpoint_missing`, `endpoint_needs_secret`, `clamped`, `failing`, `delivery_failing`); `routines.history {routineId, before?, limit?}` (firings and skips newest first, 50 or up to 500, each with its records' fields and deliveries); `routines.export {routineIds?}`; `routines.checkImport {yaml, routineId?}` (per document the definition as it would be saved, issues with paths, and warnings: what this environment lacks, the workspace as re-resolved); `routines.scripts.list`; `routines.endpoints.list` (name, URL, secret kind `pasted`, `reference` or `missing`, last result).
- **Commands at `sessions:write`**, queued offline by the client runtime (its spec names routine definitions), each ordered, not a setter: `routines.create {routineId, definition}` (`conflict` `name_taken`); `routines.update {routineId, fields}` (any subset, last writer wins per field, ADR 0003); `routines.enable` (which clears `movedTo`); `routines.disable {routineId, movedTo?}`; `routines.delete`; `routines.import {yaml, routineIds? | routineId?, movedFrom?}`, all or nothing, making each document a routine under the ids given or, with `routineId`, replacing that routine's definition from one document, and answering `checkImport`'s warnings.
- **At `runs:drive`**, never queued: `routines.runNow {routineId, withPreCheck?}`, answering at once with the entry id, whose firing or skip `routine.updated` and the history then show (`conflict` `firing_running`); the query `routines.testPreCheck {routineId}` or `{preCheck, workspace}`, bounded at 25 seconds, inside the client runtime's 30-second request timeout (a slower pre-check is tried through run now with `withPreCheck`): exit status, duration, output (scrubbed, 8,000 characters), bytes, hash, and whether it differs from the baseline.
- **At `admin`**, direct: `routines.endpoints.set {name, url, secret?}`, `routines.endpoints.remove {name}`, and the query `routines.endpoints.test {name}`, posting a `routine.test` payload and answering status and time.

### Events and notices

- **The `routine` stream**, one per routine: `routine.created {definition, savedUnderCeiling, movedFrom}`, `routine.edited {fields, savedUnderCeiling}`, `routine.enabled {savedUnderCeiling}`, `routine.disabled {movedTo}`, `routine.deleted`, `routine.skipped {skipId, trigger, dueAt, reason, count, detail, preCheck}`, `routine.firing-started {firingId, trigger, dueAt, count, sessionId, runId, requestedBy, preCheck, targets}`, `routine.firing-continued {firingId, runId}`, `routine.firing-ended {firingId, outcome, reason, text, usage, durationMs, baselineAdvanced}`, `routine.delivery-attempted {entryId, target, attempt, result, status, error, retryAt}`. Commands are the client session's; the engine's records are `routine:<id>`'s. Not compacted in milestone 1.
- **Environment notices**: `routine.updated {routineId, change}` (the runtime refreshes `routines.list`; nobody sees it; none for a `no-change` skip or a retry, so frequent routines do not fill the replay bound); `routine.delivered`; `routine.delivery-failed {routineId, name, entryId, endpoint, error}`; `routine.endpoint-set {name, url, secretKind}` and `routine.endpoint-removed {name}`.
- **Elsewhere**: `SettledBy` gains `routine`; interrupt causes gain `timeout`; a firing's session uses `session.created` as it is.

### Moving a routine

ADR 0008's two taps, pick the target and confirm, through `commands.moveRoutine(from, routineId, to, name?)`:

1. **The definition**: `routines.export` from the source when reachable, else the request cache's last `routines.list`, which carries every definition; with neither, the verb is absent with its reason.
2. **The confirmation** shows `routines.checkImport` on the target: what it lacks and the workspace as re-resolved. A request whose path is not usable there and whose repository identity is known goes through the checkout index (the target's most recently used present known directory with that identity), else `scratch` (workspace-picker spec). A name the target holds asks for another.
3. **The copy**: `routines.import` with `movedFrom`, keeping the original's enabled flag. When the target holds the routine this one came from (its `movedTo` names this one), that routine is updated from the definition and enabled instead, so moving back continues its history.
4. **The original**: `routines.disable` with `movedTo`, through the outbox, so it waits while the source is down.

History stays where it was; each copy links to the other. **Settling**: a client runtime following both environments that sees a copy whose original is still enabled with no `movedTo`, and unedited since the move, sends that disable once. Until the original hears it, it may fire its copy too (automatic failover is milestone 2 or fog).

### YAML export and import

- One document per routine, several per file, kebab-case keys: `kind: routine`, `version: 1`, `name`, `enabled`, `schedule`, `timezone`, `if-missed`, `workspace` with `repository-identity`, `account` (`provider`, `email`, `organisation`), `model`, `effort`, `mode`, `containment`, `injection`, `skills`, `pre-check`, `silent-marker`, `max-duration-minutes`, `delivery`, `instructions` (a block scalar). Export opens with a comment naming the environment and time.
- Never present: ids, the environment, the saved ceiling, history, the baseline, lineage, secrets. A webhook target is an endpoint's name, and the endpoint, with its secret or its key-manager reference, stays with its environment, so a routine document carries no key-manager path in milestone 1; ADR 0008's "key-manager paths by name" applies once a routine field names one.
- Strict: an unknown key or a bad value is an issue at its path; absent optional keys take their presets, an absent zone the importing environment's.
- The codec is in contracts and runs on the environment (`routines.export`, `routines.import`), so a client in any language needs no YAML code; its JSON Schema ships with each release.

### Clients

- **Client runtime**: `projections.routines` is every enabled environment's `routines.list` from the request cache, refreshed on ready and `routine.updated`, grouped by environment in the connection list's order with badges, pending commands flagged, and a count of routines with attention; `projections.routineHistory(environmentId, routineId)` reads `routines.history`. Notices gain `routine` ("<routine> on <environment>: <summary>", success or failure, `about` naming the session so opening it opens the firing) and `routine-delivery-failed` ("<routine> on <environment> could not deliver to <endpoint>: <error>"), paying the #142 note.
- **GUI** (84): the Routines pane on row `routines.routines`, scoped `everywhere` (ADR 0008's one view of every connected environment's routines): a health line; each environment's routines with the list's columns; a form editor with a YAML tab; history with kept output and session links; run now, enable, move, export, import and delete; the endpoints, for `admin` sessions. Choosing `bypassPermissions` shows the permissions spec's sentence; a routine notice raises an OS notification while unfocused (GUI spec).
- **Terminal UI**: `/routines` lists them grouped by environment; Enter opens the latest firing's session; row verbs run now, enable or disable, move, history, export (to a path) and edit, which opens the YAML in `$VISUAL` or `$EDITOR` and applies it with `routines.import {routineId}`, reopening it with the issues as comments when refused; `/routines new` starts from a template and `/routines import <path>` reads a file.

### Drain, update and restart

- The scheduler stops when a drain starts; a due time during it stays unhandled for the missed rule.
- A pre-check counts as a run starting: the engine admits the firing to the run registry (env spec's idle), so the drain waits for it, and admission refused by a drain leaves the due time unhandled. A due time ahead, or a firing waiting for a slot, is no busy reason.
- A firing's run cut by an update is continued (launcher-update spec); the firing follows it and delivers once, at its end.
- **The start pass**, after the update coordinator's settle and before the scheduler arms: end firings whose runs ended with nothing to continue them, resume pending deliveries, apply the missed rule.

### The upstream watch

- **The definition** comes from the routine document on `main`, its YAML rewritten by the build to this format (`email` for the account, the time zone the routines-server routine fires in so Monday 03:00 stays the same instant, the pre-check path relative to the scripts directory, instructions inline), imported disabled onto SYSTEM-SERVER's environment running as a service (86).
- **The pre-check** is today's steps 2 and 3 without the ledger: it reads every source (GitHub through `gh`, the raw changelog, the digests, npm) and prints each source's current stable ids under its name, sorted, one per line, nothing time-dependent. A quiet week prints the same, so no session, model call or ledger write happens and the history says no change, replacing the "quiet week" comment. A changed week fires: the instructions start at step 1, take the diff as a hint and keep the ledger's `recent_ids` and `judged_fps` as the authority, so a failed week is judged the next; they read the Forgejo token from the injected forge variables instead of OpenBao.
- **The ledger** stays issue #74, not routine state: it must travel with the routine on a move, and the model writes `judged_fps`.
- **Mode** stays `acceptEdits` (#31). An unattended `acceptEdits` run is denied any shell command no rule allows, so the repository's committed Claude settings gain allow rules for the watch's `git pull`, `gh api` and `curl`, loaded once David trusts the repository on that environment (skills-instructions workstream); they also apply to his own `acceptEdits` sessions there.
- **Delivery**: a client notice on both; the webhook target on success once the Hermes fleet is back (cortex issue 437) and its endpoint exists.
- **Cut-over**, this workstream's acceptance: `routines.testPreCheck` twice gives one hash; a run now files a digest with no denial in the Unattended review; David enables it and the routines-server routine `oa9YJpNDk68` is deleted in the same sitting, so no Monday has both; the routine document and the memory are updated.

### Hermes in milestone 1

The #29 plan: Hermes keeps its bots and their schedules until the milestone-2 Bot object, and its profiles reach the harness through the completions surface as `program` pairings under a ceiling (#138, #139), never through routines. The harness reaches Hermes through a webhook endpoint whose URL is a Hermes webhook route that only delivers, to the Matrix home room, and whose secret is that route's, kept in OpenBao under `personal/agents/` (referenced once key managers land, pasted until then); the same adapter carries the netdata alerts. Nothing is read or imported from Hermes.

### Set up and the settings band

ADR 0027 decided there is no Routines step: routines live in the Routines and bots band, whose Routines row names no step and shows its own health from `routines.list`'s attention, and whose Bots row stays dim until milestone 2. This workstream adds **no settings key**, since the registry's contract test fails a key no step writes; its bounds are chosen defaults and each routine's fields carry its choices. No `setup.check` entry.

### What this workstream does not decide

78 env: the wire, receipts, notices, the replay bound, the run registry. 79 session-state: tags, titles and shelves (gaining a `SettledBy` value). 80 client-runtime: the outbox, request cache and notice queue. 81 tui, 84 gui: drawing, keys, the row table. 82 claude-adapter: runs, `resultText`, the completions surface, the new interrupt cause. 83 permissions: the resolver, unattended rules, the review, the denylist matcher reused for hosts. 85 workspace-picker: the resolver, worktrees, the checkout index, the reaper. 86 launcher-update: the drain, the continuation, the service on SYSTEM-SERVER. 87 forge: the injected variables and helper. 88 setup: nothing. 89 skills-instructions: the composer, extra always-on names, the trust gate. 90 banks, 93 browser: nothing. 91 key-managers: the injection setting and its account overrides, references for endpoint secrets, the scrub registry. 94 switch-over: the state import (ticket 56) through `routines.import`.

## Testing Decisions

- **A good test** drives a routine through the wire under a manual clock and asserts what a client or receiver sees: a firing's session in the list with its tags, a `routine.delivered` notice on two clients, a signed POST, a skip in the history, a clamp in `run.policy.resolved`. Never a projection table or the scheduler's timer.
- **Primary seam: an in-process environment and a real client** (the env spec's helper): a temporary data directory, loopback port 0, the scripted fake provider (a final text, the marker, an error, a long run), the typed client over a real WebSocket, the environment's injectable clock, real small scripts in the scripts directory, and a loopback HTTP server on port 0 as webhook receiver and URL source (after the launcher-update spec's fake release source). Cases: each schedule kind on time, the floor, overlap, the cap; missed due times collapsed, caught up or skipped; `handledThrough` on enable and edit; no-change, change, first observation and each pre-check failure, the baseline moving only on success; silence and the settled session; targets by `on`; the signature checked by an independent verifier, retries on 503, a 400 failing at once, retries resumed after a restart; the saved ceiling and run now's clamp; the timeout; a person's interrupt; a drained firing followed through a scripted continuation or ended by the start pass; a crash between prepare and commit leaving no session; the Unattended review naming the routine; import and export; endpoints refusing a denylisted or public plain-`http` host and never returning a secret; scopes. Prior art: T3 Code's `buildAppUnderTest` and `withWsRpcClient`.
- **Contract tests in the contracts package**: the schedule maths as a case table (each kind, zone gaps and repeats, the 31st, cron's OR rule, the floor); the silence rule, after Hermes's `test_response_filters.py`; the YAML codec (round trip, strictness, no secret or id rendered, the upstream watch's document parsing); the signature against Standard Webhooks' published vectors; one scope per method; a schema for every event and notice.
- **Client runtime** against two in-process environments: a move with both reachable; with the source stopped, the disable queued and delivered on its return; moving back onto the original; settlement by a second runtime; the workspace re-resolved and the warnings. Against the scripted fake wire: both notice rows, news only.
- **Terminal UI**: the runtime against a scripted fake environment in Ink's test renderer: `/routines`, each verb, the edit round trip through a fake editor. **GUI**: 84's seam for the pane.
- Vitest, serial where a listener is bound. **Not tested here**: Hermes itself (checked by hand at cut-over), real sleep and clock changes, scripts on Windows (the service checklist).

## Out of Scope

- Bots, the roster, a bot's persona and forge account (milestone 2, ADR 0008, ADR 0020); moving Hermes's bot schedules into routines (milestone 2, #29).
- Webhook and API-token triggers and the fallback environment (milestone 2); automatic failover (fog); native senders such as Matrix, Telegram, ntfy or email (milestone 3 plugins, or through Hermes).
- One-shot schedules, chaining routines, a model tool that manages routines, the browser in a firing (no client to relay to, ADR 0014), contained pre-checks, bot bundles, importing from Hermes.

## Further Notes

- **Chosen defaults**: names by the Tag rule, unique per environment; 100,000-character instructions; `run-once` within seven days, missed at two minutes late; the five-minute floor; four firings at once; the 60-second check; pre-check timeout 60 seconds and its test's 25, output 1 MiB, 64 KiB kept; the baseline moving only on success; Hermes's prompt caps; the header and its silence sentence; silent firings settled at once; empty text a success; 60 minutes' maximum duration; kept text 16,000 characters, notice body 4,000, summary 200; eight targets, preset a client notice on both; retries at 1, 5 and 30 minutes, ten-second timeout; the `http` rule; Standard Webhooks; the tags and title; history pages of 50; the Routines row scoped `everywhere`; no settings key.
- **Verify first in the build session**: that the adapter resolves `opus[1m]`, or the build rewrites the upstream watch's model to a name `models.list` offers; that SYSTEM-SERVER's environment user has `gh` signed in or a github.com forge account injecting `GH_TOKEN`, and a forge account for the Forgejo origin; that `startRun` takes effort, containment, injection and skills with no change beyond its request; that the host's interrupt takes a new cause; that the run registry can admit a firing that has no run yet; that the 60-second check sees a laptop's sleep as a jump; which Standard Webhooks vectors to pin.
- **For David**: a due time whose pre-check is unchanged, fails or cannot start is a skip with no session, the reading of "every firing is a session" this spec takes (read strictly, ADR 0008 and the glossary would give each a session). The upstream watch's hand-off changes from the routine document's (the pre-check did the ledger's bookkeeping) to a pre-check that reads no ledger, and the ledger stays an issue. Its allow rules reach his own `acceptEdits` sessions in that repository; `bypassPermissions` for the routine is the alternative. A worktree routine keeps a worktree per firing until that session is deleted and purged, and nothing deletes old firing sessions (fog). The GUI spec's draft row table (PR 287) scopes Routines `environment`; this spec needs `everywhere`, and whichever lands second aligns.
- **For domain-modeling**: skip, due time, baseline, webhook endpoint, catch-up and move settlement are used here and not in `CONTEXT.md`; the glossary's Firing ("always a session") should say a skipped due time is no firing; Delivery target's "target" is an endpoint's name for a webhook.
