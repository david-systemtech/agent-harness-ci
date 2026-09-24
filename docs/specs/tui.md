# Spec: Terminal UI as the first client

Milestone 1 (Switch-over), phase A (the spine). Written 2026-09-23 from map ticket 81 of `david/agent-harness`. Decisions it implements: ADR 0004 (one client runtime, renderers are projections, the terminal UI in the server artefact, the parity contract, named shortcuts with Artemis's defaults), ADR 0016 (the terminal UI shows the Set up summary with a pointer and can pair and set mode and containment itself), with ADR 0001 (every client remote, the bootstrap grant), ADR 0003 (no organisation state in a client), ADR 0005 (environment badge, composer order), ADR 0006 (mode, ceiling, containment, parked prompts), ADR 0018 (accounts per environment, a sign-in the terminal can drive) and ADR 0017 (phase, placeholder name). It builds on `docs/specs/env.md` (ticket 78: the wire, the bootstrap grant for a `tui` local client session, pairing), `docs/specs/session-state.md` (ticket 79: summary fields, the two subscriptions, sort rules) and the client-runtime specification on branch `specs/80-client-runtime` (ticket 80: the runtime the terminal UI renders from); none of that is re-decided here. Peers read: Artemis at 443cf2e (`apps/tui`: `main.tsx`, `host.ts`, `conversation.ts`, `keymap.ts`, `commands.ts`, `preferences.ts`, `attention.ts`, the README, the 57 test files), the surfaces port audit (section 1), the pi inventory (section 1, `pi-tui`), T3 Code at 96c4bfa0 (`apps/server/src/terminal`, `packages/contracts/src/terminal.ts`). The product name is the placeholder `agent-harness` throughout.

## Problem Statement

Seth works in Artemis's terminal UI all day and David opens it on SYSTEM-SERVER. It is 31,203 lines of Ink 7 and React, and the audit found the UI layer sound: no Electron import, a keymap written as data, 57 test files, a controller that drives runs through a ten-method `RunDriver`. Everything under it is wrong. It is a third in-process assembly of the engine that reads the desktop's data directory and profile store, so it works only where the desktop is installed and drifts from it on every change. Its pins are a third store of bare session ids in `~/.local/state/artemis/tui`; a pin made there never shows in the desktop. It has no groups. Archive is the provider's tag, which Codex cannot hold. It cannot start a run in a worktree or on another machine; both rows are drawn and refused. It repaints every frame whole because Ink's `incrementalRendering` was never switched on. Keys cannot be remapped. And it is installed and updated apart from the server it should match.

## Solution

`agent-harness tui` is the second entry point of the server artefact: one install gives `serve` and `tui`, and the terminal UI's version always matches its local environment (ADR 0004). It is a pure client. It holds no organisation state, runs no engine, reads nothing of the desktop's, and renders from the client runtime and nothing else. On first launch it finds the environment on its own machine through the bootstrap grant and asks for no code; if the service is stopped it offers to start it; another environment is paired by pasting a link or typing a code. The rail projects the session-list subscription: environments as headings, same-named groups merged with a badge per row, pins, the settled shelf, snoozed sessions, the archive, tags, a filter. The transcript projects the per-session subscription and streams as the run goes. The composer keeps every Artemis key, slash commands and `@` completion, now answered by the session's environment. Permission and question cards sit under the transcript, the parked-asks card gathers every environment's prompts, the status line shows run state and plan windows, and the account and model pickers are per environment. Set up is a summary with a pointer to the desktop window; pairing, mode and containment are commands the terminal issues itself. A pane shows an environment-owned pseudo-terminal. Every shortcut is a named action with Artemis's default key, remappable in a file, with a test that every Artemis default is present. An unreachable environment shows what was last seen, queues edits as pending and refuses runs.

## User Stories

1. As Seth, I want `agent-harness tui` to open on my machine with no code to enter, so that my own computer never asks me to pair.
2. As Seth, I want the terminal to say the environment service is stopped and start it on one key, so that a stopped service is a fix, not a mystery.
3. As Seth, I want every key I use in Artemis to do the same thing, so that switching costs nothing.
4. As Seth, I want to remap a key in a file and see it in the help overlay, so that a key my terminal eats is not a key I lose.
5. As Seth, I want `Ctrl+]` to take me to the next session that needs me on any environment, so that nothing waits unseen.
6. As Seth, I want `/asks` to list every parked prompt from every environment and let me answer `y` or `n` in place, so that four prompts are not four context switches.
7. As Seth, I want the pin I make in the terminal to be the pin the desktop shows, so that there is one list.
8. As Seth, I want to group, tag, settle or snooze a session from the rail with one key, so that organisation is not a desktop-only act.
9. As Seth, I want `@` to complete paths from the session's workspace on its environment, so that naming a file works when the code is elsewhere.
10. As Seth, I want the draft I typed in the terminal to be in the desktop, so that a draft is part of the session.
11. As Seth, I want a permission answer given as the socket drops to reach the run once, so that a decision is never lost or doubled.
12. As Seth, I want the transcript to stream without flicker in tmux and over SSH, so that a long turn is readable while it runs.
13. As Seth, I want a bell and a title when a prompt has waited six seconds or a turn finished a minute ago with no key pressed, so that I can look away.
14. As David, I want the terminal on SYSTEM-SERVER to show every paired environment, the unreachable one marked with since when, so that a sleeping laptop does not empty the rail.
15. As David, I want an edit to an unreachable environment's session to show pending and apply once when it is back, so that I can tidy on a train.
16. As David, I want "Brandsolidate" on two environments to be one heading with a badge on each row, so that one project reads as one heading.
17. As David, I want to start a session on any environment, choosing environment, then account, then model, so that where code runs is the first choice.
18. As David, I want a session's mode and containment set from the terminal with the clamp to my ceiling shown, so that the terminal is a full client for permissions.
19. As David, I want the terminal to show how far Set up is on an environment and which steps need attention, with a pointer to where to run it, so that I know what is missing without a desktop.
20. As David, I want to pair to a new environment from the terminal and to create a pairing code for another client, so that a headless box needs no desktop for either direction.
21. As David, I want a pseudo-terminal on the session's environment in a pane, with scrollback that survives my reconnect, so that I can run a command where the code is.
22. As David, I want `/diff` to show what a session changed on its environment through my own diff tool, so that a remote diff looks local.
23. As David, I want a feature the terminal cannot draw to say why and to be filed as a `parity` issue, so that a gap is never silent.
24. As David, I want the account picker to start a sign-in on an environment and take the code, so that a headless environment gets its first account from a terminal.
25. As David, I want any setting the terminal has no command for to be editable in a generic settings list, so that a setting is never desktop-only by accident.
26. As a client developer in another language, I want the terminal UI's rules to be behaviour on the runtime's public surface, so that my client can copy them.
27. As the setup checklist, I want the terminal to say which environment the summary is about and point at the desktop window for the steps, so that the checklist has one home.
28. As a routine, I want my client-notice delivery to appear as a notice line in every open terminal UI, so that a firing's result is seen.
29. As a provider adapter, I want an event type the terminal does not know rendered as an opaque row, so that an older terminal survives a newer environment.
30. As a build session, I want to render the whole screen against a scripted fake environment through Ink's test renderer and type real key bytes, so that every story is a test that runs in seconds.
31. As a build session, I want one test that fails when any Artemis default key or slash command is missing from the shared action list, so that ADR 0004's contract holds.

## Implementation Decisions

### The entry point and the platform

- **`agent-harness tui`** is a verb of the same CLI as `serve` (ADR 0004, env spec). Flags: `--environment <name or id>` (preset: the last used, else the local one, ADR 0005), `--session <id>`, `-c` (the newest session whose workspace is the current directory on the local environment), `--cwd <path>` (a new session's workspace), `--keybindings <file>`. Artemis's `-p` and `ls` are not carried in phase A.
- The terminal UI is a **platform for the client runtime** (ticket 80) plus Ink components over its projections. It supplies: document storage as JSON files under the state directory (`$XDG_STATE_HOME/agent-harness/tui`, the platform equivalent elsewhere, `AGENT_HARNESS_TUI_STATE_DIR` overrides), secret storage as a 0600 file there, a Node WebSocket factory, the system clock, a network signal derived from socket failures only (chosen default), client kind `tui` with label `<user>@<hostname>:<tty>`, a bootstrap-grant reader, and **no shell**: every shell member answers absent with reason `no-shell` (ADR 0004).
- The state directory also holds the keybindings file, prompt history, snippets and the `@` pick memory, all client-local presentation. It holds no pins, groups, archive or drafts; the session-state spec's ADR 0003 lint runs on this package.
- Artemis's terminal chrome variables carry renamed: `AGENT_HARNESS_TUI_IMAGES`, `AGENT_HARNESS_TUI_NOTIFY`, `AGENT_HARNESS_TUI_NO_TITLE`, `AGENT_HARNESS_DIFF`.

### First launch: local detection, service down, pairing

- The runtime reads the local environment's bootstrap grant file and exchanges it over loopback for a `tui` local client session with every scope and the top ceiling; several terminals may run at once since `tui` exchanges are not replaced (env spec). No code is ever typed for the local environment (ADR 0001).
- **Service down**: when the grant file exists but discovery does not answer, the local connection reports `service-down` and one line above the composer offers "The environment on this machine is not running. Start it? y/n". `y` runs the CLI's service start verb (the launcher workstream's, ticket 86; assumed `service start`, verify first) and the runtime polls discovery while it reports `starting` (ticket 80). With no service installed the offer is "install and start it". With no grant file and no paired environment, the screen is the pairing prompt.
- **Pairing** is `/pair <link>` or `/pair <address> <code>`: `connections.add` on the runtime, each typed failure (`expired-code`, `used-code`, `unreachable`, `protocol-mismatch`, `not-ready`, `different-environment`) one line (ticket 80). `/pair create`, with `admin` scope, calls `access.pairings.create` and prints the link, the short code and a QR in block characters (chosen default: a text QR is not a pixel gap). `/environment` lists connections with phase, version and "unreachable since" and offers enable, disable, remove, set primary and `sessions` (list and revoke client sessions), all runtime or `access.*` calls.
- A protocol mismatch is rendered as the runtime reports it: update this client, or update the environment through the launcher's self-update when its flag is present (ticket 80, ADR 0007).

### The screen

Artemis's layout stands (audit section 1): a header (logo, environment chip, workspace), the rail on the left, and on the right the bottom-anchored transcript, the delegated-work strip, the checklist strip, the queued line, the open card (permission, question, picker, session preview, Set up summary or terminal pane), the composer, the status line and the activity line. Tab walks composer, rail, delegated strip, terminal pane when open, transcript, skipping stops not drawn (Artemis's `nextFocus`; the pane is the one added stop). Under 100 columns the rail is hidden and the picker replaces it. Layout is client-local presentation (glossary: Pane).

