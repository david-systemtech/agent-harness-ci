import { chmodSync, constants, existsSync, mkdirSync } from "node:fs";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";
import type { PreCheckFailure } from "@agent-harness/contracts";

/**
 * The scripts directory (routines spec, "Pre-checks"; #526): where the OS
 * user places the scripts routines' pre-checks run, in the data directory
 * with mode 0700. It is not among the directories the denylist's data
 * directory entry leaves out (unlike the scratch and worktree roots), so a
 * run writes a pre-check there only when a person allows it.
 *
 * A pre-check names a script by its path relative to the directory, which
 * must stay inside it once links are followed, and name a regular file the
 * environment may run: executable, or on Windows of an executable extension
 * (`PATHEXT`'s, else the system's preset list).
 */

/** The scripts directory, from the data directory. */
export const SCRIPTS_DIRECTORY = "scripts";

/** Makes the scripts directory in `dataDir`, mode 0700 even when it was there; answers its path. */
export const prepareScriptsDirectory = (dataDir: string): string => {
  const path = join(dataDir, SCRIPTS_DIRECTORY);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
  return path;
};

/** The extensions Windows runs when `PATHEXT` names none. */
const WINDOWS_EXECUTABLE = ".COM;.EXE;.BAT;.CMD";

/** What judges whether a file may be run: the platform, and the variables a Windows `PATHEXT` is read from. */
export interface Executability {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Whether the regular file at `path` may be run: on Windows by its extension, elsewhere by the file system's execute check. */
const executable = async (path: string, { platform, env }: Executability): Promise<boolean> => {
  if (platform === "win32") {
    const extensions = (env["PATHEXT"] ?? WINDOWS_EXECUTABLE).split(";").map((extension) => extension.trim().toLowerCase());
    return extname(path) !== "" && extensions.includes(extname(path).toLowerCase());
  }
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Whether `path` is the directory `root` or inside it. */
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** A script a pre-check may run: its real path. */
export interface ResolvedScript {
  readonly path: string;
}

/** Why a script cannot run: missing, or unusable, with what a person should know. */
export interface ScriptProblem {
  readonly reason: Extract<PreCheckFailure, "script_missing" | "script_unusable">;
  readonly detail: string;
}

export interface ScriptsDirectory {
  /** The directory's absolute path. */
  readonly path: string;
  /** Its regular files that stay inside it once links are followed, by path relative to it in code-point order, each executable or not; none once it is gone. */
  list(): Promise<{ readonly path: string; readonly executable: boolean }[]>;
  /** Whether a file is at `path` in it, links followed: what the list's `script_missing` attention reads. */
  present(path: string): boolean;
  /** The script `path` names, or why it cannot run. */
  resolve(path: string): Promise<ResolvedScript | ScriptProblem>;
}

const errorCode = (error: unknown): string | undefined => (error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined);

export const scriptsDirectory = (path: string, executability: Executability): ScriptsDirectory => {
  /** The directory's real path: links in the data directory's own path followed, so a script's real path compares with it. */
  const root = async (): Promise<string> => realpath(path);

  /** The script `named` names inside `base`, the directory's real path, or why it cannot run; throws what the file system throws. */
  const resolveIn = async (base: string, named: string): Promise<ResolvedScript | ScriptProblem> => {
    const real = await realpath(join(base, named));
    if (!inside(base, real)) return { reason: "script_unusable", detail: `The script ${named} leads out of the scripts directory, to ${real}, once its links are followed.` };
    if (!(await stat(real)).isFile()) return { reason: "script_unusable", detail: `The script ${named} is not a regular file.` };
    if (!(await executable(real, executability))) {
      const why = executability.platform === "win32" ? "its extension is not one Windows runs" : "it is not executable";
      return { reason: "script_unusable", detail: `The script ${named} cannot be run: ${why}.` };
    }
    return { path: real };
  };

  /** Never rejects: nothing there is `script_missing`, anything else the file system refuses `script_unusable`. */
  const resolve = async (named: string): Promise<ResolvedScript | ScriptProblem> => {
    try {
      return await resolveIn(await root(), named);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { reason: "script_missing", detail: `No script is at ${named} in the scripts directory ${path}.` };
      return { reason: "script_unusable", detail: `The script ${named} cannot be read (${code ?? String(error)}).` };
    }
  };

  const list = async (): Promise<{ readonly path: string; readonly executable: boolean }[]> => {
    if (!existsSync(path)) return [];
    const base = await root();
    const found: { path: string; executable: boolean }[] = [];
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const full = join(folder, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        try {
          const real = await realpath(full);
          if (inside(base, real) && (await stat(real)).isFile()) found.push({ path: relative(base, full).split(sep).join("/"), executable: await executable(real, executability) });
        } catch {
          // A dangling link names no file.
        }
      }
    };
    await walk(base);
    return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  };

  return {
    path,
    list,
    present: (named) => existsSync(join(path, named)),
    resolve,
  };
};

