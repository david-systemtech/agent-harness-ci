import { resolve } from "node:path";
import { parseOptions, parsePort, UsageError } from "../args.js";
import type { ProcessContext } from "../process-context.js";
import { startLauncher } from "./launcher.js";

/** The `launch` verb's usage, after the program's name. */
export const LAUNCH_USAGE = "launch --data-dir <path> [--port <n>]";

/**
 * `launch`: runs the launcher on the data directory until the service manager
 * stops it (SIGTERM, or SIGINT in the foreground), then drains its child and
 * exits 0. The service's definition runs it, and it prints the service log's
 * lines on its standard output, which the definition sends to the service
 * log. It needs the data directory named: its default is the environment
 * package's to say, and the launcher loads nothing of that package.
 */
export const launch = async (args: readonly string[], context: ProcessContext): Promise<number> => {
  let dataDir: string;
  let port: number | undefined;
  try {
    const values = parseOptions(args, { "data-dir": { type: "string" }, port: { type: "string" } });
    port = parsePort(values.port, 0);
    if (!values["data-dir"]) throw new UsageError("launch needs --data-dir <path>, the data directory whose service state names the version to run.");
    dataDir = resolve(values["data-dir"]);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    context.stderr(`${error.message}\nusage: ${LAUNCH_USAGE}\n`);
    return 2;
  }
  const launcher = startLauncher({ dataDir, port, log: (line) => context.stdout(`${line}\n`) });
  void context.stopRequested().then(() => launcher.stop());
  await launcher.stopped;
  return 0;
};
