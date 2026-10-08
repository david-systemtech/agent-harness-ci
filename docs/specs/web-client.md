# Spec: Web client and phone use

Milestone 1 (Switch-over). The owner's instruction of 2026-10-04 moves the
web client into this milestone (ADR 0017). Implements ADRs 0001, 0004, 0006,
0008 and 0025 with the amendments recorded there. Part of #3; specification
#1540. This is the current phone design for the shared GUI and client runtime.

## Problem and boundary

A phone must reach environment-owned sessions without a desktop shell or a
second engine. A background browser can lose its socket; a tailnet's encrypted
transport alone does not give a browser a secure origin. Rendering in a gallery
also does not prove pairing against a packaged environment.

The first conversation slice (#1539) is implemented: packaged shared bundle,
configured external HTTPS origin, both pairing presets, separate durable browser
stores, fragment cleanup and a real hosted browser smoke. The remaining work
below is the milestone-1 requirement, assigned to the phone tickets; this
specification does not claim those surfaces or transports are already built.

Deployment, tailnet configuration, external receiver configuration and live QA
belong to the coordinator. Builders change repository files and prove them in
tests and hosted CI. The single human checklist (#1556) blocks no builder or
release. Only dated handset evidence may establish “phone proven”.

## Serving, HTTPS and origin boundaries

Every server artefact and container contains the version-matched GUI bundle,
the same renderer carried by the desktop (ADR 0004). The environment serves
`/` and `/pair`, declared public root files and assets; undeclared routes and
API misses remain 404. Reject raw/encoded traversal and symlink escape, validate
Host, and send a restrictive CSP, no-referrer and nosniff headers. Scripts and
fonts are bundled; no third-party scripts or fonts. Static serving is not a
catch-all for authenticated API requests.

Configure the canonical external HTTPS origin with `serve --web-origin` (the
start option is `webOrigin`). It has no path, query, credentials or fragment,
a lowercase host and no explicit default port. Preserve a non-default port in
links and QR codes. Never infer trust or advertised links from forwarded headers.
The coordinator supplies a managed tailnet certificate through Tailscale Serve,
forwarding a dedicated HTTPS port (8443 unless occupied) to loopback port 7433;
read existing Serve configuration, preserve other services and never enable
Funnel. This is deployment configuration, not a builder's task or a requirement
for native TLS in the environment. Existing desktop/TUI HTTP connections remain.

The client opens `/` on that origin and uses `wss://<same-host:port>/ws` with the
existing typed wire. Session links are
`/#/session/<environment-id>/<session-id>`; the manifest and static files keep a
root scope. Accept the configured web Origin, `agent-harness://app` and
origin-less CLI/TUI clients on pairing and WebSocket upgrades; reject arbitrary
browser Origins. The implemented server also permits canonical same-host HTTP
Origin on its actual listener port for existing local use; it is not the phone
secure-origin path. Host validation remains independent of Origin validation.

Start with same-origin pairing. Direct connections to another environment must
use HTTPS and require its trusted admin to explicitly allowlist this client's
exact origin. #1549 owns exact-origin discovery/pairing CORS and preflight,
WebSocket checks and the corresponding client connection permission in CSP.
There are no wildcard origins, credential cookies or new proxy; the wire keeps
its token-in-auth-frame path. Reject mixed HTTP targets with actionable HTTPS
guidance. The current extra-origin hook denies all until that ticket implements
its leaf policy; the existence of a registry hook is not an available feature.

Plain tailnet HTTP is not localhost. It cannot provide service-worker
registration, Web Push, Async Clipboard, getUserMedia camera or secure-origin
PWA install eligibility. A browser may still offer a bookmark/manual Home Screen
shortcut; that does not enable these APIs. Ordinary user copy/paste remains.

## Platform, storage and startup

Use the UI-free runtime's existing `Platform`: documents, `SecretStore`, fetch,
WebSocket factory, clock, visibility/network and web identity. The optional
shell remains absent; browser adapters register through the web leaf slots,
never a fake desktop shell. No session or organisation state crosses a shell
or adapter seam; the environment remains the authority.

Documents, cursors, cached projections and outbox use `indexedDocuments`.
Client-session tokens use a separate origin-scoped IndexedDB SecretStore
(`indexedSecrets`), never localStorage, URLs, logs or service-worker caches.
This storage is JavaScript-readable, without OS secret protection or pretend
encryption. Reload remembers pairing; concurrent tabs and refresh must preserve
usable credentials. Storage denial switches to memory and visibly says “pair
for this visit”. Eviction or a missing/revoked credential requires deliberate
re-pairing. Forget erases the local credential and revokes it when reachable;
when unreachable, explain that remote revocation is still needed. Erasure is
attempted even after a transient storage failure.

Browser startup goes to pairing, with no local bootstrap grant, service install
or service start attempt. A shared link or the phone's OS QR camera opens
`/pair#<code>`. Scrub the fragment synchronously with `replaceState` before
rendering or network/external navigation, consume the code, and return to `/`.
Never treat a session route as a credential. Offer address+code and link entry,
plus HTTPS in-page camera scanning with portable jsQR; permission denial and
Cancel retain the manual fallback, and every exit stops camera tracks. Codes
are single use for ten minutes. An existing connection requires confirmation
to replace it; re-pairing is not an automatic grant change.

## Pairing grants and permission answers

| Preset | Scopes | Ceiling | Choice |
| --- | --- | --- | --- |
| Phone | `read`, `sessions:write`, `runs:drive` | `acceptEdits` | Restricted browser preset, fixed grant |
| My own client | Every scope | `bypassPermissions` | Existing full grant, also valid for the owner's phone |
| A program | `read`, `sessions:write`, `runs:drive` | Preset `acceptEdits` | Ceiling picker |
| Custom | Preset `read` | Preset `plan` | Explicit scope ticks and ceiling picker |

Phone is additive to ADR 0025; My own client is unchanged. Client kind never
downgrades an existing link or changes its minted grant. Display the actual
scopes and ceiling. A trusted desktop/CLI may mint an expanded Custom code at
`acceptEdits`; the phone deliberately re-pairs. The minter cannot exceed its own
scopes or ceiling and a client cannot raise its own ceiling.

Files, Diff and terminals retain their explicit `terminal` scope requirement,
since terminals permit commands outside a run-mode ceiling. Settings writes
and provider sign-in require explicit `admin`. Explain missing authority and
how to obtain a new code; never weaken method scopes to make a surface work.
A prompt answer still requires only `runs:drive`; the answering client's ceiling
does not constrain that answer, including an ask from another client's run
(permissions spec). Reconnect/replay must submit one answer once. Runs and PTYs
continue when the client disconnects, hides a pane or switches sessions.

## Phone layout and input

Use one layout predicate for the frame, viewport fitting and phone/overlay
styles: width below 640px, or a short touch layout with a coarse primary pointer,
no hover, width 640–960px inclusive and layout height at most 500px. Thus rotation
from 390×844 to 844×390 (and 360×740 to 740×360) keeps one visible conversation,
the session drawer, active session, draft and live run. The bound keeps larger
touch screens in the wide projection. Classify layout media, never the keyboard's
reduced VisualViewport height or pinch-zoom dimensions. A non-touch desktop
keeps its existing projection when its visual viewport shrinks.

In the phone projection show a session drawer with shelves,
search and actions, and a phone header with More, Settings and attention.
Retain the desktop pane arrangement without overwriting it; restore it when
returning to a genuinely wide non-phone viewport. Split
is unavailable with a width reason. Below the existing 900px pane-width
breakpoint, the side column is a sheet sized `min(480px, 85%)`; closing/hiding
it retains terminal and delegated work. A session opened in the phone layout (a
reload, a push or session link, the drawer, or a tapped notification for the
session the window already shows) shows itself, with a sheet left open hidden
and its edge handle bringing back the pane it showed, so a waiting card is not
covered (#1903); a pane a gesture asks for as it opens the session, as Set up's
"Write it myself" Files, stays shown. Outside the phone layout a column is
restored as it was left.
Drawers/sheets trap and restore focus
and close predictably. Long titles and labels wrap without page overflow.

The session drawer uses the same web-frame visible bounds, including keyboard
height and visual offset, without another viewport observer. Opening Sessions
focuses the non-input drawer; tapping Filter opens search. Results alone scroll
in a bounded inner scroller with contained overscroll; Close, New session and
footer actions stay reachable above the keyboard. At 390×480 visual bounds with
offsetTop 120 in a tall layout, search/results and dismissal never scroll the
document. Dismissal restores focus without a page jump. Selecting a result
closes the drawer and preserves each session's draft and running work. New
session, the drawer's or an environment heading's, closes the drawer and leaves
the focus in the new session's message box, not on the drawer's trigger. Selected,
running and waiting rows and explicit touch actions remain readable at text 20.

Use look.md's abyss ground, panel cards, float overlays, hairline edges,
rounded human controls and square machine output wells, existing icon names,
focus and contrast. Phone preset text size is 16 using the existing 11–20
preference; text inputs are at least 16 CSS px. Hit areas are at least 44px,
including icon buttons; tap actions replace hover-only controls without
squeezing labels. Support enlarged text at 20 and ordinary pinch zoom.

In the phone projection, the Mode chip opens a mode-only bottom sheet bounded by the
visual viewport, including keyboard height. Each 44px-or-larger row wraps its
label and description, marks the current selection, and disables modes above
the connection ceiling with its existing reason. Close stays visible while
only the choices scroll; focus is trapped and restored. An allowed selection
sends the existing mode command once and closes only on success. A failure
stays visible with retry guidance and retains the current value. Dismissal
keeps the draft, session and conversation scroll; the desktop menu remains.

Composer and status stay in the bottom flex region above the visible keyboard;
the transcript owns conversation scrolling. One web-frame owner locks the phone
web document/root and bounds the shell to VisualViewport height and offsetTop
at scale 1, with `100dvh`/window-height fallback, `viewport-fit=cover` and
`env(safe-area-inset-*)`. Keep unzoomed bounds during pinch zoom; remove locks,
styles and listeners on wide mode or unmount. Focus scrolls only the owning
scroller, never ancestors. A browser revealing focused Message can still scroll
clipped boxes around the dock against pre-resize bounds when a keyboard resizes
the layout viewport; the owner returns the shell and every clipped axis
enclosing a dock to its origin on each refit and scroll (#1737). Composer focus/keyboard opening explicitly repins
the latest transcript line after resizing; follow scrollport/content resizing
and streaming until deliberate scroll up. Jump to latest resumes following.
A visual/layout height gap identifies keyboard occlusion. When both heights
change together, a reduction of at least a quarter from the composer-focus
height identifies opening; retain that reference through gradual resize events.
Smaller bar resizes refresh unoccluded bounds without repinning, including
after a keyboard close that retains Message focus.
Reserve at least three normal text lines above the bottom dock while composing;
retain that reservation through button taps to avoid moving a target on blur. Non-conversation
controls stay above the conversation, and keyboard close retains draft/focus. Preserve the activity/asks/composer order; notices never cover a
waiting card or composer. Send/Stop, Allow/Deny and Continue/Finish remain
reachable at keyboard height. IME composition never sends early. Attachments,
queue/status, plan/question/permission cards and tool/fork/rewind actions fit
one column and are usable by touch.

A pending request in the conversation dock is a compact summary with Details.
Details opens the full command, reason, plan or questions in a bounded sheet
inside the same web-frame viewport owner. Keep Close in its header and the
existing answer verbs in a separate, non-scrolling bottom strip above the
keyboard and safe inset; only request details, choices and notes scroll.
At visual 390×480 and text 20, retain three readable transcript lines and
reachable 44px Details, Close and answer controls. Closing/Escape preserves
notes and question picks; answering removes the summary and restores composer
focus with preventScroll. IME commit never answers early, in-flight answers
cannot be submitted again, and reconnect reuses the existing answer identity.
Denial/ceiling/delivery reasons remain available. The existing authoring
conversation dialog retains its own bounded request and anchored decisions.

Native reply/code selection and the OS copy menu remain available while reading
history and receiving later stream output. Selecting transcript text pauses
following, as scrolling up does; Jump to latest explicitly repins. Tool disclosure
retains its per-call fold choices and changes only the transcript scroller, never
the outer page or dock. Keep normal links, long press, pinch zoom and horizontal
code-well scrolling; no custom swipe navigation, simulated haptics or global touch
blocker. The locked phone root and transcript use `overscroll-behavior: none`
to suppress scroll chaining and browser pull-to-refresh where supported. Capped
input/detail wells remain independently scrollable with contained overscroll.
Uncapped Markdown code contains horizontal overscroll only; vertical gestures
continue to the transcript.
CSS cannot promise suppression of every OS/browser refresh or rubberband gesture:
record engines that still refresh with dated handset evidence under #1556.

## Browser replacements and Settings

Browser adapters supply file-content pickers/download, clipboard with a
selectable-text fallback on denial, and explicit external links. Uploads use
input[type=file] or paste. Workspace directories are selected on the environment,
never represented as phone filesystem paths. Native window controls, local
service/bootstrap, this computer's gh and desktop installer/updater stay absent
with reasons. Browser bundle updates offer Reload, separately from environment
Update now. Use the browser’s explicit reload action or the existing Reload client
update offer instead of a synthetic refresh gesture. Keep explicit Copy controls
and the selectable-text clipboard-denial fallback.

Files/Diff/Documents/Tasks use existing methods and projections in the sheet.
Markdown renders normally. HTML/SVG is a static sandboxed srcdoc snapshot with
no scripts, forms, same-origin privilege or network; offer source/download and
explain that active preview scripts require desktop. Reopening rereads the
snapshot. Hosted isolation tests prove an untrusted preview cannot script,
read the parent or contact the network.

Terminals use existing xterm.js and environment-owned PTYs, scrollback,
subscribe/write/resize methods, touch selection, keyboard and Ctrl/Esc/Tab
controls. Fit on keyboard/sheet resize and keep explicit Close. Browser replaces
native webView with Open page plus the existing environment browser selector
and status, never an iframe around an arbitrary site. Headless/paired Chrome
availability belongs to the environment (ADR 0014); explain unavailable drivers.
A phone is not a paired desktop Chrome or a local relay environment.

Settings is full-height; registered-row navigation is a drawer (ADR 0027),
with no duplicate mobile registry. Set up keeps all eleven steps and a sticky
Back/Continue footer. Pairing goes straight to sessions; Set up remains available.
Without admin show re-pair guidance. With admin, provider sign-in opens the real
verification page from a tap, returns to paste its code and streams status,
resuming status after returning. Provider credentials stay in the environment,
never browser storage. Grant-aware controls remain read-only where appropriate.

## Durable attention and closed-phone delivery

Connected clients keep in-app Parked asks. Environment-owned attention dispatch
adds durable work from parked prompt events after six seconds, cancelled on
answer or TTL. Deduplicate by event/target; reuse pending IDs after restart,
expire stale work, remove revoked/expired-client targets and audit failures.
One delivery failure never stops a run. The default payload is only
“A session needs you” and the canonical HTTPS session link, without transcript,
prompt text, secrets or session title. Completion delivery remains opt-in and
quiet (ADR 0008). Clients with `read` manage only their own targets; global
routes require `admin`. Settings shows transport status and failures. An
admin client adds a signed-webhook route there: the named endpoint (URL and
pasted secret, through `routines.endpoints.set`) and the global route naming
it, then tests it (`routines.endpoints.test`); status names a webhook route's
endpoint, never its URL or secret.

Opt-in Web Push uses HTTPS, a service worker and VAPID. Enable/Test/Disable are
explicit; feature-detect support and denial. On supported iOS/iPadOS 16.4+,
permission requires an installed Home Screen web app and a user gesture.
Validate supported HTTPS vendor endpoints; reject arbitrary/private fetch
targets. Retire 404/410 endpoints and revoked/expired-client subscriptions.
The browser vendor gateway can reach a suspended/closed client; tailnet access
is required when the user opens the private session. Notification clicks open
the same-origin session route. The worker never owns a session socket or run.

When push is unavailable/denied, offer the configured signed-webhook fallback
and in-app attention with honest status; in-app alone cannot alert a closed
browser. The repository sender uses existing endpoint/secret infrastructure,
Standard Webhooks signatures, a ten-second timeout, no redirects and bounded
1/5/30-minute retries with stable event IDs across retry/cancellation/restart.
Apply existing outbound endpoint policy and surface failures. A separately
configured delivery-only receiver routes to Matrix/Element X through the existing
webhook integration; there is no new native chat adapter. Receiver secrets,
route/destination configuration and live proof belong to the coordinator.
Repository receiver doubles prove signature, timestamp, schema, retry and
idempotency; routine webhook support alone does not prove live attention delivery.

## Installation and updates

The manifest has stable id/start_url/scope, standalone display, bundled icons
and theme/background. Give iOS/Android supported/unsupported installation
guidance; Home Screen storage may be separate from a browser tab and require
its own pairing. A versioned service worker caches public assets/offline shell
only, never authenticated API traffic, transcripts, tokens or pairing URLs.
Offline content visibly says cached/stale and cannot start a run. Offer Reload
after a new bundle, retain drafts and never force reload while composing.
The worker core exports a separate push hook; push does not edit worker core.

## Verification and ticket ownership

Local behaviour tests use jsdom/runtime harnesses, scripted providers,
held clocks and fake transports at public seams. No local browser, Electron,
dev server, image or owner-machine deployment is a builder test.

Hosted CI uses the real built client against an isolated real environment,
event log and WebSocket with a scripted provider under an ordinary uid in
Chromium and WebKit phone viewports, without gallery/fake shell. Cover
pair/reload/refresh/revoke, both presets, stream and Allow/Deny, reconnect/replay,
scope rejection, storage denial/eviction, two-environment exact Origin rules,
malicious Origin/Host/assets, preview isolation, worker upgrade/draft retention,
encrypted push gateway with a closed page and signed receiver doubles. Check
packed/unpacked artefacts and container build output for version-matched assets;
keep desktop/TUI pairing compatibility tested independently.

Gallery phone subsets cover 390×844 and 360×740, dark/light, text at 20,
keyboard-height viewport, safe areas and long content. Assert no horizontal
page overflow, 44px hit areas, visible Send/Allow/Continue, drawer/sheet focus
and no notice over composer. Phone mode exposes browser capabilities rather
than a fake desktop shell. Preserve desktop captures and the same publisher/
acceptance validation. Starting allocation is 342 captures against the 400 cap;
#1541 budgets the bounded subset or shards publication and acceptance together.
#1636 additionally keeps the layout viewport at 390×844 while scripting a
390×480 visual viewport with offsets 0 and 120, composer focus, streaming,
reading/Jump to latest, browser-bar resizing, notices/cards and keyboard close.
Focused tests also cover bar resizing after a focus-preserving close followed
by gradual keyboard close/reopen, with visual-only and simultaneous height changes.
#1737 resizes the whole page instead (a hosted harness hook): Message focused
then layout and visual 844→480, back to 844 with focus kept, and the reverse
order, each proving the dock bounds without a later resize event.
Hosted geometry proves shell/dock/latest-line bounds, readable transcript and
stable document/window scroll. Animated keyboards, browser-bar settings,
rotation/insets, focus zoom, selection and Home Screen behavior require dated
handset evidence in #1556 and never block builders.
#1641 adds 32 bounded landscape captures: 844×390 and 740×360, text 16/20,
dark/light, a conversation, long-card keyboard dock, Sessions drawer and composer
details sheet. Keep layout bounds unchanged while the filled-keyboard visual
height shrinks to the supported 330px rectangle (including the waiting notice,
three normal reply lines, message/actions and safe reserve); overlay proofs use
300px. The drawer result well grows with text size (at least 54px); compact
vertical chrome leaves room while its footer scrolls independently down to a
48px floor. Scheduled routines share the result scrollport so their four
touch actions cannot consume fixed drawer height. Check a result hit area and
both footer actions as well as
Close. Both use offsetTop 8 and zero insets or 44px side/21px bottom insets. Check one
projection, no page/horizontal overflow, three readable transcript lines,
reachable Send/Stop and long-card decisions, bounded sheet/Close and trapped
focus, and exactly one safe-area reserve at the dock edge. Focused transition
tests prove portrait/landscape/portrait retains state, returning wide restores
saved panes, and non-touch/zoom/keyboard-only changes never select phone layout.
An open layout-resizing keyboard keeps the transcript reserve across rotation;
the previous orientation supplies the closing-height reference until the new
unoccluded bounds return.

Surface owners supply separate scene/baseline modules and inspect hosted PR
captures before landing; gallery evidence does not replace the real-client CI.

| Ticket | Owned work |
| --- | --- |
| #1539 | Shared startup/export/build/global-style hooks, serving, first conversation slice and hosted smoke runner/workflow |
| #1540 | This specification, affected specs and ADR amendments |
| #1541 | Gallery registry/capture/report integration and capacity |
| #1542–#1548 | Frame, conversation, overlays, panes, terminal, browser and Settings leaf surfaces respectively |
| #1549 | Camera, Machines/Access and exact-origin multi-environment policy |
| #1550 | Manifest, worker core, install and upgrade; separate push hook |
| #1551 | Shared attention contracts/store/dispatcher and attention Settings |
| #1552 / #1553 | Attention webhook / push transports; consume shared hooks |
| #1554 | README and phone/service runbooks, both presets side by side |
| #1555 | Completed hosted browser regressions and release asset checks |
| #1636 | Phone viewport/dock ownership, keyboard repin, focused following tests and bounded hosted keyboard scene; these Phone layout and Verification updates |
| #1641 | Shared bounded landscape layout predicate, frame/viewport transitions, phone/overlay rules, landscape profiles/scenes/geometry and these layout/verification sections |
| #1556 | One human phone checklist; no source edits, no builder/release dependency |

Shared startup hooks stay with their owner; surface tickets own leaf modules
and uniquely named scenes/tests. #1545 owns `session/pane-documents.ts`, excluded
from #1543. #1550 owns worker core; #1553 owns its push leaf. #1551 owns shared
attention wiring; #1552/#1553 own transports. README/runbooks belong to #1554.
New shared edits return to their named owner; minimally editing a file whose
owning ticket has merged is recorded under Decisions made in the PR.

Only #1556 proves actual OS camera permission, keyboard/safe-area/selection,
Home Screen storage isolation, background/locked push and notification-tap
return over mobile data with tailnet access, and real provider authentication.
Reference the existing provider-sign-in ask (#1492). It records the owner's
confirmation of address/port, optional expanded grants, lock-screen title policy,
fallback destination and phone layout/text defaults. Until that evidence exists,
report hosted-tested capabilities without claiming handset proof. Deployment
and the human evidence do not gate repository builds or release publication.
