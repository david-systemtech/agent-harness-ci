import {
  ManagedToolRow,
  ToolRunFinishedPayload,
  ToolRunStartedPayload,
  ToolsUpdatedPayload,
  VerifiableToolName,
  installedInstead,
  managedTool,
  toolCommandMethodOf,
  type InstallableToolName,
  type ManagedToolName,
  type ManagedToolVerification,
  type RunnableToolAction,
  type TerminalExitCause,
  type TerminalInfo,
  type ToolCommandMethod,
  type ToolDoctorReport,
} from "@agent-harness/contracts";
import type { FakeAnswer, FakeWire } from "./fake-wire.js";
import type { ManualClock } from "./in-memory-platform.js";

/**
 * The scripted environment's Managed tools (key-managers spec, "Managed
 * tools" and "Wire methods"; ADR 0026; #426): the rows `tools.list`
 * answers, `tools.verify` and `tools.detail` as the script says, and
 * `tools.run`, which opens a tool terminal whose command the script plays.
 * The command can ask for a `sudo` password, which a write ending in a
 * carriage return answers (a wrong one is asked again), then prints and
 * exits; once it has exited the tool's row changes as the script says,
 * appending `tools.updated` as the probe after a run does, and
 * `tool.run-finished` records the verification; the environment keeps its
 * terminal `TOOL_TERMINAL_KEPT_MS` on its clock, then closes it, telling no
 * one (`scripted-environment.ts`, #864). One run at a time, as the
 * environment's runner holds it: another is `conflict` reason
 * `tool_run_in_progress` until the one under way has finished. A Copy row's
 * Update, `vault`'s, and a run the script refuses are `tool_not_runnable`
 * with the vendor's command.
 */

/** How a tool's run goes, by the tool it installs or updates. */
export interface ScriptedToolRun {
  /** The method and command line its answer names: preset Homebrew's, `brew install <tool>` or `brew upgrade <tool>`. */
  readonly method?: ToolCommandMethod;
  readonly command?: string;
  /** The password its `sudo` asks for before the command goes on: preset none asked. */
  readonly password?: string;
  /** What the command prints once it goes on: preset nothing. */
  readonly output?: string;
  /** How it exits once it has printed: preset 0; null runs on until the test exits its terminal. */
  readonly exitCode?: number | null;
  /** The tool's row as the probe after a run that exited 0 finds it, over its row before: preset unchanged. */
  readonly after?: Partial<ManagedToolRow>;
  /** Refused `tool_not_runnable` with this message and command, as where no method installs it here. */
  readonly refused?: { readonly message: string; readonly command: string | null };
}

export interface ScriptedManagedTools {
  /** What `tools.verify` answers, and the verification after a run, by tool: preset passed, "<tool> works.". */
  readonly verifications?: Partial<Readonly<Record<VerifiableToolName, Pick<ManagedToolVerification, "outcome" | "reason">>>>;
  /** What `claude doctor` says (`tools.detail`, and Update on claude): preset read, reporting the row's method and no warning. */
  readonly doctor?: ToolDoctorReport;
  /** How each tool's run goes, by the tool named in `tools.run` (vault's Install is bao's run). */
  readonly runs?: Partial<Readonly<Record<InstallableToolName, ScriptedToolRun>>>;
}

/** A scripted row: its tool, and the fields that differ from a tool installed by apt at 2.1.1, current. */
export type ScriptedToolRow = Partial<ManagedToolRow> & Pick<ManagedToolRow, "tool">;

/** What the tool terminal tells the module of its terminal: a write, and the end. */
export interface ToolTerminalHooks {
  typed(data: string): void;
  ended(exit: { readonly exitCode: number; readonly signal: number | null; readonly cause: TerminalExitCause }): void;
}

