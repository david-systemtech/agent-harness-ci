import type { Dirent } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { approximateTokens, readSkillMember, type SkillMemberFolder, type SkillMemberKind, type SkillMemberReading } from "@agent-harness/contracts";
import { parse } from "yaml";
import { readSidecar } from "./sidecar.js";

/**
 * The reader (skills spec, "Skill sources", the reader; ADR 0029, the
 * root-skill rule): the one way a folder of skills is read, whether it is
 * a source's snapshot, a probe's checkout, the own directory, a trusted
 * repository's root or a catalogue entry's clone. A folder holding
 * `SKILL.md` is one member; otherwise each direct child holding `SKILL.md`
 * is a member. Nothing deeper is read, and no link leading out of the
 * folder read is followed: a link inside it is. Each member is named and
 * described by `readSkillMember` (contracts), and carries its body's size;
 * a skill's readiness sidecar that does not read is a warning on it
 * (`sidecar.ts`). What layer it lies in and where it comes from are the
 * caller's.
 */

/** The file that makes a folder a skill. */
export const SKILL_FILE = "SKILL.md";

/** A command file's extension. */
const COMMAND_EXTENSION = ".md";

/** A member as the reader finds it: what its files say of it, what it is, where it lies and its body's size. */
export interface FoundMember extends SkillMemberReading {
  readonly kind: SkillMemberKind;
  /** Its folder or file from the folder read: `.` for a folder that is itself the skill. */
  readonly relative: string;
  /** Its body's length in characters: the text after its frontmatter, white space around it left out. */
  readonly size: number;
  readonly tokens: number;
}

/**
 * What a folder that is itself one skill is named after when its
 * frontmatter gives no name that passes: the source folder's last segment
 * (null for a repository's root), else the repository's last path segment.
 */
export interface RootNaming {
  readonly sourceFolderSegment: string | null;
  readonly repositorySegment: string | null;
}

/** A `SKILL.md` or command file split: its frontmatter as parsed (empty for none, null when it does not read as a mapping) and its body. */
export interface SplitMarkdown {
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  readonly body: string;
}

/** A fence opening frontmatter on the file's first line. */
const OPENING_FENCE = /^---[ \t]*\r?\n/;
/** The fence closing it, on a line of its own. */
const CLOSING_FENCE = /(?:^|\r?\n)---[ \t]*(?:\r?\n|$)/;

/**
 * Splits a Markdown file into its YAML frontmatter and its body. A file
 * whose first line is no `---` has none, which reads as an empty mapping;
 * frontmatter that never closes, does not parse, or is not a mapping reads
 * as null.
 */
export const splitFrontmatter = (text: string): SplitMarkdown => {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const opening = OPENING_FENCE.exec(source);
  if (opening === null) return { frontmatter: {}, body: source };
  const rest = source.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(rest);
  if (closing === null) return { frontmatter: null, body: rest };
  const body = rest.slice(closing.index + closing[0].length);
  let parsed: unknown;
  try {
    parsed = parse(rest.slice(0, closing.index));
  } catch {
    return { frontmatter: null, body };
  }
  if (parsed === null || parsed === undefined) return { frontmatter: {}, body };
  return { frontmatter: typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null, body };
};

/** A name no member path holds as it is: a control character, which the path schema refuses, or a backslash, which it reads as a separator. */
const UNNAMEABLE = /[\p{Cc}\\]/u;

