import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
import { createPaneTerminal, type PaneTerminal, type PaneView } from "./pane-terminal.js";
import { useTerminalPanes } from "./terminal-panes.js";
import { useTerminalTheme } from "./terminal-theme.js";

export interface TerminalPaneProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** Whether the pane is on screen: shown, in a column not hidden. */
  readonly onScreen: boolean;
}

const NOTHING_YET: PaneView = { command: null, ended: null, line: null };

/**
 * The Terminal pane in a session's side column (docs/specs/gui.md, "The
 * seven panes and the grid"; #409): xterm.js drawing an environment-owned
 * terminal (`pane-terminal.ts`), in the theme's tokens (`terminal-theme.ts`),
 * styled under the window's content policy (`xterm-styles.ts`). A `!`
 * command's terminal is headed by its command and, once it has ended, how;
 * a shell that ended, or one that could not be opened, has a new terminal a
 * button away. The pane hears what the window asks of it for as long as it
 * is drawn (`terminal-panes.tsx`).
 */
export const TerminalPane = ({ environmentId, sessionId, onScreen }: TerminalPaneProps) => {
  const runtime = useRuntime();
  const panes = useTerminalPanes();
  const theme = useTerminalTheme();
  const environments = useObservable(runtime.projections.environments);
  const name = environments.find((view) => view.environmentId === environmentId)?.name ?? "the environment";
  const latest = useRef({ name, theme, onScreen });
  latest.current = { name, theme, onScreen };
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<PaneTerminal | null>(null);
  const [view, setView] = useState<PaneView>(NOTHING_YET);

  useEffect(() => {
    if (host.current === null) return;
    const made = createPaneTerminal({
      runtime,
      environmentId,
      source: { kind: "session", sessionId, oneOffs: panes.oneOffs },
      host: host.current,
      theme: latest.current.theme,
      onScreen: latest.current.onScreen,
      nameOf: () => latest.current.name,
      changed: setView,
    });
    terminal.current = made;
    const stopHearing = panes.hear({ environmentId, sessionId }, (ask) => made.ask(ask));
    made.start();
    return () => {
      stopHearing();
      terminal.current = null;
      made.dispose();
    };
  }, [runtime, panes, environmentId, sessionId]);
  useEffect(() => terminal.current?.theme(theme), [theme]);
  useEffect(() => terminal.current?.onScreen(onScreen), [onScreen]);

  const renew = view.command === null && view.ended !== null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {view.command !== null && (
        <p className="shrink-0 truncate border-b border-hairline px-3 py-1 font-mono text-xs text-ink-muted">
          !{view.command}
          {view.ended !== null && <span className="text-ink-faint"> · {view.ended}</span>}
        </p>
      )}
      {(view.line !== null || renew) && (
        <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
          {view.line !== null && (
            <p role="status" className="min-w-0 flex-1 text-xs text-ink-muted">
              {view.line}
            </p>
          )}
          {renew && (
            <Tooltip content="New terminal · Enter / Space">
              <Button size="xs" className="ml-auto" onClick={() => terminal.current?.ask({ kind: "shell", focus: true })}>
                <Plus aria-hidden="true" />New terminal
              </Button>
            </Tooltip>
          )}
        </div>
      )}
      <div ref={host} aria-label="Terminal screen" className="min-h-0 flex-1 overflow-hidden bg-wash px-2 py-1.5" />
    </div>
  );
};
