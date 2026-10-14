# Spec: Computer tools and the session's desktop

Written 2026-10-13 for #2160, part of #2123. Implements
[ADR 0038](../adr/0038-computer-tools-use-environment-owned-drivers-and-the-runs-mode.md),
building on ADR 0003 (session state), 0004 (client runtime), 0006 (mode,
ceiling, containment and denylist), 0007 (durable prompts), 0014 (client
relay), 0015 (environment-owned providers) and 0018 (accounts).
The source proposal is PR #2138's
`docs/research/computer-use-and-browser-toolset.md`, sections 3 and 4;
the decisions in #2123's comment override its session-grant proposal and
real-machine testing order. This ticket writes documents only. The plan
below specifies subsequent implementation and its proofs.

## Scope

A run can inspect and operate a chosen desktop through computer tools.
The environment owns resolution, the driver, policy and retained images.
The first target is a contained desktop over VNC, usable from an environment
with no display. The later target is the person's live desktop, through an
environment-owned helper. Webpage tasks continue to use the harness's MCP
browser, reshaped to the browser toolset in #2154–#2158; computer use does
not replace its page policy, reader, challenge hand-off or frame checks.

## Session field and run resolution

- Add `desktop` beside the session's `browser`, with kinds `none`,
  `contained` and `local`. `contained` selects an endpoint configured on the
  run's environment; `local` means this person's live desktop. Endpoint
  credentials are private environment configuration, never transcript data
  or tool input. Existing sessions and requests that omit the field choose
  none; there is no implicit live-desktop selection.
- `sessions.setDesktop` requires `runs:drive`, as `sessions.setBrowser` does
  because it chooses what the next run may drive. It changes the field through
  a command and appends `session.desktop.set`. Clients project that state;
  the composer chip is a presentation of it, not its owner. A field change
  during a run applies to the next run. `sessions.create` may supply the
  initial choice; forks carry it through the same event projection.
- Resolve once at run start, beside `run.policy.resolved`. Append
  `run.desktop.resolved` with the requested and resolved choices and a
  reason/message, including none, operator-disabled, unavailable,
  unattended, containment, or relay-unavailable. Fix the choice for the run;
  availability, display geometry and input safety still need checking at
  each call. Never fall back from contained to live or to another person's
  desktop.
- `desktop.contained.allowRuns` is the environment's operator switch for
  contained use, including explicit selections. Default off until configured;
  when on, a routine, bot or completions request may explicitly select a
  contained desktop. Completions omit desktop use unless requested. The
  run's resolved attendance, rather than client type, decides live access.
- A live choice resolves to none with a reason on unattended runs or when
  containment is not `off`. No prompt can override the containment refusal.
  Missing capture/input grants or an unsupported display report their reason.
- One session holds the selected desktop during its run. A second run that
  would drive it is refused with the holding session identified. Release
  ownership on run end, Stop, lock or driver loss; a disconnecting client
  alone does not end an environment-owned run.

