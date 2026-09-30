import { z } from "zod";
import { AccountId } from "../accounts.js";
import {
  InstructionBody,
  InstructionId,
  InstructionManifest,
  InstructionPreviewPart,
  InstructionReach,
  InstructionTitle,
  OrientationRow,
  OwnedInstruction,
  OwnedInstructionRow,
} from "../instructions.js";
import { commandParams, defineMethod } from "../method.js";
import { OrderKey } from "../ordering.js";
import { SessionId, Workspace } from "../sessions.js";

/**
 * The standing-instruction methods (skills-instructions spec, "Standing
 * instructions and the composer" and "Owned instructions"):
 * `instructions.preview` and `instructions.list` at `read`, and the owned
 * instructions' commands at `admin`, one per field (ADR 0003), each
 * appending one event on the `instructions` stream and raising
 * `instructions.updated` once it commits. A session not on the environment,
 * or deleted, is `not_found` (kind `session`); an account it does not hold
 * is `not_found` (kind `account`); an owned instruction it does not hold, or
 * one removed, is `not_found` (kind `instruction`).
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

/**
 * `instructions.list`: the Orientation row, which opens the list, then the
 * owned instructions in their order (ascending position, then id), every
 * row carrying the environment's accounts.
 */
export const instructionsList = defineMethod({
  name: "instructions.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z
    .object({
      orientation: OrientationRow,
      instructions: z.array(OwnedInstructionRow).meta({ description: "Every owned instruction, after the Orientation row, in the order runs are handed them." }),
    })
    .meta({ description: "The user layer's rows: the read-only Orientation row first, then the owned instructions." }),
  errors: [],
});

const instructionResult = z.object({ instruction: OwnedInstruction.meta({ description: "The owned instruction as it is now." }) });
const instructionTarget = { instructionId: InstructionId.meta({ description: "The owned instruction." }) };

/**
 * Makes an owned instruction under the id the client minted, with no
 * origin (Custom): `instructions.created`. Its scope is preset `all`, it is
 * preset enabled, and with no position it goes after the last. An id
 * already used, even by an instruction since removed, is `conflict`
 * (reason `exists`); an account the scope names that the environment does
 * not hold is `not_found` (kind `account`).
 */
export const instructionsCreate = defineMethod({
  name: "instructions.create",
  scope: "admin",
  kind: "command",
  params: commandParams({
    id: InstructionId,
    title: InstructionTitle,
    body: InstructionBody,
    scope: InstructionReach.optional().meta({ description: "The accounts it reaches; preset all." }),
    enabled: z.boolean().optional().meta({ description: "Whether runs are handed it; preset true." }),
    position: OrderKey.optional().meta({ description: "Its place in the list; preset after the last." }),
  }),
  result: instructionResult,
  errors: [],
});

/** Sets an owned instruction's title and body: `instructions.edited`. The same title and body append nothing. */
export const instructionsEdit = defineMethod({
  name: "instructions.edit",
  scope: "admin",
  kind: "command",
  params: commandParams({ ...instructionTarget, title: InstructionTitle, body: InstructionBody }),
  result: instructionResult,
  errors: [],
});

/** Sets the accounts an owned instruction reaches: `instructions.scope-set`. An account the environment does not hold is `not_found` (kind `account`). */
export const instructionsSetScope = defineMethod({
  name: "instructions.setScope",
  scope: "admin",
  kind: "command",
  params: commandParams({ ...instructionTarget, scope: InstructionReach }),
  result: instructionResult,
  errors: [],
});

/** Switches an owned instruction on or off: `instructions.enabled-set`. Switched off it stays listed. */
export const instructionsSetEnabled = defineMethod({
  name: "instructions.setEnabled",
  scope: "admin",
  kind: "command",
  params: commandParams({ ...instructionTarget, enabled: z.boolean() }),
  result: instructionResult,
  errors: [],
});

/** Gives an owned instruction a new position, a key the client made between its neighbours' (`keyBetween`): `instructions.moved`. */
export const instructionsMove = defineMethod({
  name: "instructions.move",
  scope: "admin",
  kind: "command",
  params: commandParams({ ...instructionTarget, position: OrderKey }),
  result: instructionResult,
  errors: [],
});

/** Removes an owned instruction: `instructions.removed`. Its id is not used again. */
export const instructionsRemove = defineMethod({
  name: "instructions.remove",
  scope: "admin",
  kind: "command",
  params: commandParams(instructionTarget),
  result: z.object({ instructionId: InstructionId }),
  errors: [],
});
