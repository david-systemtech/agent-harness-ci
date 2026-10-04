---
status: accepted
---

# Milestone 1 is the switch-over, built in four phases; one spec per ADR area; later milestones stand as placed

Decided 2026-09-23 on the map ticket “Decision: milestones and the first
buildable milestone” (issue 34). Milestone 1 remains one milestone,
**Switch-over**, built in four phases with one meaning of done:

- Phase A, the spine: environment wire/event log/pairing, session state, client
  runtime, TUI, adapter contract/completions and permissions.
- Phase B, daily use: GUI/desktop shell, workspace/environment picker,
  launcher/update, forge links/status and initial Set up registry/cards.
- Phase C, the organs: skills/instructions, banks/migration, key managers,
  scrub registry/managed tools, routines, browser and remaining Set up steps.
- Phase D, switch-over: state import, program integration on completions,
  daily TUI use and retirement of replaced services.

Done retains daily sessions/routines/program integration across the owner's
inventory, TUI use, completed import, stopped source services, the ADR 0003/0004/
0016 contract tests and working milestone-1 health checks. There is one
implementation-ready specification per ADR area, originally sixteen plus the
switch-over, each a task ticket on the map. Phase A is unblocked; phases B and
C are behind the environment-service and client-runtime specifications; phase
D is behind every other area. Each specification is behind its feature's
wizard-step tickets, so it is written knowing its step. The web-client
specification joins that set under the dated amendment below.

Later placements remain: milestone 2, “Every provider, every client”, opens with
the OpenAI-compatible adapter and Codex rewrite (ADR 0015), then Bots/roster, Routine webhook/API triggers and
fallback environments (ADR 0008), Hand-off (ADR 0005), forge device flow/review
panes (ADR 0012) and async questions (ADR 0006); milestone 3, “Bots without
Hermes”, owns native inbound chat and integration retirement; milestone 4,
“Models on environments”, owns model download/device placement. A milestone is
named by its number and theme; work still in the fog is placed when it graduates.
The web client
is moved to milestone 1 by the dated amendment below.

## Considered options

- A spine-only milestone 1 with the organs as milestone 2 and every later milestone renumbered: rejected; the milestone lines in ADRs 0001 to 0016 would all need editing, and a spine alone replaces nothing David uses daily, so nothing could be switched to it.
- The spine as 1.0 and each organ as a 1.x point milestone with its own done: rejected; several dones for one switch-over blur what done means.
- The GUI as the client that proves the spine: rejected; the TUI ships inside the server artefact, needs no Electron and exercises the wire and the client runtime end to end, and Milo gets an early build.
- Coarser specifications, one per phase or about eight by theme: rejected; one ADR area fits one to-spec session in one context, and a phase does not.
- Specifications written only for phase A now, or all at once with no blocking: rejected; the organs' commands ride the wire, so their specifications wait for the two spine specifications, and the frontier stays visible in the tracker.
- Bots opening milestone 2: rejected; ADR 0015 opens it with the adapters, and the bot object needs the completions surface and the Hermes lean proven first. Browser/phone use is now milestone 1 under the amendment below.

## Consequences

- Build order is phase order; a build session takes the first specification whose phase predecessors are built. Building stays a separate effort per milestone.
- All of ADR 0007 belongs to milestone 1, phase B: the launcher, channels, pin, trial and rollback, the desktop updater, and the host-side updater for containerised environments, since the agent box on SAMPLE-SERVER is a container and switch-over covers every machine David uses.
- The harness's name (issue 33) gates nothing: specifications use `agent-harness` as a placeholder token wherever the service, data directory, binary or configuration paths are named, and the rename is one find-and-replace before the first build session.
- The "completions surface for programs" is no longer fog: ADR 0015 keeps it, with client-tool passthrough, in milestone 1 phase A.
- Unrelated later milestone placements stand. The 2026-10-04 phone amendment below reconciles the affected ADRs/specs only.

## Amendment: phone web client in milestone 1 (2026-10-04)

The owner's instruction of **2026-10-04** pulls the web client, including phone
use, into milestone 1. [web-client.md](../specs/web-client.md) records the decided
platform seam, HTTPS/Origin boundary, browser storage, Phone and unchanged My
own client grants, phone panes/layout/keyboard, attention/fallback and install.
Affected env/client-runtime/gui/look/permissions/setup/switch-over specifications
and ADRs 0001/0004/0006/0008/0025 follow that amendment; unrelated later work stays
where placed.

Repository completion uses hosted real-client browser CI, isolated environments
and scripted providers, gallery geometry and packaged-asset checks. The
coordinator owns deployment, managed HTTPS/tailnet and external receiver/live QA.
The single handset checklist (#1556) blocks no builder or release, references
the existing provider-sign-in ask (#1492), and alone establishes phone-proven
status. The original switch-over operational acceptance remains required.
