# agent-harness

A coding-agent harness in which each OS user runs a harness server of their own, and every user interface, including the desktop window on the same machine, is a client of one. This glossary fixes the nouns the design uses; it holds no implementation detail.

## Language

**Environment**:
A running harness server and everything it owns: the OS user account it runs under, its accounts, workspaces and sessions. Belongs to one person; has a persistent identity independent of its addresses. A machine may host more than one, each added deliberately.
_Avoid_: server, host, remote, machine (when the server is meant)

**Client**:
Any user interface connected to an environment: the desktop window, the terminal UI, a browser tab.
_Avoid_: app, frontend, renderer (when the connected thing is meant)

**Connection**:
A client's saved way to reach one environment: its address plus the client's session credentials for it.
_Avoid_: remote, link, pairing (which is the act, not the record)

**Account**:
A provider login held by an environment in one config directory of its own, adopted from the machine's provider directory or harness-owned, through which runs are billed and authenticated; labelled uniquely per environment.
_Avoid_: profile

**Account identity**:
The provider plus the login an account signed in as, its email and, when present, its organisation; one account per identity per environment, and the same identity on several environments pools plan usage.
_Avoid_: email (the display field), profile id

**Sign-in**:
The environment running a provider's own CLI (Claude's bundled binary, `auth login`) against an account's directory, one at a time per environment: it publishes the verification URL, takes the code from whichever client is attending, and ends done, failed, expired after ten minutes, or cancelled; the harness never sees the credential, and the exact command for a terminal on that machine is the fallback.
_Avoid_: login (the provider's credential itself), authentication, OAuth flow

**Adopted account**:
An account whose config directory existed before the harness and is registered in place: the machine's own provider directory, or one listed in the data folder the state import reads; never moved, linked or deleted by the harness.
_Avoid_: carried-over profile, imported account

**Imported session**:
A session record the Carry over step creates from a transcript found in an adopted directory or an import source, with its title, workspace, repository identity and provider session id set at once and its history appended to the log the first time a client opens it.
_Avoid_: migrated session, legacy session, provider session (the provider's own record the imported session links, defined below, not the session)

**State import**:
The re-runnable environment command that reads another program's data and state folders on the same machine and carries what it can through the services that own each kind of state: provider directories adopted in place, organisation state, banks, forge accounts, key-manager records, routines (disabled, bar one imported from its document), skill sources, instructions and the browser's page policy; what it cannot carry is named on its report.
_Avoid_: migration, carry-over (the step that imports each adopted account's sessions, memory and skills, from its directory or an import source)

**Session**:
One conversation with an agent, owned by exactly one environment.
_Avoid_: thread, chat, pane, conversation

**Provider session**:
A provider's own record of a session's history, under the provider's id, which a run resumes, forks or rewinds; a session links one or more over its life, and a fork starts from its source's.
_Avoid_: conversation, provider conversation, transcript (the session's events in the log)

**Run**:
One turn of a session, from the prompt that starts it to the reason it ended.
_Avoid_: query, task, job

**Queued message**:
A message sent during a live run and not yet read: held by the provider where it has a queue, else by the environment, visible to every client in order until it is steered, delivered or withdrawn.
_Avoid_: pending message (an outbox entry), draft, follow-up

**Steer**:
A queued message the provider folded into the running turn at its next boundary; a delivery kind, not a verb of its own.
_Avoid_: nudge, mid-turn message, interject

**Read now**:
The verb that reads the whole queue at once, in order: it interrupts a live run and starts the next one with the queue, or, with no run live, starts one with the queue the environment holds.
_Avoid_: interrupt (which alone re-owns the queue and starts nothing), send now, force

**Withdraw**:
The verb that takes a queued message back before it is read, returning its text to the composer; editing a queued message is a withdraw and a send.
_Avoid_: cancel (a prompt's decision), delete, unsend

**Pairing**:
The one-time act by which a client proves to an environment that it may connect, producing a session credential that the environment can list and revoke.
_Avoid_: login, token exchange

**Group**:
A named container of sessions owned by one environment; a session belongs to at most one group. Clients may merge same-named groups from several environments into one heading, which is a view, not state.
_Avoid_: project (which is the repository being worked in), folder

**Tag**:
A free-form label a user attaches to a session, stored by the environment; several per session.
_Avoid_: label

**Settled**:
The state of a session the user or auto-settle has moved to the settled shelf; unsettling clears it.
_Avoid_: done, completed, closed

**Snoozed**:
The state of a session kept out of the active list until a chosen time.
_Avoid_: muted, hidden

**Shelf**:
Where a session sits when it is not in the active list: the settled, snoozed or archived shelf, each following from the session's own state rather than from where a client put it.
_Avoid_: bucket, folder, section

**Tombstone**:
The one event left in an environment's log for a purged session: it says the session is gone and what became of the provider's transcript, so a client that last saw the session learns to drop it.
_Avoid_: purge marker, deletion record

**Client runtime**:
The UI-free package every client renders from: connections, pairing, subscriptions with their caches and outbox, projections, command dispatch and capability flags. The only place session semantics live on the client side.
_Avoid_: SDK, store, bridge

**Desktop shell**:
The small set of things only a desktop app can do for a client (native dialogs, file pickers, the embedded web view, window chrome, notifications), reached through capability flags and never carrying session state.
_Avoid_: main process, IPC, bridge

**Theme**:
A name and seven seeds (Canvas, Accent, Machine, Thinking, Success, Warning, Danger), each one hue and chroma, from which every colour the GUI and the web tab paint is derived, and which the terminal UI maps onto its terminal's own colours; an environment setting; its shipped defaults are the exact colours already in use, so adopting it changes nothing on screen.
_Avoid_: skin, palette (the derived ladder, not the setting), colour scheme (light or dark, which is the client's)

**Seed**:
One of a theme's seven colours, a hue and chroma in OKLCH, from which the theme package derives a ladder of tokens for light and dark within the contrast rules.
_Avoid_: brand colour, base colour, primary (the role is named)

**Token**:
A named colour the GUI and web renderers use in place of a literal, derived from a seed at runtime and applied as a CSS variable; the only way those packages colour anything, apart from the allowlisted fallbacks the lint names.
_Avoid_: variable (the mechanism), hex, swatch (the picker's preview)

**Pane**:
One view inside a client's window (a conversation, a terminal, files, a diff, the browser dock); which panes are open and how they are laid out is client-local presentation, not organisation state.
_Avoid_: tab, panel, dock (the region that holds panes; the proper name "browser dock" for the embedded-browser pane is the one exception)

**Terminal**:
A pseudo-terminal an environment owns, running the user's login shell in a session's workspace, which outlives every client connected to it and closes with its session; its output is kept only in its scrollback, never in the event log.
_Avoid_: shell (the program inside it), console, the terminal UI (a client) or the user's terminal emulator (where a client runs)

**Scrollback**:
The bounded tail of a terminal's output the environment keeps, 5,000 lines or 8 MiB, from which a client reconnecting is sent what it missed.
_Avoid_: history, buffer, log (the event log holds none of it)

**Workspace**:
Where a session's code lives on its environment: a directory the environment has, a worktree the environment created from a repository it has, or a scratch directory that lives with the session. Every session has exactly one.
_Avoid_: folder, cwd, project (for the place), none (there is no session without a workspace)

**Repository identity**:
The canonical remote URL of the repository a workspace belongs to, recorded on the session so clients can relate work on the same repository across environments; absent when the workspace is outside any repository, and copied to the new session on hand-off. Never a server-side object.
_Avoid_: project, logical project

**Hand-off**:
Continuing a session on another environment as a new, linked session seeded with a summary and a workspace for the same repository; the original stays where it is.
_Avoid_: move, migrate, transfer

**Mode**:
What an agent may do without asking during a run: one of acceptEdits, plan, auto, bypassPermissions, mapped by each adapter onto its provider.
_Avoid_: permission level, approval policy, trust level

**Ceiling**:
The highest mode a connection, and anything created through it, may use; set at pairing, raised only with admin scope.
_Avoid_: limit, cap, max mode

**Clamp**:
The lowering of a mode asked for to the highest the ceiling and the account allow, recorded with its reason and never refused; a default that is lowered is not a clamp.
_Avoid_: cap, downgrade, rejection

**Attended**:
A run a person started from a client session, or a completions request that says a person is present, fixed at its start; its prompts park until someone answers or the TTL passes.
_Avoid_: interactive, supervised, foreground

**Unattended**:
A run a routine, a bot or the completions surface started, with nobody present (a completions request may say otherwise for itself; a routine or a bot never can); it runs in the unattended default unless it names a mode, and anything that would ask is denied at once and recorded.
_Avoid_: headless, background, automated

**Containment**:
Where a run may reach on its environment, independent of its mode: off, workspace only, or workspace with no network, enforced by the operating system or the container.
_Avoid_: sandbox (the mechanism, not the setting), jail, isolation

**Denylist**:
The environment's user-editable list of browser domains, paths, commands and hosts that are never auto-approved in any mode.
_Avoid_: blocklist, blacklist, guardrails

**Parked prompt**:
A permission prompt or question a run is waiting on with nobody having answered yet; shown to every client until answered; denied after its TTL unless the TTL is never.
_Avoid_: pending approval, ask (already a UI word for permission prompts; fine for the "Parked asks" view name)

**Idle**:
The state of an environment with no run starting or running, no terminal whose shell runs a command in its foreground, and no run started or ended within its idle window (`updates.idleWindowMinutes`, preset ten minutes); a run parked on a prompt counts as busy for the idle window only, and a terminal at its shell's prompt counts for nothing.
_Avoid_: quiet, inactive, free

**Drain**:
An environment refusing new runs and waiting a bounded time for running ones to finish before it restarts for an update.
_Avoid_: graceful shutdown, quiesce

**Channel**:
Which releases an environment follows for updates: stable (releases only) or beta (prereleases too); a pinned version follows none.
_Avoid_: track, ring, branch, the launcher channel (the launcher's IPC connection, defined below)

**Release source**:
Where an environment reads its releases: a forge origin, its kind and the repository, compiled into each build and read only with the forge account for that origin.
_Avoid_: feed, update server, release URL

**Release manifest**:
`release.json`, the asset every release publishes that says what the release is: its version, protocol version, launcher protocol, database schema version and bundled Claude Code version, each asset with its platform, kind, size and SHA-256, and the image's reference and digest; read before anything of the release is downloaded, and only ever added to.
_Avoid_: release notes, feed, update index

**Launcher**:
The stable process the service runs, which owns the installed versions, the pending-update record and the database snapshot, and starts the chosen server version as its child.
_Avoid_: supervisor, wrapper, bootstrap

**Launcher channel**:
The IPC connection a launcher spawns its environment with, over which each asks the other and is answered once (`idle?`, `drain?`, `prepared` and `committed`, `install?`, `switch?`, `versions?`); always named in full.
_Avoid_: channel alone (which releases an environment follows), pipe, socket

**Launcher entry**:
The stable script the service definition runs, which starts the launcher of the version its launcher version file names, and names the previous version again after three unconfirmed starts of a handed-over launcher.
_Avoid_: wrapper, bootstrap, the launcher (the process it starts)

**Launcher version file**:
The one-line file in the data directory that names the version whose launcher the launcher entry starts, written by `service install` when no launcher runs, by the launcher at a handover and by the entry when it falls back.
_Avoid_: pointer (a place in a bank), current link

**Shim**:
The `agent-harness` in the data directory's `bin` folder, which runs the CLI of the version the service state names active with the arguments it was given, so whatever a person or a helper starts from it matches its environment through every update; `service install` writes it and prints the line that puts its folder on the path.
_Avoid_: wrapper, alias, the launcher entry (what the service definition runs)

**Versions directory**:
The folder in the data directory holding one folder per installed version, named by the version; a folder counts as a version only once its sentinel, written last, is in it.
_Avoid_: install folder, releases folder, runtime

**Service state**:
The launcher's file in the data directory naming the active, previous and launcher versions, the pending-update record and the watch deadline; every write is durable, and a service state the launcher cannot read or trust stops it starting anything.
_Avoid_: service record (what `service install` wrote, for `status` and `uninstall`), launcher state

**Update coordinator**:
The environment's module that holds the update policy: it reads the channel, stages the target, waits for idle or the deferral cap, drains, asks the launcher to switch and, after the restart, settles the outcome and marks and continues the runs the update cut; it knows runs, which the launcher never does.
_Avoid_: updater (the host-side updater or the desktop's), update manager, the launcher

**Update id**:
The id an environment mints when it takes an update's target, named by every notice of that update, the launcher's switch, the database snapshot and the outcome record; a newer release replacing the target gets a new one, while the time the update first became pending carries over.
_Avoid_: job id, update number, version (what the update goes to)

**Stepping stone**:
The newest release the running launcher can host, taken on the way to a target that needs a newer launcher, so the launcher hands over before the environment goes on to the target.
_Avoid_: intermediate version, hop, bridge release

**Outcome record**:
The file whoever rolled an update back leaves in the data directory (the launcher after a failed trial or a crash loop, a container's `update restore`), naming the update, its versions, the stage and the reason; the environment reads it as it settles that update, then deletes it.
_Avoid_: rollback log, result file, the outcome (the notice it becomes)

**Trial**:
A version's first start after a switch, which serves nothing until the launcher commits it: it must say it is prepared, for itself, within 120 seconds of its spawn, or it is ended and its update rolled back.
_Avoid_: canary, probation, test start

**Database snapshot**:
The copy of the database's main, WAL and shm files the launcher takes once per update id, after the old version has exited and before the trial, in a folder named by that id; a rollback copies it back.
_Avoid_: backup (a copy a person keeps), checkpoint (SQLite's own)

**Restore marker**:
The file in the data directory that is there from before a rollback copies the database snapshot back until its outcome record is written, holding that record, so a restore cut short is finished before anything opens the database.
_Avoid_: lock file, restore flag

**Host-side updater**:
The published script that carries out the update coordinator's plan for a container, which cannot replace itself: it polls the environment, pulls the target image by its digest, stops, snapshots, recreates, checks health and rolls back on failure.
_Avoid_: Watchtower, container updater, sidecar

**Routine**:
An environment-owned definition of unattended work: instructions run on a schedule or trigger with a chosen account, model, mode, workspace, skills, pre-check and delivery targets. Fires with no client connected.
_Avoid_: cron job, scheduled task, automation, job

**Firing**:
One execution of a routine; always a session, tagged with the routine and, if any, its bot.
_Avoid_: run (a firing is a session; its turns are runs), tick, execution

**Bot**:
An environment-owned identity with a persona, default account, model and mode, and skills, that owns routines; its chat front-ends live outside the harness.
_Avoid_: agent (the model doing the work), persona (only the bot's instructions), profile (Hermes's word; also a retired word for an account)

**Delivery target**:
Where a firing's result is sent: a kind (client notice, signed webhook, later others), a target and a success or failure split.
_Avoid_: notification channel, sink, home channel

**Pre-check**:
A script or URL a routine runs before each firing; if its output is unchanged since the last firing, the model run is skipped.
_Avoid_: monitor, probe, guard

**Skill set**:
The skills an environment offers an account: its tracked skill sources, its own skills directory and the trusted repository's skills, merged in that order into one directory each adapter maps.
_Avoid_: plugin directory (Claude's delivery mechanism), skills.json, catalogue (the suggestions list)

**Skill source**:
A git repository and folder the environment tracks for skills, following a branch or pinned to a commit.
_Avoid_: mirror, skills repo, marketplace

**Readiness**:
Whether a skill can help right now on this environment: ready, setup needed (with the failing check named) or unsupported, computed by the harness from the checks the skill or its overlay declares.
_Avoid_: compatibility (the spec's free-text field), prerequisites (the prose)

**Standing instructions**:
Text appended to every run through the provider's instruction channel, composed once on the run's environment, whoever started the run, from layers in a fixed order, general to specific: the user layer (the orientation block, then owned instructions), the team bank's, the project's, the session's, a bot's persona, then always-on skills; the run's own text follows. Each composition has a manifest beside its text, which the log keeps in place of the text: per layer what it put in (ids, versions and characters), the always-on skills with their origins and commits, the skill set's fingerprint, the registries the orientation block could not read, and what was left out and why.
_Avoid_: prompt library, house rules, system prompt (the whole thing the provider builds)

**Trust gate**:
The one-time, per-repository decision that lets a repository's own skills, instructions and hooks load into runs on this environment.
_Avoid_: allowlist, safe mode, workspace trust

**Bank**:
A git-backed, self-describing collection of memories (a `BANK.md` manifest naming its kind, purpose, entities, orientation facts and landing) that an environment attaches to accounts and repositories and lands changes to through the forge.
_Avoid_: memory store, knowledge base, vault (the key manager)

**Orientation facts**:
The few memories a bank marks as always loaded, regardless of relevance, under a cap the bank respects when authoring, holding only what the bank itself knows (its accounts or brands, its secrets layout, where its work is tracked); the key vault, the forges and the attached banks come from the orientation block.
_Avoid_: pinned (a user's session-time choice), summary, README

**Bank registry**:
The environment's record of which banks it carries, each with a role, an enabled flag, an account scope, a repository scope and the account's default write target.
_Avoid_: memory-banks.json, cerebro config, catalogue

**Team bank**:
A bank of kind team: a private repository on any forge the team can reach, shared by everyone who joins it, holding the team's facts and no personal ones or secrets.
_Avoid_: shared bank (fine in prose), org bank, company memory

**Bank owner**:
A forge login a bank's manifest lists as able to approve its reviewed changes (orientation, decisions, a status, the manifest); a sole owner merges those changes themselves.
_Avoid_: admin, maintainer, code owner (the forge's own mechanism)

**Scope folder**:
A bank folder at one of the three levels every bank has, `projects/{org}/{project}/{area}/`: an org (a person's own work, a company, a team or a department), a project inside it, and an optional area inside the project; memories live at a project or an area. Project here names a bank folder, never the repository a session works in.
_Avoid_: system (the old name for an area), brand (a project that happens to be a brand), category

**Key manager**:
A secrets service an environment is connected to (OpenBao or Vault, Doppler, 1Password, Bitwarden Secrets Manager) whose credential the environment keeps in its own vault and whose environment block it injects into runs.
_Avoid_: secret manager, vault (the product; also the environment's local credential store), keychain

**Orientation block**:
The text the harness renders into every run from live environment state: the environment itself, its key managers and their verified token status, its forges and which is primary, its banks, and the environments the client knows.
_Avoid_: setup prompt (the wizard's editable prose), system prompt, preamble

**Managed tool**:
A CLI the harness depends on and tracks per environment: detected on PATH, compared against its latest version, installed or updated by one click in a terminal pane, verified by one command.
_Avoid_: dependency, prerequisite, binary

**Scrub registry**:
The one list of values the harness has resolved or injected, consulted by transcripts, the event log, tool outputs, logs and renders so none of those values is ever shown or stored; secrets the model handles on its own are not in it.
_Avoid_: redaction list, filter, mask

**Shape rule**:
A pattern for a secret the harness never registered, anchored on a recognisable prefix (`ghp_`, `hvs.`, `sk-ant-`, a key's name before `=`) and never on how random a string looks; applied beside the scrub registry's values to the harness's own log lines, captured output and error text, and checked on what it sends out, but never to a session's content.
_Avoid_: secret detector, entropy check, pattern

**Forge account**:
An environment's one identity on one forge origin (GitHub, Forgejo, Gitea; GitLab later), with any verified alias origins, a slug, its credential source and its capabilities; the only thing banks, skill sources, the tracker, pull requests, releases and repository creation authenticate with on that origin.
_Avoid_: token (the credential, not the account), git account, forge connection

**Forge origin**:
The scheme, host and port a forge account is keyed by, to which every remote URL of that forge normalises; an alias is a second origin the same instance answers on, accepted only once the account's credential proves the same identity there.
_Avoid_: host (ambiguous with the machine), base URL, remote

**Credential source**:
Where a forge account's credential comes from, never the secret itself: the environment's own `gh`, read on every operation; a token stored in the environment's vault (pasted, handed over once from a client's `gh`, imported, or from a device flow); a key-manager reference, resolved per operation; or none, a copy from another environment awaiting one.
_Avoid_: auth method, token type, credential (the secret, not where it comes from)

**Forge capability**:
One thing a forge account may be able to do (read repositories, write issues, open pull requests, create repositories, read releases), each verified, failed or unknown; reads are probed, writes are learned from use.
_Avoid_: scope (the provider's token setting), permission (the harness's run modes)

**Credential helper**:
The harness command a run's git, and the harness's own, calls for a forge origin's credential, which asks the credential route with a run-scoped secret and so answers for that run or operation only; it serves git's http transport for the account's origins and leaves ssh to the user's keys.
_Avoid_: git credential store, token file, GCM

**Run-scoped secret**:
The random value the credential helper proves itself with: minted for one harness git operation, a provider process or a terminal, naming the forge accounts it may be served, held only in the environment's memory as a secret, and void once what it was minted for ends or the environment restarts.
_Avoid_: token (the forge's credential), session token, API key

**Credential route**:
The environment's internal route the credential helper asks over loopback: it serves a run-scoped secret's forge accounts on their canonical origins and verified aliases, reading the credential on every request, and refuses everything else.
_Avoid_: token endpoint, credential server, auth API

**Primary forge**:
The one forge origin a user has marked as the default, flagged on that origin's account on every environment: where new repositories are created and the release channel is read unless another forge is named.
_Avoid_: default remote, main forge, home forge

**Tier**:
One of the four layers of the rendered bank index: the bank line, orientation, root breadcrumbs, and an expanded folder index; each capped when written, never cut when read.
_Avoid_: level (a scope depth), section, budget (the number, not the layer)

**Breadcrumb**:
An index line that points at a folder or topic rather than a memory: its pointer, its count and its one-liner.
_Avoid_: crumb (fine in prose, not in the contract), heading, category

**Topic**:
An authored sub-folder inside a scope folder's memories, declared in the parent's PROJECT.md or AREA.md, used once the folder's index would exceed forty lines.
_Avoid_: subfolder, tag, cluster (the harness's proposal, not the result)

**Pointer**:
The one way an index, a search result or a read names a place in a bank: bank:path/ for a folder or topic, bank:name for a memory.
_Avoid_: link, path (alone), reference

**Paired Chrome**:
A browser that has completed the one-time code pairing with an environment on its own machine and is stored there by name; every client of that environment can choose it for a session.
_Avoid_: connected browser, extension instance, my Chrome (the picker's label, not the object)

**Browser relay**:
The path a browser verb takes from the environment running a session to the client that started it, then to that client's local environment and its paired Chrome, and back with the answer.
_Avoid_: tunnel, bridge (a retired word for the desktop listener), proxy

**Adapter**:
The environment's implementation of one provider (Claude, Codex, an OpenAI-compatible server, OpenCode) behind the one contract: capabilities, credentials, runs as an event stream, sessions, usage, models, an instruction channel, tool servers, a permission broker.
_Avoid_: driver (T3's word), integration, connector

**Provider process**:
A long-lived process an adapter needs (Claude's per-conversation process, Codex's daemon), started, reused and stopped by the environment; never owned by a run or a client.
_Avoid_: subprocess, worker, session process

**Hold**:
Work that keeps an idle provider process from stopping after the idle time: a live background task or a schedule registered in its session, reported by the adapter and let go when the work ends.
_Avoid_: lease, lock, keep-alive

**Instruction channel**:
The way an adapter delivers standing instructions and always-on skills to its provider: a system-prompt append for Claude, developerInstructions for Codex, the prompt for a local model.
_Avoid_: system prompt append (Claude's mechanism only), prompt injection

**Set up**:
The re-runnable checklist of steps; graphical clients show it as the whole window on first launch and afterwards as the first row of Settings, the terminal UI shows its summary with a pointer; its health is per environment.
_Avoid_: wizard (fine in prose; the surface's name is Set up), onboarding, installer

**Step**:
One entry of the checklist: the settings it writes on an environment, the health check that says whether they hold, the row of Settings it lives on. Optional or skippable, never absent for a feature that has settings.
_Avoid_: page, screen, stage

**Health check**:
The test a step runs against an environment to report done, needs attention or skipped; re-running the checklist jumps to the first step that needs attention (done and skipped both pass).
_Avoid_: validation, status, probe (the account step's local-model scan)

**Minted session**:
A session a Set up step creates on the user's behalf, with a workspace that fits its artefact, the picked account, model family and effort, a tag naming the step, and the step's prompt sent as its first message, or held as its draft when no account or model resolves; an ordinary session in every other way.
_Avoid_: wizard run, setup task, LLM step (the step, not the session)

**Step registry**:
The harness's list of every step with what it writes, checks and links; a feature that adds a setting without an entry fails a contract test.
_Avoid_: wizard config, step list (the rendered rail)
