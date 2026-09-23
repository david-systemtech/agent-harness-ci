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