export interface ToolsHost {
  readonly wire: FakeWire;
  readonly clock: ManualClock;
  /** The rows `tools.list` answers, each over a tool installed by apt at 2.1.1 (the key managers' script's `tools`). */
  readonly rows: readonly ScriptedToolRow[] | undefined;
  readonly script: ScriptedManagedTools | undefined;
  notice(type: string, payload: Record<string, unknown>): void;
  head(): number;
  next(): number;
  refusal(method: string): FakeAnswer | undefined;
  /** Opens a tool terminal with the id, owned by the registry; undefined when the id was used on the environment already. */
  openToolTerminal(id: string, size: { readonly cols?: number | undefined; readonly rows?: number | undefined }, hooks: ToolTerminalHooks): TerminalInfo | undefined;
  /** The terminal's command prints `data`. */
  output(id: string, data: string): void;
  /** The terminal's command exits with `exitCode`. */
  exit(id: string, exitCode: number): void;
}

export interface ScriptedToolsHandle {
  /** The rows as the environment holds them now. */
  toolRows(): readonly ManagedToolRow[];
  /** A probe finds the tool's row changed: the fields given replace its own, and `tools.updated` carries it. */
  changeTool(tool: ManagedToolName, fields: Partial<ManagedToolRow>): void;
}

/** The prompt `sudo` prints, for the scripted home's user. */
export const SUDO_PROMPT = "[sudo] password for milo: ";

/** A row the script gives, over a tool installed by apt at 2.1.1. */
const rowOf = (row: ScriptedToolRow): ManagedToolRow =>
  ManagedToolRow.parse({
    label: managedTool(row.tool).label,
    path: `/usr/bin/${row.tool}`,
    realpath: `/usr/bin/${row.tool}`,
    version: "2.1.1",
    latest: null,
    minimum: "2.1.1",
    method: "apt",
    status: "current",
    action: "update",
    command: null,
    ...row,
  });

