import type { Ceiling, Scope } from "@agent-harness/contracts";
import { derived, type Observable } from "../observable.js";
import type { BlockedReason, ConnectionKind, ConnectionPhase, ConnectionRecord } from "../connections/records.js";

/**
 * `projections.environments` (docs/specs/client-runtime.md, "Projections"):
 * each known environment, in the saved sequence, with what a sidebar heading,
 * the mode picker and the Your machines step show. The first is the primary
 * environment. `unreachableSince` and the pending-command count join it with
 * the reconnect machine (#126) and the outbox (#128).
 */
export interface EnvironmentView {
  readonly environmentId: string;
  readonly kind: ConnectionKind;
  /** The first environment in the sequence: the one whose group order merged groups follow. */
  readonly primary: boolean;
  readonly name: string;
  readonly icon: string | null;
  readonly colour: string | null;
  /** The harness version the environment runs. */
  readonly version: string | null;
  readonly flags: readonly string[];
  readonly scopes: readonly Scope[];
  /** The mode picker clamps to it (ADR 0006). */
  readonly ceiling: Ceiling | null;
  readonly enabled: boolean;
  readonly phase: ConnectionPhase;
  readonly blocked: BlockedReason | null;
}

export const environmentsProjection = (records: Observable<readonly ConnectionRecord[]>): Observable<readonly EnvironmentView[]> =>
  derived([records], (list) =>
    list.map(
      (record, index): EnvironmentView => ({
        environmentId: record.environmentId,
        kind: record.kind,
        primary: index === 0,
        name: record.descriptor.name,
        icon: record.descriptor.icon,
        colour: record.descriptor.colour,
        version: record.descriptor.harnessVersion,
        flags: record.descriptor.capabilities,
        scopes: record.scopes,
        ceiling: record.ceiling,
        enabled: record.enabled,
        phase: record.phase,
        blocked: record.blocked,
      }),
    ),
  );
