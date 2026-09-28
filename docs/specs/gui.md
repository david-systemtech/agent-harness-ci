# Spec: GUI renderer and desktop shell

Milestone 1 (Switch-over), phase B (daily use). Written 2026-09-28 from map ticket 84 of `david/agent-harness`. Implements ADR 0004 (one client runtime, renderers are projections, the desktop shell behind capability flags, the parity contract, named shortcuts with existing defaults, the milestone-1 baseline, all seven panes and the pane grid), ADR 0022 (the GUI's queue, read-now, withdraw, fork and rewind surfaces, no stop key by default, the Keyboard shortcuts pane), ADR 0023 (every colour a token from seven seeds, `appearance.theme`, the literal-colour lint), ADR 0027 (the settings rail, row scopes, the row registry, the address table) and ADR 0016 with ADR 0031 (Set up as a client surface with per-environment health), with ADRs 0001, 0003, 0005, 0006, 0014, 0015, 0017, 0018, 0025 and 0026; decision tickets #18, #30, #37, #48, #152 and #161 and the ticket's four comments. It builds on the six phase-A specs, `docs/specs/workspace-picker.md`, `docs/specs/launcher-update.md`, `docs/specs/forge.md` and the code on `main` at e2c728b, whose names it uses and does not re-decide. Peers read: the surfaces port audit (the reference desktop checkout and fixture commit it pins; its renderer's transcript, composer, hotkeys and Escape order, session list, pane grid, settings dialog and token stylesheet with their tests, and its Electron security, preview and window modules), T3 Code at 96c4bfa0 (`apps/web`, the desktop's app scheme, the keybindings contract), and the T3 Code inventory. The product name is the placeholder `agent-harness`.

## Problem Statement

David spends his day in a desktop window, and much of what went wrong went wrong in its renderer. It is 72,000 lines of React over a 13,900-line store shaped like the desktop's IPC vocabulary; Remote mode re-implemented that vocabulary over HTTP and stubbed what did not map, which is how an archive made in one window never reached another (surfaces audit, section 4.2). Groups and pins lived in one window's preferences file, keyed by a per-machine account id. The session list was polled every 4 or 20 seconds. The terminal pane worked only where the desktop hosted the engine; a headless environment answered 501. "Read it now" was a bare interrupt that trusted the CLI to keep its queue, and the turn the provider then opened reset the transcript on 2026-09-18; nothing could take a queued message back; Escape stopped runs David never meant to stop (ADR 0022). Every colour came from an offline build of two seeds, so nothing could be re-themed (ADR 0023). The settings dialog's persisted allowlist missed one of its sixteen addresses and sent that preference back to Profiles (ADR 0027). The window loaded from `file:` and its network lockdown admitted one configured origin, so a second environment meant a second app.

Phase A built the environment, the client runtime and the terminal UI over one wire. Nothing yet draws that wire in a window.

## Solution

`agent-harness` ships a desktop app that is a client like any other. Its renderer is a new React shell whose every value is a client-runtime projection, carrying existing leaf components once they take props; the same bundle runs in a browser tab in milestone 2. A small desktop shell on Electron gives the renderer what only a desktop can: the app's own scheme, the keychain, native dialogs, notifications, the embedded browser, the preview frame, the local service and the desktop's own update. On first launch it installs and starts the environment on this machine, connects through the bootstrap grant and opens Set up as the whole window.

The window keeps its layout: a sidebar of every environment's sessions, a grid of up to eight session panes with transcript, composer, parked-prompt card and status line, and beside each the seven existing panes, the terminal now environment-owned. Fork and Rewind sit under every message David sent; a queued message offers Read now and Edit; a rewind can be undone until the next run; the Stop button and the command palette stop a run, and no key does unless David turns "Esc stops the run" on. Every colour is a token of the home environment's theme. Settings is a rail of eight bands with search, each pane naming the environment it edits, every existing settings address landing on a row, and every key a named action with a GUI column beside the terminal's.

## User Stories

1. As David, I want the desktop window to show the same sessions, groups, pins and drafts as the terminal UI at once, so that no client disagrees with another.
2. As David, I want every environment I have paired in one sidebar with its badge, an unreachable one kept with "unreachable since", so that a sleeping laptop does not empty the window.
3. As David, I want to drag a session into a group, onto the pinned block or to a new place, and to settle, snooze, tag, archive, delete and restore it from its context menu, so that organising is one gesture.
4. As David, I want to filter the sidebar by typing and reach any session on any environment from the command palette, so that four characters find it.
5. As David, I want up to eight sessions side by side, split right or down and resized, and to drop a session onto an edge, so that I can watch several runs at once.
6. As David, I want a terminal, files, the diff, the browser dock, documents, delegated work and a preview beside each session, the terminal living on its environment, so that the seven existing panes stay where I work and a `pnpm dev` survives my laptop lid.
7. As David, I want Fork, Fork onto another account and Rewind under every message I sent, and Undo rewind until the next run, so that branching starts where the message is and a misclick costs nothing.
8. As David, I want a message sent during a run shown as queued or steering with Read now and Edit, so that I can hurry or take back what I typed.
9. As David, I want a Stop button and a palette entry, no key that stops a run unless I turn "Esc stops the run" on, and Ctrl+C always copying, so that no key stops a run I meant to keep.
10. As David, I want a permission, question or plan card that a bare Enter never approves, and one Parked asks view across environments, so that nothing is approved by reflex or waits unseen.
11. As David, I want an OS notification and a taskbar or Dock badge when a prompt parks or a run ends while the window is behind others, a click opening that session, so that I can look away.
12. As David, I want the status line to show environment, account, model and effort, mode with its clamp, containment and the pooled plan gauge, so that I know what the next run will do and cost.
13. As David, I want to start a session by choosing environment, account, model and workspace in that order, so that where code runs comes first.
14. As David, I want to sign in a new account on any environment from the window, so that a headless environment gets its first account from my desktop.
15. As David, I want every colour to come from this machine's environment's theme, painted from a cache on the first frame, with light or dark chosen per client, so that a re-theme changes everything and nothing flashes.
16. As David, I want Settings as a rail of eight bands whose search finds a row by its old name, and an existing settings address to open its row, so that "secrets" still finds Key managers and nothing I saved breaks.
17. As David, I want each environment-scoped pane to name the environment it edits, Usage and Your machines to show them all, and a health dot on each step's home row, so that I never edit the wrong machine and see where attention is needed.
18. As David, I want a Keyboard shortcuts pane listing every action with its terminal and GUI keys, the GUI's remappable, so that one list explains both clients.
19. As David, I want the desktop to install and start this machine's environment on first launch, hand it the server artefact it bundles and take its own update from it, so that one install gives me both and they move together.
20. As Seth, I want every wire feature the desktop shows to be in the terminal UI with the same meaning, or filed as a `parity` issue, so that the terminal is never silently behind.
21. As the setup checklist, I want Set up as the whole window on first launch and the first Settings row afterwards, checking the environment picked, so that every step has one home in the GUI.
22. As the setup checklist, I want the Appearance step to write `appearance.theme` and need attention when a theme misses the contrast rules, so that the registry's contract holds for the theme.
23. As the launcher, I want the desktop to take its staged build from its local environment, so that the desktop holds no forge token.
24. As a routine, I want my client-notice delivery raised in the window and as an OS notification while it is in the background, so that a firing's result is seen.
25. As a provider adapter, I want an unknown event drawn as one opaque row and a verb my adapter lacks drawn dim with my reason, so that an older window survives a newer environment.
26. As a client developer in another language, I want the row registry, the address table, the GUI key column and the theme's derivation in the contracts and theme packages, so that my client lands on the same rows, keys and colours.
27. As a build session, I want every surface rendered from the client runtime against a scripted fake environment in a DOM test renderer, and a lint refusing any literal colour, so that each story is a test and no colour escapes the tokens.
28. As David, with several sessions open side by side, I want to drag a new session onto the grid, or start one in a new pane from the keyboard or the palette, so that it opens in a pane of its own beside the others and no conversation I have open is replaced

## Implementation Decisions

### Packages and the platform

- **`theme`** (ADR 0023), no UI and no session state, depending on contracts alone: the seed-to-ladder derivation in OKLCH for the light and dark ladders; the existing contrast (WCAG 2 AA: 4.5:1 text, 3:1 components), gamut and hue-separation rules inside it, an unreachable seed clamped and the clamp reported; the existing token names; a light and a dark token per environment colour name (workspace-picker spec); the terminal UI's role-to-ANSI mapping; the icon master's render for milestone 2. The environment uses it for the Appearance check.
- **`gui`**, the renderer: React 19, Tailwind 4 through the inline theme mapping, the existing Radix-based `ui` primitives, cmdk, react-resizable-panels and xterm.js (the existing stack). It imports the runtime, contracts and theme, never Electron or a Node built-in, so the bundle runs in a browser tab in milestone 2.
- **`desktop`**, the Electron shell: implements the runtime's shell interface behind a preload, carries the `gui` build and the platform's server artefact, and builds the launcher-update spec's three desktop artefacts.
- **The desktop platform** (client-runtime spec): documents in IndexedDB; tokens through the shell's `secrets`; the browser's WebSocket; `fetch` through the shell's `http`; the system clock; the network signal from the browser's online and visibility events; kind `desktop`, label `<user>@<hostname>` from the shell's `system`; the grant through `localGrant`; `reportError` to the desktop's log.

### The desktop shell

- **One window, one instance**; a second launch focuses it and hands over its deep link. The renderer loads from the privileged scheme `agent-harness://app/`, registered standard and secure so IndexedDB has a stable origin (T3 Code's `t3code://`), never `file:`.
- **Hardening**, four layers: a sandboxed renderer with context isolation and no Node; a policy of `default-src 'none'`, scripts and styles from the app scheme only; navigation locked to the app scheme, other links sent to `openExternal` (http and https) or dropped; Chromium requests cancelled unless to the app scheme, the preview scheme, or a WebSocket to an address the renderer declared through `network.allow` (its connections' addresses, and loopback). HTTP to environments (discovery, the pairing and bootstrap exchanges, `POST /api/update`) goes through the shell's `http`, so the environment needs no cross-origin headers.
- **Members**, each absent with `no-shell` where not provided: `dialogs`; `window` (title, focus, badge, background colour); `notifications` (`show` with a tag, `onActivate` handing the tag back on a click); `deepLinks` (`agent-harness://`, strings the runtime parses); `webView` (the browser dock, in a partition of its own); `preview` (added: `grant` takes bytes and a media type and answers a URL on `agent-harness-preview:` serving them from memory with no network); `update` and `installer` (launcher-update spec); `service` (the bundled artefact's `service` verbs); `clipboard` (text, and an image for pasting); `openExternal`; `localGrant`; `secrets` (Electron's `safeStorage`, one encrypted file per environment id); `gh` (added: the forge spec's read of this computer's `gh` token for a host); `http`, `network` and `system` (added: platform, architecture, hostname, user). No `tray` in milestone 1.
- **Nothing about sessions crosses it** (ADR 0004): tags and deep links are strings. The `no-session-types-in-shell` lint extends to the desktop package. The window opens on the last Canvas colour the renderer set, and on first launch on the preset's, derived by the theme package, never the OS's (ADR 0023).

### How the renderer holds state

- **One runtime per window.** Components read projections through `useSyncExternalStore` and act through `commands.dispatch`, `requests.call`, `drafts.set` and the runtime's composed commands; every affordance asks `capability`, every session verb reads its availability from `projections.runs.session`, and nothing reads flags, scopes or streams (ADR 0004) or keeps a copy of what a projection carries (ADR 0003).
- **Presentation** lives in the renderer's one presentation module (the ADR 0003 lint's allowlisted module), in IndexedDB: the pane grid, each session pane's side column, the sidebar's width, visibility and view (groups or repositories), `collapsedHeadings` (keyed as the terminal UI keys them), text size, reading width, reasoning shown, the streaming fade, the light or dark preference, the cached theme, the GUI's key remaps, the last settings row, the first-launch mark, `hiddenDirectories` and whether to run an environment on this machine; each joins the lint's presentation keys.
- **Carried forward** once they take props: transcript rows and streaming text, markdown, highlighting, the diff view, the inline permission, question and plan cards, the composer and slash menu, the plan-usage meter, status line, session rows, command palette, parked asks list, hand-off picker, the six side panes and the file viewer, the primitives and the `ui` set. **Not carried**: the store and its pane-state modules, the bridges, the preferences file, the mock bridge.

### The window and the sidebar

- **Layout** (kept for parity): a header, the sidebar, the grid. The header shows the focused pane's environment (name, icon, colour), the split, terminal and browser actions, the Parked asks button with its count, and a Set up line while a step needs attention on the home environment.
- **The sidebar** renders `projections.sessionList` and `projections.environments` with the terminal UI's headings (#145): the pinned block, merged groups (the primary environment's order, then by key), each environment's heading with its ungrouped sessions and a new-session button, the snoozed shelf with wake times, the settled shelf and the archive folded; a switch shows it by repository (workspace-picker spec). A row carries the badge (the environment's icon in its colour token), title, activity with the parked count, tags, the pull-request state from `pullRequests` (forge spec), a marker while `awaitingReceipt` (#258), and dims with the heading's "unreachable since". A heading shows the phase, `pendingCommands` and a block's action.
- **The context menu** holds every organisation command: rename, pin, archive, settle, snooze (the terminal UI's presets and a date and time, sent as UTC; Wake now), tags, Move to group (`commands.moveToGroup`), Fork, Open in a new pane, Delete (confirmed; Restore lists `sessions.listDeleted`). A merged heading is renamed or deleted as one command per member group (#128).
- **Dragging** within the pinned block or a heading's active sessions sends a key between the drawn neighbours, spread when there is no room (#145's rule); onto a group it moves, onto the pinned block it pins, onto the grid it opens (centre) or splits (edge). A shelf or a filtered list refuses the drop with its reason. Every New session button drags too (each environment heading's in the sidebar, and the header's), and its drop never replaces a session: on a pane's edge it splits that pane, anywhere else on the grid (a pane's centre included) it splits the focused pane right. The new pane is the new-session surface below. Its environment is the dragged button's (a heading's button carries its environment; the header's carries the focused pane's), and its workspace is the pane it lands beside when that pane is on the same environment, else the picker's preset. A New session button dropped anywhere but the grid (a group heading, the pinned block) is refused with its reason ("A new session opens in a pane."). With eight panes open the drop is refused with its reason ("The grid holds eight panes; close one first.").
- **Search**: a filter over `projections.search`, and the command palette's sessions page across every environment.
- **The command palette** (Mod+K) lists every GUI-wired action with its keys ("Stop the run" is `app.interrupt`), the wired slash commands, every settings row by label and old name, and the sessions page; an absent entry stays, with its reason (gated groups).

