import { z } from "zod";
import { InstructionChannelKind, RunId } from "./adapter.js";
import type { EventTypeEntry } from "./event-types.js";
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
 * An owned instruction's bounds (skills spec, "Owned instructions"): its
 * title at most 120 characters, its Markdown body at most 20,000. A
 * catalogue entry's title and text keep them, so a ticked copy always fits.
 */
export const MAX_INSTRUCTION_TITLE = 120;
export const MAX_INSTRUCTION_BODY = 20_000;

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

/** Why a composed part is not in the text a run is handed: its account's instruction channel is `none`. */
export const INSTRUCTION_LEFT_OUT_REASONS = ["channel-none"] as const;
export const InstructionLeftOutReason = z.enum(INSTRUCTION_LEFT_OUT_REASONS).meta({
  description: "Why a composed part is not in the text: channel-none (the account's adapter has no instruction channel, so it is handed no text).",
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
