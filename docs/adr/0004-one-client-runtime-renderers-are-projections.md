---
status: accepted
---

# One headless client runtime; every renderer is a projection of it; the desktop shell sits behind capability flags

Decided 2026-09-23 on the map ticket "Decision: the renderer: GUI refactor scope and the TUI parity contract" (david/agent-harness issue 18). The renderer is a 13,900-line store whose shape is the desktop's IPC vocabulary; its served path re-implements that vocabulary over HTTP and stubs what does not map, and its terminal UI is a third in-process assembly of the engine with its own pin store. The harness instead has one UI-free client-runtime package (connection registry across environments, pairing and sessions, the session-list and per-session subscriptions with cursor cache and offline outbox, projections of sessions, groups and runs, command dispatch with receipts, capability flags) and every renderer, the desktop window, the terminal UI and the milestone-1 browser tab, renders from it and nothing else. The desktop window loads the renderer bundle from the app's own scheme, and every environment serves the identical bundle for browser tabs. What only a desktop can do (native dialogs, file pickers, the embedded web view, window chrome, tray, OS notifications, deep links, installer launches) is a deliberately small shell interface reached through the same capability-flag discipline; absent flags degrade absent-with-reason, and nothing about sessions, runs or organisation ever passes through it.

## Considered options

- Refactor the current renderer in place, swapping the bridge under the store: rejected because the store's shape is the IPC vocabulary and every served bug lived there. Leaf components (transcript, composer, permission cards, diff, markdown, panes) are carried once they take props instead of store reads; the store is not.
- Shared contract types only, each renderer with its own sync and cache: rejected as two implementations of the hardest part.
- Replacing Ink in the terminal UI with pi-tui: deferred; Ink 7 already emits synchronized output and its `incrementalRendering` option supplies the line diff, and the existing tests and keymap carry over.

## Consequences

- The parity contract is the wire: whatever the contract expresses, both renderers support with the same semantics. The terminal UI may lack pixel surfaces (browser dock, preview, drag reordering, images beyond terminal protocols). A gap is a tracker issue labelled `parity`; David decides; a GUI-only contract feature ships with its issue open, never silently.
- Keyboard shortcuts are named actions from one shared list; defaults reproduce today's GUI and terminal keymaps exactly and are remappable; a test asserts every one of today's defaults is present.
- The environment owns pseudo-terminals with capped scrollback, streamed to any client; files and diffs are read through the environment too.
- The terminal UI ships inside the server artefact as a second entry point, so its version always matches its local environment.
- Milestone 1 shows the full baseline (sidebar with environments, merged groups and badges, pins, archive, settled shelf, snooze, tags, search; transcript; composer; permission and question cards; parked asks; run status and usage; account and model picker; settings; the setup wizard), all seven panes and the pane grid. The browser dock's server route is decided separately (issue 27).

## Amendment: phone web client in milestone 1 (2026-10-04)

The browser tab is a milestone-1 projection of the same runtime/bundle, with
origin-scoped IndexedDB documents and a separate JavaScript-readable token
SecretStore; storage denial means pairing for this visit. Its desktop shell is
absent. Browser leaf adapters offer supported inputs, downloads, clipboard,
camera and external links without session state. HTML/SVG preview is a static
sandboxed snapshot without scripts/forms/network, not the desktop preview
protocol. The browser surface offers Open page and environment driver status
instead of a native webView; it never frames arbitrary sites. At phone width
one conversation, drawers/sheets and keyboard/safe-area geometry replace the
grid while retaining the desktop arrangement and environment PTYs/runs.
The wire's grant and capability semantics remain unchanged. See
[web-client.md](../specs/web-client.md).
