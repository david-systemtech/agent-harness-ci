import type { CapabilityFlags, Ceiling, Scope } from "@agent-harness/contracts";
import { derived, type Observable } from "../observable.js";
import { LOCAL_PLACEHOLDER_ID, type BlockedReason, type ConnectionKind, type ConnectionPhase, type ConnectionRecord } from "../connections/records.js";
import type { ConnectionAction } from "../connections/state-machine.js";
import type { OutboxView } from "../outbox/overlay.js";

/**
 * `projections.environments` (docs/specs/client-runtime.md, "Projections"):
 * each known environment, in the saved sequence, with what a sidebar heading,
 * the mode picker and the Your machines step show. The first is the primary
 * environment.
 */
export interface EnvironmentView {
  readonly environmentId: string;
  readonly kind: ConnectionKind;
  /** The first environment in the sequence: the one whose group order merged groups follow. */
  readonly primary: boolean;
  /** Null for the local environment before it has ever answered (`LOCAL_PLACEHOLDER_ID`): a renderer calls it "this machine". */
  readonly name: string | null;
  readonly icon: string | null;
  readonly colour: string | null;
  /** The harness version the environment runs. */
  readonly version: string | null;
  readonly flags: CapabilityFlags;
  readonly scopes: readonly Scope[];
  /** The mode picker clamps to it (ADR 0006). */
  readonly ceiling: Ceiling | null;
  readonly enabled: boolean;
  readonly phase: ConnectionPhase;
  readonly blocked: BlockedReason | null;
  /** When the next attempt is due; null when none is scheduled. */
  readonly retryAt: string | null;
  /** What the sidebar heading shows: since when the environment has not been reached, null while it is. */
  readonly unreachableSince: string | null;
  /** Why the last token refresh failed; null when it has not. */
  readonly refreshFailed: string | null;
  /** What David can do about the phase: `service.start`, `re-pair`, `update-client`, `update-environment`. */
  readonly action: ConnectionAction | null;
  /** How many commands wait in the outbox for the environment's receipt: queued, or sent and not yet answered. */
  readonly pendingCommands: number;
}

export const environmentsProjection = (records: Observable<readonly ConnectionRecord[]>, outbox: Observable<OutboxView>): Observable<readonly EnvironmentView[]> =>
  derived([records, outbox] as const, (list, waiting) =>
    list.map(
      (record, index): EnvironmentView => ({
        environmentId: record.environmentId,
        kind: record.kind,
        primary: index === 0,
        name: record.environmentId === LOCAL_PLACEHOLDER_ID ? null : record.descriptor.name,
        icon: record.descriptor.icon,
        colour: record.descriptor.colour,
        version: record.descriptor.harnessVersion,
        flags: record.descriptor.capabilities,
        scopes: record.scopes,
        ceiling: record.ceiling,
        enabled: record.enabled,
        phase: record.phase,
        blocked: record.blocked,
        retryAt: record.retryAt,
        unreachableSince: record.unreachableSince,
        refreshFailed: record.refreshFailed,
        action: record.action,
        pendingCommands: waiting.get(record.environmentId)?.entries.length ?? 0,
      }),
    ),
  );
