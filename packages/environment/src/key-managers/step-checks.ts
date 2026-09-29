import type { KeyManagerConnectionRecord, StateCheckId } from "@agent-harness/contracts";
import type { StateCheckAnswer } from "../permissions/step-checks.js";
import type { StateChecker } from "../setup/check.js";

/**
 * The Key manager step's state checks (key-managers spec, "The Key manager
 * step"; setup spec, "Skipped"; ADR 0028, ADR 0031), answered from the
 * connections the environment holds. `key-manager.present` is the step's
 * skip check (#367): with no connection the step answers skipped and asks
 * nothing else, so it is never forced. The checks that read what a
 * verification finds are #383's.
 */

/** The Key manager step's state checks, by id. */
type KeyManagerStateCheckId = Extract<StateCheckId, `key-manager.${string}`>;

export interface KeyManagerStateChecksOptions {
  /** The connections the environment holds now (`KeyManagerConnections.list`). */
  readonly connections: () => readonly KeyManagerConnectionRecord[];
}

/** At least one connection is on the environment. */
const connectionPresent = (connections: readonly KeyManagerConnectionRecord[]): StateCheckAnswer =>
  connections.length > 0 || { reason: "No key-manager connection is on this environment." };

export const keyManagerStateChecks = ({ connections }: KeyManagerStateChecksOptions): { readonly [Id in KeyManagerStateCheckId]: StateChecker } => ({
  "key-manager.present": () => connectionPresent(connections()),
});
