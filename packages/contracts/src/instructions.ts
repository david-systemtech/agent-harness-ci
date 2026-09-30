import { z } from "zod";
import { AccountId, AccountLabel } from "./accounts.js";
import { InstructionChannel, InstructionChannelKind, RunId } from "./adapter.js";
import type { EventTypeEntry } from "./event-types.js";
import { OrderKey } from "./ordering.js";
import { normaliseTrimmedName, trimmedNamePattern } from "./primitives.js";
import { Sha256 } from "./release.js";
import { SkillName } from "./skill-rules.js";
import { GitCommit, SkillOrigin, SkillSetFingerprint } from "./skills.js";

/**
 * The composition of a run's standing instructions (skills-instructions
 * spec, "Standing instructions and the composer"; ADR 0009, ADR 0011, ADR
 * 0030): the layers in their fixed order, the manifest that says what a
 * composition holds and what it left out, `run.instructions.composed` on the
 * session's stream, and the parts `instructions.preview` answers
 * (`methods/instructions.ts`). The text itself is never logged: the event
 * carries its digest.
 */

/**
 * The layers, from general to specific, in the order the text holds them:
 * the user layer (the orientation block, then owned instructions), the team
 * bank's, the project's (which Claude loads natively, so nothing is added
 * there for it), the session's, a bot's persona, then always-on skills. The
 * run's own text (a completions request's) follows the composed text.
 */
export const INSTRUCTION_LAYERS = ["user", "team-bank", "project", "session", "persona", "always-on"] as const;
export const InstructionLayer = z.enum(INSTRUCTION_LAYERS).meta({
  description:
    "A layer of a run's standing instructions, in the order the text holds them: user (the orientation block, then owned instructions), team-bank, project, session, persona (a bot's), always-on (always-on skills).",
});
export type InstructionLayer = z.infer<typeof InstructionLayer>;

const PartId = z.string().min(1).meta({ description: "What the part is, within its layer: orientation for the orientation block, else the id of the thing it renders." });

const PartVersion = z
  .string()
  .min(1)
  .nullable()
  .meta({ description: "The version of what the part renders, where it has one (a catalogue entry's); null where it has none." });

/** One part of a layer as a manifest names it: what it is, its version, and its length. */
export const InstructionManifestPart = z
  .object({
    id: PartId,
    version: PartVersion,
    characters: z.int().nonnegative().meta({ description: "The part's length in characters." }),
  })
  .meta({ description: "A part of a layer as the manifest names it: its id, its version, and its length in characters." });
export type InstructionManifestPart = z.infer<typeof InstructionManifestPart>;

/** A layer that put text into the composition: its parts in order, and the characters it holds there. */
export const InstructionManifestLayer = z
  .object({
    layer: InstructionLayer,
    characters: z.int().positive().meta({ description: "The characters the layer holds in the text: its parts, with the two line breaks between each two of them." }),
    parts: z.array(InstructionManifestPart).min(1).meta({ description: "The layer's parts, in the order the text holds them." }),
  })
  .meta({ description: "A layer of the composed text: which, the characters it holds there, and its parts." });
export type InstructionManifestLayer = z.infer<typeof InstructionManifestLayer>;

/**
 * An always-on skill the composition appended: its name, where it comes
 * from (the member's origin, `skills.ts`), and the commit of the source
 * snapshot it was read from. None until the always-on layer is built (#507).
 */
export const InstructionAlwaysOnSkill = z
  .object({
    name: SkillName,
    origin: SkillOrigin.nullable().meta({
      description: "Where the skill comes from, as its member's origin: null for one of the own directory with no provenance manifest, or of a repository with no identity.",
    }),
    commit: GitCommit.nullable().meta({ description: "The commit of the source snapshot it was read from; null for a member linked live (the own directory, a trusted repository)." }),
  })
  .meta({ description: "An always-on skill the composition appended: its name, its origin and the commit it was read at." });
export type InstructionAlwaysOnSkill = z.infer<typeof InstructionAlwaysOnSkill>;

/**
 * Why a composed part is not in the text a run is handed: its account's
 * instruction channel is `none`; or the text was over the channel's
 * character cap, which leaves owned instructions out last first (#505).
 */