export const scriptedTools = (host: ToolsHost): ScriptedToolsHandle => {
  const { wire, clock } = host;
  const script = host.script ?? {};
  const rows = (host.rows ?? []).map(rowOf);
  /** The run under way: the tool, what was asked, its method and its terminal. */
  let running: { readonly tool: InstallableToolName; readonly action: RunnableToolAction; readonly method: ToolCommandMethod; readonly terminalId: string } | null = null;

  const rejected = (code: string, message: string, data: Record<string, unknown>): FakeAnswer => ({
    result: { receipt: { status: "rejected", sequence: host.next(), changed: false, reason: code, error: { code, message, data } } },
  });
  const notRunnable = (tool: ManagedToolName, action: RunnableToolAction, message: string, command: string | null): FakeAnswer =>
    rejected("tool_not_runnable", message, { tool, action, command });
  const verification = (tool: VerifiableToolName): ManagedToolVerification => ({ tool, outcome: "passed", reason: `${tool} works.`, ...script.verifications?.[tool] });
  const doctor = (): ToolDoctorReport => script.doctor ?? { outcome: "read", method: rows.find((row) => row.tool === "claude")?.method ?? null, fields: [], warnings: [] };

  /** A probe found `row`: it replaces the one held, and `tools.updated` carries it when it changed. */
  const probed = (row: ManagedToolRow) => {
    const at = rows.findIndex((held) => held.tool === row.tool);
    if (at !== -1 && JSON.stringify(rows[at]) === JSON.stringify(row)) return;
    if (at === -1) rows.push(row);
    else rows[at] = row;
    host.notice("tools.updated", ToolsUpdatedPayload.parse({ tools: [row] }));
  };

  wire.answer("tools.list", () => ({ result: { tools: [...rows], probedAt: clock.now().toISOString() } }));
  wire.answer("tools.verify", (params) => {
    const tool = VerifiableToolName.parse(params["tool"]);
    return { result: verification(tool) };
  });
  wire.answer("tools.detail", () => {
    const row = rows.find((held) => held.tool === "claude") ?? rowOf({ tool: "claude", minimum: null, method: "native" });
    return { result: { tool: "claude", row, doctor: doctor() } };
  });

  wire.answer("tools.run", (params) => {
    const refused = host.refusal("tools.run");
    if (refused) return refused;
    const asked = params["tool"] as ManagedToolName;
    const action = params["action"] as RunnableToolAction;
    if (running !== null) {
      const message = `A ${running.tool} ${running.action} is running on this environment; package managers lock, so one tool run runs at a time.`;
      return rejected("conflict", message, { reason: "tool_run_in_progress", tool: running.tool, terminalId: running.terminalId });
    }
    const tool = action === "install" ? installedInstead(asked) : asked;
    if (tool === "vault") return notRunnable(asked, action, "The harness never installs or updates vault, which is under the Business Source License: Install bao instead.", null);
    const row = rows.find((held) => held.tool === tool) ?? rowOf({ tool });
    const run = script.runs?.[tool] ?? {};
    if (run.refused !== undefined) return notRunnable(asked, action, run.refused.message, run.refused.command);
    if (action !== "install" && row.action === "copy") return notRunnable(asked, action, `The harness does not update ${tool} installed that way: run the vendor's command yourself.`, row.command);
    // Run in a terminal pane runs the row's command, held back until Enter (#1833).
    if (action === "terminal" && row.command === null) return notRunnable(asked, action, `The harness has no command for ${tool} here: update it the way it was installed.`, null);
    const method = run.method ?? (action === "update" && row.method !== null ? (toolCommandMethodOf(row.method) ?? "homebrew") : "homebrew");
    const command = run.command ?? (action === "terminal" && row.command !== null ? row.command : `brew ${action === "install" ? "install" : "upgrade"} ${tool}`);
    const terminalId = String(params["id"]).toLowerCase();
    let typed = "";
    /** The command goes on past `sudo`: it prints, then exits as the script says. */
    const goOn = () => {
      if (run.output !== undefined) host.output(terminalId, run.output);
      const exitCode = run.exitCode === undefined ? 0 : run.exitCode;
      if (exitCode !== null) host.exit(terminalId, exitCode);
    };
    const terminal = host.openToolTerminal(terminalId, { cols: params["cols"] as number | undefined, rows: params["rows"] as number | undefined }, {
      typed(data) {
        if (run.password === undefined) return;
        typed += data;
        const end = typed.indexOf("\r");
        if (end === -1) return;
        const password = typed.slice(0, end);
        typed = typed.slice(end + 1);
        host.output(terminalId, "\r\n");
        if (password === run.password) goOn();
        else host.output(terminalId, `Sorry, try again.\r\n${SUDO_PROMPT}`);
      },
      ended(exit) {
        const finished = running;
        if (finished === null || finished.terminalId !== terminalId) return;
        if (exit.cause === "exited" && exit.exitCode === 0 && run.after !== undefined) probed(ManagedToolRow.parse({ ...row, ...run.after }));
        const verified = VerifiableToolName.safeParse(tool);
        const payload = ToolRunFinishedPayload.parse({
          ...finished,
          exitCode: exit.cause === "closed" ? null : exit.exitCode,
          signal: exit.signal,
          cause: exit.cause === "deleted" ? "closed" : exit.cause,
          verification: verified.success && exit.cause !== "closed" ? verification(verified.data) : null,
        });
        running = null;
        host.notice("tool.run-finished", payload);
      },
    });
    if (terminal === undefined) return rejected("conflict", `A terminal ${terminalId} was opened on this environment already.`, { reason: "exists" });
    running = { tool, action, method, terminalId };
    host.notice("tool.run-started", ToolRunStartedPayload.parse({ ...running, command }));
    // The command starts a moment after the terminal opens: `sudo`'s prompt, or straight on.
    void Promise.resolve().then(() => {
      host.output(terminalId, `$ ${command}\r\n`);
      if (run.password === undefined) goOn();
      else host.output(terminalId, SUDO_PROMPT);
    });
    const doctorSaid = tool === "claude" && action === "update" ? doctor() : null;
    return { result: { receipt: { status: "accepted", sequence: host.head(), changed: true }, result: { terminal, tool, action, method, command, doctor: doctorSaid } } };
  });

  return {
    toolRows: () => [...rows],
    changeTool(tool, fields) {
      const row = rows.find((held) => held.tool === tool) ?? rowOf({ tool });
      probed(ManagedToolRow.parse({ ...row, ...fields }));
    },
  };
};
