import { constants } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Auto memory copied by ADR 0021's carry-over rule: a memory directory
 * (`MEMORY.md`, the index Claude Code loads, and its topic files) copied
 * into another, never moved, and nothing the target holds overwritten. A
 * session whose auto-memory key changes carries its old directory into its
 * new one by it (#329), and the Carry over import (#580) its adopted
 * memory folders.
 *
 * - An absent or empty target takes the source's files where they are.
 * - A target holding every file of the source already, byte for byte,
 *   takes nothing: the source was carried before.
 * - Otherwise the source is a second source for the target: it lands whole
 *   under `carried/<name>/` (`<name>-2`, `-3` while another copy holds the
 *   name), so its index still reaches its own topic files, and one pointer
 *   line to it is appended to the target's `MEMORY.md`, which Claude Code
 *   reads. A copy already there, byte for byte, is left as it is, and gets
 *   its pointer line if a carry cut short left it without one.
 *
 * Only regular files are copied: a link, and anything else that is not a
 * file or a directory, stays behind. The source is only read.
 */

/** What a carry did: nothing to carry, the files copied into an empty target, nothing since the target holds them, or a second source put under `carried/`. */
export type CarryOutcome = { readonly outcome: "empty" | "copied" | "held" } | { readonly outcome: "carried"; readonly under: string };

export interface MemorySource {
  /** The memory directory to carry. */
  readonly directory: string;
  /** The name a second source lands under, in `carried/`: one path segment. */
  readonly name: string;
  /** What the pointer line calls the source, for a person reading `MEMORY.md`. */
  readonly label: string;
}

/** The directory a second source lands in, inside the target. */
export const CARRIED_DIRECTORY = "carried";

/** The index Claude Code loads from a memory directory. */
const INDEX = "MEMORY.md";

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** The regular files under `directory`, each as its path segments from there, in a stable order; none for a directory that is not there. */
const filesIn = async (directory: string, within: readonly string[] = []): Promise<string[][]> => {
  let entries;
  try {
    entries = await readdir(join(directory, ...within), { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return [];
    throw error;
  }
  const files: string[][] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const path = [...within, entry.name];
    if (entry.isFile()) files.push(path);
    else if (entry.isDirectory()) files.push(...(await filesIn(directory, path)));
  }
  return files;
};

/** Whether `directory` holds anything at all; one that is not there holds nothing. */
const holdsAnything = async (directory: string): Promise<boolean> => {
  try {
    return (await readdir(directory)).length > 0;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
};

/** The bytes of the file at `path`; null when there is none. */
const bytesAt = async (path: string): Promise<Buffer | null> => {
  try {
    return await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR" || errorCode(error) === "EISDIR") return null;
    throw error;
  }
};

/** Whether `directory` holds each of `files` of `source`, byte for byte. */
const holdsAll = async (directory: string, source: string, files: readonly string[][]): Promise<boolean> => {
  for (const file of files) {
    const [held, carried] = await Promise.all([bytesAt(join(directory, ...file)), readFile(join(source, ...file))]);
    if (held === null || !held.equals(carried)) return false;
  }
  return true;
};

/** Copies `files` from `source` into `target`, making their directories, never over a file already there. */
const copyInto = async (source: string, target: string, files: readonly string[][]): Promise<void> => {
  for (const file of files) {
    const to = join(target, ...file);
    await mkdir(dirname(to), { recursive: true });
    try {
      await copyFile(join(source, ...file), to, constants.COPYFILE_EXCL);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
  }
};

/** `text` as the text of a Markdown link: on one line, its brackets and backslashes escaped. */
const linkText = (text: string): string => text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/[\\[\]]/g, (character) => `\\${character}`);

/**
 * Appends to the target's index the line pointing at the second source
 * under `under` (a path from the target, `/`-separated), unless a line there
 * points at it already: so a carry cut short between its copy and its line
 * gets the line from the next carry of that source, and never two.
 */
const pointTo = async (target: string, under: string, label: string, hasIndex: boolean): Promise<void> => {
  const index = join(target, INDEX);
  const held = (await bytesAt(index))?.toString("utf8") ?? "";
  if (held.includes(`](${under}/`)) return;
  const line = `- [Memory carried from ${linkText(label)}](${under}/${hasIndex ? INDEX : ""})\n`;
  await appendFile(index, held === "" || held.endsWith("\n") ? line : `\n${line}`);
};

/** Carries the memory directory `source` into `target` by the rule: see the module comment. */
export const carryMemory = async (source: MemorySource, target: string): Promise<CarryOutcome> => {
  const files = await filesIn(source.directory);
  if (files.length === 0) return { outcome: "empty" };
  if (!(await holdsAnything(target))) {
    await copyInto(source.directory, target, files);
    return { outcome: "copied" };
  }
  if (await holdsAll(target, source.directory, files)) return { outcome: "held" };
  const hasIndex = files.some((file) => file.length === 1 && file[0] === INDEX);
  for (let n = 1; ; n += 1) {
    const under = `${CARRIED_DIRECTORY}/${n === 1 ? source.name : `${source.name}-${n}`}`;
    const directory = join(target, ...under.split("/"));
    if (await holdsAnything(directory)) {
      if (!(await holdsAll(directory, source.directory, files))) continue;
      await pointTo(target, under, source.label, hasIndex);
      return { outcome: "held" };
    }
    await copyInto(source.directory, directory, files);
    await pointTo(target, under, source.label, hasIndex);
    return { outcome: "carried", under };
  }
};
