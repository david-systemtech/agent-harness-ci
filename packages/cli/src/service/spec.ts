import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import type { PlatformContext } from "@agent-harness/environment";

/**
 * The service's launchd label, systemd unit name and scheduled task name: the
 * product's placeholder name (ADR 0017), so the rename stays one constant.
 */
export const SERVICE_LABEL = PRODUCT_NAME;

/** What a service definition is rendered from. */
export interface ServiceSpec {
  /**
   * The absolute command line that runs the `agent-harness` binary, before its
   * verb: node and the CLI's entry, or the executable alone (`resolveProgram`).
   */
  readonly program: readonly string[];
  /** The environment's data directory, absolute. The service's logs go under it. */
  readonly dataDir: string;
  /** The loopback port `serve` listens on. */
  readonly port: number;
}

/** The folder under the data directory the service's output is written to, where the platform can redirect it. */
export const LOG_DIRECTORY = "logs";
/** The file in `LOG_DIRECTORY` that takes the service's stdout and stderr. */
export const LOG_FILE = "service.log";

/** The command line the service runs: `serve` on the spec's data directory and port. */
export const serveArguments = (spec: ServiceSpec): string[] => [
  ...spec.program,
  "serve",
  "--data-dir",
  spec.dataDir,
  "--port",
  String(spec.port),
];

/** The machine and user a service is installed for; the running process's own unless a test says otherwise. */
export interface InstallContext extends PlatformContext {
  /** The POSIX user id, which names the launchd domain; undefined on Windows. */
  readonly uid: number | undefined;
  /** The login name, for `loginctl` and the Windows task's principal. */
  readonly username: string;
}

export const currentInstallContext = (): InstallContext => ({
  platform: process.platform,
  env: process.env,
  homedir: homedir(),
  uid: process.getuid?.(),
  username: userInfo().username,
});

/** The parts of the running process `resolveProgram` reads. */
export interface RunningProgram {
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
}

/**
 * The command line that runs this CLI, for a service to run later: node's
 * absolute path, node's own flags (so a CLI run from source with `--import
 * tsx` installs a service that runs from source; the shipped bin has none),
 * and the real path of the entry script, so a symlinked bin names the files it
 * points at. When the artefact is a single executable, node reports the
 * executable as the script too, and the executable alone is the program.
 */
export const resolveProgram = (
  running: RunningProgram = process,
  realpath: (path: string) => string = realpathSync,
): string[] => {
  const entry = running.argv[1];
  if (entry === undefined || entry === running.execPath) return [running.execPath];
  return [running.execPath, ...running.execArgv, realpath(entry)];
};
