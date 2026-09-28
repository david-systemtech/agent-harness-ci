import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { BINARY_SNIFF_BYTES, ContractError, FILES_LIST_CAP, FILES_READ_CAP, invalidParams } from "@agent-harness/contracts";
import { runGit } from "./git.js";
import { resolveInWorkspace } from "./paths.js";

/**
 * `files.list` and `files.read` (tui spec, "Terminals, files and diffs"),
 * read-only. The listing is git's when the workspace is in a repository
 * (`ls-files --cached --others --exclude-standard`: what the project
 * considers its own, ignored files left out), else a bounded walk with a
 * fixed skip list: `.git`, `node_modules`, `dist`, `out`, `.tsbuild` and
 * every other dot-directory are never entered, and a symlink is neither
 * listed nor followed. Either way at most 20,000 paths, and the
 * walk enters at most 20,000 directories, so a tree of empty directories is
 * bounded too. Where there is no git, or git cannot answer (not a
 * repository, a broken index), the listing is the walk's.
 */

/** The most directories the walk enters, the workspace itself included. */
export const WALK_DIRECTORY_CAP = 20_000;

export interface ListOptions {
  /** Preset `WALK_DIRECTORY_CAP`. */
  readonly maxDirectories?: number;
}

/** Directories the walk never enters, beside every dot-directory (a fixed list). */
export const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules", "dist", "out", ".tsbuild"]);

/** Enough of git's NUL-separated listing for well past 20,000 paths of any sane length. */
const GIT_LIST_BYTES = 32 * 1024 * 1024;

/** Code-unit order, so a listing does not depend on anybody's locale. */
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface FileListing {
  readonly files: string[];
  readonly truncated: boolean;
  readonly source: "git" | "walk";
}

/** The paths of git's listing; undefined when git could not answer, which is the signal to walk. */
const gitFiles = async (root: string): Promise<{ paths: string[]; truncated: boolean } | undefined> => {
  const answer = await runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { maxBytes: GIT_LIST_BYTES });
  if (!answer.ok) return undefined;
  const pieces = answer.stdout.toString("utf8").split("\0");
  // Whole output ends with a NUL, so the last piece is empty; output cut at the cap ends mid-path, and that half is dropped.
  pieces.pop();
  return { paths: pieces.filter((piece) => piece.length > 0), truncated: answer.truncated };
};

const isSkipped = (name: string): boolean => SKIPPED_DIRECTORIES.has(name) || name.startsWith(".");

/** The walk: depth-first in name order, so the same tree always gives the same list, a cut one included. */
const walkFiles = async (root: string, limit: number, maxDirectories: number): Promise<{ paths: string[]; truncated: boolean }> => {
  const found: string[] = [];
  let truncated = false;
  let entered = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    if (entered >= maxDirectories) {
      truncated = true;
      return;
    }
    entered += 1;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const descend: { directory: string; prefix: string }[] = [];
    for (const entry of [...entries].sort((a, b) => byPath(a.name, b.name))) {
      if (truncated) return;
      if (entry.isFile()) {
        if (found.length >= limit) {
          truncated = true;
          return;
        }
        found.push(prefix + entry.name);
      } else if (entry.isDirectory() && !isSkipped(entry.name)) {
        // `isDirectory` is false for a symlink, which is how "never follow one" holds.
        descend.push({ directory: join(directory, entry.name), prefix: `${prefix}${entry.name}/` });
      }
    }
    for (const child of descend) {
      if (truncated) return;
      await visit(child.directory, child.prefix);
    }
  };
  await visit(root, "");
  return { paths: found, truncated };
};

/** The workspace's files: see the module comment. */
export const listFiles = async (root: string, options: ListOptions = {}): Promise<FileListing> => {
  const tracked = await gitFiles(root);
  if (tracked !== undefined) {
    // The index lists a conflicted path once per stage.
    const unique = [...new Set(tracked.paths)].sort(byPath);
    return { files: unique.slice(0, FILES_LIST_CAP), truncated: tracked.truncated || unique.length > FILES_LIST_CAP, source: "git" };
  }
  const walked = await walkFiles(root, FILES_LIST_CAP, options.maxDirectories ?? WALK_DIRECTORY_CAP);
  return { files: walked.paths.sort(byPath), truncated: walked.truncated, source: "walk" };
};

export interface FileRead {
  readonly path: string;
  readonly size: number;
  readonly binary: boolean;
  readonly truncated: boolean;
  readonly text: string | null;
}

/**
 * A file of the workspace: its first 2 MiB as UTF-8, or no text when a NUL
 * in its first 8 KiB says it is binary (git's test). A cut read may end mid
 * character, which decodes as one replacement character at the very end.
 */
export const readWorkspaceFile = async (root: string, requested: string): Promise<FileRead> => {
  const file = await resolveInWorkspace(root, requested);
  const info = await stat(file.absolute);
  if (!info.isFile()) {
    const message = `${file.relative || "The workspace"} is not a file.`;
    const error = invalidParams([{ code: "custom", path: ["path"], message }], message);
    throw new ContractError({ ...error, data: { ...error.data, reason: "not_a_file" } });
  }
  const handle = await open(file.absolute, "r");
  try {
    const buffer = Buffer.allocUnsafe(Math.min(FILES_READ_CAP, Math.max(info.size, 1)));
    // One read may answer less than asked; read on until the buffer is full or the file ends.
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const { bytesRead: more } = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (more === 0) break;
      bytesRead += more;
    }
    const body = buffer.subarray(0, bytesRead);
    const binary = body.subarray(0, BINARY_SNIFF_BYTES).includes(0);
    return { path: file.relative, size: info.size, binary, truncated: info.size > bytesRead, text: binary ? null : body.toString("utf8") };
  } finally {
    await handle.close();
  }
};