As built (#2161): the summary's `desktop` is `{ kind }` or null for a
session that never set one, which resolves as none; `session.desktop.set`
carries `{ desktop }` and a choice the session already has appends nothing.
`desktop.contained.allowRuns` sits on the browser's settings row
(`access.browser`), preset off. `run.desktop.resolved` follows
`run.browser.resolved` in the run's first append, and a provider-opened turn
resolves it afresh as it does its browser. `serve/start.ts` resolves through
`resolveRunDesktop` with the switch as it is at the run's start and each
kind's availability (neither is available until #2162 configures a contained
desktop and #2164 a live helper), and offers the `computer` server only to
a run whose resolved desktop is not none. Calls go through the run's mode and
tool gate as any in-process tool's; #2163 adds the `desktopApps` gate checks,
ownership and the deferred decision at that point, where the browser's
`gate` and `allowance` hooks sit for its tools.

## Driver and tool surface

`packages/contracts/src/desktop-driver.ts` defines transport-neutral inputs,
results, refusals, display geometry and abilities without Node, DOM or
Electron types. `packages/environment/src/desktop/` resolves and drives it;
`tool-server.ts` exposes the in-process MCP server `computer` through
`serve/start.ts`. Tool names are `mcp__computer__<member>`; the Claude adapter
uses `toolAliases` only where the bare member cannot shadow a built-in or
another tool. Unsupported abilities are reported rather than silently faked.

Inputs follow the [computer toolset reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool),
read 2026-10-13:

| Members | Input |
| --- | --- |
| `screenshot`, `cursor_position`, `left_mouse_down`, `left_mouse_up` | `{}` |
| `zoom` | `region: [x0, y0, x1, y1]` |
| `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click` | optional `coordinate: [x, y]`, optional modifier `text` |
| `left_click_drag` | `start_coordinate`, `coordinate`, optional modifier `text` |
| `mouse_move` | `coordinate` |
| `scroll` | `scroll_direction`, `scroll_amount`, optional `coordinate` and modifier `text` |
| `type` | literal `text` |
| `key` | key/combination `text`, optional `repeat` (1–100, default 1) |
| `hold_key` | key/combination `text`, `duration` in seconds (at most 300) |
| `wait` | `duration` in seconds (at most 300) |

Coordinates use full-display screenshot pixels even after zoom. Modifier
text is a `+`-joined combination; scroll direction is up/down/left/right and
amount counts wheel steps. Screenshot and zoom return images; cursor returns
coordinates; input returns an acknowledgment or refusal. These are MCP
members, not a claim to expose a native Messages API toolset.

A driver also supplies the app under a point, the frontmost app, a stop
signal and desktop ownership. A failed or refused call returns an error
result with the reason; native exceptions become bounded error results.
Calls on one desktop execute serially. Where actions are batched, stop at
the first failure and mark later actions unexecuted. Do not apply an
API-batch assumption to independent MCP calls from the provider's loop.

### The contract and the server as built (#2161)

`desktop-driver.ts` holds the session's `SessionDesktop` (`none`, `contained`,
`local`), `RunDesktopResolution` with its reasons, each member's input
schema (`COMPUTER_MEMBER_INPUTS`, the table above) and the driver's
operations (`DESKTOP_OPERATION_SCHEMAS`), all exported under
`schema/desktop/`. A `DesktopDriver` has a kind (`contained`, `local`,
`scripted`), its abilities, and `perform(command)`, which never rejects:
it answers the operation's value or a `DesktopRefusal` with a code and the
sentence the model reads. Operations are in physical display pixels; only
`release` may arrive during another operation, ending a `hold_key` early.

| Member | Driver operations | Mode category |
| --- | --- | --- |
| `screenshot` | `capture { longEdge }` (keeps the frame) | observe |
| `zoom` | `geometry`, `zoom { physical region, longEdge }` | observe |
| `cursor_position` | `geometry`, `cursor` (answered in screenshot pixels) | observe |
| `wait` | the server's clock, then `capture` | observe |
| `left_click`, `right_click`, `middle_click`, `double_click`, `triple_click` | `geometry` when a coordinate is given, `click { button, count, at?, modifiers }` | pointer |
| `left_click_drag` | `geometry`, `drag { from, to, modifiers }` | pointer |
| `mouse_move` | `geometry`, `move { to }` | pointer |
| `scroll` | `geometry` when a coordinate is given, `scroll { direction, amount, at?, modifiers }` | pointer |
| `left_mouse_down`, `left_mouse_up` | `mouse_down` / `mouse_up { button: left }` | pointer |
| `type` | `type { text }` | keyboard |
| `key` | `key { chords, repeat }` (space-separated combinations in turn) | keyboard |
| `hold_key` | `hold_key { keys, durationMs }`; `release` when the call is cancelled | keyboard |

`createComputerToolServers` in `packages/environment/src/desktop/tool-server.ts`
builds the `computer` server for a run whose resolved desktop is not none.
Each call reads the session's live run, asks its kind's seam in
`DesktopDrivers` for the driver, and answers why when there is no run, no
desktop, no driver for the kind, or an ability the driver lacks. The last
full screenshot's display and scale are kept per session and run; a point
outside that frame is refused, a changed `geometry` refuses coordinate input
until a fresh screenshot, and calls on one session run one at a time. Driver
exceptions become bounded error results.

The Claude adapter's `computerToolAliases` maps each bare member to
`mcp__computer__<member>` unless the name is a built-in or another of the
run's in-process tools (the browser server's `screenshot`, `scroll`,
`type`, `key`), which keeps that name. Observe members declare `readOnly`,
which the adapter passes as `readOnlyHint` so the provider's mode treats them
as observation; pointer and keyboard members go through the run's mode and
the tool gate as any tool that changes things. `computerModeRuling` in the
contract is the mode table above, which #2163 enforces at the gate with the
`desktopApps` checks, including the decision deferred until the target is
rechecked after an allow.

