import { z } from "zod";
import { AccountId } from "../accounts.js";
import { CatalogueInstructionEntryId } from "../catalogue.js";
import {
  InstructionBody,
  InstructionDiff,
  InstructionId,
  InstructionManifest,
  InstructionPreviewPart,
  InstructionReach,
  InstructionTitle,
  InstructionVersionChoice,
  OrientationRow,
  OwnedInstruction,
  OwnedInstructionRow,
  SessionInstructions,
  SessionInstructionsSetPayload,
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
 * one removed, is `not_found` (kind `instruction`, with `instructionId`), and
 * so is a catalogue entry this build's catalogue does not hold (with
 * `catalogueId`). Suggested instructions (#509; ADR 0030): ticking,
 * newer versions with their diff, Replace or Keep mine, dismissal
 * remembered, and the import of a minted session's file (ADR 0019).
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
      dismissed: z.array(CatalogueInstructionEntryId).meta({
        description: "The catalogue entries dismissed on this environment, for the Dismissed fold, in the order of their ids: none of them is held as a copy.",
      }),
    })
    .meta({ description: "The user layer's rows: the read-only Orientation row first, then the owned instructions; and the dismissed catalogue entries." }),
  errors: [],
});

const instructionResult = z.object({ instruction: OwnedInstruction.meta({ description: "The owned instruction as it is now." }) });
const instructionTarget = { instructionId: InstructionId.meta({ description: "The owned instruction." }) };

const placement = {
  scope: InstructionReach.optional().meta({ description: "The accounts it reaches; preset all." }),
  enabled: z.boolean().optional().meta({ description: "Whether runs are handed it; preset true." }),
  position: OrderKey.optional().meta({ description: "Its place in the list; preset after the last." }),
};

/**
 * Makes an owned instruction under the id the client minted:
 * `instructions.created`. With a title and a body it has no origin
 * (Custom); with a catalogue id instead (a tick) it copies the entry's
 * current title, text and version, and remembers them as its origin, and an
 * entry that was dismissed is restored with it
 * (`instructions.suggestion-restored`). Its scope is preset `all`, it is
 * preset enabled, and with no position it goes after the last. An id
 * already used, even by an instruction since removed, is `conflict`
 * (reason `exists`); an account the scope names that the environment does
 * not hold is `not_found` (kind `account`); a catalogue id this build does
 * not hold is `not_found` (kind `instruction`). The refinement is zod's
 * half; the `oneOf` the export's.
 */
