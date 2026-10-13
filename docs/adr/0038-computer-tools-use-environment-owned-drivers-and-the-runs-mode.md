---
status: accepted
---

# Computer tools use environment-owned drivers and the run's mode; the contained desktop comes first

Decided 2026-10-13 on issue #2123, recorded by #2160. The harness has a
browser driver and an in-process MCP server, but no desktop driver. The
research on PR #2138 found no native toolset entry point in the pinned Agent
SDK. Computer use therefore follows the environment-owned browser route of
ADR 0014 and the adapter boundary of ADR 0015: a transport-neutral desktop
driver, an in-process `computer` server, and tools named
`mcp__computer__<member>` with the computer toolset's member names and inputs.
The browser keeps its MCP server and is reshaped to its toolset's members in
the separate browser track. A Messages API adapter remains a later option
alongside ADR 0015's local loop and ADR 0018's later API-key accounts.

The first working desktop is **contained**, driven over VNC by the
environment: a non-root virtual desktop in an opt-in compose profile or a
VM. Live desktop support follows through a helper process owned by the local
environment. Native capture and input code stays in that child so a failed
optional dependency or a native crash cannot take down the environment.
The desktop shell carries no session policy or native desktop driver.

## Decisions

- The desktop is a session field beside the browser: none, contained (an
  environment-configured endpoint), or local (the person's live desktop).
  A command changes it and records an event; each run resolves it once and
  records `run.desktop.resolved`, including a refusal reason. A local choice
  for a remote run uses the client relay, as the browser does.
- The live desktop follows the run's effective mode and ceiling like any
  tool (ADR 0006). **There is no separate per-session grant**, including in
  bypass. This replaces the research proposal's grant. Live desktop use is
  attended only; unattended runs may use a contained desktop when
  `desktop.contained.allowRuns` is on. An unattended action that would ask
  is denied and recorded through the existing broker.
- The denylist gains `desktopApps`: password managers, terminals and shells,
  system settings, credential managers, and banking apps. Input checks the
  app under the pointer or the frontmost app, according to the member. A
  match always needs the person's explicit one-call answer, bypass included;
  unattended matches are denied. This extends ADR 0006's denylist rule.
- A live desktop is refused whenever containment is not off: confining the
  agent's shell cannot confine the applications it operates. A contained
  desktop needs a real isolation boundary; a VNC connection alone is not
  containment. The driver's reason explains unavailable or unenforceable
  choices instead of silently using another desktop.
- One session drives a desktop at a time. Live input has a visible use
  notification and a stop chord; stopping, locking or losing the driver
  releases held input. Screens are untrusted content, and MCP results must
  not be assumed to receive the native toolset's screenshot classifiers.
- Browser and computer screenshots share an environment-owned transcript
  image store: lazy reads under `read`, a default 200 MB cap per session,
  oldest-first eviction with visible gaps, and removal on session purge.
  Live screenshots are sensitive and blurred on phones until revealed.
- Real-machine proof proceeds **contained desktop, then Mac, then PC**;
  the PC is never tested while its person is gaming. Implementation order
  can still build the Windows helper before macOS support. Linux X11 follows;
  Wayland initially returns an unavailable reason.

## Considered options

- A native Messages API toolset now: deferred; the pinned Agent SDK accepts
  custom MCP tools, and replacing its loop would add another adapter and
  credential route before the desktop is proved.
- Driving the live desktop first: rejected; the contained desktop works from
  a container and gives unattended work an isolated target before live input.
- Driving through Electron: rejected; the window can close while a run
  continues, and capture alone supplies no system-wide input driver.
- A separate live-desktop session grant, or bypass-only use: rejected by the
  decision on #2123; the existing modes, ceilings and denylist govern it.
- Allowing live desktop use under containment with a warning: rejected;
  input can reach applications outside the run's enforced boundary.
- Storing image bytes in log events, or retaining no screenshots: rejected;
  the former grows replay and feeds without bound, and the latter leaves
  clients unable to watch or review computer calls.

## Consequences

The implementation contract, settings, policy table, platform limitations,
image lifecycle and PR-sized plan are in [the computer specification](../specs/computer.md).
That spec governs the computer tickets where the research's proposed session
grant and Windows-first testing order differ from the accepted decisions.
The contained driver is pure TypeScript; live native dependencies remain
optional behind the helper. Real desktop and packaging proofs belong in the
platform checklists and release smoke jobs of the implementation tickets.
