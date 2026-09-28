---
status: accepted
---

# One environment per OS user; every client is a remote client of one

Decided 2026-09-23 on the map ticket "Decision: server-per-machine topology, one renderer, and the wire" (david/agent-harness issue 16). Three renderers (local IPC, Remote mode, the served profile) and a separate headless server grew up because the server was never the primary way in; every served bug fixed in September 2026 came from translating about 250 IPC channels onto a wire. The harness instead runs one environment per OS user, a server installed as a user-level service that outlives any window, and every client, the desktop window on the same machine included, speaks to it over one typed JSON-RPC contract on a WebSocket, with a required scope on every method. Other environments are reached the same way over the tailnet; there is no second wire and no in-process engine in any client, the terminal UI included.

## Considered options

- Merge the two server clients onto the bridge routes unchanged: rejected because the bridge is a translation of the desktop's IPC and has no scopes, no push for session-list changes and no client identity.
- Spawn the server as a child of the desktop app (T3 Code): rejected because routines and unattended updates die with the window.
- Effect RPC (T3 Code) or tRPC for the wire: rejected for lock-in; a plain documented frame with schemas is what lets a client in another language exist.

## Consequences

- A remote server is an **environment**, not an account; accounts belong to environments and the picker is environment by account. The served profile's product shape survives, its object does not.
- Pairing is a one-time code exchanged for a per-client session that the environment lists and revokes; this supersedes an earlier decision to reject QR pairing. The server binds loopback and the tailnet interface only; a relay is a later milestone.
- Capabilities are negotiated by flags plus one integer protocol version; never by semver ranges.
- WSL, containers or a second data dir are separate environments added deliberately; auto-spawning them is a far-future nice-to-have.
- An environment belongs to one person: every paired client is the same human. A teammate runs their own environment; sharing goes through memory banks and the forge.
- The server is its own installable artefact per platform. The desktop app bundles a copy and installs or repairs the user service from it; headless machines install the same artefact by script. A desktop with no local environment is permitted by the design but not offered in milestone 1.
