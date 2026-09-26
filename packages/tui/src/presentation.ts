import { join } from "node:path";
import { writable, type Observable } from "@agent-harness/client-runtime";
import { readTextIfPresent, writePrivateFile } from "./platform/files.js";

/**
 * The terminal UI's client-local presentation (ADR 0003, ADR 0004; glossary:
 * Pane): the one module where the organisation-state lint allows its
 * enumerated presentation keys (`eslint-rules/no-client-organisation-state.ts`).
 * It holds one, `collapsedHeadings`: which of the rail's headings are folded,
 * by heading name, since a merged heading spans environments and no one
 * environment could own the flag (session-state spec, "Group"). A heading
 * named here holds `true` (folded) or `false` (open); one not named takes
 * the rail's default (the settled shelf and the archive folded). It is kept
 * in the state directory as `presentation.json`, written whole, so a fold
 * outlives a launch; nothing about a session is kept in it.
 */

/** The rail's fold state: heading name to folded. */
export type CollapsedHeadings = Readonly<Record<string, boolean>>;

export interface Presentation {
  readonly collapsedHeadings: Observable<CollapsedHeadings>;
  /**
   * Folds or opens the heading named `heading`. A heading `keep` refuses (a
   * group's, once the group is gone) is dropped as the document is written,
   * so folds of headings long gone do not pile up.
   */
  setFolded(heading: string, folded: boolean, keep?: (heading: string) => boolean): void;
}

/** The file in the state directory. */
export const PRESENTATION_FILE = "presentation.json";

const presentationOf = (initial: CollapsedHeadings, save: (value: CollapsedHeadings) => void): Presentation => {
  const collapsedHeadings = writable<CollapsedHeadings>(initial);
  return {
    collapsedHeadings,
    setFolded(heading, folded, keep = () => true) {
      const now = collapsedHeadings.read();
      const kept = Object.entries(now).filter(([name]) => name === heading || keep(name));
      if (now[heading] === folded && kept.length === Object.keys(now).length) return;
      collapsedHeadings.set({ ...Object.fromEntries(kept), [heading]: folded });
      save(collapsedHeadings.read());
    },
  };
};

/** Held in memory only: the preset when the terminal UI is given no state directory (tests). */
export const inMemoryPresentation = (initial: CollapsedHeadings = {}): Presentation => presentationOf(initial, () => undefined);

/** A document this build reads: `{format: 1, collapsedHeadings}` with a boolean per heading. */
const readDocument = (text: string): CollapsedHeadings => {
  const parsed = JSON.parse(text) as { readonly format?: unknown; readonly collapsedHeadings?: unknown };
  const value = parsed.collapsedHeadings;
  if (parsed.format !== 1 || typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("it is not a presentation document this build reads");
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.every(([, folded]) => typeof folded === "boolean")) throw new Error("a heading's fold is not true or false");
  return Object.fromEntries(entries) as CollapsedHeadings;
};

/**
 * Kept in `presentation.json` in `stateDir`: read once now, written whole on
 * each change. A file that cannot be read is reported once through
 * `report`, and the rail starts from its defaults; it is written over only
 * when a fold changes.
 */
export const presentationFile = (stateDir: string, report: (error: unknown) => void = () => undefined): Presentation => {
  const path = join(stateDir, PRESENTATION_FILE);
  let initial: CollapsedHeadings = {};
  try {
    const text = readTextIfPresent(path);
    if (text !== undefined) initial = readDocument(text);
  } catch (error) {
    report(new Error(`${path} could not be read (${error instanceof Error ? error.message : String(error)}); the rail's headings start folded as they are by default.`));
  }
  return presentationOf(initial, (value) => {
    try {
      writePrivateFile(path, `${JSON.stringify({ format: 1, collapsedHeadings: value })}\n`);
    } catch (error) {
      report(error);
    }
  });
};
