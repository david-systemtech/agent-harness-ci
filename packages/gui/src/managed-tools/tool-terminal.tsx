import "@xterm/xterm/css/xterm.css";
import type { ToolRunStartedPayload } from "@agent-harness/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { createPaneTerminal, type PaneTerminal, type PaneView } from "../terminal/pane-terminal.js";
import { useTerminalTheme } from "../terminal/terminal-theme.js";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/** The run a tool terminal shows: its terminal and the size the environment opened it at, the tool, Install or Update, and the command line it runs. */
export interface ShownRun extends Pick<ToolRunStartedPayload, "tool" | "action" | "command"> {
  readonly terminal: { readonly id: string; readonly cols: number; readonly rows: number };
}

const NOTHING_YET: PaneView = { command: null, ended: null, line: null };

/**
 * A tool terminal in a terminal pane, drawn in About's Managed tools
 * (key-managers spec, "Managed tools"; ADR 0026; #426): #409's xterm.js
 * view (`pane-terminal.ts`) over `terminals.subscribe`, the keys typed in it
 * sent through `terminals.write`, so a `sudo` password is typed there. It is
 * headed by what it runs and, once the command has exited, how; it stays
 * until its Close button closes the terminal (`terminals.close`), or until
 * the environment no longer holds it (closed by another client, thirty
 * minutes after its command exited, or at its stop), when it goes by
 * itself.
 */
export const ToolTerminal = ({ environmentId, run, label, close }: { readonly environmentId: string; readonly run: ShownRun; readonly label: string; readonly close: () => void }) => {
  const runtime = useRuntime();
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
      source: { kind: "tool", terminal: { id, cols, rows }, gone: () => latest.current.close() },
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
  }, [runtime, environmentId, id, cols, rows]);
  useEffect(() => terminal.current?.theme(theme), [theme]);

  const closeIt = () => {
    terminal.current?.ask({ kind: "close" });
    close();
  };
  return (
    <section aria-labelledby={heading} className="flex flex-col gap-2 rounded-md border border-line p-3">
      <header className="flex items-center gap-2">
        <h4 id={heading} className="min-w-0 flex-1 text-sm font-semibold text-ink">
          {run.action === "install" ? "Installing" : "Updating"} {label}
        </h4>
        <Button onClick={closeIt}>Close</Button>
      </header>
      <p className="truncate font-mono text-xs text-ink-muted">
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
