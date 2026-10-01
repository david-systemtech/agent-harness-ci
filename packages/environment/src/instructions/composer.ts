import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  INSTRUCTION_LAYERS,
  type InstructionLayer,
  type InstructionLeftOut,
  type InstructionManifest,
  type InstructionManifestLayer,
} from "@agent-harness/contracts";
import type { ComposedInstructions, InstructionComposer, InstructionPart, InstructionScope } from "../adapter/seams.js";
import { splitFrontmatter } from "../skills/reader.js";
import { projectParts } from "./project-layer.js";

/**
 * The composer (skills-instructions spec, "Standing instructions and the
 * composer"; ADR 0009, ADR 0011, ADR 0030): what fills the host's
 * instruction seam. A run's standing instructions are composed once, on its
 * environment, whoever started it, from the layers in their fixed order,
 * general to specific:
 *
 * 1. the user layer: the orientation block (its seam, which the
 *    OrientationRenderer fills, `orientation.ts`) while the
 *    `instructions.orientation` key is on, then the account's enabled owned
 *    instructions in list order (its seam, which the instruction store
 *    fills, `store.ts`; #505), under `# Standing instructions`, each as
 *    `## <title>` over its body;
 * 2. the team bank's (its seam, which #90's renderer fills);
 * 3. the project's, which Claude loads natively under trust beside the
 *    appended text, so nothing is added for it; an adapter without native
 *    project instructions is handed the trusted repository's `AGENTS.md`,
 *    else its `CLAUDE.md` (`project-layer.ts`, #500);
 * 4. the session's own instructions, under `# Instructions for this
 *    session` (its seam, which `session-instructions.ts` fills; #506);
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
 * Under a channel's character cap, always-on skills are left out last
 * first, then owned instructions, each listed as left out, `over-cap`; a
 * text still over the cap with none left is handed as it is.
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
  /** Whether the orientation block is composed: the `instructions.orientation` key, read at each composition; preset on. */
  readonly orientationOn?: () => boolean;
  /** The owned instructions a run's account is handed, in list order, each with its title and its body as its text (#505). */
  readonly owned?: LayerSeam;
  /** The team bank's lines (#90's renderer). */
  readonly teamBank?: LayerSeam;
  /** The session's own instructions (#506). */
  readonly session?: LayerSeam;
  /** A bot's persona (milestone 2, #92). */
  readonly persona?: LayerSeam;
}

/** The heading over the owned instructions, which the first of them handed carries. */
const STANDING_HEADING = "# Standing instructions";

/** The orientation block's part: its id in the manifest and its title in a preview. */
const ORIENTATION_PART = { id: "orientation", title: "Orientation" } as const;

/** What sits between two parts of the text. */
const PART_SEPARATOR = "\n\n";

const nothing = (): readonly LayerPart[] => [];

/** Enabled account members first, then requested members, each name once. */
const alwaysOnParts = async (scope: InstructionScope) => {
  const names = [...new Set([...scope.skillSet.members.filter((member) => member.alwaysOn).map((member) => member.name), ...scope.alwaysOn])];
  return Promise.all(names.flatMap((name) => {
    const member = scope.skillSet.members.find((entry) => entry.name === name);
    if (member === undefined) return [];
    const file = member.file ?? (scope.skillSet.generation === null ? null : join(scope.skillSet.generation, "skills", name, "SKILL.md"));
    if (file === null) return [];
    return [readFile(file, "utf8").then((markdown) => {
      const body = splitFrontmatter(markdown).body.trim();
      const cut = body.length > 60_000 ? `\n\n[Body cut at 60,000 characters; read ${file} for the rest.]` : "";
      return {
        id: name, version: member.commit ?? null, title: name,
        text: `# Always-on skill: ${name}\n\nFollow this skill for the whole session; its files are relative to its folder in the generation (${dirname(file)}).\n\n${body.slice(0, 60_000)}${cut}`,
        origin: member.origin, commit: member.commit ?? null,
      };
    })];
  }));
};

const noOrientation = (): OrientationAnswer => ({ text: "", unreadRegistries: [] });

