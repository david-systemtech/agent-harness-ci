---
status: accepted
---

# The environment owns an event log, and the log holds transcripts

Decided 2026-09-23 on the map ticket "Decision: server-per-machine topology, one renderer, and the wire" (david/agent-harness issue 16). Artemis kept no state the provider's own store did not hold: archive rode a provider tag, groups and pins were desktop preferences keyed by a per-machine random id, and a second client rebuilt transcripts by kind from a lossy stream. The harness instead keeps a SQLite event log per environment with a global sequence, command receipts for idempotent retry, per-session bounded replay then snapshot then a synchronized marker; every piece of session organisation (archive, pin, order, group, tag, title) is an event, and so is every transcript event as it crosses from a provider. Provider stores remain only the thing a resume id is handed to.

## Considered options

- Harness state in the log, transcripts fetched from the provider store on demand: rejected because it keeps two sources of truth and the rebuild-by-kind loss.
- Provider stores plus a ledger index (Artemis): rejected; it is the cause of the state that never reached a second client.

## Consequences

- Organisation events live until their session is deleted. Transcript events of a session untouched for a long time are compacted into a snapshot that replaces them, so replay stays bounded; the snapshot lives until the session is deleted. Ages and sizes are specification detail.
- Disk holds a copy of what the provider also stores; a pruning policy is owed, not optional.
