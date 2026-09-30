import { createHash } from "node:crypto";
import {
  INSTRUCTION_LAYERS,
  type InstructionLayer,
  type InstructionLeftOut,
  type InstructionManifest,
  type InstructionManifestLayer,
} from "@agent-harness/contracts";
import type { ComposedInstructions, InstructionComposer, InstructionPart, InstructionScope } from "../adapter/seams.js";
import { projectParts } from "./project-layer.js";

/**
 * The composer (skills-instructions spec, "Standing instructions and the
 * composer"; ADR 0009, ADR 0011, ADR 0030): what fills the host's
 * instruction seam. A run's standing instructions are composed once, on its
 * environment, whoever started it, from the layers in their fixed order,
 * general to specific:
 *
 * 1. the user layer: the orientation block (its seam, which the
 *    OrientationRenderer fills, `orientation.ts`), then owned instructions
 *    (#505);
 * 2. the team bank's (its seam, which #90's renderer fills);
 * 3. the project's, which Claude loads natively under trust beside the
 *    appended text, so nothing is added for it; an adapter without native
 *    project instructions is handed the trusted repository's `AGENTS.md`,
 *    else its `CLAUDE.md` (`project-layer.ts`, #500);
 * 4. the session's (its seam, which #506 fills);
 * 5. a bot's persona (its seam; empty until milestone 2);
 * 6. always-on skills (#507).
 *
 * A layer gives parts, each with an id, a version, a title and its text; a
 * part whose text is blank is left out, and so is a layer that gives none.
 * The text is the parts in order, two line breaks apart. Nothing here reads
 * a clock, so unchanged state composes the same text byte for byte, which a
 * provider process that fixes its instructions at spawn depends on (#138).
 *
 * An account whose adapter's instruction channel is `none` is handed no
 * text: every part is listed in the manifest as left out, `channel-none`.
 * Beside the text, the answer holds its parts and the manifest: per layer
 * its parts' ids, versions and characters, the always-on skills, the skill
 * set's fingerprint, the registries the orientation block could not read,
 * and what was left out and why.
 */

/** The orientation block as its seam answers it: the text, and the registries it could not read, each rendered as could not be read. */
export interface OrientationAnswer {
  readonly text: string;
  readonly unreadRegistries: readonly string[];
}

/**
 * Renders the orientation block for a run (ADR 0011): from live state,
 * never a clock. It may take its time: a run's launch awaits it.
 */
export type OrientationSeam = (scope: InstructionScope) => OrientationAnswer | Promise<OrientationAnswer>;

/** A part as a layer gives it: what it is (an id, and its version where it has one), its title, and its text. */
export type LayerPart = Omit<InstructionPart, "layer">;

/** A layer's parts for a run, in the order the text is to hold them; none for an empty layer. */
export type LayerSeam = (scope: InstructionScope) => readonly LayerPart[] | Promise<readonly LayerPart[]>;

/** The seams the composer's layers read; each preset gives nothing. */
export interface InstructionLayers {
  /** The orientation block, first in the user layer (the OrientationRenderer's seam, `orientation.ts`). */
  readonly orientation?: OrientationSeam;
  /** The team bank's lines (#90's renderer). */
  readonly teamBank?: LayerSeam;
  /** The session's own instructions (#506). */
  readonly session?: LayerSeam;
  /** A bot's persona (milestone 2, #92). */
  readonly persona?: LayerSeam;
}

/** The orientation block's part: its id in the manifest and its title in a preview. */
const ORIENTATION_PART = { id: "orientation", title: "Orientation" } as const;

/** What sits between two parts of the text. */
const PART_SEPARATOR = "\n\n";

const nothing = (): readonly LayerPart[] => [];

const noOrientation = (): OrientationAnswer => ({ text: "", unreadRegistries: [] });

/** The orientation block as the user layer's first part; none while it is blank. */
const orientationParts = ({ text }: OrientationAnswer): readonly LayerPart[] =>
  text.trim() === "" ? [] : [{ id: ORIENTATION_PART.id, version: null, title: ORIENTATION_PART.title, text }];

/** The manifest's entry for each layer the handed parts come from, in the layers' order. */
const manifestLayers = (parts: readonly InstructionPart[]): InstructionManifestLayer[] =>
  INSTRUCTION_LAYERS.flatMap((layer) => {
    const own = parts.filter((part) => part.layer === layer);
    if (own.length === 0) return [];
    return [
      {
        layer,
        characters: own.map((part) => part.text).join(PART_SEPARATOR).length,
        parts: own.map((part) => ({ id: part.id, version: part.version, characters: part.text.length })),
      },
    ];
  });

/** The composer over `layers`; with none, every run is handed nothing. */
export const composeInstructions =
  (layers: InstructionLayers = {}): InstructionComposer =>
  async (scope) => {
    const [orientation, teamBank, project, session, persona] = await Promise.all([
      (layers.orientation ?? noOrientation)(scope),
      (layers.teamBank ?? nothing)(scope),
      projectParts(scope),
      (layers.session ?? nothing)(scope),
      (layers.persona ?? nothing)(scope),
    ]);
    const given: Readonly<Record<InstructionLayer, readonly LayerPart[]>> = {
      user: orientationParts(orientation),
      "team-bank": teamBank,
      project,
      session,
      persona,
      "always-on": [],
    };
    const composed: InstructionPart[] = INSTRUCTION_LAYERS.flatMap((layer) =>
      given[layer].filter((part) => part.text.trim() !== "").map((part) => ({ ...part, layer })),
    );
    const channelNone = scope.channel.kind === "none";
    const parts = channelNone ? [] : composed;
    const leftOut: InstructionLeftOut[] = channelNone ? composed.map(({ layer, id }) => ({ layer, id, reason: "channel-none" })) : [];
    const manifest: InstructionManifest = {
      channel: scope.channel.kind,
      layers: manifestLayers(parts),
      alwaysOn: [],
      skillSetFingerprint: scope.skillSet.fingerprint,
      unreadRegistries: [...orientation.unreadRegistries],
      leftOut,
    };
    return { text: parts.map((part) => part.text).join(PART_SEPARATOR), parts, manifest } satisfies ComposedInstructions;
  };

/** The digest `run.instructions.composed` carries in place of the text: its SHA-256 as UTF-8, in lowercase hex. */
export const instructionsDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
