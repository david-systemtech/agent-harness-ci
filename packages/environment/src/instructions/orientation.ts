import type { InstructionScope } from "../adapter/seams.js";
import type { OrientationAnswer, OrientationSeam } from "./composer.js";

/**
 * The orientation block's sections (key-managers spec, "The orientation
 * block"; ADR 0011): each is rendered by a provider the owning service
 * registers with the OrientationRenderer, which puts them in their fixed
 * order (this environment, key managers, forges, banks, other
 * environments) and fills the composer's orientation seam (#380).
 *
 * A provider renders its section's lines from state, never from a clock,
 * within the renderer's one-second budget: for unchanged state the text is
 * byte-identical, since it is in a provider process's spawn key and any
 * other text costs a fresh process.
 *
 * Until the renderer exists, the forges section fills the seam alone
 * (#318; David, 2026-09-28): `soleSection`.
 */

/** One section of the orientation block, as its provider gives it to the renderer. */
export interface OrientationSection {
  /** What the seam's answer names when the section could not be read: `forges`. */
  readonly name: string;
  /** Its heading in the block: `Forges`. */
  readonly title: string;
  /** Its lines for a run, from state and never a clock; blank leaves the section out. */
  render(scope: InstructionScope): string | Promise<string>;
}

/** The block's heading, over its sections. */
const BLOCK_HEADING = "# Orientation";

/** What a section whose provider failed renders in place of its lines. */
export const COULD_NOT_BE_READ = "Could not be read.";

/** The section under its heading. */
const headed = (title: string, lines: string): string => `## ${title}\n\n${lines}`;

/**
 * The orientation seam filled by one section alone, under the block's
 * heading: blank when the section renders nothing; its heading over "Could
 * not be read.", named in the answer, when its provider throws.
 */
export const soleSection =
  (section: OrientationSection): OrientationSeam =>
  async (scope): Promise<OrientationAnswer> => {
    let lines: string;
    try {
      lines = await section.render(scope);
    } catch (error) {
      console.error(`The orientation block's ${section.name} section could not be read:`, error);
      return { text: `${BLOCK_HEADING}\n\n${headed(section.title, COULD_NOT_BE_READ)}`, unreadRegistries: [section.name] };
    }
    if (lines.trim() === "") return { text: "", unreadRegistries: [] };
    return { text: `${BLOCK_HEADING}\n\n${headed(section.title, lines)}`, unreadRegistries: [] };
  };
