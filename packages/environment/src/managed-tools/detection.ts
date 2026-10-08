import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { ManagedToolVersion, updateCommand, type ManagedToolInstallMethod, type ManagedToolName, type ToolCommand, type ToolCommandEntry } from "@agent-harness/contracts";

/**
 * Detecting a managed tool (key-managers spec, "Managed tools"; ADR 0026):
 * the name resolved on a PATH, its realpath, the harness's own files passed
 * over; the version its `--version` printed; and the install method its
 * path's shape says.
 */

/** Where a tool was found: the path on the PATH, and the file it resolves to. */
export interface FoundTool {
  readonly path: string;
  readonly realpath: string;
}

export interface PathLookup {
  readonly platform: NodeJS.Platform;
  /** Directories inside the harness's own files: a tool whose path or realpath is inside one is passed over. */
  readonly ownResources: readonly string[];
  /** Windows' executable extensions, in order; preset `.COM;.EXE;.BAT;.CMD`. */
  readonly pathext?: string;
  /** Whether `file` is a file this platform runs; preset: the file system's answer. */
  readonly isExecutable?: (file: string) => boolean;
}

const executableFile = (file: string): boolean => {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const realOrSelf = (file: string): string => {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
};

/**
 * The first executable `name` (a managed tool, or a program an install
 * method needs) on `pathValue`, in order: absolute entries
 * only (a relative one would resolve against the service's working
 * directory), each of Windows' executable extensions in turn there, and
 * never a path, or a realpath, inside the harness's own files. Null when
 * there is none.
 */
export const findOnPath = (name: string, pathValue: string, lookup: PathLookup): FoundTool | null => {
  const windows = lookup.platform === "win32";
  const paths = windows ? win32 : posix;
  const isExecutable = lookup.isExecutable ?? executableFile;
  const fold = (file: string): string => (windows ? file.toLowerCase() : file);
  const own = lookup.ownResources.map((directory) => fold(realOrSelf(directory)));
  const inside = (file: string): boolean => own.some((directory) => fold(file) === directory || fold(file).startsWith(`${directory}${paths.sep}`));
  const names = windows ? (lookup.pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((extension) => extension !== "").map((extension) => `${name}${extension.toLowerCase()}`) : [name];
  for (const entry of pathValue.split(windows ? ";" : ":")) {
    const directory = windows ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (directory === "" || !paths.isAbsolute(directory)) continue;
    for (const file of names) {
      const candidate = paths.join(directory, file);
      if (!isExecutable(candidate)) continue;
      const realpath = realOrSelf(candidate);
      if (inside(candidate) || inside(realpath)) continue;
      return { path: candidate, realpath };
    }
  }
  return null;
};

/** Package managers' directories, recognised in a path with its separators read as `/`, in the order they are tried. */
const SHAPES: readonly (readonly [RegExp, ManagedToolInstallMethod])[] = [
  [/\/(?:Cellar|Caskroom)\/[^/]+\/[^/]+\//i, "homebrew"],
  [/\/WinGet\/(?:Packages|Links)\//i, "winget"],
  [/\/scoop\/(?:apps|shims)\//i, "scoop"],
  [/\/mise\/(?:installs|shims)\//i, "mise"],
  [/\/\.asdf\/(?:installs|shims)\//i, "asdf"],
  // Last: a version manager's Node holds its packages' node_modules too, and updating those through npm is its to do.
  [/\/node_modules\//i, "npm"],
];

/** Claude Code's native installer keeps each version as a file in `.../claude/versions/`, which `claude` links to. */
const CLAUDE_NATIVE = /\/claude\/versions\/[^/]+$/i;

/** A shim directory of Scoop, mise or asdf, whose root (`scoop`, `mise`, `.asdf`) holds the packages' directory too. */
const SHIM = /^(.*\/(scoop|mise|\.asdf))\/shims\/[^/]+$/i;

/** The manager each shim directory's root belongs to. */
const SHIM_MANAGERS: Readonly<Record<string, ManagedToolInstallMethod>> = { scoop: "scoop", mise: "mise", ".asdf": "asdf" };

/** The manager whose shim directory `file` is in; null outside one. */
const shimManager = (file: string): ManagedToolInstallMethod | null => SHIM_MANAGERS[SHIM.exec(file.replaceAll("\\", "/"))?.[2]?.toLowerCase() ?? ""] ?? null;

/**
 * The install method a tool's place says: for `claude`, its native
 * installer's versions directory; then the manager whose shim directory its
 * path on the PATH is in, wherever the shim resolves to (#1876: mise's are
 * links to mise itself, which may be Homebrew's); then a package manager's
 * directory in its realpath, else in its path (WinGet's links). Null when
 * none says, for the package owner to answer.
 */
export const methodFromShape = (tool: ManagedToolName, found: FoundTool): ManagedToolInstallMethod | null => {
  const slashed = (file: string): string => file.replaceAll("\\", "/");
  if (tool === "claude" && CLAUDE_NATIVE.test(slashed(found.realpath))) return "native";
  const shim = shimManager(found.path);
  if (shim !== null) return shim;
  for (const file of [found.realpath, found.path]) {
    const shape = SHAPES.find(([pattern]) => pattern.test(slashed(file)));
    if (shape !== undefined) return shape[1];
  }
  return null;
};

/** The package directories of Scoop, mise and asdf, whose next part is the package a tool was installed as. */
const PACKAGE_DIRECTORY = /\/(?:scoop\/apps|mise\/installs|\.asdf\/installs)\/([^/]+)\//i;

/**
 * The package a tool's realpath is installed under by Scoop, mise or asdf
 * (`scoop/apps/<name>/`, `mise/installs/<name>/`, `.asdf/installs/<name>/`),
 * which their update names (#1833); null for any other place, a shim among
 * them (`drivenUpdate` reads a shim's package from the directories beside it).
 */
export const installedPackage = (realpath: string): string | null => PACKAGE_DIRECTORY.exec(realpath.replaceAll("\\", "/"))?.[1] ?? null;

/**
 * Places a system package manager may own a file in, read with its
 * separators as `/`: `/usr` but its `local`, `/bin`, `/sbin`, MacPorts'
 * `/opt/local`, Nix's store and snap's, anchored; cargo's and Chocolatey's
 * anywhere. Detection asks dpkg and rpm alone, so pacman's, apk's and these
 * read as manual (#1833).
 */
const SYSTEM_PLACE = [/^\/(?:usr\/(?!local\/)|bin\/|sbin\/|opt\/local\/|nix\/store\/|snap\/)/, /\/\.cargo\/bin\//, /\/chocolatey\//i];

/** Whether a tool's realpath is somewhere a system package manager may own it, so no self-update replaces it (#1833). */
export const heldBySystem = (realpath: string): boolean => {
  const slashed = realpath.replaceAll("\\", "/");
  return SYSTEM_PLACE.some((place) => place.test(slashed));
};


/**
 * Which of `own` (a tool's own package names) a shim of Scoop, mise or asdf
 * at `file` stands for: the first whose package directory exists beside the
 * shims (`scoop/apps/<name>`, `mise/installs/<name>`, `.asdf/installs/<name>`).
 * A shim does not say which package it runs (mise's is a link to mise
 * itself), so one for a tool npm installed into their Node is none (#1833).
 */
const shimPackage = (file: string, own: readonly string[]): string | null => {
  const shim = SHIM.exec(file.replaceAll("\\", "/"));
  if (shim === null) return null;
  const packages = `${shim[1]}/${shim[2]?.toLowerCase() === "scoop" ? "apps" : "installs"}`;
  return own.find((name) => existsSync(`${packages}/${name}`)) ?? null;
};

/**
 * The update `entry` runs for a tool found at `found`, else null when the
 * table must not drive it (#1833): a bare binary somewhere a system package
 * manager may own it; for Scoop, mise and asdf, a package other than the
 * tool's own (`npm i -g` into a Node they installed), read from the
 * realpath's package directory, else from the package directories beside
 * a shim, whose upgrade would update that package instead.
 */
export const drivenUpdate = (entry: ToolCommandEntry, found: FoundTool): ToolCommand | null => {
  if (entry.method === "manual") return heldBySystem(found.realpath) ? null : entry.update;
  if (entry.package === undefined) return entry.update;
  const own = [entry.package, entry.tool];
  const installedAs = installedPackage(found.realpath) ?? shimPackage(found.path, own) ?? shimPackage(found.realpath, own);
  return installedAs !== null && own.includes(installedAs) ? updateCommand(entry, installedAs) : null;
};

/** A version in a tool's `--version`, with an optional leading `v`, standing alone: not part of a longer dotted run or a word. */
const PRINTED_VERSION = /(?<![\w.])v?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?![\w.])/;

/** The first version `--version` printed, on standard output and then standard error; null when neither holds one. */
export const versionIn = (stdout: string, stderr: string): string | null => {
  for (const text of [stdout, stderr]) {
    const printed = PRINTED_VERSION.exec(text)?.[1];
    if (printed !== undefined && ManagedToolVersion.safeParse(printed).success) return printed;
  }
  return null;
};
