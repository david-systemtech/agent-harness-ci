import { execFileSync } from "node:child_process";
import { win32 } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";

/**
 * Whether the process runs with privileges an environment must never have.
 * A check that cannot tell throws, and the environment refuses as if it were.
 */
export interface UserCheck {
  isPrivileged(): boolean;
}

/**
 * The one sentence `serve` prints when it refuses. No flag, environment
 * variable or container marker changes the refusal (ADR 0006; the permissions
 * spec's "Never root").
 */
export const ROOT_REFUSAL = `${PRODUCT_NAME} does not run as root or with an elevated Windows token; start it as your own user.`;

/** The refusal, still one sentence, with a clause saying why the check could not tell when it could not. */
export const rootRefusal = (uncheckedBecause?: string): string =>
  uncheckedBecause === undefined
    ? ROOT_REFUSAL
    : `${ROOT_REFUSAL.slice(0, -1)} (the check could not run, so it refuses: ${uncheckedBecause.replace(/\.$/, "")}).`;

/** Starting as root, or elevated on Windows, or unchecked, was refused before anything was created or opened. */
export class RootRefusedError extends Error {
  constructor(uncheckedBecause?: string, options?: ErrorOptions) {
    super(rootRefusal(uncheckedBecause), options);
    this.name = "RootRefusedError";
  }
}

/** The privilege check could not run or could not read its answer. */
export class PrivilegeCheckError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PrivilegeCheckError";
  }
}

/**
 * Refuses a privileged user, or one the check cannot clear: throws
 * `RootRefusedError`, with the reason when the check itself failed.
 */
export const refusePrivilegedUser = (user: UserCheck): void => {
  let privileged: boolean;
  try {
    privileged = user.isPrivileged();
  } catch (error) {
    throw new RootRefusedError(error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (privileged) throw new RootRefusedError();
};

/** What the check reads of the running process; tests pass their own. */
export interface ProcessIdentity {
  readonly platform: NodeJS.Platform;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly geteuid?: (() => number) | undefined;
  readonly getuid?: (() => number) | undefined;
  /** Runs a program by absolute path and returns its standard output; throws when it cannot. */
  readonly run?: (file: string, args: readonly string[]) => string;
}

/** The mandatory level a High token (an administrator's elevated token) carries; System is above it. */
const HIGH_MANDATORY_LEVEL = 12288;

/** The mandatory level in `whoami /groups` output (`S-1-16-<level>`), or undefined when it names none. */
export const mandatoryLevel = (whoamiGroupsOutput: string): number | undefined => {
  const match = /(?<![\w-])S-1-16-(\d+)(?![\w-])/.exec(whoamiGroupsOutput);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const runProgram = (file: string, args: readonly string[]): string =>
  execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });

const currentProcess = (): ProcessIdentity => ({
  platform: process.platform,
  env: process.env,
  geteuid: process.geteuid?.bind(process),
  getuid: process.getuid?.bind(process),
  run: runProgram,
});

/** `whoami.exe` in System32 by absolute path, so nothing on PATH can stand in for it. */
const whoamiPath = (env: Readonly<Record<string, string | undefined>>): string =>
  win32.join(env["SystemRoot"] || env["SYSTEMROOT"] || "C:\\Windows", "System32", "whoami.exe");

/**
 * The check `serve` uses. On Linux and macOS: the effective uid is 0, or the
 * real uid is, since a process whose real uid is root can take root back. On
 * Windows: the token's mandatory level is High or above, read from System32's
 * `whoami.exe /groups`. It fails closed: a `whoami` that cannot run, or output
 * with no mandatory level, throws, and the environment refuses.
 */
export const processUserCheck = (identity: ProcessIdentity = currentProcess()): UserCheck => ({
  isPrivileged: () => {
    if (identity.platform !== "win32") {
      if (!identity.geteuid && !identity.getuid) {
        throw new PrivilegeCheckError("the process exposes neither geteuid nor getuid, so the user cannot be told");
      }
      return identity.geteuid?.() === 0 || identity.getuid?.() === 0;
    }
    const whoami = whoamiPath(identity.env ?? {});
    let output: string;
    try {
      output = (identity.run ?? runProgram)(whoami, ["/groups"]);
    } catch (error) {
      throw new PrivilegeCheckError(`${whoami} could not run: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    const level = mandatoryLevel(output);
    if (level === undefined) throw new PrivilegeCheckError(`${whoami} /groups named no mandatory level`);
    return level >= HIGH_MANDATORY_LEVEL;
  },
});
