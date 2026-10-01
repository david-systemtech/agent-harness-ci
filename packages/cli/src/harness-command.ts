import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { VERSIONS_DIRECTORY } from "./launch/versions.js";
import { scriptKind } from "./service/entry.js";
import { SHIM_DIRECTORY, SHIM_FILES, shimReads } from "./service/shim.js";

/** The parts of the running process `resolveProgram` reads. */
export interface RunningProgram {
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
}

/**
 * The command line that runs this CLI: node's absolute path, node's own
 * flags (so a CLI run from source with `--import tsx` names itself from
 * source; the shipped bin has none), and the real path of the entry script,
 * so a symlinked bin names the files it points at. When the artefact is a
 * single executable, node reports the executable as the script too, and the
 * executable alone is the program.
 */
export const resolveProgram = (running: RunningProgram = process, realpath: (path: string) => string = realpathSync): string[] => {
  const entry = running.argv[1];
  if (entry === undefined || entry === running.execPath) return [running.execPath];
  return [running.execPath, ...running.execArgv, realpath(entry)];
};

/** What `harnessCommand` reads beyond its arguments; each has a preset, the running process's. */
export interface HarnessCommandSeams {
  readonly platform?: NodeJS.Platform;
  /** Whether a file is there. Preset: the file system's. */
  readonly exists?: (path: string) => boolean;
  /** The command line this process runs as. Preset: `resolveProgram`. */
  readonly program?: () => string[];
}

/** The `agent-harness` command `serve` gives the environment, and the paths it reads as it runs beyond its own words. */
export interface HarnessCommand {
  readonly command: string[];
  readonly reads: string[];
}

/**
 * The command line `serve` gives the environment as the `agent-harness`
 * binary, which git runs, with `git-credential`, as its credential helper
 * (#314). Under a launcher it is the shim in the data directory's `bin`
 * folder (#338, #459): one path through every update, where a version's own
 * files go when the launcher prunes it while a provider process started from
 * it still runs; it reads the service state and the versions directory,
 * which a contained run's sandbox must let it read (#705). A `serve` in the
 * foreground names the command line it runs as, and nothing it reads. Under
 * a launcher with no shim (one started by hand), that same command reads
 * the versions directory so Node can load the CLI and its dependencies
 * beyond the command's own directories (#1080).
 */
export const harnessCommand = (dataDir: string, underLauncher: boolean, seams: HarnessCommandSeams = {}): HarnessCommand => {
  const shim = join(dataDir, SHIM_DIRECTORY, SHIM_FILES[scriptKind(seams.platform ?? process.platform)]);
  return underLauncher && (seams.exists ?? existsSync)(shim)
    ? { command: [shim], reads: shimReads(dataDir) }
    : { command: (seams.program ?? resolveProgram)(), reads: underLauncher ? [join(dataDir, VERSIONS_DIRECTORY)] : [] };
};
