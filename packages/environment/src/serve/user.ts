import { execFileSync } from "node:child_process";
import { PRODUCT_NAME } from "@agent-harness/contracts";

/** Whether the process runs with privileges an environment must never have. */
export interface UserCheck {
  isPrivileged(): boolean;
}

/**
 * The one sentence `serve` prints when it refuses. No flag, environment
 * variable or container marker changes the refusal (ADR 0006; the permissions
 * spec's "Never root").
 */
export const ROOT_REFUSAL = `${PRODUCT_NAME} does not run as root or with an elevated Windows token; start it as your own user.`;

/** Starting as root, or elevated on Windows, was refused before anything was created or opened. */
export class RootRefusedError extends Error {
  constructor() {
    super(ROOT_REFUSAL);
    this.name = "RootRefusedError";
  }
}

/** What the check reads of the running process; tests pass their own. */
export interface ProcessIdentity {
  readonly platform: NodeJS.Platform;
  readonly geteuid?: (() => number) | undefined;
  readonly getuid?: (() => number) | undefined;
  /** The output of `whoami /groups`, on Windows. */
  readonly whoamiGroups?: (() => string) | undefined;
}

/** The mandatory-level SIDs of an elevated token: High (an administrator's elevated token) and System. */
const ELEVATED_LEVELS = /(?<![\w-])S-1-16-(?:12288|16384)(?![\w-])/;

/** Whether `whoami /groups` output shows a High or System mandatory level. */
export const isElevatedToken = (whoamiGroupsOutput: string): boolean => ELEVATED_LEVELS.test(whoamiGroupsOutput);

const runWhoamiGroups = (): string =>
  execFileSync("whoami", ["/groups"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });

const currentProcess = (): ProcessIdentity => ({
  platform: process.platform,
  geteuid: process.geteuid?.bind(process),
  getuid: process.getuid?.bind(process),
  whoamiGroups: runWhoamiGroups,
});

/**
 * The check `serve` uses. On Linux and macOS: the effective uid is 0, or the
 * real uid is, since a process whose real uid is root can take root back. On
 * Windows: the token's mandatory level is High or System, read from `whoami
 * /groups`; a `whoami` that cannot run counts as not privileged rather than
 * refusing every start on a machine without it.
 */
export const processUserCheck = (identity: ProcessIdentity = currentProcess()): UserCheck => ({
  isPrivileged: () => {
    if (identity.platform === "win32") {
      try {
        return isElevatedToken(identity.whoamiGroups?.() ?? "");
      } catch {
        return false;
      }
    }
    return identity.geteuid?.() === 0 || identity.getuid?.() === 0;
  },
});