`resolveRunDesktop` in `desktop/run-desktop.ts` is the resolution above as a
pure function. `unavailable.ts` holds `unavailableDesktop` and the
contained stub `containedDesktopDriver`, which answers that the contained
desktop is not available on this environment (none configured, or no driver
to connect with until #2162). The scripted desktop for tests,
`packages/environment/test/scripted-desktop.ts`, answers a scripted screen and
display, keeps a pointer, logs every operation, and can change the display,
refuse an operation once or hold a key until released.

### Capture and coordinates

Capture one display at physical resolution, preserving aspect ratio when
downsampling. `desktop.screenshot.longEdge` defaults to 1280. Keep the full
frame's dimensions, origin and scale (model pixels per physical pixel).
Refuse coordinates outside that frame; never clamp them. Map model pixels
back through the scale and virtual-desktop origin, then to platform input:
Windows normalised absolute virtual-desktop coordinates, macOS points using
the backing scale, or X11 pixels. `zoom` crops the physical frame and scales
the crop for reading without changing the input coordinate space.

Use the main display unless the person chooses another. A resolution,
backing-scale or display change invalidates the mapping: refuse coordinate
input until a fresh full screenshot establishes it. Validate both drag
ends and zoom bounds. Cancellation releases held mouse buttons and keys,
including during `hold_key` or `wait`; tests use a held clock or explicit
events rather than short wall-clock budgets.

## Modes, denylist and containment

The effective run mode has already been clamped to the connection/account
ceiling. Live tools use it without an additional per-session desktop grant.
The following table adopts the research's action categories as defaults,
with its proposed grant removed. Ordinary permission prompts use the
existing broker and decision events; there is no desktop authorization flag.

| Effective mode | Live desktop behavior, after hard refusals and denylist checks |
| --- | --- |
| `plan` | Observation only: screenshot, zoom, cursor position and wait; input is denied. |
| `acceptEdits` | Observation and pointer members may proceed; `type`, `key` and `hold_key` ask through the permission broker. |
| `auto` | The account's existing reviewer/rules decide consequential calls; unavailable where that account cannot express auto. |
| `bypassPermissions` | Ordinary actions proceed without a mode prompt; denylist matches still require an explicit answer. |

Contained members are ordinary tools under the effective mode too; the
contained target does not turn plan into input permission or bypass a
denylist. Anything that would ask during an unattended run is denied and
recorded immediately. Live use remains attended only in every mode.

### `desktopApps`

Extend the environment-owned denylist and its existing edit/restore methods
with `desktopApps`, using the same entry identity, note, preset and enabled
fields. Match platform app identities: macOS bundle ids, Windows executable
image names, X11 `WM_CLASS`. Presets cover password managers, terminals and
shells, system settings, credential managers and banking apps; the person can
edit, disable or extend them. Typing into a terminal is shell access outside
the agent's shell gate, so it must never be silently allowed by bypass.

Before pointer input, check the app under the action's point (the current
cursor if no point was supplied); before keyboard or typing, check the
frontmost app. Check a drag's target as well as its origin. Recheck the target
after a parked answer, before applying input, so a focus/window change does
not transfer approval to a different app. If target identity cannot be
established, do not silently skip policy: return a reason or ask when
attended. Observation cannot promise pixel redaction of a sensitive app.

A match opens the existing `denylist` prompt naming section, entry and call;
only the person's one-call allowance passes, even in bypass. Unattended or
TTL-expired matches are denied and recorded. No classifier, rule or mode
auto-approves them. When a recognised browser exposes a host through window
metadata, also match `browserDomains`. This is best effort; desktop pixels
cannot provide the browser driver's per-frame domain or text-redaction
guarantees.

### Enforced boundaries and stopping

Live input can operate applications outside a shell's bubblewrap or Seatbelt
boundary. Refuse live desktop use at both workspace containment levels with
that explanation, before capture or input. A contained desktop is a VM or
an isolated virtual desktop; merely running Xvfb as the same user does not
isolate files or network. Its configuration must enforce the requested reach,
including no network where requested, or refuse it with a reason.

At the first live action of each run, notify the person that the harness is
using their computer. The helper registers a stop chord and consumes it so
applications cannot use it; it interrupts the run like GUI Stop. A locked
session allows neither capture nor input. Driver disconnects, helper crashes and
Stop release held input and ownership. Every screenshot is framed as
untrusted screen content. Native toolset classifiers are not assumed for
MCP screenshots; instructions visible on screen are never user instructions.

## Contained and live drivers

The contained driver is a pure-TypeScript RFB 3.8 client supporting raw and
CopyRect framebuffer updates, VNC authentication, PNG encoding and scaling
without native dependencies. The opt-in `desktop` compose profile runs a
non-root virtual desktop, initially 1280 by 800, a light window manager and
VNC server, with a memory limit and digest-pinned image. VNC stays private
to the environment/profile network, without a public host port. A VM's
configured VNC endpoint uses the same driver. Authentication alone does not
make an exposed VNC connection a secure transport.

