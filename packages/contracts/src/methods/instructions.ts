import { z } from "zod";
import { AccountId } from "../accounts.js";
import { InstructionManifest, InstructionPreviewPart } from "../instructions.js";
import { defineMethod } from "../method.js";
import { SessionId, Workspace } from "../sessions.js";

/**
 * The standing-instruction reads (skills-instructions spec, "Standing
 * instructions and the composer"): `instructions.preview` at `read`. A
 * session not on the environment, or deleted, is `not_found` (kind
 * `session`); an account it does not hold is `not_found` (kind `account`).
 */

/**
 * `instructions.preview`: a session, or an account and a workspace, never
 * both. The refinement is zod's half; the `oneOf` the export's.
 */
const PreviewTarget = z
  .object({
    sessionId: SessionId.optional().meta({ description: "The session whose next run to preview; leave out accountId and workspace." }),
    accountId: AccountId.optional().meta({ description: "With workspace and no sessionId: the account of a new session to preview." }),
    workspace: Workspace.optional().meta({ description: "With accountId and no sessionId: the workspace of a new session to preview." }),
  })
  .refine((target) => (target.sessionId === undefined ? target.accountId !== undefined && target.workspace !== undefined : target.accountId === undefined && target.workspace === undefined), {
    message: "Name a session, or an account and a workspace, not both.",
  })
  .meta({
    description: "A session, whose next run is previewed; or an account and a workspace, where a new session's first run is previewed.",
    oneOf: [
      { required: ["sessionId"], properties: { sessionId: true, accountId: false, workspace: false } },
      { required: ["accountId", "workspace"], properties: { sessionId: false, accountId: true, workspace: true } },
    ],
  });

/**
 * What a run would be handed now, composed as a run's start composes it:
 * with a session, what its next run started from a client would get; with
 * an account and a workspace, what the first run of a new session there
 * would. Each part with its layer and title, the text (equal to the text an
 * adapter is then handed; empty for an account whose adapter has no
 * instruction channel), and the manifest.
 */
export const instructionsPreview = defineMethod({
  name: "instructions.preview",
  scope: "read",
  kind: "query",
  params: PreviewTarget,
  result: z.object({
    parts: z.array(InstructionPreviewPart).meta({ description: "The parts of the text, in the order it holds them." }),
    text: z.string().meta({ description: "The composed text a run would be handed now: its parts, each two line breaks apart." }),
    manifest: InstructionManifest,
  }),
  errors: [],
});
