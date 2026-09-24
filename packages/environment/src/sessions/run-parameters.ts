import type { IssueInput, Mode } from "@agent-harness/contracts";
import type { VerifiedClientSession } from "../auth/client-sessions.js";

/**
 * The run parameters a session is created with: the account, model and mode
 * its runs use. `sessions.create` delegates their check to the adapter
 * host (`validateSessionInput`), which knows the accounts, their catalogues
 * and the modes each adapter maps; the permissions workstream (#129) adds the
 * clamp to the connection's ceiling when a run starts. This is the seam.
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

/** Accepts every account, model and mode: the preset for a `sessionMethods` built without the adapter host (lower-seam tests). */
export const acceptAnyRunParameters: RunParametersCheck = () => [];

/**
 * The mode `sessions.create` stores for a session given one (#129): clamped
 * to the caller's ceiling and the account's modes, so no client leaves a
 * mode above its ceiling for a later run to ask for; null when nothing at or
 * below the ceiling is available.
 */
export type SessionModeClamp = (mode: Mode, account: string | null, clientSession: VerifiedClientSession) => Mode | null;

/** Keeps the mode as given: the preset for a `sessionMethods` built without the permissions workstream (lower-seam tests). */
export const keepSessionMode: SessionModeClamp = (mode) => mode;