The live helper is a child of the local environment, speaking bounded
messages over stdio. Optional capture/input dependencies are candidates
`node-screenshots` and `robotjs`; native prebuilds and any install scripts
must be handled by each release artefact, as for `node-pty`. A missing module
or native crash reports unavailable and leaves other environment tools up.
The desktop shell does not own it or load its native modules.

| Platform | Helper requirements and limitations |
| --- | --- |
| Windows | Interactive user service; DPI awareness and 150% scaling proof; detect elevated windows/UIPI refusal and the locked or secure desktop rather than reporting successful input. Never elevate the helper. |
| macOS | Detect Screen Recording and Accessibility grants; explain how to grant them in System Settings and when to restart; map Retina pixels to points. Verify grants against the released bundled runtime's identity across updates; a stable signed helper remains a later option. |
| Linux X11 | Capture and XTest input with display/auth discovery for the user service; explain a missing display instead of failing silently. |
| Linux Wayland | Initially unavailable, with a reason directing the person to the contained desktop. Portal-based input is later work; no root or input-device privilege workaround. |

For a remote run, use `desktop.local` on the client-addressed call channel:
run environment → initiating client → local environment → helper, then back.
Preserve the browser relay's scoped authorization, deadlines, disconnect
refusals and 8 MiB answer cap. Enforce policy before local input as well as on
the run side; a remote choice cannot grant the client more reach. No direct
environment-to-environment trust is introduced.

## Transcript image store

Implement the shared store in #2159 before claiming screenshot watching works.
Persist tool images as content-addressed files outside the event log; record
hash, media type and byte size in `tool.ended`. Keep session ownership so an
authenticated `transcript.image` query under `read` can fetch only an image
referenced by that session. Clients fetch lazily rather than replaying bytes
through subscriptions; browser screenshots use the same path.

`transcript.images.maxMb` defaults to 200 per session. Evict the oldest images
first and show an explicit unavailable gap for evicted references. Purging a
session removes its retained images, with shared files kept only while another
session owns them. Keep live screenshots by default, mark them sensitive,
blur them on phones until tapped, and offer a per-session forget-screenshots
action. Pixels may contain secrets and cannot promise page-style redaction.

## Implementation plan and proof

Each row is one PR-sized ticket. The browser track remains independent;
#2159 is shared. Implementation dependencies do not change the accepted
real-machine proof order: contained desktop, Mac, then PC, with PC testing
only while its person is not gaming. Linux X11 proof follows.

| Ticket | Change and seam to prove |
| --- | --- |
| #2160 | This accepted ADR and spec; reconcile the proposal with #2123's decisions. |
| #2161, after #2160 | Contracts, session field/settings/events, `desktop/{tool-server,run-desktop}.ts`, startup wiring and schema export. Scripted-driver tool-server tests and run-resolution tests cover attended, unattended and completions choices. |
| #2162, after #2161 | `desktop/vnc/`, opt-in compose profile and container text tests. Scripted loopback RFB peer proves handshake, framebuffer updates, pointer/keys, scaling and bounds refusal. Service-install checklist proves the profile and a session on an isolated test machine. |
| #2163, after #2161 | `desktopApps` contracts/presets/matcher, gate/broker, containment refusal, ownership and mode table. Tests cover every mode, unattended denial and a target-app match parking a prompt before any input. |
| #2164, after #2163 | Windows helper, optional modules, stop/notification, prebuild packaging. Fake-native tests prove behavior; Windows checklist proves ordinary app input, elevated-window refusal, DPI 150% and Stop. Its real proof waits for contained and Mac proof. |
| #2165, after #2164 | macOS grants/Retina, then X11 discovery and Wayland refusal. Platform checklists prove the released helper's capture, input, grants and stop behavior; Mac is tested before PC. |
| #2166, after #2161 | `desktop.local` in contracts, environment and client-runtime. Two in-process environments prove the relay, authorization, refusal, deadlines and bounded image answers. |
| #2167, after #2162 | Composer chip for none/contained/this computer, with GUI harness tests and a gallery scene. Watching through noVNC remains ADR 0014's fog; deliver the chip alone until watching is decided. |
| #2159, shared | Store, adapter mapper, contracts query, GUI lazy image rendering and purge. An in-process fake-provider image is fetched through the real client and disappears after purge; GUI harness proves display/phone blur, with cap/eviction coverage. |

Startup and packaging work in these tickets must extend the release smoke
jobs wherever the packaged helper or dependency can be exercised. Smoke
checks prove packaged loading and a clear unsupported/unavailable answer
without driving a person's desktop; real input and OS grants belong to the
platform checklists. Run no desktop, browser, container or dev server on the
shared build machine. A documentation-only PR introduces no smoke change.
