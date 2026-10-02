import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { MODES, PRODUCT_NAME, type Mode } from "@agent-harness/contracts";
import { defaultDataDirectory, HARNESS_VERSION } from "@agent-harness/environment";
import { readLocalTerminalSource } from "@agent-harness/environment/terminal-source";
import type { LocalService, ServiceOutcome, TuiOptions } from "@agent-harness/tui";
import type { PrintFormat, PrintRequest, ScreenlessOptions, SelectionOutcome } from "@agent-harness/tui/screenless";
import { parseOptions, UsageError } from "./args.js";
import { discoverEnvironment } from "./discover.js";
import type { ProcessContext } from "./process-context.js";
import { service, serviceInstalled, servicePort, type ServiceContext } from "./service/verbs.js";

/**
 * `tui`: the terminal UI, the second entry point of the same artefact as
 * `serve` (ADR 0004; docs/specs/tui.md, "The entry point and the platform").
 * This parses its flags and hands the terminal UI what only the CLI knows:
 * the local environment's data directory (where its grant file is), the
 * harness version, and the CLI's own `service` verbs (#113), which `y` on
 * the service-down offer runs. With `-p` it draws nothing: it prints one
 * answer through the terminal UI's screenless entry (#1180).
 */

export const TUI_USAGE = `${PRODUCT_NAME} tui [--environment <name or id>] [--session <id> | -c] [--cwd <path>] [[--keybindings <file>] [--import-terminal-state] | -p <prompt> [--model <id>] [--mode <mode>] [--effort <level>] [--output-format text|json|stream-json]]`;

/** The terminal UI's entry point: `runTui`, loaded only when `tui` runs, so `serve` never loads Ink and React. */
export type RunTui = (options: TuiOptions) => Promise<number>;

export interface TuiContext extends Pick<ServiceContext, "fetch" | "user" | "seams">, ProcessContext {
  /** Preset: the terminal UI package's `runTui`. */
  readonly runTui?: RunTui | undefined;
}

/** The formats `--output-format` takes, every one of the screenless entry's: the CLI loads that entry only to print. */
const PRINT_FORMATS = Object.keys({ text: true, json: true, "stream-json": true } satisfies Record<PrintFormat, true>);

type TuiFlags = Pick<TuiOptions, "environment" | "session" | "continueLatest" | "cwd" | "keybindings" | "terminalSource"> & {
  /** `-p` and what goes with it: what to print, and how. */
  readonly print: PrintRequest | undefined;
};

const nonEmpty = (flag: string, value: string | undefined): string | undefined => {
  if (value !== undefined && value.trim() === "") throw new UsageError(`${flag} takes a value; got an empty one.`);
  return value;
};

const isFormat = (value: string | undefined): value is PrintFormat => PRINT_FORMATS.includes(value ?? "");
const isMode = (value: string): value is Mode => MODES.some((mode) => mode === value);

const TUI_OPTIONS = {
  environment: { type: "string" },
  session: { type: "string" },
  continue: { type: "boolean", short: "c" },
  cwd: { type: "string" },
  keybindings: { type: "string" },
  "import-terminal-state": { type: "boolean" },
  print: { type: "string", short: "p" },
  model: { type: "string" },
  mode: { type: "string" },
  effort: { type: "string" },
  "output-format": { type: "string" },
} as const;

/** `-p`'s flags, judged once the rest parsed: a prompt with something in it, a known mode and format, and no flag of the screen's. */
const parsePrint = (values: ReturnType<typeof parseOptions<typeof TUI_OPTIONS>>, session: string | undefined): PrintRequest | undefined => {
  const prompt = values.print;
  const format = values["output-format"];
  if (prompt === undefined) {
    if ([values.model, values.mode, values.effort, format].some((value) => value !== undefined)) {
      throw new UsageError("--model, --mode, --effort and --output-format go with -p.");
    }
    return undefined;
  }
  if (prompt.trim() === "") throw new UsageError("-p takes the prompt; got an empty one.");
  if (format !== undefined && !isFormat(format)) throw new UsageError(`--output-format takes ${PRINT_FORMATS.join(", ").replace(/, (?=[^,]*$)/, " or ")}; got ${format}.`);
  const mode = values.mode;
  if (mode !== undefined && !isMode(mode)) throw new UsageError(`--mode takes ${MODES.join(", ").replace(/, (?=[^,]*$)/, " or ")}; got ${mode}.`);
  const screenFlag = values.keybindings !== undefined ? "--keybindings" : values["import-terminal-state"] === true ? "--import-terminal-state" : undefined;
  if (screenFlag !== undefined) throw new UsageError(`${screenFlag} is the screen's; -p draws none.`);
  if (session !== undefined && values.cwd !== undefined) {
    throw new UsageError("--cwd names a new session's directory, or the one -c looks in; --session continues a session in its own.");
  }
  return { prompt, format: format ?? "text", model: nonEmpty("--model", values.model), mode, effort: nonEmpty("--effort", values.effort) };
};

