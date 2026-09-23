---
status: accepted
---

# Permission ceilings per connection; mode and containment are separate switches; the denylist holds in every mode

Decided 2026-09-23 on the map ticket "Decision: permissions for unattended server runs" (david/agent-harness issue 20). In Artemis any connection token could request `bypassPermissions`, server routines defaulted to it, a parked prompt waited forever with nobody told, and the server ran as root behind an `IS_SANDBOX` flag to satisfy Claude's root check. The harness keeps Artemis's four permission modes (acceptEdits, plan, auto, bypassPermissions) as its own set, mapped by every adapter, and adds three rules. Every pairing carries a **ceiling**, the highest mode that connection and anything it creates (runs, routines, bots) may use; the environment clamps requests to it and records the clamp, and only admin scope raises it. **Mode** (what the agent may do without asking) and **containment** (where it may reach: off, workspace only, or workspace with no network, enforced by bubblewrap, Seatbelt or a container) are independent settings, so bypass is available to any connection within its ceiling, with a plain-language warning and no containment requirement, and containment is available to anyone who chooses it; the service never runs as root. An environment-owned, user-editable **denylist** (browser domains, filesystem paths, command patterns, network hosts) is never auto-approved in any mode, bypass included, and never blocks a user's own explicit choice. When no one is present to choose (an unattended run, or a parked prompt past its TTL), a denylisted action is denied, the denial is recorded as an event, and the run continues.

## Considered options

- Bypass refused unless containment is on: rejected because a machine without an enforceable sandbox could then never choose bypass, and the flag would be one more thing a non-technical user has to understand.
- A harness-run reviewer model to give local accounts an `auto` mode: rejected for now; `auto` is absent-with-reason on local accounts, and any provider that cannot express a mode comes back as a decision with that provider's own options.
- Runs interrupted when their client disconnects (Artemis's 60 s guard): rejected; a run belongs to the environment, not the connection.

## Consequences

- The unattended default is an environment setting with two values, acceptEdits (preset) or bypassPermissions, overridable per routine or bot within the creating connection's ceiling.
- A permission prompt is an event. Every connected client is notified; the prompt sits below the transcript and above the composer until answered, then appears in the transcript where it was asked. A parked prompt is denied after a configurable TTL (default 24 hours, may be never) and the run continues. Unattended runs and bypass mode never park.
- Asking the user a question without stopping the turn is supported wherever a provider offers it (Codex does); milestone 2 or 3.
- Every permission decision is an event with its outcome and who or what answered; the environment keeps an access log of pairings, connections, scope grants and ceiling changes; clients offer an "Unattended review" view of runs with denials or auto-approvals.
- Codex mapping: acceptEdits is on-request with a workspace-write sandbox, plan is a read-only sandbox, auto is the `auto_review` reviewer, bypassPermissions is approval `never` with full access; the retired `untrusted` value is never sent.