### A session pane

- **Caption**: badge, title (renamed in place), workspace chip (kind, directory, a worktree's branch; the path on hover), pull-request link, run info (the latest run's resolved policy, account, model, effort, tokens, cost, ending), close.
- **The transcript** renders `projections.session` in the existing GUI presentation: streamed text with the word fade, reasoning behind a fold, each run's tool calls folded with a quiet call amber at three minutes, delegated work, plans, answered prompts at their `prompt.opened` place, the cost line under each turn, images and document tiles, an unknown entry as one dim row (ADR 0001), the freshness marker until `live`, and a find bar (Mod+F). A fork opens on the runtime's `forked` entry: one row naming its source and anchor, linking to the source.
- **Fork and Rewind** (ADR 0022), revealed on hover under every user message a run has read: Fork (`sessions.fork` anchored there), Fork onto another account (the hand-off picker with plan readings; the hand-off on one environment, ADR 0015) and Rewind (`sessions.rewind`), each drawn from its verb's availability (`verbs.fork`, `verbs.rewind`) and dim with the runtime's reason when absent, never hidden. One reason is turned into an offer: when `verbs.rewind` is absent only with `run_active`, the run has an id to stop and nothing is queued, Rewind reads "Stop and rewind here" and runs the runtime's stop-first rewind (below); with messages queued it stays dim, saying to withdraw them first (#232's rule). A rewind to the first message opens the session the runtime starts instead (`use_new_session`); a fork or that session opens in the pane once accepted.
- **The rewound fold**: one row at the rewind point, "Rewound: <prompt> · N prompts cut", unfolding the cut rows dim, with Undo rewind while `undoable`, and over the composer "Rewound to <prompt> · Undo" until a run starts. The fold says files are not restored.
- **Queued messages**: each message of `projections.runs.session`'s queue, drawn after its turn marked Queued, or Steering when the provider holds it and its adapter steers, with Read now (`runs.readNow`, which reads the whole queue in order, as its tooltip says) and Edit (`runs.withdraw`; the text returns through the session's draft into every composer). A message an interrupt re-owned keeps its place. A strip over the composer counts the queue with Read now and Edit newest (the runtime's withdraw target), each dim with its reason.
- **The parked prompt's card** sits between the transcript and the composer until answered (permissions spec), oldest first, "1 of N waiting" with its TTL in the environment's time. The existing inline cards: an approval only by Mod+Enter or a click on Allow once or Allow for this session (`remember: 'session'`), never a bare Enter; Esc denies; a note line; a question's options and a free answer; a plan's Keep planning and one approval per mode, a mode above the prompt's ceiling greyed; a denylist prompt naming its entry, with no "for this session". The answer is `permissions.prompts.answer`; a refusal is one line on the card (#149).
- **The composer**: the draft through `drafts.set`, another client's draft replacing the text only while nothing was typed over what this client held (the terminal UI's rule). Enter sends (`runs.start`, or `runs.send` during a run, never queued in the outbox); `/` opens the provider's commands (`commands.list`) and the slash commands the GUI wires; `@` lists files (`files.list` in the request cache); attachments by paste, drop or dialog, refused when `providers.list`'s input flags do not take them; `!` and `!!` as in the terminal UI. **Send and Stop share one button**: Stop while a run is live and the box is empty, "Stopping…" until it ends. The composer is locked with `capability`'s line while no run can start; a missing workspace replaces it with Choose a workspace (workspace-picker spec).
- **A new session**: environment, account, model, then workspace chips from `projections.newSession`, above a composer. Text typed there stays in the pane (it has no session to hold a draft yet); the first send runs `commands.startSession` (workspace-picker spec), which creates the session, and then sends that text as its first message, so a pane closed before its first send leaves nothing behind. `app.session.new` (Mod+N, a click on New session) shows it in the focused pane (the session that pane showed stays in the sidebar, nothing is lost); `app.session.newInPane` (Mod+Shift+N, and the palette's "New session in a new pane") and dragging the New session control onto the grid open it in a new pane instead, refused at eight panes (story 28).
- **The status line**: badge, account (label and identity), model and effort, the mode badge with its clamp, containment (as set, or the default marked so), the plan gauge pooled by account identity, the run's activity, time, tokens and cost, and the hand-off offer while the account's window is out and no run is live (`accounts.handoff.recommend`).
- **Pickers** per environment: accounts with status and plan reading and Add an account with the sign-in card (the URL opened through `openExternal`, the code pasted, the fallback command; `accounts.signin.get`, #147); models with efforts. A session's account is fixed, so another account means a fork onto it (#147).

### The seven panes and the grid

- **The grid** (the existing working area): rows of session panes, at most eight, split right or down from the focused pane, resized with a pixel floor, closed from the caption only; a session shows in one pane at a time. Layout is presentation (glossary: Pane). A new pane also comes from the New session control, dragged onto the grid or through `app.session.newInPane`, and holds the new-session surface (chips and a composer) until its first send (story 28).
- **The side column** beside each session pane shows one of its open panes at a time from a strip of names. Opening another session in the pane shows that session's column; a terminal or browser dock leaving the screen is hidden, never closed (the existing rule).
- **Terminal**: xterm.js over `terminals.subscribe` (the scrollback's snapshot, then live chunks); keys batched per animation frame into one `terminals.write` (the receipt cost the tui spec measured); `terminals.resize` on fit; the newest running terminal of `terminals.list` reused; only its close button sends `terminals.close`; token colours handed to xterm.
- **Files**: one directory at a time from `files.list`, a file in a file view through `files.read` (2 MiB; binary said, not drawn). **Diff**: `diffs.session` per file with its calls, and `diffs.workingTree`, in the existing diff view.
- **Browser dock**: a page from the shell's `webView`, one per session pane; absent with `no-shell` elsewhere. Whether a run drives it (ADR 0014's "embedded dock") is the browser workstream's.
- **Documents**: `projections.documents`, each row opening the preview, the source, or the transcript at the call that made it. **Tasks**: delegated work, live on top and finished folded, with a stop (`runs.stopTask`) and each agent's transcript (`sessions.subagentTranscript`).
- **Preview**: a page or SVG read through `files.read`, framed from the shell's `preview` URL in a frame sandboxed with scripts and without same-origin (the existing hardening layers); markdown drawn in the window; a snapshot, re-read on reopening; absent with `no-shell` in a browser tab.

### Parked asks, attention and notices

- **Parked asks**: `projections.runs`' parked list across environments, oldest first, each with badge, title, kind, question and TTL; Allow and Deny in place on permission rows; Allow all and Deny all behind one confirmation, never on denylist rows (#149).
- **Attention**: while the window is unfocused, the runtime's `prompt-parked`, a `run-ended` of a session shown in the grid, and a routine delivery's notice (once 92 raises one) each raise one OS notification whose activation opens that session in the focused pane; the badge counts parked sessions; the title says "needs you", "working" or "ready".
- **Notices** (`projections.notices`) show as toasts with their action (re-pair, update this client, update the environment, start the service) and stack in a list; dismissal is client-local.

### Keyboard: the GUI column and the Keyboard shortcuts pane

- **The GUI column.** The shared action list gains per action the GUI's default keys, `wired` or `absent` with a reason, an optional condition, and `off` for a key written but unbound until turned on. The terminal fields are unchanged; "a pressed action has a key" holds for the terminal column only, so an action only the GUI answers has an empty terminal column, which the terminal UI's help leaves out. A GUI action wired with no key is in the command palette and bindable.
- **Keys** are written as the terminal column writes them, with `Mod` for ⌘ on macOS and Ctrl elsewhere.
- **Defaults** reproduce the GUI map the surfaces port audit pins (the window's, the composer's, the cards', the find bar's, the palette's). ADR 0022 changes one row: Escape's last step, stopping a live run, is `app.interrupt` with Esc `off`, the switch "Esc stops the run".

| Action | GUI keys |
| --- | --- |
| app.palette, app.find, app.session.new (added) | Mod+K, Mod+F, Mod+N |
| app.session.newInPane (added) | Mod+Shift+N |
| app.sidebar.toggle, app.terminal.toggle, app.browser.toggle (added) | Mod+B, Mod+J, Mod+Shift+B |
| app.pane.splitRight, app.pane.splitDown (added) | Mod+\, Mod+Shift+\ |
| app.settings.toggle, app.runInfo.toggle (added) | Mod+,, Mod+I |
| app.interrupt | Esc, off |
| composer.send, composer.newline | Enter, Shift+Enter |
| composer.navigate | ↑, ↓ (from the start of the box) |
| composer.withdrawLast | ↑ (empty composer) |
| composer.complete, composer.command.menu, composer.file.mention, composer.paste | Tab, /, @, Mod+V |
| composer.shell | ! (as in the terminal UI; added by #388) |
| composer.readNow | none (wired) |
| permission.allow (added), permission.deny | Mod+Enter, Esc |
| picker.move, picker.choose, picker.leave | ↑ ↓, Enter, Esc |
| picker.back (added) | Backspace (empty query) |
| transcript.findNext, transcript.findPrevious, transcript.findClose (added) | Enter, Shift+Enter, Esc (find bar) |

- Every other action's GUI column is `absent` with its reason: the text field's own keys, a surface the GUI reaches otherwise and names (the context menu, the Fork and Rewind buttons, the scroll bar, Parked asks), or ADR 0022 for `app.interruptOrQuit` (Ctrl+C is copy). A slash command is wired when it names a session verb or opens a GUI surface; `/quit` and `/reload` are absent.
- **Escape** walks the existing order: close the palette, run info, the find bar or a menu; else deny the focused pane's parked prompt; else close Settings; else, only with "Esc stops the run" on, stop the focused pane's run.
- **Binding rules**: `keyClashes` per column; Ctrl+C and Mod+C refused for `app.interrupt` and anything that stops a run (ADR 0022); Mod+C, Mod+X, Mod+A and Mod+Z refused for every action, Mod+V for all but `composer.paste`. Remaps are the GUI's presentation, read by id against the defaults; the terminal UI's stay in its keybindings file (ADR 0022: each binding stored with its client).
- **The Keyboard shortcuts pane** (`appearance.shortcuts`): the list in its groups with search, each row's description, the terminal column (defaults, read-only, naming the terminal UI's keybindings file) and the GUI column (keys in force, remapped marked, record by pressing, reset, clash named before saving, absent rows dim with their reason). "Esc stops the run" heads the pane.

### Theme: tokens, the setting and the lint

- **`appearance.theme`** joins the settings table (ADR 0023): a name of 1 to 40 characters and seven seeds (canvas, accent, machine, thinking, success, warning, danger), each a hue and a chroma. The preset, "Default", is the existing one: Canvas neutral, Accent at hue 264, Machine 210, Thinking 310, Success 150, Warning 85, Danger 25, at the chromas of the dark pass the surfaces port audit records. Written by `settings.update` (`admin`), under the Appearance step's entry.
- **The Appearance check**: the state check `appearance.contrast` runs on the environment with the theme package: done when both ladders meet the rules, else naming each clamped seed with the action `restore`; never skipped (ADR 0031).
- **Painting**: before the runtime connects, the renderer applies the cached theme as CSS variables on the root, the window already on the cached Canvas colour; it then reads `appearance.theme` from the home environment (`settings.get` in the request cache) and re-derives and re-caches when it differs. The home environment is the local one on the desktop (the serving one in a browser tab), else the primary one; focus never recolours the window (ADR 0023).
- **Live**: a new environment notice, `settings.changed` (the keys), is appended with every `settings.updated`, and the runtime refreshes `settings.get` and `permissions.settings.get` on it, so a theme set from any client repaints within a round trip; it also pays the terminal UI's owed notice (#147).
- **Light or dark** is the client's preference: light, dark, or the OS's (preset).
- **`agent-harness/no-literal-colour`**, in CI over `gui`, `desktop` and any later renderer package the lint configuration names (it already reserves the browser tab's): refuses hex, `rgb()`, `hsl()`, `oklch()`, their alpha forms and `color()` in literals, JSX attributes, style objects and stylesheets; Tailwind's palette classes, `black` and `white` utilities and arbitrary colour values; named colour keywords in style objects and stylesheets but `transparent`, `currentColor` and `inherit`. Allowlisted: xterm's fallback theme and the preview frame's content. Logos use `currentColor`; environment colours stay data, drawn with their tokens.

### Settings: the rail, the rows and the addresses

- **The rail** (ADR 0027, #37's rail take): search at the top, the eight bands and their rows, the pane on the right; opened by Mod+,, the palette, a step's link, a deep link or an existing address.
- **The row registry** in contracts: id `band.row`, band, label, one-line hint, scope, the step it is home to, and search terms (the old addresses and section names). A pane is a GUI component keyed by row id; the terminal UI's `/settings` opens its editor by row id (ADR 0027).

| Row | Label | Scope | Home of |
| --- | --- | --- | --- |
| setup.checklist | Set up | environment | the checklist |
| accounts.accounts | Accounts | environment | account, carry-over |
| accounts.default-model | Default account and model | environment | |
| accounts.usage | Usage | everywhere | |
| knowledge.banks, knowledge.skills, knowledge.instructions | Memory banks, Skills, Instructions | environment | memory-bank, skills, instructions |
| access.permissions, access.browser, access.key-managers, access.forges | Permissions, Browser, Key managers, Forges | environment | permissions, browser, key-manager, forges |
| routines.routines, routines.bots | Routines, Bots (dim until milestone 2) | environment | no step |
| environments.machines | Your machines | everywhere | your-machines |
| environments.access, environments.service | Access, Service | environment | |
| appearance.theme | Theme | client | appearance |
| appearance.shortcuts | Keyboard shortcuts | client | |
| about.about | About | environment | |

- **Scopes** (ADR 0027): an `environment` row's header has an environment picker preset to the home environment and following the last choice for the life of the window, an unreachable environment's values shown cached and read-only; `everywhere` rows group every environment; `client` rows have none. About pins this client's version above its picker. The Theme row shows the light or dark preference, the display preferences and the home environment's theme with its swatches and clamps, edited in phase B through the generic editor (the picker is phase D).
- **Health dots** follow the environment the last `environment` pane picked and show only on home rows, the worst state of the steps homed there; the Set up row shows the worst of all.
- **Keys and steps name rows**: every settings key names its row, replacing its step band, and every step names its home row, replacing its pane and band; a contract test fails on a missing row, a home row homing another step, or a row naming an unknown step. Placed: the Account step's four keys on `accounts.default-model`, the permission keys on `access.permissions`, `updates.*` on `environments.machines`, `appearance.theme` on its row, and the two auto-settle keys and `sessions.transcriptCompactAfterDays` on `environments.service`.
- **Search** matches id, label, hint and the old names, so "secrets" finds Key managers and "cerebro" Memory banks.
- **The existing sixteen addresses** stay a closed union in contracts, mapped exhaustively at compile time (ADR 0027):

| Address | Row |
| --- | --- |
| profiles, models | accounts.accounts, accounts.default-model |
| runs | accounts.usage (its speed on accounts.default-model) |
| agents, skills | knowledge.instructions, knowledge.skills |
| memory-banks, cerebro | knowledge.banks |
| permissions, browser, secrets | access.permissions, access.browser, access.key-managers |
| server, remote | environments.access, environments.machines |
| routines | routines.routines |
| advanced | environments.machines (its service verbs on environments.service) |
| appearance, about | appearance.theme, about.about |

  The last row opened is stored as a row id checked against the registry (unknown opens Set up); the state import maps `settingsSection` through the same table.
- **Panes built here**, each over its feature's methods: Accounts (adopt, add and sign in, relabel, remove), Default account and model, Usage (every pooled gauge with its accounts and environments), Permissions (`permissions.settings.*`, the denylist with test and restore, the Unattended review), Forges (the forge spec's cards, add by pasted token or this computer's `gh`, primary, verify, remove), Your machines (a card per connection: name, icon and colour; version, channel, auto-update, Update now; containment availability; a pairing code for another client with link and QR; forget), Access (client sessions, ceilings, revoke, program pairings, the access log), Service (state, drain, rebuild projections, the session keys), Theme, Keyboard shortcuts and About (the launcher-update rows; Managed tools once 91 serves them). A row whose feature is not built shows its hint, its step's link and the generic editor for its keys. A step's card and its home pane may share components; the card is 88's.

### Set up in the window

- **First launch**: once the home environment is ready and while the first-launch mark is unset, Set up takes the whole window: the eleven steps on a rail with dots, the step's card beside it, the environment checked with a picker. Finishing or closing sets the mark; the Set up pane's "Open the full checklist" brings it back.
- **The Set up pane** (ADR 0027): each step with its dot and one-line status linking to its home row, the counts, Re-run (a `setup.check` of every step, then the first needing attention), and the environment checked with a link to set up another machine. Results come from the `setup` subscription once 88 serves it, until then from `setup.check` on opening, Check now and Re-run (ADR 0031); pending after half a second; a result older than its cadence shows its age; named actions map to commands or rows.

### The local environment, pairing and updates

- **First launch**: the runtime lists the placeholder "this machine" (#181); with "Run an environment on this machine" on (preset), the renderer calls `connections.startService`, whose shell `service` installs from the bundled artefact when nothing is installed and starts it. Off, the window opens on pairing.
- **Updates** (launcher-update spec): a bundled artefact newer than the local environment goes to `updates.apply` with the path from `installer.bundledServer`; "Restart to update" shows once `updates.desktop.stage` has staged the desktop's build, and `update.apply` takes it on that click or the next quit.
- **Pairing, blocks and unreachable environments** render the runtime's states as the terminal UI does: a link or an address and code with each typed failure in one line and re-pairing in place; a block's action (update this client, update the environment, re-pair); "unreachable since", cached rows and transcripts with the marker, pending organisation commands, run affordances and new terminals refused at once with the line.

### Client runtime, contracts and environment additions

- **`projections.documents(environmentId, sessionId)`**: a pure fold of the session's write and edit tool calls into one entry per workspace path that is a page, an SVG or markdown: its first write's call and time, last touch, revisions, and size when last written whole. A projection, so the terminal UI may list it.
- **A `forked` entry** from `session.forked` (source and anchor), both renderers' first row of a fork, answering #232's owed question with a note and a link.
- **`commands.fork`** (anchor, account and title optional): `sessions.fork`, then for an unanchored hand-off `sessions.setDraft` with the source's draft once accepted. **Stop-first rewind** on `commands.rewind`: `runs.interrupt`, then `sessions.rewind` once the run is no longer live, 30 seconds at most, never while messages are queued. Both are #232's rules moved here so both renderers carry them.
- **Refresh and capabilities**: `settings.changed` refreshes `settings.get` and `permissions.settings.get`; capability names `shell.preview`, `shell.gh`, `shell.http`, `shell.network`, `shell.system` and `shell.notifications.onActivate`. **The scripted environment** moves from the terminal UI's tests to the runtime's testing exports.
- **Contracts**: the GUI column and added actions, the row registry with keys' rows and steps' home rows, the address table, `appearance.theme`, `appearance.contrast`, `settings.changed`, the parity-gap list. **Environment**: `settings.changed` and the Appearance check. No method is added.

### The parity contract in practice

The GUI renders everything on the terminal UI's parity list (tui spec) with the same semantics from the same projections. The terminal UI's named gaps are the GUI's pixel surfaces: the browser dock, the preview, drag reordering, images beyond the terminal protocols and the pane grid; documents is no gap, being a projection. The GUI build files one `parity` issue per gap before its first merge, David deciding (ADR 0004), and a contracts list holds each gap with its issue number for ADR 0017's contract test.

### What this workstream does not decide

78 env: the wire, discovery, the grant, the Host check. 79 session-state: summary fields, commands, sort and merge rules, the ADR 0003 lint. 80 client-runtime: everything beyond the additions above. 81 tui: its rendering, keymap column and keybindings file. 82 claude-adapter: run events, attachments, sign-in, provider fork and rewind. 83 permissions: modes, ceilings, containment, prompts, the review. 85 workspace-picker: workspaces, the new-session projection, name, icon and colour. 86 launcher-update: the release and updater methods, the shell's `update` and `installer` behaviour. 87 forge: forge accounts and pull-request links. 88 setup: checks, cadence, the result cache, the `setup` subscription, every step's card. 89 skills-instructions, 90 banks, 91 key-managers, 92 routines: their panes and notices. 93 browser: the relay, the page driver, the composer's browser picker, the dock as a driver. 94 switch-over: the import's use of the address table.

## Testing Decisions

- **A good test** asserts what a person sees (roles, accessible names, text) after what a person does (pointer and key events through Testing Library's user-event), on the renderer mounted over a runtime; never a component's state, a hook's value, a class name, the presentation document or the runtime's internals. What presentation keeps is asserted by mounting again on the same storage.
- **Primary seam: the client runtime against the scripted fake environment**, on the in-memory platform with a fake shell that records what it was asked, the `gui` app rendered in jsdom with React Testing Library. Cases: first launch (the service installed and started through the fake shell, then Set up whole-window); the sidebar's headings, merged group, shelves, filter and palette search; each context-menu command and drag sent once, `awaitingReceipt` until its receipt, a refused drop's reason; streaming, folds, the opaque row, freshness; Fork, Fork onto another account, Rewind, stop-and-rewind, the fold and Undo, each dim with its reason where absent; Queued and Steering, Read now, Edit returning text to the composer; Send and Stop sharing the button; Escape's order with "Esc stops the run" off and on, Ctrl+C refused as a stop key; the card's Mod+Enter and Esc and never a bare Enter, an answer re-sent after a mid-flight drop applied once; Parked asks across two environments; a notification's activation; the grid's splits, its limit and an edge drop; the terminal replaying scrollback after a reconnect; the other panes from scripted answers; the rail's search by old name, the picker's preset, dots on home rows, an existing address opening its row; a remap, a clash and a reset; the theme painted from cache, then from the environment, then again on `settings.changed`. Prior art: T3 Code's `apps/web/src/components/*.test.tsx`; the terminal UI's harness over the same script. Also: dragging New session onto a grid of two panes adds a third holding the new-session chips and replaces neither; `app.session.newInPane` does the same from the keyboard; at eight panes both are refused with their reason (story 28).
- **Smoke through the real spine**: two serial tests on the env spec's in-process environment (temporary data directory, loopback port 0, scripted fake provider) with the real runtime over a real WebSocket and the renderer in jsdom: the grant exchange to a rendered sidebar, and a send streaming into a transcript. Prior art: T3 Code's `buildAppUnderTest` and `withWsRpcClient` in `apps/server/src/server.test.ts`.
- **Environment**, through that seam: `settings.changed` beside `settings.updated`; `appearance.contrast` through `setup.check`, done on the preset and naming a clamped seed on a theme built to fail.
- **The theme package**, as pure functions: both ladders meet contrast, gamut and hue separation; an unreachable seed is clamped and reported; the preset derives its shipped tokens within rounding; each environment colour's token pair passes. Prior art: T3 Code's `appearanceContrast.test.ts`.
- **The desktop shell**, with Electron's modules faked and the platform injected: the navigation and network lockdown, the preview scheme's snapshot and policy, `secrets`, `service` over a fake artefact, `http`, and each platform's update path driven, never skipped by the runner's own platform (the updater-bin-rm write-up, Windows).
- **Contracts**: the GUI column holds every key of a fixture transcribed from the GUI map the surfaces port audit pins, `app.interrupt`'s Esc `off` the one recorded difference; the clash rule per column; Ctrl+C and Mod+C refused on stop actions; the row registry's scopes and homes, every settings key on a row, every step's home row; the address table exhaustive; `appearance.theme`'s preset parsing; each parity gap with an issue number. Prior art: `actions.test.ts` and `steps.test.ts` on `main`, T3 Code's `keybindings.test.ts`.
- **Lint rules**: `no-literal-colour` with valid and invalid cases through the rule tester the other rules use; the shell lint over the desktop package.
- **Manual**: a desktop checklist per platform, as the service-install checklist is: first launch installing the service, the keychain, notifications and activation, the browser dock, the preview scheme, and the restart to update.
- **Framework**: Vitest with jsdom and Testing Library. **Not tested**: pixels and packaging.

## Out of Scope

- The Appearance picker, shipped themes, import and export, live preview (phase D, ADR 0023); the tinted icon (milestone 2).
- The browser tab's platform, the environment serving the bundle, and cross-origin rules for it (milestone 2, ADR 0001); hand-off between environments (milestone 2).
- A tray, several windows, mobile, and the existing follow-up suggestion chips (no carrier, #146).
- Every step's card (88), the content of the phase C panes (89 to 93), the browser dock as a run's driver (93), the what's-new checklist (ADR 0016).

## Further Notes

- **A new session in a new pane** (added 2026-09-28 at David's request, story 28): starting a new session must never cover a conversation already open in the grid. Dragging the New session control onto the grid, or `app.session.newInPane`, adds a pane instead. The pane's chips preset from the pane it lands beside because that is the environment and workspace he was looking at; the picker's own presets (workspace-picker spec) apply when it lands beside none.

**Chosen defaults** not decided on a ticket, for review:

- Packages `theme`, `gui` and `desktop`; the existing stack (Electron, React 19, Tailwind 4, Radix, cmdk, react-resizable-panels, xterm.js).
- The app scheme `agent-harness://app/`, the preview scheme `agent-harness-preview:`, deep links on `agent-harness://`; HTTP through the shell, WebSockets only to declared addresses; tokens as `safeStorage`-encrypted files per environment id; one window, no tray; the label `<user>@<hostname>`.
- Installing and starting the local service on first launch, with a preference to opt out; the home environment falling back to the primary one.
- Eight panes (the existing limit); a side column per session pane; terminals and browser docks hidden, not closed; terminal keys batched per animation frame; OS notifications only while the window is unfocused.
- `Mod` in the GUI column; `off` for Esc's stop; `composer.readNow` wired with no default key; `composer.withdrawLast` on ↑ in an empty composer, as in the terminal UI; `permission.allow` on Mod+Enter; Mod+C, Mod+X, Mod+A and Mod+Z reserved to text fields; only GUI-wired actions remappable.
- The theme preset's name "Default" and its seeds; light or dark preset to system; the Theme row `client`-scoped, showing the home environment's theme; the lint's named-colour rule limited to style objects and stylesheets, since environment colour names are data.
- Row ids `setup.checklist`, `access.forges`, `routines.bots` and `appearance.shortcuts`; Carry over homed on `accounts.accounts` beside Account; an unknown stored row opening Set up.
- The three session keys on `environments.service`, where the session-state spec put them in an Appearance "Sessions" band: ADR 0027 closed the Appearance band at Theme and Keyboard shortcuts, and auto-settle and compaction are the environment's policy on its log. The Set up spec may move them from the Appearance step's entry to Your machines'.
- The `settings.changed` notice; documents as pages, SVG and markdown by extension.

**Verify first** in the build session:

- That IndexedDB keeps a stable origin under `agent-harness://app/`, and a WebSocket from it passes the environment's Host check (the Host is the environment's address; the Origin, the app scheme, is not checked today).
- `safeStorage` on Linux without a secret service (Electron falls back to a weak backend): if so, the Your machines card says tokens are stored unprotected.
- That the fixture transcribed from the GUI map the surfaces port audit pins matches the table row for row.
- That xterm.js mounts under jsdom for the terminal pane's tests, else the pane's wiring is tested over the headless emulator the terminal UI uses.
- That `service install` runs from inside a signed app bundle on macOS (translocation) and from the Windows install directory.
- That a WebContentsView beside the renderer honours the browser dock's own partition and the renderer's navigation lockdown.

**Owed by this workstream's build**:

- To the terminal UI: adopt `commands.fork`, stop-first rewind and the `forked` entry in place of its own; drive its tests from the script's new home; leave GUI-only actions out of `/help` (paid by #388); whether to list `projections.documents` is David's.
- With 88: this build turns the step registry's pane links into home row ids and each settings key's band into a row, since the rail reads them first; 88 then serves the `setup` subscription and fills this frame with the step cards.
- To 93: the browser dock as a driver and the relay's handler registration on the runtime. To 91: Managed tools rows in About.

- Verified in the GUI column's build (#388): the fixture transcribed from the GUI map the surfaces port audit pins (`packages/contracts/test/reference-gui-keymap.ts`, the reference renderer at 443cf2e: the window's hotkey map, the composer's handlers, the three cards, the find bar and the palette) matches the table row for row: its 26 rows are the table's keys in the same places, Esc's stop the one row changed (`off`). The table's other rows are additions the reference lacks: `app.session.newInPane` (story 28), `composer.file.mention` (`@`, the composer section), `composer.withdrawLast` and `composer.readNow` (ADR 0022). The reference recalls on ↑ only from an empty box or one holding a recalled prompt; the table's "from the start of the box" is wider, and `composer.withdrawLast` now takes the empty box first. Not keys of the five places, and left out: the composer's Esc (the window's again), the slash menu's own keys, the sidebar context menu's letters.
- Chosen defaults not decided on a ticket, from the GUI column's build (#388):
  - **The column** is `gui` on each action: `wired` with `keys` (possibly none), an optional `when` and `off: true`, or `absent` with a `reason`. An action only the GUI answers has an empty terminal column: no keys, `absent` with one shared reason, no condition; `isGuiOnly` names it, the help overlay leaves it out, and the terminal UI's keybindings file reports its id and ignores it. The GUI-only actions sit at the end of the group of their context.
  - **Conditions**: `composer.atStart` ("from the start of the box"), `picker.queryEmpty` ("empty query") and `transcript.finding` ("find bar") join `composer.empty`. The find bar's and the palette's parenthesised places are conditions like the composer's, so a later transcript or picker key can share Enter, Esc or Backspace.
  - **Nested conditions**: `composer.navigate` (from the start of the box) and `composer.withdrawLast` (empty composer) both hold ↑ in the GUI, which the terminal's rule (one conditioned holder beside one unconditioned) refuses. A condition now names the wider one it lies `within` (`composer.empty` within `composer.atStart`), and `keyClashes` admits holders of one key whose conditions nest, the narrowest asked first; two under one condition, or under conditions neither within the other, still clash. The terminal column's rulings are unchanged.
  - **`composer.shell`** is wired on `!`, which the table left out: the composer section and #409 give the GUI `!` and `!!`. `composer.snippet.expand` and `composer.slot.back` are absent: snippets are the terminal UI's own.
  - **Slash commands** absent in the GUI beside `/quit` and `/reload`: `/timeline` (the transcript's cost lines and run info carry it) and `/snip` (snippets), neither a session verb nor a GUI surface; `/undo` and `/check` stay deferred to phase D as in the terminal.
  - **Stopping a run**: the actions no Ctrl+C or Mod+C may be are `app.interrupt`, `app.interruptOrQuit` and `composer.readNow` (it interrupts the run to read the queue); `row.stop` and `delegated.stop` stop a call or a task, not the run. `reservedGuiKey(id, key)` is the check a client calls before saving a remap; it reads `Mod` as the platform's command key, so a client writes Ctrl only for macOS's Control key.
- Chosen defaults not decided on a ticket, from the literal-colour lint's build (#386):
  - **The allowlist** is two module names, wherever a painting package keeps them: `xterm-fallback-theme.ts` (the terminal pane's colours before the theme is read) and `preview-frame-content.{ts,tsx,css}` (the preview frame's document and its own colours). The terminal and preview panes' builds put those colours there and nowhere else.
  - **Test files are linted too**, the allowlist being the only exemption: a test compares a painted colour with the theme package's derivation, and text shaped exactly like a hex colour (an issue number such as `#454`) is written from data.
  - **Beyond the four functions named**, `hwb()`, `lab()`, `lch()` and `oklab()` are literal colours too. A relative colour from a token or `currentColor` (`oklch(from var(--beam) l c h / 50%)`) and `color-mix()` of tokens pass as tokens.
  - **Every string is read for Tailwind's colour classes**, as Tailwind's own scanner reads every string, so a class string held in a variable is caught as one in `className` is. Tailwind's palette through its theme variables (`var(--color-red-500)`) is refused with the classes.
  - **An SVG element's colour attributes** (`fill`, `stroke`, `stop-color` and the like) are style, so a named colour there is refused (logos use `currentColor`); a component's `color` prop is data. The named colours are CSS's 148; system colours such as `Canvas` are not refused.
  - **Stylesheets are parsed tolerantly**, so Tailwind 4's at-rules and the `--color-*: initial` reset parse; the JavaScript rules read scripts only.

**For domain-modeling**: session pane, side column, pane grid, home environment, row, row registry and band are used here and are not glossary terms; "Esc stops the run" is a switch, not a mode, and "mode" stays the permission mode (the light or dark choice is called a preference here to keep it so).
