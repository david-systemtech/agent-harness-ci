import { posix, win32, type PlatformPath } from "node:path";

/**
 * How `ls` compares a session's workspace with the directory listed
 * (docs/specs/switch-over.md, "Listing": normalised absolute workspace
 * paths on the environment): by the rules of the machine the environment
 * runs on, which write a path from `/`, a drive or a share, and which may
 * tell two spellings in different case apart or not. The environment
 * records a directory resolved but with its links unfollowed
 * (`workspace/resolver.ts`), so nothing here reads the disk.
 */

/** How one machine writes and compares a directory. */
export interface DirectoryRules {
  readonly path: PlatformPath;
  /** Two spellings in different case are one directory, as the machine's file systems have it by default. */
  readonly caseFolds: boolean;
}

const WINDOWS: DirectoryRules = { path: win32, caseFolds: true };
const MACOS: DirectoryRules = { path: posix, caseFolds: true };
const POSIX: DirectoryRules = { path: posix, caseFolds: false };

/** The rules of the machine the command runs on, its own environment's: case folds on macOS and Windows, as the environment's resolver has it. */
export const machineRules = (platform: NodeJS.Platform): DirectoryRules => (platform === "win32" ? WINDOWS : platform === "darwin" ? MACOS : POSIX);

/**
 * The rules an absolute path's own form shows, for another machine's
 * environment: a drive or a share is Windows's; a path from `/` is POSIX's,
 * its case kept, since nothing says that machine folds it. Undefined for a
 * path that is not absolute in either form.
 */
export const rulesOf = (path: string): DirectoryRules | undefined => (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? WINDOWS : path.startsWith("/") ? POSIX : undefined);

/** A directory as `rules` compare it: normalised, with no separator after its last name, its case folded where the machine folds it. */
const keyOf = (rules: DirectoryRules, directory: string): string => {
  const normal = rules.path.normalize(directory);
  const { root } = rules.path.parse(normal);
  // Normalising leaves at most one separator at the end, and a root keeps its own.
  const trimmed = normal.length > root.length && normal.endsWith(rules.path.sep) ? normal.slice(0, -1) : normal;
  return rules.caseFolds ? trimmed.toLowerCase() : trimmed;
};

/** Whether a workspace's path is `directory`, an absolute path, both compared by `rules`. */
export const isDirectory = (rules: DirectoryRules, directory: string): ((path: string) => boolean) => {
  const key = keyOf(rules, directory);
  return (path) => keyOf(rules, path) === key;
};
