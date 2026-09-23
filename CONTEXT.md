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
