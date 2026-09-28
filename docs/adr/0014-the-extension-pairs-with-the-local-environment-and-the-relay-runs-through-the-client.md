---
status: accepted
---

# The browser extension pairs with the local environment; a browser verb runs run-environment to client to local environment

Decided 2026-09-23 on the map ticket "Decision: browser extension carry-over and its server route" (david/agent-harness issue 27). The extension is the best-separated code audited: an MV3 extension that depends only on the protocol package, dials loopback, pairs by code with an HMAC proof, and drives pages through a `PageDriver` contract shared with a headless Chromium over CDP and the desktop's embedded dock. Its listener, pairing store and driver host, however, live in the Electron main process, so only the desktop window could answer a browser verb, the terminal UI had no browser at all, and pairing was per desktop install. The harness ports the extension, the contract, the tools and the CDP driver as they are and moves the **listener, pairing store and extension driver into the environment service on the user's machine**: a Chrome pairs once, by code, with its **local environment**, and paired Chromes are named environment state that every client on that machine sees. A browser verb from a run on any environment rides the client-addressed feed channel to the client that started the run; that client asks its own local environment to perform the verb on the chosen Chrome and answers back. No environment talks to another, the extension carries nothing tunnel-related, and the GUI, the terminal UI and the browser tab all have a Chrome.

## Considered options

- Keeping the listener in the desktop app behind the shell API: rejected; only the GUI could answer and pairing stayed per install.
- An environment-to-environment relay, the run's environment calling the user's local environment directly: rejected for now; it needs environments to know and trust each other, which is fog.
- Prompting on every browser action regardless of mode: rejected on 2026-09-21 and again here; the fewest approvals that still leave a layer.

## Consequences

- The browser is a **session field**, set by a command and recorded as an event like every session field (ADR 0003), with three kinds of value: a named Chrome paired to the client's local environment, the run environment's headless browser, or the embedded dock when the client is the GUI. The composer picker lists them; the default comes from the account's reach setting (per-conversation choice, the default, or a named Chrome always). Routines and bots use the headless browser on their environment.
- A browser verb is an ordinary tool call under the run's mode (ADR 0006). The denylist's browser section is enforced by the driver on the resolved address and on every frame, in every mode. One operator setting on a headless environment says whether runs may drive its browser at all.
- The environment's headless Chromium over CDP ships in milestone 1 with the tab rules (idle tabs close, the process exits when empty, a memory watchdog); the extension, its relay and the picker are milestone 1 too; the dock browser pane is GUI-only.
- The wizard's browser step downloads the extension, walks through `chrome://extensions`, pairs to the local environment with a code and countdown, collects the developer sites where cookies and storage are readable with values, sets My Chrome as the default and shows three health states; it can be skipped on first run and returned to later. Chrome-only copy until Edge and Brave are tested.
- A live view of the driven page and a server-side helper agent over the same tools stay in the fog.
