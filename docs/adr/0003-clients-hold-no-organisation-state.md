---
status: accepted
---

# Clients hold no organisation state; every user-set session field is a command, an event and a projection

Decided 2026-09-23 on the map ticket "Decision: session state on the server: archive, groups, tags, ordering, and how clients sync" (david/agent-harness issue 17). Archive rode a provider tag that one client mode stubbed out and one provider could not carry, and groups and pins lived in a per-machine preferences file keyed by a per-machine random id, so state set on one client never reached another. The harness instead treats every user-set field of a session (archive, pin and pin order, manual order, title, tags, group membership, settle, snooze) and every group (a first-class object the environment owns, a session in at most one) as a field of the contract with a command, an event on the environment's log and a projection, and the renderer's session list is a pure projection of the session-list subscription. A contract test fails when a session-summary field has no command, and a lint forbids any client store or preferences key named after session state. The provider's own tag field is never written.

## Considered options

- Derive groups from repository identity per client (T3 Code): rejected because it cannot express "these unrelated sessions belong together", which is what groups are used for.
- Groups that span environments as synchronised state: rejected; state with two owners is the bug's cousin. The client may merge same-named groups across environments as a view, with an environment badge on every session.
- A rule in the ADR without an enforcing test: rejected; exactly this regression was added after the rule was decided, with no test to catch it.

## Consequences

- Clients cache a snapshot and a cursor per session and for the session list, resubscribe with replay or snapshot then a synchronized marker, and keep an offline outbox of commands with command ids. Conflicts resolve as last writer wins per field by server sequence; a command aimed at a deleted session is rejected with a receipt. An unreachable environment shows its cached state with queued edits marked pending.
- Read models are SQLite tables written in the same transaction as the events, so startup never replays the log.
- Deleting a session is an event; its events and projections are purged after a grace period.
- Auto-settle on pull-request merge is a setting, off by default; auto-settle after idle is a setting, on by default at 14 days, any span in days, weeks or months, and never while a run, a question or an approval is pending.