export const INSTRUCTION_LEFT_OUT_REASONS = ["channel-none", "over-cap"] as const;
export const InstructionLeftOutReason = z.enum(INSTRUCTION_LEFT_OUT_REASONS).meta({
  description:
    "Why a composed part is not in the text: channel-none (the account's adapter has no instruction channel, so it is handed no text), or over-cap (the text was over the channel's character cap, and owned instructions are left out last first until it fits).",
});
export type InstructionLeftOutReason = z.infer<typeof InstructionLeftOutReason>;

export const InstructionLeftOut = z
  .object({ layer: InstructionLayer, id: PartId, reason: InstructionLeftOutReason })
  .meta({ description: "A part the layers gave that the text does not hold, and why." });
export type InstructionLeftOut = z.infer<typeof InstructionLeftOut>;

/**
 * What a composition holds and what it left out: the account's instruction
 * channel; per layer that put text in, its parts' ids, versions and
 * characters; the always-on skills with their origins and commits; the skill
 * set's fingerprint; the registries the orientation block could not read;
 * and each part left out, with why.
 */
export const InstructionManifest = z
  .object({
    channel: InstructionChannelKind.meta({ description: "The instruction channel of the account's adapter: none is handed no text." }),
    layers: z.array(InstructionManifestLayer).meta({
      description: "The layers the text holds, in their fixed order; a layer that gave nothing, or whose parts were all left out, is not listed.",
    }),
    alwaysOn: z.array(InstructionAlwaysOnSkill).meta({ description: "The always-on skills the text holds, in the order it holds them." }),
    skillSetFingerprint: SkillSetFingerprint.nullable().meta({ description: "The fingerprint of the run's skill set; null while none is resolved for it." }),
    unreadRegistries: z.array(z.string().min(1)).meta({
      description: "The registries the orientation block could not read in time, each rendered as could not be read; empty when every one was read.",
    }),
    leftOut: z.array(InstructionLeftOut).meta({ description: "The parts the layers gave that the text does not hold, each with why." }),
  })
  .meta({
    description:
      "What a composition of standing instructions holds: the channel, per layer its parts' ids, versions and characters, the always-on skills with origins and commits, the skill set's fingerprint, the registries the orientation block could not read, and what was left out and why.",
  });
export type InstructionManifest = z.infer<typeof InstructionManifest>;

/** One part of the composed text as `instructions.preview` shows it: its layer, what it is, its title and its text. */
export const InstructionPreviewPart = z
  .object({
    layer: InstructionLayer,
    id: PartId,
    title: z.string().min(1).meta({ description: "The part's title, as a client heads it: Orientation for the orientation block." }),
    text: z.string().min(1).meta({ description: "The part's text, as the composed text holds it." }),
  })
  .meta({ description: "A part of the composed text: its layer, its id, its title and its text." });
export type InstructionPreviewPart = z.infer<typeof InstructionPreviewPart>;

export const RunInstructionsComposedPayload = z
  .object({
    runId: RunId,
    manifest: InstructionManifest,
    digest: Sha256.meta({ description: "The SHA-256 of the composed text as UTF-8, which is never logged: two runs handed the same text have the same digest." }),
  })
  .meta({
    description:
      "run.instructions.composed: the run's standing instructions were composed, once, after run.started and run.policy.resolved and before the provider's first event: the manifest and the text's digest, never the text.",
  });
export type RunInstructionsComposedPayload = z.infer<typeof RunInstructionsComposedPayload>;

/**
 * The composition's event on a session's stream: it changes nothing listed,
 * and transcript compaction may fold it (`sessions/compaction.ts`).
 */
export const INSTRUCTION_SESSION_EVENT_TYPES = {
  "run.instructions.composed": { list: false, payload: RunInstructionsComposedPayload },
} as const satisfies Record<string, EventTypeEntry>;

// Owned instructions ------------------------------------------------------------------

