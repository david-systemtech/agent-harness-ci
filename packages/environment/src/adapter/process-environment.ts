import type { RunActorKind } from "@agent-harness/contracts";
import type { ProcessEnvironment, SuppliedVariables } from "./contract.js";

/**
 * The process environment's registry (forge spec, "Runs: the injection";
 * key-managers spec, "The key" and "Injection"; ADR 0011, ADR 0020, ADR
 * 0028; #307): the suppliers harness services register (the forge's
 * variables and credential helper, #315; the key managers' block and run
 * tokens, #91), none by default, from which each holder's process
 * environment is built the same way, whatever started it. A holder is a
 * run's provider process or a session's terminal.
 */

/** Who a holder serves: its session, the account its runs go through (null when neither the session nor the environment names one), and who started it (a client, for a terminal). */
export interface ProcessEnvironmentScope {
  readonly sessionId: string;
  readonly accountId: string | null;
  readonly origin: RunActorKind;
}

export interface ProcessEnvironments {
  /** The process environment of one holder, built now. */
  of(scope: ProcessEnvironmentScope): ProcessEnvironment;
}

/** Nothing to supply, and nothing to release. */
const NOTHING: SuppliedVariables = { variables: {}, release: () => undefined };

/** A holder's process environment while no supplier is registered: an empty key, and nothing supplied. */
export const EMPTY_PROCESS_ENVIRONMENT: ProcessEnvironment = { key: "", supply: async () => NOTHING };

export const createProcessEnvironments = (): ProcessEnvironments => ({
  of: () => EMPTY_PROCESS_ENVIRONMENT,
});
