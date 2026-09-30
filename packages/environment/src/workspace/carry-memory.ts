import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

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
 * file or a directory, stays behind. The source is only read. A dry run
 * answers what the carry would do, and writes nothing; the dry carries of
 * one pass, handed one `DryRun`, each see what the ones before it would
 * have written, so a pass of several sources into one target is answered as
 * the same carries then do it.
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

/**
 * What the dry carries of one pass would have written, so far: the
 * directories they would have filled, each with the source whose files it
 * would hold, and the text they would have appended to an index. Hand one to
 * each dry carry of the pass; a real carry never reads it.
 */
export interface DryRun {
  readonly filled: Map<string, { readonly source: string; readonly files: readonly string[] }>;
  readonly appended: Map<string, string>;
}

/** A dry run of a pass that has carried nothing yet. */
export const createDryRun = (): DryRun => ({ filled: new Map(), appended: new Map() });

/** How a carry runs: for real, or dry, within the pass `plan` pictures (a pass of its own when there is none). */
export interface CarryOptions {
  readonly dryRun?: boolean;
  readonly plan?: DryRun;
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
const holdsAll = async (place: Place, directory: string, source: string, files: readonly string[][]): Promise<boolean> => {
  for (const file of files) {
    const [held, carried] = await Promise.all([place.bytesAt(join(directory, ...file)), readFile(join(source, ...file))]);
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
const pointTo = async (place: Place, target: string, under: string, label: string, hasIndex: boolean): Promise<void> => {
  const index = join(target, INDEX);
  const held = (await place.bytesAt(index))?.toString("utf8") ?? "";
  if (held.includes(`](${under}/`)) return;
  const line = `- [Memory carried from ${linkText(label)}](${under}/${hasIndex ? INDEX : ""})\n`;
  await place.append(index, held === "" || held.endsWith("\n") ? line : `\n${line}`);
};

/** The target as a carry reads and writes it: the disk, or a dry run's picture of it. */
interface Place {
  holdsAnything(directory: string): Promise<boolean>;
  bytesAt(path: string): Promise<Buffer | null>;
  copyInto(source: string, target: string, files: readonly string[][]): Promise<void>;
  append(path: string, text: string): Promise<void>;
}

const disk: Place = { holdsAnything, bytesAt, copyInto, append: (path, text) => appendFile(path, text) };

/** `path` from `directory` when it is `directory` or inside it (`""` for itself); else null. */
const inside = (path: string, directory: string): string | null => {
  const from = relative(directory, path);
  return from === ".." || from.startsWith(`..${sep}`) || isAbsolute(from) ? null : from;
};

/** The disk as it would be had `plan`'s carries run: what they filled read from their sources, what they appended after what is there. */
const pictured = (plan: DryRun): Place => ({
  holdsAnything: async (directory) => {
    if (await holdsAnything(directory)) return true;
    const pictured = [...plan.filled].flatMap(([filled, { files }]) => files.map((file) => join(filled, file)));
    return [...pictured, ...plan.appended.keys()].some((path) => inside(path, directory) !== null);
  },
  bytesAt: async (path) => {
    let held: Buffer | null = null;
    for (const [filled, { source, files }] of plan.filled) {
      const from = inside(path, filled);
      if (from !== null && files.includes(from)) held ??= await readFile(join(source, from));
    }
    held ??= await bytesAt(path);
    const appended = plan.appended.get(path);
    return appended === undefined ? held : Buffer.concat([held ?? Buffer.alloc(0), Buffer.from(appended)]);
  },
  copyInto: (source, target, files) => {
    plan.filled.set(target, { source, files: files.map((file) => join(...file)) });
    return Promise.resolve();
  },
  append: (path, text) => {
    plan.appended.set(path, (plan.appended.get(path) ?? "") + text);
    return Promise.resolve();
  },
});

/** Carries the memory directory `source` into `target` by the rule, or with `dryRun` answers what it would do: see the module comment. */
export const carryMemory = async (source: MemorySource, target: string, options: CarryOptions = {}): Promise<CarryOutcome> => {
  const place = options.dryRun === true ? pictured(options.plan ?? createDryRun()) : disk;
  const files = await filesIn(source.directory);
  if (files.length === 0) return { outcome: "empty" };
  if (!(await place.holdsAnything(target))) {
    await place.copyInto(source.directory, target, files);
    return { outcome: "copied" };
  }
  if (await holdsAll(place, target, source.directory, files)) return { outcome: "held" };
  const hasIndex = files.some((file) => file.length === 1 && file[0] === INDEX);
  for (let n = 1; ; n += 1) {
    const under = `${CARRIED_DIRECTORY}/${n === 1 ? source.name : `${source.name}-${n}`}`;
    const directory = join(target, ...under.split("/"));
    if (await place.holdsAnything(directory)) {
      if (!(await holdsAll(place, directory, source.directory, files))) continue;
      await pointTo(place, target, under, source.label, hasIndex);
      return { outcome: "held" };
    }
    await place.copyInto(source.directory, directory, files);
    await pointTo(place, target, under, source.label, hasIndex);
    return { outcome: "carried", under };
  }
};

/**
 * A digest of the memory directory `directory` as a carry reads it: the
 * SHA-256 of each regular file's path and bytes, in the order `filesIn`
 * gives them, as `sha256:<hex>`; null when it holds no file, so nothing
 * would be carried.
 */
export const memoryDigest = async (directory: string): Promise<string | null> => {
  const files = await filesIn(directory);
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(join(directory, ...file));
    hash.update(`${file.join("/")}\0${bytes.length}\0`).update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
};
