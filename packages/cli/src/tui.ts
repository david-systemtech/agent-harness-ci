import { resolve } from "node:path";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { defaultDataDirectory, HARNESS_VERSION } from "@agent-harness/environment";
import { readLocalTerminalSource } from "@agent-harness/environment/terminal-source";
import type { LocalService, ServiceOutcome, TuiOptions } from "@agent-harness/tui";
import { parseOptions, UsageError } from "./args.js";
import { discoverEnvironment } from "./discover.js";
import { service, serviceInstalled, servicePort, type ServiceContext } from "./service/verbs.js";

/**
 * `tui`: the terminal UI, the second entry point of the same artefact as
 * `serve` (ADR 0004; docs/specs/tui.md, "The entry point and the platform").
 * This parses its flags and hands the terminal UI what only the CLI knows:
 * the local environment's data directory (where its grant file is), the
 * harness version, and the CLI's own `service` verbs (#113), which `y` on
 * the service-down offer runs. The `-p` and `ls` flags are not carried.
 */

export const TUI_USAGE = `${PRODUCT_NAME} tui [--environment <name or id>] [--session <id> | -c] [--cwd <path>] [--keybindings <file>] [--import-terminal-state]`;

/** The terminal UI's entry point: `runTui`, loaded only when `tui` runs, so `serve` never loads Ink and React. */
export type RunTui = (options: TuiOptions) => Promise<number>;

export interface TuiContext extends Pick<ServiceContext, "fetch" | "user" | "seams"> {
  /** Preset: the terminal UI package's `runTui`. */
  readonly runTui?: RunTui | undefined;
}

type TuiFlags = Pick<TuiOptions, "environment" | "session" | "continueLatest" | "cwd" | "keybindings" | "terminalSource">;

const nonEmpty = (flag: string, value: string | undefined): string | undefined => {
  if (value !== undefined && value.trim() === "") throw new UsageError(`${flag} takes a value; got an empty one.`);
  return value;
};

const parseTui = (args: readonly string[]): TuiFlags => {
  const values = parseOptions(args, {
    environment: { type: "string" },
    session: { type: "string" },
    continue: { type: "boolean", short: "c" },
    cwd: { type: "string" },
    keybindings: { type: "string" },
    "import-terminal-state": { type: "boolean" },
  });
  const session = nonEmpty("--session", values.session);
  if (session !== undefined && values.continue) throw new UsageError("--session and -c each name the session to open; give one.");
  const cwd = nonEmpty("--cwd", values.cwd);
  const keybindings = nonEmpty("--keybindings", values.keybindings);
  return {
    ...(values["import-terminal-state"] ? { terminalSource: readLocalTerminalSource } : {}),
    environment: nonEmpty("--environment", values.environment),
    session,
    continueLatest: values.continue ?? false,
    cwd: cwd === undefined ? undefined : resolve(cwd),
    keybindings: keybindings === undefined ? undefined : resolve(keybindings),
  };
};

/** One service verb run for the terminal UI: its output kept off the terminal UI's screen, its outcome in one line. */
const runVerb = async (args: readonly string[], context: TuiContext): Promise<ServiceOutcome> => {
  let said = "";
  let complained = "";
  const lines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
  try {
    const code = await service(args, {
      stdout: (text) => void (said += text),
      stderr: (text) => void (complained += text),
      fetch: context.fetch,
      user: context.user,
      seams: context.seams,
    });
    if (code === 0) return { ok: true, message: lines(said).join(" ") };
    return { ok: false, message: lines(complained).join(" ") || lines(said).join(" ") || `\`${PRODUCT_NAME} service ${args[0]}\` exited ${code}.` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * The local environment's service as the terminal UI drives it: `service
 * install` and `service start`, and the environment's readiness from its
 * discovery URL on the port the service was installed on.
 */
export const localService = (context: TuiContext, dataDir: string): LocalService => ({
  installed: () => serviceInstalled(context),
  install: () => runVerb(["install"], context),
  start: () => runVerb(["start"], context),
  readiness: async () => {
    const discovery = await discoverEnvironment(context.fetch, servicePort(dataDir));
    return discovery.kind === "environment" ? discovery.document.readiness : "nothing";
  },
});

/** `tui`: runs the terminal UI until it quits, and exits with its code. */
export const tui = async (args: readonly string[], context: TuiContext): Promise<number> => {
  const flags = parseTui(args);
  // The data directory `serve` and the service verbs use when given none; the service seam's install context in tests.
  const installContext = context.seams.installContext;
  const dataDir = installContext ? defaultDataDirectory(installContext) : defaultDataDirectory();
  const runTui = context.runTui ?? (await import("@agent-harness/tui")).runTui;
  return runTui({ ...flags, dataDir, version: HARNESS_VERSION, services: localService(context, dataDir) });
};