const parseTui = (args: readonly string[]): TuiFlags => {
  const values = parseOptions(args, TUI_OPTIONS);
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
    print: parsePrint(values, session),
  };
};

/**
 * The JSON format a print asked for, read leniently: a print refused for
 * its arguments still ends with its one result in a format that has one
 * (docs/specs/switch-over.md L101). Undefined for text, or no print.
 */
const resultFormatIn = (args: readonly string[]): PrintFormat | undefined => {
  try {
    const { values } = parseArgs({ args: [...args], options: TUI_OPTIONS, strict: false, allowPositionals: true });
    const format = values["output-format"];
    return values.print !== undefined && typeof format === "string" && isFormat(format) && format !== "text" ? format : undefined;
  } catch {
    return undefined;
  }
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

/** The data directory `serve` and the service verbs use when given none, where the local environment's grant file is; the service seam's install context in tests. */
const localDataDirectory = (context: Pick<TuiContext, "seams">): string => {
  const installContext = context.seams.installContext;
  return installContext ? defaultDataDirectory(installContext) : defaultDataDirectory();
};

/** `tui -p`: one answer printed on the environment `tui` would show, with no screen; exits as the print does. */
const print = async (request: PrintRequest, flags: TuiFlags, context: TuiContext): Promise<number> => {
  const { printAnswer } = await import("@agent-harness/tui/screenless");
  const selection = { environment: flags.environment, session: flags.session, continueLatest: flags.continueLatest, cwd: flags.cwd };
  return printAnswer(() => selectEnvironment(selection, { seams: context.seams, report: (line) => context.stderr(`${line}\n`) }), request, {
    stdout: context.stdout,
    stderr: context.stderr,
    interrupted: context.stopRequested(),
    outputClosed: context.outputClosed?.() ?? new Promise(() => undefined),
    fetch: context.fetch,
  });
};

/** `tui`: runs the terminal UI until it quits, and exits with its code; with `-p`, prints one answer. */
export const tui = async (args: readonly string[], context: TuiContext): Promise<number> => {
  let flags: TuiFlags;
  try {
    flags = parseTui(args);
  } catch (error) {
    const format = error instanceof UsageError ? resultFormatIn(args) : undefined;
    if (format !== undefined) {
      const { refusedResult } = await import("@agent-harness/tui/screenless");
      context.stdout(`${JSON.stringify(refusedResult(error instanceof Error ? error.message : String(error)))}\n`);
    }
    throw error;
  }
  if (flags.print !== undefined) return print(flags.print, flags, context);
  const dataDir = localDataDirectory(context);
  const runTui = context.runTui ?? (await import("@agent-harness/tui")).runTui;
  return runTui({ ...flags, dataDir, version: HARNESS_VERSION, services: localService(context, dataDir) });
};

/** The selectors `tui` takes that name an environment, a session and a directory. */
export type SelectionFlags = Pick<ScreenlessOptions, "environment" | "session" | "continueLatest" | "cwd">;

/**
 * The environment `tui` would show, chosen without a screen for a verb that
 * prints rather than draws (docs/specs/switch-over.md, "Phase-D commands
 * and parity": `tui -p` and `ls`; #1178): the terminal UI's screenless
 * entry, loaded alone so neither Ink nor React is, on the data directory
 * and version `tui` hands over. It needs no terminal; a fault the runtime
 * can hand no caller goes to `report`, and the caller closes the selection
 * it is handed.
 */
export const selectEnvironment = async (
  flags: SelectionFlags,
  context: Pick<TuiContext, "seams"> & { readonly report: (line: string) => void },
): Promise<SelectionOutcome> => {
  const { selectTerminalEnvironment } = await import("@agent-harness/tui/screenless");
  return selectTerminalEnvironment({ ...flags, dataDir: localDataDirectory(context), version: HARNESS_VERSION, report: context.report });
};
