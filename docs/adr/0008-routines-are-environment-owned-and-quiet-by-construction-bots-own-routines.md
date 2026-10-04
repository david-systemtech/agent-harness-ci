---
status: accepted
---

# Routines are environment-owned and quiet by construction; a bot is an identity that owns routines

Decided 2026-09-23 on the map ticket "Decision: routines as first-class and the bot roster: create, see, configure" (david/agent-harness issue 22). Two schedulers exist today, one in the desktop that fires only while the window is open and one on the server that delivers nothing, records no firing as a session, and defaults to bypass; Hermes cron has what those lack (a pre-check that skips the model, silent-run suppression, delivery targets, per-routine skills, kept output) and already presents bots as profiles with a roster. The harness has one **routine** object per environment, with commands and events like a group: name, schedule, instructions, environment, workspace, account and model, mode within the creating connection's ceiling, skills, a pre-check, silent suppression, delivery targets, kept output and a firing history in which every firing is a session. One scheduler per environment fires it with no client connected. A **bot** is an environment-owned identity (name, avatar, persona as standing instructions, default account and model, default mode, skills) that owns routines; every bot firing is a session tagged with the bot. Chat adapters are not the harness's: a Hermes profile pairs to a bot through a connection carrying the bot's ceiling.

## Considered options

- Routines stored in the client and fired by whichever environment is connected (today's desktop scheduler): rejected; a routine must fire with no client present.
- No bot object, bots as Hermes profiles read by the harness: rejected; David wants one roster with state and configuration, and a routine needs an owner identity. A full Hermes-style profile inside the harness (own memory, tools, adapters) was set aside as a possible later step, not ruled out.
- Native chat delivery (Matrix, Telegram) in the harness: not chosen for milestone 1; delivery is a pluggable kind, so any sender can be added later as a plugin without a redesign, and no surface is locked in.

## Consequences

- Quiet by construction: a pre-check (a script in the environment's scripts directory, or a URL) is hashed before each firing and an unchanged result skips the model run, recorded as no change; a run whose final text is the silence marker on its first or last line, or as a prefix, delivers nothing and is recorded as silent.
- Delivery targets have a kind (client notice and signed webhook POST in milestone 1), a target, and a success/failure split; every firing is also a session in the list, so nothing is lost.
- Clients list every connected environment's routines in one view with the environment badge and edit them through commands, with the offline outbox. Moving a routine is a two-tap copy of its portable definition to another environment that disables the original; the workspace re-resolves by repository identity, else scratch; history stays and the copies link. A fallback environment per routine, with a global default, is milestone 2.
- Triggers: schedule and run-now in milestone 1; signed inbound webhook and per-routine API token in milestone 2, both wrapping the payload as untrusted.
- Every routine and bot exports to a YAML file without secrets (accounts by identity, key-manager paths by name) and imports on any environment; a git-backed bot bundle an environment tracks is a later milestone.
- Milestone 1 shows a routines list grouped by environment; the bots roster (state from the environments' logs, never read from Hermes; configure inline; open the latest session) arrives with the bot object in milestone 2. Hermes keeps running the fleet on the completions surface under a ceiling until then.

## Amendment: phone web client in milestone 1 (2026-10-04)

Milestone 1 adds durable parked-ask attention independently of Routine firing,
with opt-in Web Push and the existing signed-webhook infrastructure as fallback.
Default payloads are generic session-needs-you text and HTTPS links, with no
prompt/transcript/secrets; routine completion delivery stays opt-in and quiet.
The environment owns dispatch/retry/cancellation, not a client socket or worker.
A separately configured delivery-only receiver routes the signed fallback to
Matrix/Element X; repository receiver doubles prove the sender boundary, and
the coordinator alone configures/proves live routing. This is not a native chat
adapter and does not move Bots/roster, new Routine triggers, fallback environments
or Hermes retirement into milestone 1. See
[web-client.md](../specs/web-client.md).
