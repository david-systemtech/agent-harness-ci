import type { IssueInput } from "@agent-harness/contracts";

/**
 * The run parameters a session is created with: the account, model and mode
 * its runs use. Each is defined and validated by its own workstream: the
 * account and model by the adapter workstream (#119), the mode by the
 * permissions workstream (against the connection's ceiling). This is the
 * seam they fill.
 */
export interface RunParameters {
  readonly account: string | null;
  readonly model: string | null;
  readonly mode: string | null;
}

/**
 * Checks the run parameters `sessions.create` was given: the schema issues
 * that make it `invalid_params`, with paths naming the param (`["account"]`),
 * or none.
 */
export type RunParametersCheck = (parameters: RunParameters) => readonly IssueInput[];

/** Accepts every account, model and mode: the check until #119 and the permissions workstream replace it. */
export const acceptAnyRunParameters: RunParametersCheck = () => [];
