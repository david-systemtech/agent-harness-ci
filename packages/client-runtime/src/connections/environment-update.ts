import { UPDATE_PATH, UpdateAnswer, UpdateError, commandResponse, registry, type ResponseFrame, type UpdateRequest } from "@agent-harness/contracts";
import { readJson } from "../discovery.js";
import type { HttpFetch } from "../platform.js";
import type { Shell } from "../shell.js";

/**
 * The `update-environment` action's asking (launcher-update spec, "Across a
 * protocol gap"): the environment is asked to update itself to this client's
 * version, `when: idle`. Blocked `protocol-mismatch`, the wire refuses this
 * client, so the ask goes over `POST /api/update` with the client session's
 * token (a local connection that holds none, blocked before any grant
 * exchange, exchanges the grant first, #826), and a desktop hands its local
 * environment the server it carries there when it is the version asked
 * (#918); otherwise it is `updates.apply` on the connection's socket. Either
 * way the environment answers the update it took, or refuses with a reason.
 */

/** What asking an environment to update came to: the update it took, or why not. */
export type UpdateEnvironmentOutcome =
  | { readonly ok: true; readonly updateId: string; readonly toVersion: string }
  | {
      readonly ok: false;
      /** The environment said no, which a notice names; else the ask failed on the way (`unreachable`, `no-token` (a local grant exchange that failed among them), `malformed`). */
      readonly refused: boolean;
      /** The environment's conflict reason, `local` for an artefact path, else its error's code; or how the ask failed. */
      readonly reason: string;
      readonly message: string;
    };

/** A refusal the environment made, as `refused` says it, for the notice naming why. */
export const refusedBy = (error: { readonly code: string; readonly message: string; readonly data: Readonly<Record<string, unknown>> }): UpdateEnvironmentOutcome => {
  const reason = typeof error.data["reason"] === "string" ? error.data["reason"] : error.code;
  return { ok: false, refused: true, reason, message: error.message };
};

/** The ask failed on the way: nothing was refused. */
export const failed = (reason: "unreachable" | "no-token" | "malformed", message: string): UpdateEnvironmentOutcome => ({ ok: false, refused: false, reason, message });

/**
 * Where the server artefact this desktop carries is, when it is `version`:
 * the path sent with the ask across the gap, so that the local environment
 * stages it rather than downloading the same release (launcher-update spec,
 * story 15; #918). Undefined for a shell that carries none (the terminal UI
 * has no shell, a desktop run from a checkout carries none), carries another
 * version, or cannot say what it carries: the ask then names the version
 * alone, as it did before. A known bundle refused for disk space is returned
 * as a refusal: downloading it instead would also spend its snapshot reserve.
 */
export const carriedArtefact = async (shell: Shell | undefined, version: string): Promise<string | undefined | Extract<UpdateEnvironmentOutcome, { readonly ok: false }>> => {
  try {
    const carried = await shell?.installer?.bundledServer();
    if (carried?.version !== version) return undefined;
    if (carried.refusal !== undefined) return { ok: false, refused: true, ...carried.refusal };
    return carried.path;
  } catch {
    return undefined;
  }
};

/** `POST /api/update` at `origin` with the token, asking for the update `request` names. */
export const askOverRoute = async (fetch: HttpFetch, origin: string, token: string, request: UpdateRequest): Promise<UpdateEnvironmentOutcome> => {
  let response;
  try {
    response = await fetch(`${origin}${UPDATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
    });
  } catch (error) {
    return failed("unreachable", `Nothing answered at ${origin}: ${error instanceof Error ? error.message : String(error)}.`);
  }
  const body = await readJson(response);
  if (response.status === 200) {
    const taken = UpdateAnswer.safeParse(body);
    if (taken.success) return { ok: true, ...taken.data };
  } else {
    const refused = UpdateError.safeParse(body);
    if (refused.success) return refusedBy(refused.data);
  }
  return failed("malformed", `The environment answered ${response.status} to the update, which is no answer the update route gives.`);
};

/** The answer to `updates.apply` as the update taken or the refusal: the response's error, or the receipt's rejection. */
export const answeredByMethod = (response: ResponseFrame): UpdateEnvironmentOutcome => {
  if (response.error) return refusedBy(response.error);
  const answer = commandResponse(registry["updates.apply"].result).safeParse(response.result);
  if (!answer.success) return failed("malformed", "The environment's answer to updates.apply is not an update.");
  const { receipt, result } = answer.data;
  if (receipt.status === "rejected") return refusedBy(receipt.error);
  if (result === undefined) return failed("malformed", "The environment accepted the update but named none.");
  return { ok: true, ...result };
};
