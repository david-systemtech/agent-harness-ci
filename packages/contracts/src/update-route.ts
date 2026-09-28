import { z } from "zod";
import { ForbiddenError, InternalError, InvalidParamsError, NotFoundError, UnauthorizedError, UnavailableError, errorSchema } from "./errors.js";
import { ReleaseVersion } from "./release.js";
import { UpdateConflictReason, UpdateId, UpdateInstallRefusal } from "./updates.js";

/**
 * `POST /api/update` (launcher-update spec, "Across a protocol gap"): a
 * stable HTTP route outside the wire, like the pairing exchange, by which a
 * newer client updates an environment it no longer shares a wire protocol
 * with (the runtime's `update-environment` action when blocked
 * `protocol-mismatch`). It does what `updates.apply` does with `when: idle`.
 *
 * Its path, request, answer and refusals are fixed here apart from the
 * wire's protocol version, which none of them carries, so that they never
 * change shape: a client of any version can ask an environment of any
 * other. The answer is defined here rather than shared with
 * `updates.apply`'s for that reason.
 *
 * The client session's token goes in the `Authorization` header as
 * `Bearer <token>`, and the session needs the `admin` scope.
 */

/** Where a client asks an environment to update itself: `POST`, from any bound address. */
export const UPDATE_PATH = "/api/update";

/** The body of `POST /api/update`. */
export const UpdateRequest = z
  .object({
    version: ReleaseVersion.meta({ description: "The version to update to: the asking client's own, for a newer client's offer." }),
    artefactPath: z.string().min(1).optional().meta({
      description: "The path of an artefact of that version on the environment's machine; from a local client session only.",
    }),
  })
  .meta({ description: "A client's request that the environment update itself to a version, when idle." });
export type UpdateRequest = z.infer<typeof UpdateRequest>;

/** What `POST /api/update` answers when it takes the update. */
export const UpdateAnswer = z
  .object({
    updateId: UpdateId,
    toVersion: z.string().min(1).meta({ description: "The target: the version the update goes to." }),
  })
  .meta({ description: "The update the environment took: its id, and the version it goes to." });
export type UpdateAnswer = z.infer<typeof UpdateAnswer>;

/** The update was refused for the state it would change: `data.reason` says why, and `data.launcherReason` why the launcher refused its install. */
const UpdateConflictError = errorSchema(
  "conflict",
  z.object({
    reason: UpdateConflictReason,
    launcherReason: UpdateInstallRefusal.optional().meta({ description: "With reason install: why the launcher refused to install the version." }),
  }),
).meta({
  description: "The update was refused for the environment's state; data.reason says why, and with reason install data.launcherReason says why the launcher refused.",
});

/**
 * What a refused update answers: `unauthorized` for a missing, invalid,
 * revoked or expired token (401); `forbidden` without the `admin` scope, or
 * with reason `local` for an artefact path from a paired session (403);
 * `invalid_params` for a body that is not an `UpdateRequest` (400) or too
 * large to be one (413); `not_found` when there is no such release or no
 * artefact for this platform (404); `conflict` with its reason (409);
 * `unavailable` before the startup gate or while draining (503); `internal`
 * when the environment failed (500).
 */
export const UpdateError = z
  .discriminatedUnion("code", [UnauthorizedError, ForbiddenError, InvalidParamsError, NotFoundError, UpdateConflictError, UnavailableError, InternalError])
  .meta({ description: "Why an update asked for over HTTP was refused." });
export type UpdateError = z.infer<typeof UpdateError>;