/**
 * Owned instructions (skills spec, "Owned instructions"; ADR 0030; #505):
 * David's standing instructions, environment state on the `instructions`
 * stream, one stream whose id is the environment's, with one command per
 * field (ADR 0003). Each reaches the runs of the accounts its scope names,
 * `all` reaching accounts added later too, while it is enabled, in the
 * order of its position, after the orientation block in the user layer.
 */

/** The stream kind of the owned instructions; its one stream's id is the environment's. */
export const INSTRUCTIONS_STREAM_KIND = "instructions";

/** The most characters an owned instruction's title holds once trimmed (chosen default). */
export const MAX_INSTRUCTION_TITLE = 120;

/** The most characters an owned instruction's body holds (chosen default). */
export const MAX_INSTRUCTION_BODY = 20000;

export const InstructionId = z.uuidv4().meta({ description: "An owned instruction's id: a version 4 UUID the creating client mints, kept in lowercase." });
export type InstructionId = z.infer<typeof InstructionId>;

export const InstructionTitle = z
  .string()
  .regex(trimmedNamePattern(MAX_INSTRUCTION_TITLE))
  .meta({
    description: `An owned instruction's title: 1 to ${MAX_INSTRUCTION_TITLE} characters once trimmed, no control or format (zero-width) characters other than white space; stored trimmed with white space collapsed. A run reads it as the instruction's heading.`,
  });
export type InstructionTitle = z.infer<typeof InstructionTitle>;

/** An owned instruction's title as the environment keeps it: trimmed, every run of white space one space. */
export const normaliseInstructionTitle = normaliseTrimmedName;

export const InstructionBody = z
  .string()
  .max(MAX_INSTRUCTION_BODY)
  .meta({ description: `An owned instruction's body: Markdown, at most ${MAX_INSTRUCTION_BODY} characters, which a run reads under its title.` });
export type InstructionBody = z.infer<typeof InstructionBody>;

/** Where a copy came from: the catalogue entry and the version it copied (ADR 0030). */
export const InstructionOrigin = z
  .object({
    catalogueId: z.string().min(1).meta({ description: "The catalogue entry it was copied from." }),
    version: z.int().positive().meta({ description: "The entry's version it holds." }),
  })
  .meta({ description: "The catalogue entry an owned instruction was copied from, and the version it holds." });
export type InstructionOrigin = z.infer<typeof InstructionOrigin>;

/** The accounts an owned instruction reaches: every one, those added later included, or the ones named. */
export const InstructionReach = z
  .union([
    z.literal("all").meta({ description: "Every account on the environment, those added later included." }),
    z.array(AccountId).min(1).meta({ description: "The accounts named, each once; an account removed since reaches nothing." }),
  ])
  .refine((reach) => reach === "all" || new Set(reach).size === reach.length, { message: "Name each account once." })
  .meta({ description: "The accounts an owned instruction reaches: all (every account, those added later included), or the account ids named, each once." });
export type InstructionReach = z.infer<typeof InstructionReach>;

/**
 * An owned instruction (ADR 0030): its id, title and body, its origin (null
 * for Custom), the accounts it reaches, whether it is enabled, and its
 * position, a fractional key (session-state's ordering).
 */
export const OwnedInstruction = z
  .object({
    id: InstructionId,
    title: InstructionTitle,
    body: InstructionBody,
    origin: InstructionOrigin.nullable().meta({ description: "The catalogue entry it was copied from; null for one written here (Custom)." }),
    scope: InstructionReach,
    enabled: z.boolean().meta({ description: "Whether runs are handed it; switched off it stays listed." }),
    position: OrderKey.meta({ description: "Its place in the list: runs are handed the instructions in ascending order of it, then of id." }),
  })
  .meta({ description: "An owned instruction: its id, title, body, origin, the accounts it reaches, whether it is enabled, and its position." });
export type OwnedInstruction = z.infer<typeof OwnedInstruction>;

const instructionRef = { id: InstructionId };

export const InstructionCreatedPayload = OwnedInstruction.meta({ description: "instructions.created: an owned instruction was made, as it now is." });
export const InstructionEditedPayload = z
  .object({ ...instructionRef, title: InstructionTitle, body: InstructionBody })
  .meta({ description: "instructions.edited: an owned instruction's title and body are now these." });