/** Whether `path` lies in `tree` or is it, both with every link resolved. */
const within = (tree: string, path: string): boolean => {
  const rel = relative(tree, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Where `path` leads, every link resolved, when that lies in `tree`; null when it leads out of it or nowhere. */
const inside = async (tree: string, path: string): Promise<string | null> => {
  try {
    const resolved = await realpath(path);
    return within(tree, resolved) ? resolved : null;
  } catch {
    return null;
  }
};

/** Whether `path` (links resolved) is a directory, or a regular file. */
const kindOf = async (path: string): Promise<"directory" | "file" | null> => {
  try {
    const found = await stat(path);
    return found.isDirectory() ? "directory" : found.isFile() ? "file" : null;
  } catch {
    return null;
  }
};

/** The `SKILL.md` in `folder`, links resolved, when it is a file lying in `tree`; null otherwise. */
const skillFileIn = async (tree: string, folder: string): Promise<string | null> => {
  const path = join(folder, SKILL_FILE);
  try {
    await lstat(path);
  } catch {
    return null;
  }
  const resolved = await inside(tree, path);
  return resolved !== null && (await kindOf(resolved)) === "file" ? resolved : null;
};

/** The entries of `folder` in name order (by code unit, so every machine lists them alike), those no path can hold left out. */
export const entriesOf = async (folder: string): Promise<Dirent[]> => {
  const entries = await readdir(folder, { withFileTypes: true });
  return entries.filter((entry) => !UNNAMEABLE.test(entry.name)).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

/**
 * Reads one member from its file: for a skill, `folder` is the folder
 * holding its `SKILL.md`, whose readiness sidecar, when it does not read,
 * is a warning on the member (null for a command, which has none).
 */
const readMember = async (file: string, naming: SkillMemberFolder, found: Pick<FoundMember, "kind" | "relative">, folder: string | null): Promise<FoundMember> => {
  const [text, sidecar] = await Promise.all([readFile(file, "utf8"), folder === null ? null : readSidecar(folder)]);
  const { frontmatter, body } = splitFrontmatter(text);
  const size = body.trim().length;
  const reading = readSkillMember(frontmatter, naming);
  const warnings = sidecar?.kind === "invalid" ? [...reading.warnings, { kind: "sidecar-invalid" as const, message: sidecar.message }] : reading.warnings;
  return { ...reading, warnings, ...found, size, tokens: approximateTokens(size) };
};

/** `folder` with every link resolved; null when it is no directory. */
const treeOf = async (folder: string): Promise<string | null> => {
  try {
    const resolved = await realpath(folder);
    return (await kindOf(resolved)) === "directory" ? resolved : null;
  } catch {
    return null;
  }
};

/**
 * Reads a folder of skills by the root-skill rule: the folder itself when
 * it holds `SKILL.md`, named as `root` says; else each direct child folder
 * holding `SKILL.md`, named after the child. A folder that is not there
 * holds none.
 */
export const readSkillFolder = async (folder: string, root: RootNaming): Promise<FoundMember[]> => {
  const tree = await treeOf(folder);
  if (tree === null) return [];
  const own = await skillFileIn(tree, tree);
  if (own !== null) return [await readMember(own, { kind: "root", ...root }, { kind: "skill", relative: "." }, tree)];
  const members: FoundMember[] = [];
  for (const entry of await entriesOf(tree)) {
    const child = await inside(tree, join(tree, entry.name));
    if (child === null || child === tree || (await kindOf(child)) !== "directory") continue;
    const file = await skillFileIn(tree, child);
    if (file !== null) members.push(await readMember(file, { kind: "folder", name: entry.name }, { kind: "skill", relative: entry.name }, child));
  }
  return members;
};

/**
 * Reads a folder of commands: each Markdown file directly in it is a
 * member named by its file, without `.md`, and described by its
 * frontmatter. A folder that is not there holds none.
 */
export const readCommandFolder = async (folder: string): Promise<FoundMember[]> => {
  const tree = await treeOf(folder);
  if (tree === null) return [];
  const members: FoundMember[] = [];
  for (const entry of await entriesOf(tree)) {
    if (!entry.name.endsWith(COMMAND_EXTENSION) || entry.name.length === COMMAND_EXTENSION.length) continue;
    const file = await inside(tree, join(tree, entry.name));
    if (file === null || (await kindOf(file)) !== "file") continue;
    const name = entry.name.slice(0, -COMMAND_EXTENSION.length);
    members.push(await readMember(file, { kind: "file", name }, { kind: "command", relative: entry.name }, null));
  }
  return members;
};

/**
 * Reads the one skill folder at `folder`, named after `name` as a child of
 * a folder read, following every link: Carry over's originals, which may
 * lie anywhere a link leads. Null when it is no folder holding a
 * `SKILL.md` file.
 */
export const readSkillFolderAt = async (folder: string, name: string): Promise<FoundMember | null> => {
  const file = join(folder, SKILL_FILE);
  if ((await kindOf(folder)) !== "directory" || (await kindOf(file)) !== "file") return null;
  return readMember(file, { kind: "folder", name }, { kind: "skill", relative: name }, folder);
};

/**
 * Reads the command file at `file`, following every link, as a member named
 * by its file name `name`, without `.md`. Null when it is no file.
 */
export const readCommandFileAt = async (file: string, name: string): Promise<FoundMember | null> => {
  if ((await kindOf(file)) !== "file") return null;
  return readMember(file, { kind: "file", name }, { kind: "command", relative: `${name}${COMMAND_EXTENSION}` }, null);
};
