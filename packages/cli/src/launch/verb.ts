import type { ChildProcess } from "node:child_process";
import { openSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { DRAIN_CAP_MS } from "@agent-harness/contracts/launcher";
import { parseName, parseOptions, parsePort, UsageError } from "../args.js";
import type { ProcessContext } from "../process-context.js";
import { spawnEntryOwnerWatch, watchEntryOwner } from "./entry-owner.js";
import { claimLauncher, launcherClaimAddress, type ClaimResult, type LauncherClaim } from "./launcher-claim.js";
import { launcherLine, startLauncher, systemTimer, type LauncherTimer } from "./launcher.js";

/** The `launch` verb's usage, after the program's name. */
export const LAUNCH_USAGE = "launch --data-dir <path> [--port <n>] [--name <name>]";

/**
 * The variable the Windows launcher entry names the service log in (#1712).
 * The launcher then writes the log itself, and its child's output into it,
 * rather than cmd redirecting its output there: cmd opens a file it redirects
 * to for itself alone, so while one launcher ran, a second could not even
 * start, and nothing it tried reached the log. A launcher from before this
 * variable writes on its standard output, as before.
 */
export const SERVICE_LOG_VARIABLE = "AGENT_HARNESS_SERVICE_LOG";

/** How long a launcher waits for one that holds the data directory and is stopping: that one's drain, at its cap, and a minute to close. */
export const STOPPING_LAUNCHER_WAIT_MS = DRAIN_CAP_MS + 60_000;
/** How often a launcher waiting for a stopping one tries the claim again. */
export const CLAIM_RETRY_MS = 1_000;

/** What `launch` needs of the platform: preset by the process's, and seams for tests. */
export interface LaunchSeams {
  /** The variables `launch` reads `SERVICE_LOG_VARIABLE` from, and takes it out of, so nothing the launcher starts writes the log by name. */
  readonly env: NodeJS.ProcessEnv;
  readonly timer: LauncherTimer;
  /** Where the launchers on a data directory claim it (`launcher-claim.ts`); none where the service manager runs one instance. */
  readonly claimAddress?: ((dataDir: string) => string) | undefined;
  /** Starts the watch on the process that started the launcher entry (`entry-owner.ts`); none where the service manager stops the whole service. */
  readonly entryOwnerWatch?: (() => ChildProcess) | undefined;
}

/** On Windows, Task Scheduler's End leaves the launcher running: the launcher claims its data directory and watches its task. */
const platformSeams = (): LaunchSeams => ({
  env: process.env,
  timer: systemTimer,
  ...(process.platform === "win32" ? { claimAddress: launcherClaimAddress, entryOwnerWatch: spawnEntryOwnerWatch } : {}),
});

/**
 * Claims the data directory at `address`, waiting while a launcher that
 * holds it stops. Undefined, with the reason in the log, when a launcher that
 * holds it runs on or does not stop within the wait, or when this one is
 * asked to stop first: this launcher then starts nothing and exits 0, which
 * ends the launcher entry rather than starting it again.
 */
const claimDataDirectory = async (
  address: string,
  { log, timer, stopRequested }: { log: (text: string) => void; timer: LauncherTimer; stopRequested: Promise<unknown> },
): Promise<LauncherClaim | undefined> => {
  let asked = false;
  void stopRequested.then(() => (asked = true));
  const deadline = timer.now() + STOPPING_LAUNCHER_WAIT_MS;
  let waiting = false;
  for (;;) {
    let result: ClaimResult;
    try {
      result = await claimLauncher(address);
    } catch (error) {
      log(`cannot claim the data directory (${error instanceof Error ? error.message : String(error)}), so this launcher runs without the claim`);
      return { markStopping: () => undefined, release: async () => undefined };
    }
    if ("claimed" in result) {
      if (asked) {
        await result.claimed.release();
        return undefined;
      }
      return result.claimed;
    }
    const { pid, stopping } = result.heldBy;
    if (!stopping) {
      log(`a launcher is already running on this data directory (pid ${pid}), so this one exits and starts nothing; \`service stop\` stops that one`);
      return undefined;
    }
    if (timer.now() >= deadline) {
      log(`the launcher pid ${pid} has not stopped within ${STOPPING_LAUNCHER_WAIT_MS / 60_000} minutes, so this one exits and starts nothing`);
      return undefined;
    }
    if (!waiting) {
      log(`the launcher pid ${pid} is stopping, so this one starts once it has`);
      waiting = true;
    }
    await new Promise<void>((settle) => {
      const cancel = timer.after(CLAIM_RETRY_MS, settle);
      void stopRequested.then(() => {
        cancel();
        settle();
      });
    });
    if (asked) {
      log("stopping: asked to stop before the launcher it waited for had stopped");
      return undefined;
    }
  }
};

/**
 * `launch`: runs the launcher on the data directory until the service manager
 * stops it (SIGTERM, or SIGINT in the foreground), then drains its child and
 * exits 0, or until it hands over to a newer launcher, when it exits with the
 * relaunch code for the service manager to start the launcher entry again
 * (`RELAUNCH_EXIT_CODE`). The service's definition runs it, and it prints the service log's
 * lines on its standard output, which the definition sends to the service
 * log, or writes them to the file `SERVICE_LOG_VARIABLE` names. It needs the data directory named: its default is the environment
 * package's to say, and the launcher loads nothing of that package. `--port`
 * and `--name` are passed to each `serve` it starts; the name is the one a
 * new environment is created with, which `service install --name` gives.
 *
 * On Windows it first claims the data directory, and exits 0 at once when
 * another launcher runs on it; and it stops as the service manager's stop
 * does once the process that started its launcher entry has ended.
 */
export const launch = async (args: readonly string[], context: ProcessContext, seams: LaunchSeams = platformSeams()): Promise<number> => {
  let dataDir: string;
  let port: number | undefined;
  let name: string | undefined;
  try {
    const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" }, name: { type: "string" } });
    port = parsePort(values.port, 0);
    if (!values["data-dir"]) throw new UsageError("launch needs --data-dir <path>, the data directory whose service state names the version to run.");
    name = parseName(values.name);
    dataDir = resolve(values["data-dir"]);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    context.stderr(`${error.message}\nusage: ${LAUNCH_USAGE}\n`);
    return 2;
  }

  const logFile = seams.env[SERVICE_LOG_VARIABLE];
  delete seams.env[SERVICE_LOG_VARIABLE];
  let logFd: number | undefined;
  try {
    // Left open: the launcher writes its child's exit after it has stopped, and the process's exit closes it.
    if (logFile) logFd = openSync(logFile, "a");
  } catch (error) {
    context.stderr(`launch cannot open the service log ${logFile}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const output = logFd;
  const write = output === undefined ? context.stdout : (text: string) => void writeSync(output, text);
  const log = (text: string) => write(`${launcherLine(seams.timer.now(), text)}\n`);

  const stopRequested = context.stopRequested();
  const claim =
    seams.claimAddress === undefined ? undefined : await claimDataDirectory(seams.claimAddress(dataDir), { log, timer: seams.timer, stopRequested });
  if (seams.claimAddress !== undefined && claim === undefined) return 0;
  const launcher = startLauncher({ dataDir, port, name, log: (line) => write(`${line}\n`), output, env: seams.env });
  const watch = seams.entryOwnerWatch === undefined ? undefined : watchEntryOwner(seams.entryOwnerWatch, log);
  const stop = () => {
    claim?.markStopping();
    return launcher.stop();
  };
  void stopRequested.then(stop);
  void watch?.ended.then(stop);
  const code = await launcher.stopped;
  watch?.close();
  await claim?.release();
  return code;
};
