# Set up: switch-over contract check

Ticket [#1192](https://git.systemtech.dev:5526/david/agent-harness/issues/1192)
implements the automated gate in the [switch-over specification](../specs/switch-over.md)
and [Set up specification](../specs/setup.md). It consumes the feature registrations
and [#1165](https://git.systemtech.dev:5526/david/agent-harness/issues/1165)'s
Instructions import, without changing feature defaults or confirmations.

`packages/contracts/src/steps.test.ts` requires exactly `account`, `carry-over`,
`your-machines`, `forges`, `key-manager`, `memory-bank`, `skills`, `instructions`,
`browser`, `permissions`, `appearance`, in that order. The complete registry passes
the existing settings/writes/checks, home-row, budget, cadence/reason, trigger and
optional skip contracts. Removing any registration fails, including entries that
write no settings. The import methods each have one scope and no owed handler.

`packages/environment/src/setup/switch-over.test.ts` calls every Step and all Steps
over the typed wire on an in-process Environment. Empty optional features skip;
configured features run their owners' checks, including a fixture extension and
an invalid git Bank. Missing owner checks need attention even on optional Steps.
Forge, Key manager and Memory bank repairs remain visible after an Instructions
import is repaired. Environment snapshots/notices carry cadence and feature-triggered
findings; the manual clock expires a pending owner check at its budget and observes
its persisted last good result. Failed and unmatched import attempts survive restart
on the same Environment, stay failing after a preview, and clear after application.

The existing owning checks remain part of the contract: `setup/setup.test.ts`
covers all three budget classes and skip-check failures; `setup/scheduler.test.ts`
covers cadence and trigger coalescing; `setup/feature-triggers.test.ts` covers real
feature events; Contracts' `state-import.test.ts` and schema-export tests cover the
import event payloads. Undo and project-check schemas remain with their owning
switch-over tickets (#1182–#1188); they are not yet registered on this build's base.

The terminal summary/actions belong to [#261](https://git.systemtech.dev:5526/david/agent-harness/issues/261)
and [#572](https://git.systemtech.dev:5526/david/agent-harness/issues/572); the Memory
bank card belongs to [#587](https://git.systemtech.dev:5526/david/agent-harness/issues/587).
This contract check does not complete those surfaces or their human acceptance.
The [existing acceptance record](switch-over-acceptance.md#workstream-evidence-matrix)
distinguishes owner links from observed evidence and currently lists no supplied
live Set up evidence. Keep required unrun checks owed there, with the release head,
machine, operator and result; use the [desktop](desktop-checklist.md),
[browser](browser-checklist.md) and [service](service-install-checklist.md) checklists
for their owned platforms. Automated fixture results do not sign off switch-over.
