import { selectOn, type SelectionOutcome, type SelectionRequest } from "./startup/selection.js";
import { terminalPlatform } from "./startup/terminal-platform.js";
import { messageOf } from "./view.js";

export type {
  NewSessionPresets,
  SelectionOutcome,
  SelectionRefusal,
  SelectionRefusalReason,
  SessionSelection,
  TerminalSelection,
} from "./startup/selection.js";

/**
 * The terminal UI's entry without a screen (`@agent-harness/tui/screenless`,
 * #1178): what the CLI's printing and listing choose their environment
 * with. Nothing it loads draws or reads a terminal, so it runs with standard
 * input and output piped, and the CLI loads it without Ink or React.
 */

/** `agent-harness tui`'s selectors and what the CLI hands in beside them. */
export interface ScreenlessOptions extends Omit<SelectionRequest, "currentDirectory"> {
  /** The local environment's data directory, where its grant file is: the CLI's `defaultDataDirectory()`. */
  readonly dataDir: string;
  /** The harness version, sent in `auth`. */
  readonly version: string;
  /** Preset: `stateDirectory()`, which `AGENT_HARNESS_TUI_STATE_DIR` overrides. */
  readonly stateDir?: string | undefined;
  /** A fault the runtime could hand no caller (a background write that failed), in one line. */
  readonly report: (line: string) => void;
  /** Preset: the process's working directory. */
  readonly currentDirectory?: string | undefined;
}

/**
 * Chooses the environment as `agent-harness tui` would show it, on the
 * terminal's own saved connections, secret storage and local grant, and
 * hands over what a caller needs to use it; or says why not, having closed
 * what it started. The caller closes a selection when done with it.
 */
export const selectTerminalEnvironment = (options: ScreenlessOptions): Promise<SelectionOutcome> => {
  const { platform } = terminalPlatform({
    stateDir: options.stateDir,
    dataDir: options.dataDir,
    version: options.version,
    reportError: (error) => options.report(`Fault: ${messageOf(error)}`),
  });
  return selectOn(platform, {
    environment: options.environment,
    session: options.session,
    continueLatest: options.continueLatest,
    cwd: options.cwd,
    currentDirectory: options.currentDirectory ?? process.cwd(),
  });
};
