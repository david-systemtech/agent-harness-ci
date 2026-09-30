import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CarryOverDoesNotCarry } from "@agent-harness/contracts";
import { readTranscriptOpening } from "./session-listing.js";
import { hooksOf, mcpServerNames, objectAt, readJsonObject, rulesIn } from "./settings-file.js";

/**
 * What Carry over reads of an adopted Claude config directory beside its
 * sessions (ADR 0021; #580), read as written and never changed.
 *
 * - **Memory folders**: Claude Code keeps auto memory by repository root in
 *   `projects/<folder>/memory/`, the folder's name a lossy encoding of the
 *   path. Each memory folder holding a file is found with the path a
 *   transcript in the same project folder names, its newest first (the
 *   transcript's first lines, as the session listing reads them); none when
 *   no transcript there names one.
 * - **What does not carry**, counted: the hook commands and permission
 *   rules of the directory's `settings.json`, and the personal MCP servers
 *   of its global config (at user scope, and at local scope under each
 *   project). The global config is the directory's `.claude.json`, which
 *   the CLI reads with `CLAUDE_CONFIG_DIR` set; for the home's `.claude`,
 *   the home's `.claude.json` first, which the terminal `claude` reads with
 *   no variable set.
 */

/** A memory folder of the directory, and the working directory a transcript beside it names. */
export interface MemoryFolderFound {
  /** The project folder's name under `projects/`. */
  readonly folder: string;
  /** The memory folder: `projects/<folder>/memory`. */
  readonly path: string;
  /** The working directory the newest transcript naming one names; null when none does. */
  readonly workingDirectory: string | null;
}

/** The folder under a project folder that holds its auto memory. */
const MEMORY = "memory";

/** Whether `directory`, or a folder in it, holds a regular file; false when it is not there. */
const holdsAFile = async (directory: string): Promise<boolean> => {
  try {
    return (await readdir(directory, { recursive: true, withFileTypes: true })).some((entry) => entry.isFile());
  } catch {
    return false;
  }
};

/** The working directory the newest transcript in `project` that names one names; null when none does. */
const workingDirectoryIn = async (project: string): Promise<string | null> => {
  const names = (await readdir(project).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
  const transcripts = await Promise.all(
    names.map(async (name) => {
      const path = join(project, name);
      return { path, written: await stat(path).then((found) => (found.isFile() ? found.mtimeMs : null), () => null) };
    }),
  );
  const newestFirst = transcripts.filter((transcript) => transcript.written !== null).sort((a, b) => (b.written ?? 0) - (a.written ?? 0));
  for (const { path } of newestFirst) {
    const { workingDirectory } = await readTranscriptOpening(path);
    if (workingDirectory !== null) return workingDirectory;
  }
  return null;
};

/** The project folders of the config directory `directory`, by name, in order. */
const projectFolders = async (directory: string): Promise<string[]> =>
  (await readdir(join(directory, "projects"), { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** The memory folders of the config directory `directory` that hold a file, in the project folders' name order, each with the path a transcript beside it names. */
export const readMemoryFolders = async (directory: string): Promise<MemoryFolderFound[]> => {
  const found: MemoryFolderFound[] = [];
  for (const folder of await projectFolders(directory)) {
    const path = join(directory, "projects", folder, MEMORY);
    if (!(await holdsAFile(path))) continue;
    found.push({ folder, path, workingDirectory: await workingDirectoryIn(join(directory, "projects", folder)) });
  }
  return found;
};

/** Whether the config directory `directory` holds a memory folder with a file in it, no transcript read. */
export const holdsMemory = async (directory: string): Promise<boolean> => {
  for (const folder of await projectFolders(directory)) if (await holdsAFile(join(directory, "projects", folder, MEMORY))) return true;
  return false;
};

/** The global config the CLI reads for the config directory `directory`: see the module comment. Null when none is there. */
const globalConfigOf = async (directory: string, home: string): Promise<Record<string, unknown> | null> => {
  const candidates = resolve(directory) === resolve(home, ".claude") ? [join(home, ".claude.json"), join(directory, ".claude.json")] : [join(directory, ".claude.json")];
  for (const candidate of candidates) {
    const config = await readJsonObject(candidate);
    if (config !== null) return config;
  }
  return null;
};

/** What does not carry from the config directory `directory`, counted: see the module comment. */
export const readDoesNotCarry = async (directory: string, home: string): Promise<CarryOverDoesNotCarry> => {
  const [settings, config] = await Promise.all([readJsonObject(join(directory, "settings.json")), globalConfigOf(directory, home)]);
  const shared = settings ?? {};
  const global = config ?? {};
  const local = Object.values(objectAt(global["projects"])).reduce<number>((count, project) => count + mcpServerNames(objectAt(project)).length, 0);
  return {
    hooks: hooksOf(shared).reduce((count, event) => count + event.hooks, 0),
    mcpServers: mcpServerNames(global).length + local,
    permissionRules: rulesIn(shared, "allow") + rulesIn(shared, "ask") + rulesIn(shared, "deny"),
  };
};