/** The orientation block as the user layer's first part; none while it is blank. */
const orientationParts = ({ text }: OrientationAnswer): readonly LayerPart[] =>
  text.trim() === "" ? [] : [{ id: ORIENTATION_PART.id, version: null, title: ORIENTATION_PART.title, text }];

/** An owned instruction's part as the text holds it: its title as a heading over its body. */
const ownedPart = (part: LayerPart): LayerPart => ({ ...part, text: part.text.trim() === "" ? `## ${part.title}` : `## ${part.title}${PART_SEPARATOR}${part.text}` });

/** The owned instructions a text holds: the heading over the first of them. */
const standing = (parts: readonly LayerPart[]): LayerPart[] =>
  parts.map((part, index) => (index === 0 ? { ...part, text: `${STANDING_HEADING}${PART_SEPARATOR}${part.text}` } : part));

const joined = (parts: readonly InstructionPart[]): string => parts.map((part) => part.text).join(PART_SEPARATOR);

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
    const orientationOn = layers.orientationOn ?? (() => true);
    const [orientation, owned, teamBank, project, session, persona, alwaysOn] = await Promise.all([
      orientationOn() ? (layers.orientation ?? noOrientation)(scope) : noOrientation(),
      (layers.owned ?? nothing)(scope),
      (layers.teamBank ?? nothing)(scope),
      projectParts(scope),
      (layers.session ?? nothing)(scope),
      (layers.persona ?? nothing)(scope),
      alwaysOnParts(scope),
    ]);
    const ownedParts = owned.map(ownedPart);
    /** The parts in the layers' order with the first `kept` owned instructions, the blank ones left out. */
    const composedWith = (kept: number, keptSkills = alwaysOn.length): InstructionPart[] => {
      const given: Readonly<Record<InstructionLayer, readonly LayerPart[]>> = {
        user: [...orientationParts(orientation), ...standing(ownedParts.slice(0, kept))],
        "team-bank": teamBank,
        project,
        session,
        persona,
        "always-on": alwaysOn.slice(0, keptSkills).map(({ id, version, title, text }) => ({ id, version, title, text })),
      };
      return INSTRUCTION_LAYERS.flatMap((layer) => given[layer].filter((part) => part.text.trim() !== "").map((part) => ({ ...part, layer })));
    };
    let parts: InstructionPart[];
    let leftOut: InstructionLeftOut[];
    if (scope.channel.kind === "none") {
      parts = [];
      leftOut = composedWith(ownedParts.length).map(({ layer, id }) => ({ layer, id, reason: "channel-none" }));
    } else {
      // Under the cap, always-on skills go last first, then owned instructions.
      const cap = scope.channel.maxCharacters;
      let kept = ownedParts.length;
      let keptSkills = alwaysOn.length;
      while (cap !== null && keptSkills > 0 && joined(composedWith(kept, keptSkills)).length > cap) keptSkills -= 1;
      while (cap !== null && kept > 0 && joined(composedWith(kept, keptSkills)).length > cap) kept -= 1;
      parts = composedWith(kept, keptSkills);
      leftOut = [
        ...alwaysOn.slice(keptSkills).map(({ id }): InstructionLeftOut => ({ layer: "always-on", id, reason: "over-cap" })),
        ...ownedParts.slice(kept).map(({ id }): InstructionLeftOut => ({ layer: "user", id, reason: "over-cap" })),
      ];
    }
    const manifest: InstructionManifest = {
      channel: scope.channel.kind,
      layers: manifestLayers(parts),
      alwaysOn: alwaysOn.filter(({ id }) => parts.some((part) => part.layer === "always-on" && part.id === id)).map(({ id, origin, commit }) => ({ name: id, origin, commit })),
      skillSetFingerprint: scope.skillSet.fingerprint,
      unreadRegistries: [...orientation.unreadRegistries],
      leftOut,
    };
    return { text: joined(parts), parts, manifest } satisfies ComposedInstructions;
  };

/** The digest `run.instructions.composed` carries in place of the text: its SHA-256 as UTF-8, in lowercase hex. */
export const instructionsDigest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