export const instructionsCreate = defineMethod({
  name: "instructions.create",
  scope: "admin",
  kind: "command",
  params: commandParams({
    id: InstructionId,
    catalogueId: CatalogueInstructionEntryId.optional().meta({ description: "The catalogue entry to copy, with no title and no body: a tick." }),
    title: InstructionTitle.optional().meta({ description: "With body and no catalogueId: the title of one written here (Custom)." }),
    body: InstructionBody.optional().meta({ description: "With title and no catalogueId: the body of one written here (Custom)." }),
    ...placement,
  })
    .refine((params) => (params.catalogueId === undefined ? params.title !== undefined && params.body !== undefined : params.title === undefined && params.body === undefined), {
      message: "Give a title and a body, or a catalogue id, not both.",
    })
    .meta({
      description: "A Custom instruction's title and body, or the catalogue entry a tick copies; then its scope, whether it is enabled and its position.",
      oneOf: [
        { required: ["title", "body"], properties: { title: true, body: true, catalogueId: false } },
        { required: ["catalogueId"], properties: { catalogueId: true, title: false, body: false } },
      ],
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

/**
 * `instructions.diff`: what a copy's catalogue entry changed since the
 * version the copy holds, and what Replace would change in the copy (ADR
 * 0030's See what changed). Custom, with no origin, is `conflict` (reason
 * `no_origin`); a copy whose entry this build's catalogue does not hold is
 * `not_found` (kind `instruction`, with `catalogueId`).
 */
export const instructionsDiff = defineMethod({
  name: "instructions.diff",
  scope: "read",
  kind: "query",
  params: z.object(instructionTarget),
  result: InstructionDiff,
  errors: [],
});

/**
 * Resolves a copy whose catalogue entry has a newer version:
 * `instructions.version-resolved`. Replace sets the body to the entry's
 * current text and the version to its current one, the copy's edits lost
 * (a client says so before it asks); keep raises the version and keeps the
 * body. Either way `newerVersion` clears until the entry's next version. A
 * copy already at the current version appends nothing; Custom is
 * `conflict` (reason `no_origin`). Nothing else ever updates a copy.
 */
export const instructionsResolveVersion = defineMethod({
  name: "instructions.resolveVersion",
  scope: "admin",
  kind: "command",
  params: commandParams({ ...instructionTarget, choice: InstructionVersionChoice }),
  result: instructionResult,
  errors: [],
});

const catalogueTarget = { catalogueId: CatalogueInstructionEntryId.meta({ description: "The catalogue entry." }) };
const suggestionResult = z.object({ catalogueId: CatalogueInstructionEntryId, dismissed: z.boolean().meta({ description: "Whether the entry is dismissed now." }) });

/**
 * Dismisses a catalogue entry never ticked, so the catalogue shows it under
 * the Dismissed fold: `instructions.suggestion-dismissed`. One dismissed
 * already appends nothing; one held as a copy is `conflict` (reason
 * `ticked`: removing the copy dismisses it); one this build does not hold
 * is `not_found` (kind `instruction`).
 */
export const instructionsDismissSuggestion = defineMethod({
  name: "instructions.dismissSuggestion",
  scope: "admin",
  kind: "command",
  params: commandParams(catalogueTarget),
  result: suggestionResult,
  errors: [],
});

/** Offers a dismissed catalogue entry again: `instructions.suggestion-restored`. One not dismissed appends nothing. A dismissed entry never returns by itself. */
export const instructionsRestoreSuggestion = defineMethod({
  name: "instructions.restoreSuggestion",
  scope: "admin",
  kind: "command",
  params: commandParams(catalogueTarget),
  result: suggestionResult,
  errors: [],
});

/**
 * Imports an instruction an LLM step wrote (ADR 0019): the Markdown file at
 * `path` in the scratch workspace of a minted session (one tagged `setup`
 * and `instructions`, as the Instructions step mints it) becomes a new
 * owned instruction under the id the client minted, its first heading
 * outside a code fence the title and the text before and after that heading,
 * a blank line apart, the body, with the catalogue entry's
 * id and current version as its origin when `catalogueId` is given
 * (restoring the entry if it was dismissed); preset for every account,
 * enabled and after the last. A session that was not minted, a path outside
 * its workspace or not a `.md` file there, or a file with no heading or
 * over the bounds, is `invalid_params`; the rest as `instructions.create`.
 */
export const instructionsImport = defineMethod({
  name: "instructions.import",
  scope: "admin",
  kind: "command",
  params: commandParams({
    id: InstructionId,
    sessionId: SessionId.meta({ description: "The minted session whose scratch workspace holds the file." }),
    path: z
      .string()
      .min(1)
      .meta({ description: "The Markdown file: relative to the session's scratch workspace, or an absolute path inside it; a .md file." }),
    catalogueId: CatalogueInstructionEntryId.optional().meta({ description: "The catalogue entry the instruction was tailored from, its origin." }),
  }),
  result: instructionResult,
  errors: [],
});

/**
 * `sessions.setInstructions` (skills spec, "Session instructions"; ADR
 * 0009; #506): the session's own instructions, so a one-off constraint does
 * not become a habit. At `runs:drive`, as `sessions.rewind` is, since it
 * changes what the session's next run does. Recorded as
 * `session.instructions-set`, which changes nothing listed; empty text
 * clears them, and text over 20,000 characters is `invalid_params`. The
 * session's next runs are handed them in the session layer, under
 * `# Instructions for this session`; a live run keeps what it began with.
 * The per-session snapshot carries them, and `sessions.fork` copies them.
 * The text the session has already appends nothing (the receipt says
 * `changed: false`). A session not on the environment, or deleted, is
 * `not_found` (kind `session`). The result is the event's payload with the
 * session.
 */
export const sessionsSetInstructions = defineMethod({
  name: "sessions.setInstructions",
  scope: "runs:drive",
  kind: "command",
  params: commandParams({
    sessionId: SessionId,
    text: SessionInstructions.meta({ description: "The session's instructions from its next run on, at most 20,000 characters; empty text clears them." }),
  }),
  result: z.object({ sessionId: SessionId, ...SessionInstructionsSetPayload.shape }),
  errors: [],
});