### The rail: a projection of the session list

The rail renders `projections.sessionList` and `projections.environments` (ticket 80); every row is a summary of the session-state spec.

- **Headings, in order**: pinned (merged across environments by `pinOrderKey` then `pinnedAt`); one heading per merged group (the session-state spec's merge and order rules, text from the primary environment); ungrouped sessions under their environment's name; the snoozed shelf with wake times; the settled shelf, folded; the archive, folded. Fold state per heading name is the allowed presentation key `collapsedHeadings`.
- **Every row**: environment badge (colour, icon, two-letter abbreviation, ADR 0005), title, activity glyph (`idle`, `starting`, `running`, `parked` with count), tags, a `pending` marker while an outbox entry is unconfirmed, and a dim style with "unreachable since" on the heading when its environment is down.
- **Row keys** dispatch the session-state commands: `a` archive or unarchive, `p` pin or unpin, `d` delete (confirmed once; `/restore` within the grace), and the added `s` settle or unsettle, `z` snooze (picker: an hour, this evening, tomorrow morning, next Monday, a typed time; absolute UTC on the wire), `t` tag, `g` group (a picker of merged headings plus new; `groups.create` on the session's environment first when it lacks the group, then `sessions.setGroup`), `Shift+↑` and `Shift+↓` move within the pinned block or the active list (`sessions.reorderPinned` or `sessions.reorderActive` with a key generated between neighbours) and answer absent with the reason in the shelves and the archive, which have no manual order (session-state spec). These are chosen defaults that clash with nothing in Artemis's sidebar context; the drag gesture is the named gap, the semantics are not.
- **Filter and search**: `/` in the rail filters visible rows; `/search <text>` runs `projections.search` across environments (ticket 80) into a picker. Neither is server-side search.
- Enter on an environment heading starts a session there (ADR 0005): the composer shows environment, account, model chips in that order and `sessions.create` carries the client-minted id, the workspace and the chosen account, model and mode. The workspace in phase A is a `directory` path on that environment, chosen from a picker of the paths that environment's session summaries already carry, or typed; browsing an environment's directories and the other workspace kinds are the workspace-picker workstream's (85), and `/cwd` opens the same picker.

### The transcript: a projection of one session

- The transcript renders `projections.session` (ticket 80): streamed messages; tool calls folded as Artemis folds them (a run's finished calls as one count row, running and failed in full, a tool quiet three minutes turns amber); prompts and questions at the sequence of `prompt.opened` once answered (permissions spec); plans; delegated work as the strip; the cost line under each finished turn (tokens, dollars, plan-window deltas when the adapter reports them). An opaque event is one dim row naming its type (ADR 0001). A `cached` or `catching-up` marker heads the transcript until `synchronized` (ticket 80).
- The row verbs carry: `o` opens the file in `$VISUAL` or `$EDITOR` when the environment is local, else in the pager through `files.read`; `d` and `/diff` read `diffs.session` and `diffs.workingTree` through the user's diff filter; `x` interrupts the tool through the adapter workstream's method; `r` recalls the command. The pager (`Ctrl+O`) and `/export` work over the projection.

### The composer

- Artemis's component with props from the runtime: `live` from `projections.runs`, `locked` with a reason from `capability`. The draft is a session field, debounced one second and dispatched by the runtime (ticket 80), so it follows the session between clients. History, snippets, paste chips, `Ctrl+V` images and `Ctrl+G` are client-local and carry as they are.
- Sending dispatches the adapter workstream's start and send methods (`runs:drive`, never queued); a send during a live run is a queued message, held by the provider where it declares a queue and by the environment otherwise (ADR 0022), shown on Artemis's queued line in order until it is steered, delivered or withdrawn. `Ctrl+Enter` reads now (`runs.readNow`); `↑` on an empty composer withdraws the newest queued message (`runs.withdraw`), whose text lands in the session draft and so in every client's composer, a real withdraw where Artemis could only take the text back. Attachments ride the send method's field (ticket 82).
- **Fork and rewind** (ADR 0022): Esc Esc opens Artemis's prompt picker with two actions per row: `picker.choose` (Enter) rewinds here (`sessions.rewind`) and `picker.branch` (`b`) branches here (`sessions.fork` with the row as anchor); `/rewind [n]` (n counts prompts back, default 1) and `/fork [n]` (bare `/fork` forks the end) do the same from the composer; on a user row under the transcript cursor `w` rewinds and `f` forks (`r` stays Artemis's recall). After a rewind the strip shows "Rewound to <prompt> · /rewind undo" until the next run starts; `/rewind undo` and `u` on the rewound fold under the transcript cursor both call `sessions.undoRewind`. A rewind while a run is live is refused; the picker offers stop-and-rewind as two commands. Fork onto another account goes through `/handoff`'s picker on the new session. Files are never restored; the picker says so.
- **Slash commands** carried with one rename: `/account` (was `/profile`; `/profile` stays a hidden alias), `/model`, `/mode`, `/resume`, `/attach`, `/copy`, `/export`, `/diff`, `/pin`, `/title`, `/asks`, `/timeline`, `/snip`, `/tasks`, `/usage`, `/handoff`, `/cwd`, `/new`, `/help`, `/quit`. Added: `/environment`, `/pair`, `/containment`, `/setup`, `/settings`, `/review`, `/archive`, `/group`, `/tag`, `/settle`, `/snooze`, `/restore`, `/search`, `/terminal`, `/files`, `/notices`, `/reload`, `/fork`, `/rewind`. Deferred: `/undo`, `/check`. An unknown `/command` goes to the agent as typed (Artemis's rule); the provider's own commands come from the adapter's commands query when its flag is present.
- `/handoff` in phase A opens the account picker for this session's next run on the same environment with each account's plan reading, as Artemis's offer does; hand-off between environments is milestone 2 (ADR 0005), drawn absent-with-reason.
- `@` lists the workspace through `files.list` on the session's environment, scored by Artemis's fuzzy scorer; `/files [path]` opens the same listing as a browsable picker and Enter reads the file in the pager through `files.read`. `!` runs a command in an environment-owned terminal attached to the workspace and `!!` sends its output.

### Cards: permissions, questions, parked asks

- A parked prompt (permissions spec) renders as Artemis's card below the transcript: cursor on Deny, a bare Enter never authorises, `Tab` for a note, `Space` ticks options on a question, the blast-radius lines when the adapter supplies them. The answer is `permissions.prompts.answer` (`runs:drive`: never queued, re-sent with its command id after a mid-flight drop, so story 11 holds by the runtime's rule). `remember: 'session'` is the card's "for this session" row. Artemis's `e` and `s` keep their keys and answer absent ("rules are per session on the harness", permissions spec), drawn dim as Artemis drew `planned` rows.
- **Parked asks**: `/asks`, and `Ctrl+]` when more than one session is parked, open Artemis's asks card over `projections.runs`' parked list across environments, each row with badge and TTL countdown from server time; `y` and `n` answer in place, Enter opens the session.
- **Attention**: the runtime's attention events drive Artemis's `attention` module unchanged: title, bell or OSC notification after six seconds of an unanswered prompt or sixty after a finished turn with no key pressed, and the away summary. `projections.notices` shows on the activity line and stacks in `/notices`.

### Status, usage, pickers

- **Status line one**: badge, account, model and effort, mode, containment glyph, and at the right the plan windows from `projections.usage`, pooled by account identity (ADR 0005, ADR 0018). **Line two**: the run's activity, elapsed time, tokens, cost, key hints; or Artemis's yellow hand-off offer when the window is out and no run is live.
- `/account` lists `projections.accounts` for the session's environment with plan readings plus "add an account", which starts the sign-in the adapter workstream drives (ADR 0018: the environment publishes the URL, the terminal shows it and takes the code). `/model` lists `projections.models` with effort. Both are per environment (ADR 0001).
- `/mode` and `Shift+Tab` step plan, acceptEdits, auto, bypassPermissions clamped to the connection's ceiling; a mode above it is greyed with the ceiling named; the choice is `permissions.mode.set`, which returns the effective mode; bypass shows the permissions spec's sentence. `/containment` calls `permissions.containment.set` among off, workspace, workspace-no-network, greying unavailable levels with the probe's reason from `permissions.settings.get`. `/review` renders `permissions.review.list`.
- `/settings` is a generic editor over `settings.get` and `settings.update` (session-state spec): every key of the contracts settings schema, rendered by type, read-only without `admin` scope.

### Set up: the summary and the pointer

- Set up is a summary with a pointer, never the steps (ADR 0016, ticket 30). `/setup [environment]` renders one line per step from the step-registry query the Set up workstream names (assumed `setup.steps.list`, scope `read`, per environment; verify first): name, health, and the check's message when it needs attention. While any step needs attention the header carries "Set up on <environment>: 7 of 10 done, 2 need attention (Key manager, Browser). Run it in the desktop window." The pointer names the desktop window in milestone 1, the browser tab from milestone 2.
- Steps the terminal completes itself are those whose writes are commands it already issues: pairing (`/pair`, Your machines), mode and containment (`/mode`, `/containment`, Permissions), a sign-in (`/account`, Account, ADR 0018). Their health re-reads after the receipt.

### Terminals, files and diffs: the vocabulary this workstream fixes

The env spec reserves scope `terminal` for these and leaves them to the renderer workstreams; the terminal UI is built first, so this workstream fixes the vocabulary in the contracts package and the environment's terminal module. The GUI (84) reuses it and may add optional fields, never rename. Every method takes scope `terminal`; mutating ones a `commandId`.

- **Terminals** are environment-owned pseudo-terminals with scrollback capped at 5,000 lines or 8 MiB (ADR 0004, T3 Code's `BoundedTerminalHistory`), attached to a session's workspace, outliving any connection. `terminals.open` (client-minted id, session, optional columns, rows and environment variables; the login shell in the workspace directory), `terminals.write`, `terminals.resize`, `terminals.close`, `terminals.list` (per session: id, opened at, size, exit code), and the stream `terminals.subscribe` (id, `afterSequence`; snapshot of the retained scrollback, then output chunks and `exited`). Output never enters the event log: a bounded in-memory history per terminal plus the subscription, gone with the terminal (chosen default; the log holds transcripts, ADR 0002). A session's terminals close on delete. Prior art: T3 Code's terminal manager, `NodePtyAdapter`, `OutputProtocol`.
- **Files**, read-only in phase A: `files.list` (session; `git ls-files --cached --others --exclude-standard` in a repository, else a bounded walk with Artemis's skip list; capped at 20,000 entries with `truncated`) and `files.read` (session, relative path, 2 MiB cap, `binary` flag). Paths never escape the workspace (`invalid_params`).
- **Diffs**: `diffs.workingTree` (session; unified diff of the workspace) and `diffs.session` (per file, from the runs' tool events); 8 MiB cap with `truncated`.

**The terminal pane.** `/terminal` opens or reopens a terminal for the session as a pane between transcript and composer, sized through `terminals.resize`. It is drawn from a **headless terminal emulator** (`@xterm/headless`, which pi-tui's tests drive) fed by `terminals.subscribe`, its rows rendered as Ink text with colours. With focus, every key is forwarded through `terminals.write` except the two `terminal` actions: `terminal.leave` on `Ctrl+\` (chosen default; twice sends a literal) and `terminal.scrollback` on `Ctrl+O`, which opens the retained scrollback in the pager. A reconnect resubscribes from the cursor and replays, so scrollback survives a blip. The environment owns the terminal; the pane only draws it, so this is not a pixel gap.

### The parity contract in practice

The contract is the wire (ADR 0004). In milestone 1 the terminal UI implements: sessions and every organisation command; runs (start, send, steer, queue, read-now, withdraw, interrupt, fork, rewind, undo rewind, status, usage; ADR 0022); permissions and questions (cards, parked asks, mode, containment, the review list); accounts, models and usage per environment, including a sign-in; settings (the generic editor); Set up as summary and pointer (ADR 0016's shape, not a gap); environment management (pair both ways, list, enable, disable, remove, revoke); the terminal pane, and files and diffs as pager views; delegated work and tasks. Whatever the runtime projects, the terminal renders.

**Named gaps**, each filed as a `parity` issue when the build starts, David deciding (ADR 0004): the browser dock pane; the GUI's preview pane (a rendered web preview of the workspace, not the rail's session preview, which the terminal has); the drag gesture for reordering (semantics on `Shift+↑`/`Shift+↓`); images beyond the kitty, iTerm2, WezTerm and Ghostty protocols (drawn as `[image WxH · size]` elsewhere, as Artemis does); the pane grid (one session at a time, `Ctrl+]` switches); the documents pane, pending the GUI workstream's wire. A capability the environment reports absent is not a parity gap; it is the runtime's absent-with-reason line.

### Shortcuts: the shared action list, the defaults, the keybindings file

- **Named actions.** Every key is an entry in one shared list in the contracts package: id, context, default keys, one-line description, and `wired` or `absent` with a reason (ADR 0004). Ids are `<context>.<verb>` (prefix `row` is context `transcript`, `rail` is `sidebar`) and `command.<name>` for slash commands; contexts are Artemis's eight plus `terminal`, `asks` (the parked-asks card, whose keys Artemis drew on the card's hint line rather than in `KEYMAP`) and `confirm` (the one-line yes or no offers: service down, delete). Sigils typed into the composer (`/`, `@`, `;;`, `!`, `!!`) are syntax, not keys, and only their menu triggers are actions. The GUI's defaults for the same ids are its own column.
- **Defaults reproduce Artemis's terminal map exactly**: every row of `KEYMAP` at 443cf2e is one action with the same keys and context, every entry of `COMMANDS` a `command.<name>` with the same usage line; the table below is the transcription. A row the harness lacks keeps its keys as `absent` with its reason, drawn dim in the help overlay as Artemis drew `planned` rows.
- **Bindings are per client** (ADR 0022): the terminal map is Artemis's, Esc and Ctrl+C included, and the GUI keeps a map of its own with no stop key by default; the Keyboard shortcuts pane (GUI spec) shows both columns over this one action list.
- **`keybindings.json`** in the state directory (or `--keybindings`): a JSON object from action id to a list of key names as written in the table, read at launch and on `/reload`. An unknown id or key name is reported and ignored; a mapping giving one key to two actions in one context is refused whole with the clash named (Artemis's test rule made a runtime rule). `/help` shows the effective map with remapped rows marked.
- **The test**: a fixture holds Artemis's rows and commands as data; it asserts every fixture row has an action with the same keys and context, every command has its `command.<name>`, no two actions in one context share a default key, and every id is in the shared list. This is ADR 0017's shortcut contract test.

The defaults (keys separated by commas are alternatives; the description is Artemis's):

| Action | Keys |
| --- | --- |
| app.focus.next | Tab |
| app.mode.step | Shift+Tab |
| app.interrupt | Esc |
| app.prompt.back | Esc Esc |
| app.interruptOrQuit | Ctrl+C |
| app.pager.open | Ctrl+O |
| app.checklist.toggle | Ctrl+T |
| app.attention.next | Ctrl+] |
| app.handoff | Alt+H |
| app.help | ? |
| composer.send | Enter |
| composer.newline | Shift+Enter, Ctrl+J |
| composer.continueLine | \ Enter |
| composer.navigate | ↑, ↓ |
| composer.command.menu | / |
| composer.file.mention | @ |
| composer.snippet.expand | ;; |
| composer.complete | Tab |
| composer.slot.back | Shift+Tab |
| composer.shell | ! |
| composer.paste | Ctrl+V |
| composer.editor | Ctrl+G |
| composer.suggestion.take | 1–4 |
| composer.line.start | Ctrl+A, Home |
| composer.line.end | Ctrl+E, End |
| composer.buffer.start | Ctrl+Home |
| composer.buffer.end | Ctrl+End |
| composer.word.back | Alt+B, Ctrl+← |
| composer.word.forward | Alt+F, Ctrl+→ |
| composer.word.deleteBack | Ctrl+W |
| composer.word.deleteForward | Alt+D |
| composer.cut.toStart | Ctrl+U |
| composer.cut.toEnd | Ctrl+K |
| composer.yank | Ctrl+Y |
| composer.undo | Ctrl+_ |
| composer.backspace | Backspace |
| composer.history.search | Ctrl+R |
| composer.history.scopeOrStash | Ctrl+S |
| transcript.pageUp | PgUp, Shift+↑, Ctrl+↑ |
| transcript.pageDown | PgDn, Shift+↓, Ctrl+↓ |
| transcript.cursor | ↑, ↓ |
| transcript.follow | End |
| row.open | o |
| row.recall | r |
| row.copy | y |
| row.diff | d |
| row.unfold | Enter |
| row.stop | x |
| row.leave | Esc |
| rail.move | ↑, ↓ |
| rail.moveVi | k, j |
| rail.open | Enter |
| rail.filter | / |
| rail.filter.erase | Backspace |
| rail.preview | Space |
| rail.archive | a |
| rail.delete | d |
| rail.pin | p |
| rail.archive.filtering | Ctrl+A |
| rail.delete.filtering | Ctrl+D |
| rail.pin.filtering | Ctrl+P |
| rail.leave | Esc |
| composer.readNow | Ctrl+Enter |
| composer.withdrawLast | ↑ (empty composer) |
| row.rewind | w |
| row.fork | f |
| row.rewindUndo | u (on the rewound fold) |
| picker.branch | b |
| delegated.enter | Tab |
| delegated.move | ↑, ↓ |
| delegated.open | Enter |
| delegated.stop | x |
| delegated.unfold | → |
| delegated.fold | ← |
| delegated.leave | Esc |
| picker.move | ↑, ↓ |
| picker.moveVi | k, j |
| picker.filter | Letters |
| picker.choose | Enter |
| picker.preview | Space |
| picker.rename | Ctrl+R |
| picker.archive | Ctrl+A |
| picker.pin | Ctrl+P |
| picker.leave | Esc |
| permission.move | ↑, ↓, k, j |
| permission.choose | Enter |
| permission.deny | Esc |
| permission.note | Tab |
| permission.rule.edit (absent) | e |
| permission.scope.walk (absent) | s |
| permission.tick | Space |
| pager.line | j, k, ↑, ↓ |
| pager.screenDown | Space |
| pager.screenUp | b |
| pager.halfDown | PgDn, Ctrl+D |
| pager.halfUp | PgUp, Ctrl+U |
| pager.top | g, Home |
| pager.bottom | G, End |
| pager.turn.next | } |
| pager.turn.prev | { |
| pager.search | / |
| pager.match | n, N |
| pager.editor | v |
| pager.close | q, Esc |

Added here, chosen defaults: `rail.settle` (s), `rail.snooze` (z), `rail.tag` (t), `rail.group` (g), `rail.moveUp` (Shift+↑), `rail.moveDown` (Shift+↓); `terminal.leave` (Ctrl+\), `terminal.scrollback` (Ctrl+O); `asks.move` (↑, ↓), `asks.open` (Enter), `asks.allow` (y), `asks.deny` (n), `asks.close` (Esc), as Artemis's asks card hints them; `confirm.yes` (y), `confirm.no` (n, Esc); `command.<name>` for every slash command above.

### Rendering

- Ink 7 with React on the alternate screen, `exitOnCtrlC` off and **`incrementalRendering` on** (ticket 18, ADR 0004). Ink 7.1.1 already wraps frames in synchronized output on a TTY, so the terminal UI writes no such escape itself (audit section 1). The frame is sized to the terminal so Ink's clear-terminal path stays the exception. Images are re-sent only when their row changes.
- Frames are throttled to one per 16 milliseconds under streaming with keyboard input bypassing the throttle (chosen default, pi's rule), in the frame scheduler Artemis already has.
- `pi-tui` stays deferred (ADR 0004, pi inventory): re-evaluated only if flicker or scrollback complaints remain after `incrementalRendering` is measured in Seth's terminal and tmux (audit open question 2). The seam that keeps the swap possible is kept: components take props from projections and hold no state.

### When the environment is unreachable

The runtime's rules (ticket 80, session-state spec) rendered: the heading shows "unreachable since" from server-time skew; rows come from the cached snapshot, dim; an open transcript shows its cached snapshot with the marker; organisation keys queue in the outbox and the row shows `pending` until the receipt; run keys, the composer's send and `/terminal` refuse at once with one line, the composer locked with that reason; a rejected receipt after reconnect is one notice. On `ready` the heading clears, `catching-up` shows until `synchronized`, and pending markers retire as receipts land. `revoked`, `expired` and `draining` show the runtime's notice with its action. No transcript line is ever rebuilt client-side.

### What this workstream does not decide

78 env: frames, scopes, receipts, replay, the grant file, pairing routes, service verbs. 79 session-state: summary fields, commands, events, sort keys, merge rules, the lint. 80 client-runtime: the connection machine, backoff, outbox, overlays, projections, capability answers, the shell seam. 82 claude-adapter: run and transcript events, start, send, steer, interrupt, attachments, account, model, usage and commands queries, sign-in, provider titles. 83 permissions: modes, ceilings, containment, prompt events, the answer method, the review list. 84 gui: the desktop renderer, the shell, its shortcut column, extensions of the terminal and file vocabulary. 85 workspace-picker: workspace kinds beyond `directory`, name, icon and colour. 86 launcher-update: the service start verb, self-update, channels. 87 forge: pull-request rows. 88 setup: the step-registry query and shape. 89 skills-instructions, 90 banks, 91 key-managers, 92 routines, 93 browser: nothing here beyond rendering their notices. 94 switch-over: Seth's move and the retirement of Artemis's terminal binary.

## Testing Decisions

- **What a good test is**: a frame a person would see, produced by a key a person would press, asserted by row; never a component's state, a hook's value or a private map. Keys are the bytes a terminal sends, through Ink's own parser (Artemis's `Composer.test.tsx` names them: `\r`, `\u001B[A`, `\u001B[Z`), so a passing test is a test of real keys.
- **Primary seam: the client runtime against a scripted fake environment, rendered by Ink's test renderer.** The runtime runs on an in-memory platform (ticket 80's storage, secrets, clock, network toggle, no shell) over ticket 80's fake wire, extended with a script: sessions and groups on one or two environments, a run streaming deltas, tool calls and a prompt, receipts with chosen outcomes, `bye` reasons, discovery answering `starting` or nothing. The App renders through `ink-testing-library` (`render`, `lastFrame`, `stdin.write`, `rerender`) at a fixed size, one tick per frame as Artemis's tests wait. Cases: the first-launch paths (grant present; service down with `y` invoking a recorded start command, then `starting`, then `ready`; no local environment; a link and a code with each typed failure); the rail's headings, merged group, badges, shelves, filter and `/search`; each rail key issuing its command once with a command id and `pending` until the receipt, and the group chain; streaming, the fold, the opaque row, the freshness markers; the draft debounced and restored on switching; `@` from `files.list`; the card's cursor on Deny, `y` and `n` in the asks card, the answer re-sent after a mid-flight drop and applied once; the mode and containment pickers greying and showing the clamp; the Set up summary and pointer; `/settings` per schema type; the terminal pane drawing scripted output, forwarding keys, leaving on `Ctrl+\`, replaying after a reconnect; the unreachable rendering; `revoked` and `protocol-mismatch` notices; title and bell after six seconds under fake timers. Prior art: Artemis's `Composer.test.tsx`, `Transcript.test.tsx`, `Sidebar.test.ts`, `PermissionCard.test.tsx`, `AsksCard.test.tsx`, `StatusBar.test.ts`, and `conversation.test.ts`, whose `fakeDriver` with `emit` is the shape the scripted environment replaces.
- **Smoke through the real spine**: two serial tests against the env spec's in-process environment (temporary directory, loopback port 0, scripted fake provider) with the real platform on a temporary state directory: grant exchange to a rendered rail, and a send streaming through the fake provider into a rendered transcript. Prior art: T3 Code's `buildAppUnderTest` and `withWsRpcClient`; Artemis's port-0 helper in `runStreamClaim.test.ts`.
- **The keymap test** as specified, plus Artemis's honesty checks from `keymap.test.ts` (every group has rows, no key twice per context, commands echoed from the list, `nextFocus` and `stepCursor` pure) and the keybindings file (override applied, unknown id reported, clash refused whole).
- **Pure modules with their own tests**, carried from the 57 files where the pattern is a decision with no I/O: `attention`, `rowVerbs`, `blastRadius`, the fold, `Sidebar`'s row script (rewritten to the session-state sort and merged headings), `render/markdown`, `render/diff`, `render/highlight`, `render/images`, `pasteKind`, `snippets`, `history`, `editor`, `clipboard`, `suggestions`, `timeline`, `exportTranscript`, `terminal` (protocol sniffing). **Not carried**: `dataDir`, `preferences` (the third pin store), `host`, `pool`, `failover` (reshaped onto `projections.usage`), `fileIndex` (listing moved to the environment; the scorer stays), `update` (ADR 0007), `print`, `sessionsCli`, `launch`, `directories`.
- **Terminal vocabulary tests** run in the environment package through the env spec's primary seam: open, write, resize, close, list, the snapshot at the caps, live chunks, `exited`, replay from a cursor, closure on session delete, scope refusal; `files.list` capped and never escaping the workspace; `diffs.*` truncation.
- **Framework**: Vitest with `ink-testing-library`, as Artemis. The ADR 0003 lint runs on the package.

## Out of Scope

- Everything under "What this workstream does not decide".
- `-p` one-shot printing and `ls`: not phase A; programs use the completions surface (ADR 0015); verify in phase D whether Seth relies on them.
- `/undo` and `/check`: deferred to phase D, carried if Seth relies on them; neither is a wire-contract feature, so neither is a `parity` issue.
- Server-side and full-text search, paging the archive (later); hand-off between environments (milestone 2); the named `parity` gaps; the web tab (milestone 2); mouse support, a main-screen mode with native scrollback, `pi-tui`.

## Further Notes

Chosen defaults not decided on a ticket, for review:

- The `tui` flags; the state directory and its variables; the client label; a network signal from socket failures only; the QR in block characters.
- Rail actions `s`, `z`, `t`, `g`, `Shift+↑`, `Shift+↓`; `Ctrl+\` to leave the pane and `Ctrl+O` for its scrollback; the snooze presets; `/profile` as a hidden alias; the slash commands added and the two deferred.
- The terminal, file and diff vocabulary: scrollback 5,000 lines or 8 MiB, output never in the log, `files.list` at 20,000 entries, `files.read` at 2 MiB, diffs at 8 MiB, the login shell in the workspace, `@xterm/headless` as the pane's screen model.
- One frame per 16 milliseconds with keyboard bypass; the six and sixty second attention thresholds and the 100-column rail threshold, carried from Artemis.
- Rows the harness lacks kept as `absent` rather than dropped; the generic `/settings` editor; the Set up line in the header while a step needs attention.

Things a build session must verify first:

- The launcher workstream's service start verb (assumed `service start`) and whether install and start work from the terminal without a desktop.
- The Set up workstream's step-registry query (assumed `setup.steps.list`) and that it reports health per environment with the check's message.
- The adapter workstream's names for start, send, steer, interrupt, attachments, the commands query, sign-in, and the follow-up suggestions the `1`–`4` keys consume; whether a session may change account mid-way (`/handoff`).
- That the session-state vocabulary has a draft command (ticket 80 assumes drafts are session fields) and that `sessions.create` accepts a `directory` workspace from the terminal.
- That `ink-testing-library` drives Ink 7.1.1 with `incrementalRendering` on, and that the option removes the flicker in Seth's terminal and tmux (audit open question 2), before anything is decided about `pi-tui`.
- That `@xterm/headless` exposes colour attributes the Ink text layer can carry and fits the server artefact.
- That the fixture transcribed from `KEYMAP` and `COMMANDS` at 443cf2e matches the table row for row; the fixture is the test's source of truth, and drift is fixed in the table.
