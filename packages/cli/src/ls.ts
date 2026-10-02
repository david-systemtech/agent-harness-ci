import { PRODUCT_NAME } from "@agent-harness/contracts";
import type { ListRequest } from "@agent-harness/tui/screenless";
import { parseOptions, UsageError } from "./args.js";
import { nonEmpty, selectEnvironment, type TuiContext } from "./tui.js";

/**
 * `ls` (docs/specs/switch-over.md, "Phase-D commands and parity"; #1181):
 * the stored sessions of the environment `tui` would show, in one
 * directory there or in every one, a row a line. This parses the flags and
 * hands the terminal UI's listing the selection, the process's streams,
 * its working directory and its platform.
 */

export const LS_USAGE = `${PRODUCT_NAME} ls [--environment <name or id>] [--cwd <path> | --all] [--json]`;

export interface LsContext extends Pick<TuiContext, "seams"> {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** The process's working directory: the directory listed on this machine's environment when `--cwd` names none. */
  readonly cwd: string;
}

interface LsFlags extends ListRequest {
  readonly environment: string | undefined;
}

const parseLs = (args: readonly string[]): LsFlags => {
  const values = parseOptions(args, {
    environment: { type: "string" },
    cwd: { type: "string" },
    all: { type: "boolean" },
    json: { type: "boolean" },
  });
  const cwd = nonEmpty("--cwd", values.cwd);
  const all = values.all ?? false;
  if (cwd !== undefined && all) throw new UsageError("--cwd and --all each say which directories to list; give one.");
  // `--cwd` stays as typed: only the listing knows whether it names a directory on this machine or on another.
  return { environment: nonEmpty("--environment", values.environment), cwd, all, json: values.json ?? false };
};

/** `ls`: lists the sessions and exits 0, 1 when the environment cannot be chosen or read, 2 on a usage error. */
export const ls = async (args: readonly string[], context: LsContext): Promise<number> => {
  const { environment, ...request } = parseLs(args);
  const { listSessions } = await import("@agent-harness/tui/screenless");
  const report = (line: string) => context.stderr(`${line}\n`);
  return listSessions(() => selectEnvironment({ environment }, { seams: context.seams, report }), request, {
    stdout: context.stdout,
    stderr: context.stderr,
    currentDirectory: context.cwd,
    platform: process.platform,
  });
};
