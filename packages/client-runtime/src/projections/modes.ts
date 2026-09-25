import { MODES, compareModes, type Ceiling, type Mode } from "@agent-harness/contracts";
import { derived, type Observable } from "../observable.js";
import type { ConnectionRecord } from "../connections/records.js";

/**
 * `projections.modes(environmentId)` (docs/specs/client-runtime.md,
 * "Capability flags, ceiling and absent-with-reason"; ADR 0006): what the
 * mode picker offers on one environment. The modes are the contracts' in
 * their order (`MODES`: plan, acceptEdits, auto, bypassPermissions), each
 * allowed up to the connection's ceiling from `hello`, so the picker clamps
 * to it and shows the clamp. The mode and ceiling values are the permissions
 * workstream's; a mode the session's account cannot use is that account's
 * to say (`permissions.mode.set` answers the effective mode).
 */

export interface ModeChoice {
  readonly mode: Mode;
  /** At or below the connection's ceiling; false for every mode while the ceiling is not known. */
  readonly allowed: boolean;
}

export interface ModePicker {
  readonly environmentId: string;
  /** The connection's ceiling from `hello`; null until the environment has said. */
  readonly ceiling: Ceiling | null;
  /** Every mode, in the contracts' order. */
  readonly modes: readonly ModeChoice[];
}

/** The picker for a connection whose ceiling is `ceiling`. */
export const modePicker = (environmentId: string, ceiling: Ceiling | null): ModePicker => ({
  environmentId,
  ceiling,
  modes: MODES.map((mode) => ({ mode, allowed: ceiling !== null && compareModes(mode, ceiling) <= 0 })),
});

export const modesProjection = (records: Observable<readonly ConnectionRecord[]>, environmentId: string): Observable<ModePicker> => {
  const ceiling = derived([records] as const, (list) => list.find((record) => record.environmentId === environmentId)?.ceiling ?? null);
  return derived([ceiling] as const, (value) => modePicker(environmentId, value));
};
