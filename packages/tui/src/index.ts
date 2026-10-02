import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { PROTOCOL_VERSION, createRuntime, writable } from "@agent-harness/client-runtime";
import { PRODUCT_NAME } from "@agent-harness/contracts";
import { App, mountApp, type InkRender } from "./app.js";
import { terminalChrome } from "./attention/chrome.js";
import { keybindingsFor } from "./keys.js";
import { systemClock } from "./platform/node-platform.js";
import type { LocalService } from "./platform/services.js";
import { presentationFile } from "./presentation.js";
import { createRuntimeHost } from "./runtime-host.js";
import { terminalPlatform } from "./startup/terminal-platform.js";
import { colourDepth } from "./theme/colours.js";
import { askGround } from "./theme/ground.js";
import { messageOf, type Fault } from "./view.js";

export type { LocalService, ServiceOutcome } from "./platform/services.js";

/** The protocol version the terminal UI speaks: the client runtime's. */
export const TUI_PROTOCOL_VERSION: number = PROTOCOL_VERSION;

/** `agent-harness tui`'s flags and what the CLI hands in beside them. */
export interface TuiOptions {
  /** `--environment <name or id>`. */
  readonly environment?: string | undefined;
  /** `--session <id>`. */
  readonly session?: string | undefined;
  /** `-c`: the newest session whose workspace is the current directory, on the local environment. */
  readonly continueLatest?: boolean | undefined;
  /** `--cwd <path>`: a new session's workspace; preset the current directory. */
  readonly cwd?: string | undefined;
  /** `--keybindings <file>`; preset `keybindings.json` in the state directory, when there is one. */
  readonly keybindings?: string | undefined;
  /** The local environment's data directory, where its grant file is: the CLI's `defaultDataDirectory()`. */
  readonly dataDir: string;
  /** The harness version, sent in `auth`. */
  readonly version: string;
  /** The CLI's service verbs. */
  readonly services: LocalService;
  /** Preset: `stateDirectory()`, which `AGENT_HARNESS_TUI_STATE_DIR` overrides. */
  readonly stateDir?: string;
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /** Ink's `render`, unless a test hands in another. */
  readonly render?: InkRender;
  /** The variables the colour depth is read from (`COLORTERM`, `AGENT_HARNESS_TUI_BACKGROUND`); preset the process's. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * `agent-harness tui` (docs/specs/tui.md): the client runtime on the
 * terminal's platform, rendered by Ink until Ctrl+C quits. Resolves to the
 * exit code.
 */
export const runTui = async (options: TuiOptions): Promise<number> => {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (!stdin.isTTY || !stdout.isTTY) {
    stderr.write(`${PRODUCT_NAME} tui needs a terminal: its standard input and output must be one.\n`);
    return 1;
  }
  // Truecolour from COLORTERM, and under it the ground: the setting's, else the terminal's answer, asked before Ink reads the keys.
  const depth = await colourDepth(options.env ?? process.env, () => askGround({ stdin, stdout }));
  const faults = writable<readonly Fault[]>([]);
  // On the system clock the platform is built with, the one notices carry, so the activity line can tell which is newer;
  // read from the clock itself, so a report never depends on the platform binding being initialised.
  const report = (message: string) => faults.update((list) => [...list, { message, at: systemClock.now().toISOString() }].slice(-20));
  const { stateDir, platform } = terminalPlatform({
    stateDir: options.stateDir,
    dataDir: options.dataDir,
    version: options.version,
    reportError: (error) => report(`Fault: ${messageOf(error)}`),
  });
  const keybindings = keybindingsFor(options, stateDir);
  const host = createRuntimeHost(() => createRuntime(platform));
  const app = createElement(App, {
    host,
    clock: platform.clock,
    services: options.services,
    grant: platform.grant,
    keymap: keybindings.launch.keymap,
    keybindings: { path: keybindings.path, reload: keybindings.reload },
    flags: {
      environment: options.environment,
      session: options.session,
      continueLatest: options.continueLatest,
      workspace: options.cwd ?? process.cwd(),
    },
    notes: keybindings.launch.problems,
    faults,
    newCommandId: randomUUID,
    newSessionId: randomUUID,
    version: options.version,
    stateDir,
    cwd: process.cwd(),
    // The title and the bell on this terminal, `AGENT_HARNESS_TUI_NO_TITLE` and `AGENT_HARNESS_TUI_NOTIFY` honoured.
    chrome: terminalChrome({ stdout, env: process.env }),
    // The rail's folds, kept in the state directory (`presentation.json`).
    presentation: presentationFile(stateDir, (error) => report(`Fault: ${messageOf(error)}`)),
    depth,
  });
  const instance = mountApp(app, { stdin, stdout, stderr }, options.render);
  void host.start().catch((error: unknown) => report(`The runtime did not start: ${messageOf(error)}`));
  try {
    await instance.waitUntilExit();
  } finally {
    await host.close();
  }
  return 0;
};