export const InstructionScopeSetPayload = z.object({ ...instructionRef, scope: InstructionReach }).meta({ description: "instructions.scope-set: an owned instruction now reaches these accounts." });
export const InstructionEnabledSetPayload = z
  .object({ ...instructionRef, enabled: z.boolean() })
  .meta({ description: "instructions.enabled-set: an owned instruction was switched on or off." });
export const InstructionMovedPayload = z.object({ ...instructionRef, position: OrderKey }).meta({ description: "instructions.moved: an owned instruction has this position now." });
export const InstructionRemovedPayload = z.object(instructionRef).meta({ description: "instructions.removed: an owned instruction was removed; its id is not used again." });

/** The event types of the instructions stream. */
export const INSTRUCTIONS_EVENT_TYPES = {
  "instructions.created": { list: false, payload: InstructionCreatedPayload },
  "instructions.edited": { list: false, payload: InstructionEditedPayload },
  "instructions.scope-set": { list: false, payload: InstructionScopeSetPayload },
  "instructions.enabled-set": { list: false, payload: InstructionEnabledSetPayload },
  "instructions.moved": { list: false, payload: InstructionMovedPayload },
  "instructions.removed": { list: false, payload: InstructionRemovedPayload },
} as const satisfies Record<string, EventTypeEntry>;

export type InstructionsEventType = keyof typeof INSTRUCTIONS_EVENT_TYPES;
export const InstructionsEventType = z
  .enum(Object.keys(INSTRUCTIONS_EVENT_TYPES) as [InstructionsEventType, ...InstructionsEventType[]])
  .meta({ description: `The event types of the instructions stream: ${Object.keys(INSTRUCTIONS_EVENT_TYPES).join(", ")}.` });

/** The `instructions.updated` notice's payload: nothing beyond the notice. */
export const InstructionsUpdatedPayload = z.object({}).meta({
  description: "instructions.updated: an owned instruction changed and has committed; a client reads instructions.list and instructions.preview again.",
});
export type InstructionsUpdatedPayload = z.infer<typeof InstructionsUpdatedPayload>;

/**
 * An account as every row of `instructions.list` carries it (ADR 0030): its
 * adapter's instruction channel, and, for one with none, why its runs are
 * handed nothing, so a client shows it dim with the reason.
 */
export const InstructionAccount = z
  .object({
    accountId: AccountId,
    label: AccountLabel,
    channel: InstructionChannel.meta({ description: "Its adapter's instruction channel: none is handed no standing instructions." }),
    reason: z.string().min(1).nullable().meta({ description: "Why its runs are handed no standing instructions; null while its adapter has an instruction channel." }),
  })
  .meta({ description: "An account of the environment, with its adapter's instruction channel and, without one, why its runs are handed no standing instructions." });
export type InstructionAccount = z.infer<typeof InstructionAccount>;

const rowAccounts = z.array(InstructionAccount).meta({ description: "The environment's accounts, in the account list's order." });

/**
 * The Orientation row (ADR 0030): read-only and never edited or removed, so
 * it has no id a command takes. The `instructions.orientation` key, and the
 * block as a run receives it while the key is on.
 */
export const OrientationRow = z
  .strictObject({
    enabled: z.boolean().meta({ description: "The instructions.orientation key: whether runs are handed the block." }),
    text: z.string().nullable().meta({
      description:
        "The block as the first run of a new session of the default account, started from a client, is handed it while the key is on, verification lines included; null while the environment holds no account.",
    }),
    unreadRegistries: z.array(z.string().min(1)).meta({ description: "The registries the block could not read in time, each rendered as could not be read." }),
    accounts: rowAccounts,
  })
  .meta({ description: "The read-only Orientation row: the instructions.orientation key, the block as a run receives it, and the environment's accounts." });
export type OrientationRow = z.infer<typeof OrientationRow>;

export const OwnedInstructionRow = z
  .object({ ...OwnedInstruction.shape, accounts: rowAccounts })
  .meta({ description: "An owned instruction as instructions.list rows it, with the environment's accounts." });
export type OwnedInstructionRow = z.infer<typeof OwnedInstructionRow>;
