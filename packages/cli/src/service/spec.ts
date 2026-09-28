import { homedir, userInfo } from "node:os";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { DRAIN_CAP_MS } from "@agent-harness/contracts/launcher";
import type { PlatformContext } from "@agent-harness/environment";

/**
 * The service's launchd label, systemd unit name and scheduled task name: the
 * product's placeholder name (ADR 0017), so the rename stays one constant.
 */
export const SERVICE_LABEL = PRODUCT_NAME;

/** What a service definition is rendered from. */
export interface ServiceSpec {
  /** The environment's data directory, absolute. The service's logs go under it. */
  readonly dataDir: string;
  /** The launcher entry in the data directory, absolute: the one thing the definition runs, which starts the launcher. */
  readonly entry: string;
}

/** The folder under the data directory the service's output is written to. */
export const LOG_DIRECTORY = "logs";
/** The file in `LOG_DIRECTORY` that takes the service's stdout and stderr. */
export const LOG_FILE = "service.log";

/**
 * How long the service manager waits for the launcher to stop before it kills
 * it, where the platform has such a wait (launchd, systemd): the drain's cap
 * and a minute, so a stop lets running runs finish.
 */
export const STOP_TIMEOUT_S = (DRAIN_CAP_MS + 60_000) / 1000;

/** The shell the launchd and systemd definitions run the launcher entry with, so the entry needs no execute bit. */
export const ENTRY_SHELL = "/bin/sh";

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
