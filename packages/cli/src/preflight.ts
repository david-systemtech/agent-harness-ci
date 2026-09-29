import { PRODUCT_NAME } from "@agent-harness/contracts";
import { preflight as runPreflight, type PreflightSeams } from "@agent-harness/environment";
import { parseOptions } from "./args.js";

/** The `preflight` verb's usage, after the program's name. */
export const PREFLIGHT_USAGE = "preflight";

export interface PreflightContext {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly seams: PreflightSeams;
}

/**
 * `preflight` (launcher-update spec, "Preflight"): whether this build can
 * run on this machine, which the launcher asks of a staged version before it
 * installs it. It loads SQLite, `node-pty` and the bundled Claude binary's
 * `--version`; then it prints its report, one JSON document on one line, and
 * exits 0, or names each that failed on its standard error, printing no
 * report, and exits 1. It touches no data directory.
 */
export const preflight = async (args: readonly string[], context: PreflightContext): Promise<number> => {
  parseOptions(args, {});
  const answer = await runPreflight(context.seams);
  if ("report" in answer) {
    context.stdout(`${JSON.stringify(answer.report)}\n`);
    return 0;
  }
  for (const { check, message } of answer.failures) context.stderr(`${PRODUCT_NAME} preflight failed: ${check}: ${message}\n`);
  return 1;
};
