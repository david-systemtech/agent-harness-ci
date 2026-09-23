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
A provider login held by an environment, through which runs are billed and authenticated.
_Avoid_: profile

**Session**:
One conversation with an agent, owned by exactly one environment.
_Avoid_: thread, chat, pane, conversation

**Run**:
One turn of a session, from the prompt that starts it to the reason it ended.
_Avoid_: query, task, job

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

**Client runtime**:
The UI-free package every client renders from: connections, pairing, subscriptions with their caches and outbox, projections, command dispatch and capability flags. The only place session semantics live on the client side.
_Avoid_: SDK, store, bridge

**Desktop shell**:
The small set of things only a desktop app can do for a client (native dialogs, file pickers, the embedded web view, window chrome, notifications), reached through capability flags and never carrying session state.
_Avoid_: main process, IPC, bridge

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
