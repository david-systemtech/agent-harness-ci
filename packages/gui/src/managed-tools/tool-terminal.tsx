import "@xterm/xterm/css/xterm.css";
import { DEFAULT_TERMINAL_SIZE, type ManagedToolName, type ToolRunFinishedPayload, type ToolRunStartedPayload } from "@agent-harness/contracts";
import { Terminal, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPaneTerminal, type PaneTerminal, type PaneView } from "../terminal/pane-terminal.js";
import { useTerminalTheme } from "../terminal/terminal-theme.js";
import { Button, Tooltip } from "../ui/index.js";
import { useClock, useObservable, useRuntime } from "../window-context.js";

/** The run a tool terminal shows: its terminal and the size the environment opened it at, the tool, Install or Update, and the command line it runs. */
export interface ShownRun extends Pick<ToolRunStartedPayload, "tool" | "action" | "command"> {
  readonly terminal: { readonly id: string; readonly cols: number; readonly rows: number };
}

const NOTHING_YET: PaneView = { command: null, ended: null, line: null };

/** A run the environment's stream says is under way, as a section holds it: at the size the environment opens a tool terminal at unless asked another. */
const shownFrom = (running: ToolRunStartedPayload): ShownRun => ({
  terminal: { id: running.terminalId, ...DEFAULT_TERMINAL_SIZE },
  tool: running.tool,
  action: running.action,
  command: running.command,
});

/** The tool terminal a section draws, and the tool runs the environment's stream tells of. */
export interface DrawnToolTerminal {
  /** The run drawn until its Close: one this section started, or one under way the stream told of; null for none. */
  readonly drawn: ShownRun | null;
  /** Install or Update opened a tool terminal: it is drawn. */
  readonly started: (run: ShownRun) => void;
  /** Its Close, or the environment ending its terminal: it goes, and the run under way does not bring it back. */
  readonly close: () => void;
  /** The tool's last run heard to finish. */
  readonly finishedOf: (tool: ManagedToolName) => ToolRunFinishedPayload | undefined;
}

/**
 * The tool terminal a section draws (#426, #590): the one its Install or
 * Update opened, else the run under way the environment's stream tells of
 * (from this window earlier, or another client) of a tool the section
 * `shows`, while its terminal was not closed here; held as drawn, one
 * object, past its finish until Close, so a `sudo` prompt left waiting can
 * still be answered.
 */
export const useToolTerminal = (environmentId: string, shows: (tool: ManagedToolName) => boolean): DrawnToolTerminal => {
  const runtime = useRuntime();
  const { running, finished } = useObservable(useMemo(() => runtime.projections.toolRuns(environmentId), [runtime, environmentId]));
  const [drawn, started] = useState<ShownRun | null>(null);
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const adopted = running !== null && shows(running.tool) ? running : null;
  useEffect(() => {
    if (adopted !== null && !closed.has(adopted.terminalId)) started((shown) => shown ?? shownFrom(adopted));
  }, [adopted, closed]);
  const close = () => {
    if (drawn !== null) setClosed((held) => new Set(held).add(drawn.terminal.id));
    started(null);
  };
  return { drawn, started, close, finishedOf: (tool) => (tool === "vault" ? undefined : finished[tool]) };
};

/**
 * A tool terminal in a terminal pane, drawn in About's Managed tools
 * (key-managers spec, "Managed tools"; ADR 0026; #426): #409's xterm.js
 * view (`pane-terminal.ts`) over `terminals.subscribe`, the keys typed in it
 * sent through `terminals.write`, so a `sudo` password is typed there. It is
 * headed by what it runs and, once the command has exited, how; it stays
 * until its Close button closes the terminal (`terminals.close`, whose
 * `not_found` for one the environment has closed already is not said), or
 * until the environment no longer holds it, when it goes by itself: closed
 * by another client or at its stop while the command runs, or, once it has
 * exited, found gone when the pane asks after it thirty minutes after the
 * exit on the environment's clock (#864).
 */
export const ToolTerminal = ({ environmentId, run, label, close }: { readonly environmentId: string; readonly run: ShownRun; readonly label: string; readonly close: () => void }) => {
  const runtime = useRuntime();
  const clock = useClock();
  const theme = useTerminalTheme();
  const environments = useObservable(runtime.projections.environments);
  const name = environments.find((view) => view.environmentId === environmentId)?.name ?? "the environment";
  const latest = useRef({ name, theme, close });
  latest.current = { name, theme, close };
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<PaneTerminal | null>(null);
  const [view, setView] = useState<PaneView>(NOTHING_YET);
  const heading = useId();
  // The pane is made once per terminal and size, not per drawing of `run`: a section drawn anew keeps its subscription and its focus.
  const { id, cols, rows } = run.terminal;

  useEffect(() => {
    if (host.current === null) return;
    const made = createPaneTerminal({
      runtime,
      environmentId,
      source: { kind: "tool", terminal: { id, cols, rows }, gone: () => latest.current.close(), clock },
      host: host.current,
      theme: latest.current.theme,
      onScreen: true,
      nameOf: () => latest.current.name,
      changed: setView,
    });
    terminal.current = made;
    made.start();
    return () => {
      terminal.current = null;
      made.dispose();
    };
  }, [runtime, clock, environmentId, id, cols, rows]);
  useEffect(() => terminal.current?.theme(theme), [theme]);

  const closeIt = () => {
    terminal.current?.ask({ kind: "close" });
    close();
  };
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2 rounded-lg border border-hairline p-3">
      <header className="flex items-center gap-2">
        <Terminal aria-hidden="true" className="size-4 shrink-0 text-cyan" />
        <h4 id={heading} className="min-w-0 flex-1 text-sm font-semibold text-ink">
          {run.action === "install" ? "Installing" : "Updating"} {label}
        </h4>
        <Tooltip content="Close tool terminal" keys="Enter / Space"><Button size="xs" onClick={closeIt}><X aria-hidden="true" />Close</Button></Tooltip>
      </header>
      <p title={run.command} className="break-words font-mono text-xs text-ink-muted">
        {run.command}
        {view.ended !== null && <span className="text-ink-faint"> · {view.ended}</span>}
      </p>
      <div ref={host} aria-label="Terminal screen" className="h-72 overflow-hidden bg-inset px-2 py-1" />
      {view.line !== null && (
        <p role="status" className="text-xs text-ink-muted">
          {view.line}
        </p>
      )}
    </section>
  );
};
