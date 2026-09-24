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

**Adopted account**:
An account whose config directory is the machine's own provider directory, registered in place; never moved, linked or deleted by the harness.
_Avoid_: carried-over profile, imported account

**Imported session**:
A session record the Carry over step creates from a transcript found in an adopted directory, with its title, workspace, repository identity and provider session id set at once and its history appended to the log the first time a client opens it.
_Avoid_: migrated session, legacy session, provider session (the transcript, not the record)

**Session**:
One conversation with an agent, owned by exactly one environment.
_Avoid_: thread, chat, pane, conversation

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
The verb that interrupts a live run and starts the next one with the whole queue in order, so a queued message is read at once.
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
A name and seven seeds (Canvas, Accent, Machine, Thinking, Success, Warning, Danger), each one hue and chroma, from which every colour the GUI and the web tab paint is derived, and which the terminal UI maps onto its terminal's own colours; an environment setting, with Artemis's colours as the default.
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

**Containment**:
Where a run may reach on its environment, independent of its mode: off, workspace only, or workspace with no network, enforced by the operating system or the container.
_Avoid_: sandbox (the mechanism, not the setting), jail, isolation

**Denylist**:
The environment's user-editable list of browser domains, paths, commands and hosts that are never auto-approved in any mode.
_Avoid_: blocklist, blacklist, guardrails

**Parked prompt**:
A permission prompt or question a run is waiting on with nobody having answered yet; shown to every client until answered; denied after its TTL unless the TTL is never.
_Avoid_: pending approval, ask (the Artemis UI word; fine for the "Parked asks" view name)

**Idle**:
The state of an environment with no run starting or running and no run started or ended in the last ten minutes; a run parked on a prompt counts as busy for ten minutes only.
_Avoid_: quiet, inactive, free

**Drain**:
An environment refusing new runs and waiting a bounded time for running ones to finish before it restarts for an update.
_Avoid_: graceful shutdown, quiesce

**Channel**:
Which releases an environment follows for updates: stable (releases only) or beta (prereleases too); a pinned version follows none.
_Avoid_: track, ring, branch

**Launcher**:
The stable process the service runs, which owns the installed versions, the pending-update record and the database snapshot, and starts the chosen server version as its child.
_Avoid_: supervisor, wrapper, bootstrap

**Routine**:
An environment-owned definition of unattended work: instructions run on a schedule or trigger with a chosen account, model, mode, workspace, skills, pre-check and delivery targets. Fires with no client connected.
_Avoid_: cron job, scheduled task, automation, job

**Firing**:
One execution of a routine; always a session, tagged with the routine and, if any, its bot.
_Avoid_: run (a firing is a session; its turns are runs), tick, execution

**Bot**:
An environment-owned identity with a persona, default account, model and mode, and skills, that owns routines; its chat front-ends live outside the harness.
_Avoid_: agent (the model doing the work), persona (only the bot's instructions), profile (Hermes's word; also Artemis's retired word for an account)

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
Text appended to every run through the provider's instruction channel, composed on the run's environment from the user, team bank, project and session layers and, for a bot, its persona.
_Avoid_: prompt library, house rules, system prompt (the whole thing the provider builds)

**Trust gate**:
The one-time, per-repository decision that lets a repository's own skills, instructions and hooks load into runs on this environment.
_Avoid_: allowlist, safe mode, workspace trust

**Bank**:
A git-backed, self-describing collection of memories (a `BANK.md` manifest naming its kind, purpose, entities, orientation facts and landing) that an environment attaches to accounts and repositories and lands changes to through the forge.
_Avoid_: memory store, knowledge base, vault (the key manager)

**Orientation facts**:
The few memories a bank marks as always loaded, regardless of relevance, under a cap the bank respects when authoring: where the key vault is, which forge is primary, which banks exist.
_Avoid_: pinned (a user's session-time choice), summary, README

**Bank registry**:
The environment's record of which banks it carries, each with a role, an enabled flag, an account scope, a repository scope and the account's default write target.
_Avoid_: memory-banks.json, cerebro config, catalogue

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

**Forge account**:
An environment's one identity on one forge origin (GitHub, Forgejo, Gitea; GitLab later), with any verified alias origins, a slug, its credential source and its capabilities; the only thing banks, skill sources, the tracker, pull requests, releases and repository creation authenticate with on that origin.
_Avoid_: token (the credential, not the account), git account, forge connection

**Forge origin**:
The scheme, host and port a forge account is keyed by, to which every remote URL of that forge normalises; an alias is a second origin the same instance answers on, accepted only once the account's credential proves the same identity there.
_Avoid_: host (ambiguous with the machine), base URL, remote

**Forge capability**:
One thing a forge account may be able to do (read repositories, write issues, open pull requests, create repositories, read releases), each verified, failed or unknown; reads are probed, writes are learned from use.
_Avoid_: scope (the provider's token setting), permission (the harness's run modes)

**Credential helper**:
The harness command a run's git calls for a forge origin's credential, which answers from the environment's vault for that run only; it serves git's http transport for the account's origins and leaves ssh to the user's keys.
_Avoid_: git credential store, token file, GCM

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
An authored sub-folder inside a scope folder's memories, declared in the parent's PROJECT.md or SYSTEM.md, used once the folder's index would exceed forty lines.
_Avoid_: subfolder, tag, cluster (the harness's proposal, not the result)

**Pointer**:
The one way an index, a search result or a read names a place in a bank: bank:path/ for a folder or topic, bank:name for a memory.
_Avoid_: link, path (alone), reference

**Paired Chrome**:
A browser that has completed the one-time code pairing with an environment on its own machine and is stored there by name; every client of that environment can choose it for a session.
_Avoid_: connected browser, extension instance, my Chrome (the picker's label, not the object)

**Browser relay**:
The path a browser verb takes from the environment running a session to the client that started it, then to that client's local environment and its paired Chrome, and back with the answer.
_Avoid_: tunnel, bridge (Artemis's word for the desktop listener), proxy

**Adapter**:
The environment's implementation of one provider (Claude, Codex, an OpenAI-compatible server, OpenCode) behind the one contract: capabilities, credentials, runs as an event stream, sessions, usage, models, an instruction channel, tool servers, a permission broker.
_Avoid_: driver (T3's word), integration, connector

**Provider process**:
A long-lived process an adapter needs (Claude's per-conversation process, Codex's daemon), started, reused and stopped by the environment; never owned by a run or a client.
_Avoid_: subprocess, worker, session process

**Instruction channel**:
The way an adapter delivers standing instructions and always-on skills to its provider: a system-prompt append for Claude, developerInstructions for Codex, the prompt for a local model.
_Avoid_: system prompt append (Claude's mechanism only), prompt injection

**Set up**:
The re-runnable checklist of steps; graphical clients show it as the whole window on first launch and afterwards as the first row of Settings, the terminal UI shows its summary with a pointer; its health is per environment.
_Avoid_: wizard (fine in prose; the surface's name is Set up), onboarding, installer

**Step**:
One entry of the checklist: the settings it writes on an environment, the health check that says whether they hold, the settings pane it links to. Optional or skippable, never absent for a feature that has settings.
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
