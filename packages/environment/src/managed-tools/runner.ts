import { homedir } from "node:os";
import {
  DEFAULT_TERMINAL_SIZE,
  ENVIRONMENT_STREAM_KIND,
  MANAGED_TOOL_COMMANDS,
  TOOL_COMMAND_PLATFORMS,
  VerifiableToolName,
  documentedChoice,
  documentedCommand,
  installChoice,
  installedInstead,
  toolCommandEntry,
  toolCommandMethodOf,
  type InstallableToolName,
  type ManagedToolName,
  type ManagedToolRow,
  type ManagedToolVerification,
  type RunnableToolAction,
  type TerminalExitedPayload,
  type ToolCommand,
  type ToolCommandEntry,
  type ToolCommandMethod,
  type ToolCommandPlatform,
  type ToolDoctorReport,
  type ToolRunFinishedPayload,
  type ToolRunStartedPayload,
} from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { CommandRejection, PreparedCommand } from "../serve/methods.js";
import type { ToolTerminals } from "../terminals/service.js";
import { commandLine, confirmedLine } from "./command-line.js";
import { drivenUpdate, heldBySystem } from "./detection.js";
import type { ToolDoctor } from "./doctor.js";
import { MANAGED_TOOLS_ACTOR, type ManagedTools } from "./registry.js";
import type { ToolVerifier } from "./verify.js";

/**
 * Install and Update in a tool terminal (key-managers spec, "Managed
 * tools"; ADR 0026; #376): `tools.run` runs the closed command table's
 * command for a tool, in a tool terminal (#362) through the user's login
 * shell, where a person watches it and types a `sudo` password.
 *
 * - **Which command.** Install takes the first method, in the order
 *   Homebrew, WinGet, the vendor's apt or dnf repository, the vendor's
 *   script, whose every program is on the PATH the last probe read; `vault`
 *   is never installed, and its row's Install installs `bao`. Update takes
 *   the method the row detected (claude's native installer is its script),
 *   and on `claude` runs its `doctor` first, whose report the answer sets
 *   beside the detected method, which the run uses (ADR 0026: the realpath's
 *   shape is trusted over what doctor reports); Scoop, mise and asdf name
 *   the package the realpath is installed under where it is the tool's own
 *   (`drivenUpdate`). Run in a terminal pane,
 *   and Update of a tool installed by a method the table cannot drive here,
 *   run the vendor's documented command (`documentedChoice`) held back
 *   until a person presses Enter in the tool terminal (#1833). Anything
 *   else (no method available here, no command for the tool on this
 *   platform, `vault`'s Update) is `tool_not_runnable`, answering the
 *   vendor's documented command where there is one.
 * - **One at a time.** Package managers lock, so one run per environment
 *   runs at a time; another is `conflict` `tool_run_in_progress` until the
 *   one under way has finished, even one the row would refuse, since the
 *   run may change the row.
 * - **Its record.** `tool.run-started` is appended with the command, in the
 *   command's transaction, by the client session that ran it; the terminal
 *   opens once that has committed. When the command exits the registry
 *   probes again at once, reading the PATH anew (a changed row appends
 *   `tools.updated`), the tool's verify command runs, and
 *   `tool.run-finished` is appended with the exit code and the
 *   verification. A run the environment's stop cuts short is recorded
 *   finished at the stop, closed, with nothing verified.
 */

export interface ToolRunnerOptions {
  /** The Managed tools registry: the rows, the programs on the PATH, the environment a tool runs in, and the probe after a run. */
  readonly tools: Pick<ManagedTools, "row" | "commandEnvironment" | "programsOnPath" | "probeNow">;
  readonly toolTerminals: Pick<ToolTerminals, "refusal" | "openRecorded">;
  /** `claude doctor`, which Update on claude runs first. */
  readonly doctor: Pick<ToolDoctor, "detail">;
  /** The verify command a finished run runs. */
  readonly verifier: Pick<ToolVerifier, "verify">;
  readonly log: EventLog;
  readonly clock: Clock;
  readonly environmentId: string;
  /** The closed command table. Preset: the contracts' (`MANAGED_TOOL_COMMANDS`); tests give one whose installer is a fake. */
  readonly commands?: readonly ToolCommandEntry[];
  /** Preset: this process's. */
  readonly platform?: NodeJS.Platform;
}

export interface ToolRunner {
  /** `tools.run`, a prepared command: its `prepare` reads the row and the PATH, and runs `claude doctor` for Update on claude. */
  readonly run: PreparedCommand<"tools.run">;
  /** Records a run under way as finished, closed, before the environment stops. */
  close(): void;
}

/** What `tools.run` was asked to run, as its `prepare` found it: the command to run, or why not. */
type Plan =
  | {
      readonly kind: "run";
      readonly tool: InstallableToolName;
      readonly method: ToolCommandMethod;
      readonly command: string;
      readonly doctor: ToolDoctorReport | null;
      /** Put over the tool terminal's clean base: the PATH the probe resolved the tools on. */
      readonly env: Readonly<Record<string, string>>;
      readonly cwd: string;
    }
  | { readonly kind: "refused"; readonly message: string; readonly command: string | null };

/** The run under way: the tool, what was asked, and its terminal. */
interface Running {
  readonly tool: InstallableToolName;
  readonly action: RunnableToolAction;
  readonly method: ToolCommandMethod;
  readonly terminalId: string;
  /** How its command exited, once it has. */
  exit?: TerminalExitedPayload;
}

/** How an install method reads in a sentence. */
const METHOD_WORDS: Readonly<Record<NonNullable<ManagedToolRow["method"]>, string>> = {
  homebrew: "by Homebrew",
  winget: "by WinGet",
  scoop: "by Scoop",
  mise: "by mise",
  asdf: "by asdf",
  npm: "by npm",
  native: "by its native installer",
  apt: "by apt",
  dnf: "by dnf",
  manual: "by hand",
  unknown: "in a way that could not be told",
};

export const createToolRunner = (options: ToolRunnerOptions): ToolRunner => {
  const { tools, toolTerminals, log, clock } = options;
  const commands = options.commands ?? MANAGED_TOOL_COMMANDS;
  const platform = options.platform ?? process.platform;
  /** The table's platform this environment is; null for one it has no commands for. */
  const tablePlatform = (TOOL_COMMAND_PLATFORMS as readonly string[]).includes(platform) ? (platform as ToolCommandPlatform) : null;
  const stream = { kind: ENVIRONMENT_STREAM_KIND, id: options.environmentId };
  let running: Running | null = null;
  let closed = false;

  const line = (command: ToolCommand): string => commandLine(command, platform);

  /** The programs every install method of the table needs, found on the PATH now. */
  const availability = async (): Promise<(program: string) => boolean> => {
    const found = await tools.programsOnPath([...new Set(commands.flatMap((entry) => entry.needs))]);
    return (program) => found.has(program);
  };

  /** The vendor's documented command for `tool` at `realpath`, which a refusal answers for a person to copy (`documentedCommand`); null where the table has none here. */
  const documented = (tool: ManagedToolName, realpath: string | null, available: (program: string) => boolean): string | null => {
    const command = tablePlatform === null ? null : documentedCommand(tool, realpath !== null && !heldBySystem(realpath), tablePlatform, available, commands);
    return command === null ? null : line(command);
  };

  /**
   * The entry and command that `action` of `tool` (the tool installed or
   * updated), whose row is `row`, runs here, and whether it waits for Enter
   * first; else why not, in a sentence.
   */
  const choose = (
    tool: InstallableToolName,
    action: RunnableToolAction,
    row: ManagedToolRow,
    available: (program: string) => boolean,
  ): { readonly entry: ToolCommandEntry; readonly command: ToolCommand; readonly confirmed: boolean } | string => {
    if (action === "install") {
      if (row.status !== "not-installed") return `${tool} is installed already, ${METHOD_WORDS[row.method ?? "unknown"]}: its row's action is ${row.action}.`;
      const entry = tablePlatform === null ? null : installChoice(tool, tablePlatform, available, commands);
      if (entry === null || entry.install === null) return `No way to install ${tool} is available on this environment: run the vendor's command yourself.`;
      return { entry, command: entry.install, confirmed: false };
    }
    if (row.status === "not-installed" || row.method === null || row.path === null || row.realpath === null) return `${tool} is not installed on this environment: Install it.`;
    if (tablePlatform === null) return `The harness has no commands for ${platform}: update ${tool} the way it was installed.`;
    const method = action === "update" ? toolCommandMethodOf(row.method) : null;
    const entry = method === null ? null : toolCommandEntry(tool, method, tablePlatform, commands);
    const command = entry === null ? null : drivenUpdate(entry, { path: row.path, realpath: row.realpath });
    if (entry !== null && command !== null) return { entry, command, confirmed: false };
    // Installed in a way the table does not drive here, or Run in a terminal pane asked: the vendor's command, once a person presses Enter,
    // never a self-update over a file a system package manager may own.
    const documented = documentedChoice(tool, !heldBySystem(row.realpath), tablePlatform, available, commands);
    return documented === null ? `The harness has no command for ${tool} installed ${METHOD_WORDS[row.method]} here: update it the way it was installed.` : { ...documented, confirmed: true };
  };

  /** What `tools.run` of `tool`'s `action` runs here, read from its row, the PATH and the table. */
  const plan = async (tool: ManagedToolName, action: RunnableToolAction): Promise<Plan> => {
    const target = action === "install" ? installedInstead(tool) : tool;
    const [row, available] = await Promise.all([tools.row(target), availability()]);
    const refused = (message: string): Plan => ({ kind: "refused", message, command: documented(target, row.status === "not-installed" ? null : row.realpath, available) });
    if (target === "vault") return refused("The harness never installs or updates vault, which is under the Business Source License: Install bao instead.");
    const chosen = choose(target, action, row, available);
    if (typeof chosen === "string") return refused(chosen);
    // Update on claude asks its doctor first, to set what it reports beside the method the row detected (#374).
    const doctor = target === "claude" && action === "update" ? (await options.doctor.detail("claude")).doctor : null;
    const { PATH: path, HOME: home, USERPROFILE: profile } = await tools.commandEnvironment();
    return {
      kind: "run",
      tool: target,
      method: chosen.entry.method,
      command: chosen.confirmed ? confirmedLine(chosen.command, platform) : line(chosen.command),
      doctor,
      env: path === undefined ? {} : { PATH: path },
      cwd: home ?? profile ?? homedir(),
    };
  };

  /** Appends `tool.run-finished`; a failed append is said, and the run is over all the same. */
  const recordFinished = (run: Running, exit: TerminalExitedPayload | undefined, verification: ManagedToolVerification | null): void => {
    const payload: ToolRunFinishedPayload = {
      tool: run.tool,
      action: run.action,
      method: run.method,
      terminalId: run.terminalId,
      exitCode: exit?.exitCode ?? null,
      signal: exit?.signal ?? null,
      cause: exit === undefined || exit.cause === "deleted" ? "closed" : exit.cause,
      verification,
    };
    try {
      log.append(stream, [{ type: "tool.run-finished", payload }], { actor: MANAGED_TOOLS_ACTOR });
    } catch (error) {
      console.error(`Recording the end of the ${run.tool} run in terminal ${run.terminalId} failed:`, error);
    }
  };

  /** Once the command has exited: the probe, reading the PATH anew, the verify command, and the record. */
  const finish = async (run: Running, exit: TerminalExitedPayload): Promise<void> => {
    run.exit = exit;
    let verification: ManagedToolVerification | null = null;
    try {
      await tools.probeNow();
      const verifiable = VerifiableToolName.safeParse(run.tool);
      if (verifiable.success && !closed) verification = await options.verifier.verify(verifiable.data);
    } catch (error) {
      console.error(`Probing and verifying ${run.tool} after its run failed; the run is recorded without a verification:`, error);
    }
    if (closed || running !== run) return;
    recordFinished(run, exit, verification);
    running = null;
  };

  /** Opens the tool terminal and follows its command to its end: after the run's start has committed. */
  const begin = (run: Running, planned: Extract<Plan, { kind: "run" }>, size: { cols: number; rows: number }, openedAt: string): void => {
    running = run;
    let exited: Promise<TerminalExitedPayload>;
    try {
      exited = toolTerminals.openRecorded({ id: run.terminalId, command: planned.command, cwd: planned.cwd, cols: size.cols, rows: size.rows, env: planned.env, openedAt }).exited;
    } catch (error) {
      console.error(`The tool terminal ${run.terminalId} for the ${run.tool} run could not open:`, error);
      exited = Promise.resolve({ exitCode: -1, signal: null, cause: "failed" });
    }
    void exited.then((exit) => finish(run, exit));
  };

  const run: PreparedCommand<"tools.run"> = {
    prepare: async (asked) => {
      const planned = await plan(asked.tool, asked.action);
      return (params, context) => {
        const terminalId = params.id.toLowerCase();
        // The run under way wins over a refusal: the plan read the row before it, and the run may change it.
        if (running !== null) {
          const underWay: CommandRejection<"conflict"> = {
            code: "conflict",
            message: `A ${running.tool} ${running.action} is running on this environment; package managers lock, so one tool run runs at a time.`,
            data: { reason: "tool_run_in_progress", tool: running.tool, terminalId: running.terminalId },
          };
          return { aggregate: stream, rejected: underWay };
        }
        if (planned.kind === "refused") {
          return { aggregate: stream, rejected: { code: "tool_not_runnable", message: planned.message, data: { tool: params.tool, action: params.action, command: planned.command } } };
        }
        const refused = toolTerminals.refusal(terminalId);
        if (refused !== undefined) return { aggregate: stream, rejected: refused };
        const size = { cols: params.cols ?? DEFAULT_TERMINAL_SIZE.cols, rows: params.rows ?? DEFAULT_TERMINAL_SIZE.rows };
        const openedAt = clock.now().toISOString();
        const started: ToolRunStartedPayload = { tool: planned.tool, action: params.action, method: planned.method, terminalId, command: planned.command };
        context.tx.afterCommit(() => begin({ tool: planned.tool, action: params.action, method: planned.method, terminalId }, planned, size, openedAt));
        return {
          aggregate: stream,
          result: {
            terminal: { id: terminalId, owner: "managed-tools", sessionId: null, openedAt, cols: size.cols, rows: size.rows, exitCode: null, signal: null },
            tool: planned.tool,
            action: params.action,
            method: planned.method,
            command: planned.command,
            doctor: planned.doctor,
          },
          events: [{ type: "tool.run-started", payload: started }],
        };
      };
    },
  };

  return {
    run,
    close() {
      if (closed) return;
      closed = true;
      if (running !== null) recordFinished(running, running.exit, null);
      running = null;
    },
  };
};
