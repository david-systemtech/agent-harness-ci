import "@xterm/xterm/css/xterm.css";
import { AccessUnavailable } from "../connections/limited-access.js";
import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { Button, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime, useShell } from "../window-context.js";
import { createPaneTerminal, type PaneTerminal, type PaneView } from "./pane-terminal.js";
import { useTerminalPanes } from "./terminal-panes.js";
import { useTerminalTheme } from "./terminal-theme.js";
import { closePane, useSideColumn } from "../side-column/column.js";

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
  const shell = useShell();
  const panes = useTerminalPanes();
  const [, changeColumn] = useSideColumn({ environmentId, sessionId });
  const theme = useTerminalTheme();
  const environments = useObservable(runtime.projections.environments);
  const name = environments.find((view) => view.environmentId === environmentId)?.name ?? "the environment";
  const latest = useRef({ name, theme, onScreen });
  latest.current = { name, theme, onScreen };
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<PaneTerminal | null>(null);
  const [view, setView] = useState<PaneView>(NOTHING_YET);
  const [control, setControl] = useState(false);
  const [selection, setSelection] = useState("");
  const [selecting, setSelecting] = useState(false);
  const touch = useRef<{ readonly id: number; readonly x: number; readonly y: number } | null>(null);
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
      controlChanged: setControl,
      selectionChanged: setSelection,
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
  const authority = runtime.capability(environmentId, "terminals.write");
  const limited = shell === undefined && authority.status === "absent" && authority.reason === "scope";
  const draftAuthority = runtime.capability(environmentId, "sessions.setDraft");
  const unavailable = authority.status === "absent" || view.ended !== null || view.command !== null;
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
            <AccessUnavailable environmentId={environmentId} answer={authority}><p role="status" className="min-w-0 flex-1 text-xs text-ink-muted">{view.line}</p></AccessUnavailable>
          )}
          {renew && (
            <Tooltip content="New terminal · Enter / Space">
              <Button size="xs" className={phone ? "ml-auto min-h-11 min-w-11 whitespace-normal" : "ml-auto"} onClick={() => terminal.current?.ask({ kind: "shell", focus: true })}>
                <Plus aria-hidden="true" />New terminal
              </Button>
            </Tooltip>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={host} aria-label="Terminal screen" className="min-h-0 flex-1 overflow-hidden bg-wash px-2 py-1.5 max-[640px]:[&_textarea]:text-base" />
        {phone && selecting && <div aria-label="Select terminal text" className="absolute inset-0 touch-none"
          onPointerDown={event => {
            event.preventDefault();
            if (event.isTrusted) event.currentTarget.setPointerCapture(event.pointerId);
            touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
            terminal.current?.selectTouch(touch.current, touch.current);
          }}
          onPointerMove={event => {
            if (touch.current?.id === event.pointerId) terminal.current?.selectTouch(touch.current, { x: event.clientX, y: event.clientY });
          }}
          onPointerUp={event => {
            if (touch.current?.id !== event.pointerId) return;
            terminal.current?.selectTouch(touch.current, { x: event.clientX, y: event.clientY });
            touch.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { touch.current = null; }} />}
      </div>
      {phone && !limited && <div aria-label="Terminal keys" role="group" className="flex shrink-0 flex-wrap gap-1 border-t border-hairline bg-panel p-2">
        <Tooltip content="Ctrl · then type a key">
          <Button className="min-h-11 min-w-11" disabled={unavailable} aria-pressed={control} onClick={() => terminal.current?.control("ctrl")}>Ctrl</Button>
        </Tooltip>
        <Tooltip content="Escape · Esc">
          <Button className="min-h-11 min-w-11" disabled={unavailable} onClick={() => terminal.current?.control("escape")}>Esc</Button>
        </Tooltip>
        <Tooltip content="Tab · Tab">
          <Button className="min-h-11 min-w-11" disabled={unavailable} onClick={() => terminal.current?.control("tab")}>Tab</Button>
        </Tooltip>
        <Tooltip content="Select output · drag across text; turn off to scroll">
          <Button className="min-h-11 min-w-11" aria-pressed={selecting} onClick={() => setSelecting(value => !value)}>Select</Button>
        </Tooltip>
        <Tooltip content="Close the environment terminal · Enter / Space">
          <Button className="min-h-11 min-w-11" onClick={() => {
            terminal.current?.ask({ kind: "close" });
            changeColumn(held => closePane(held, "terminal"));
          }}>Close terminal</Button>
        </Tooltip>
      </div>}
      {phone && shell !== undefined && authority.status === "absent" && authority.reason === "scope" && <p className="shrink-0 px-3 py-2 text-sm text-ink-muted">
        To use this environment terminal, make a Custom pairing code with terminal scope on a trusted client, then deliberately pair again. The Phone preset does not grant terminal access.
      </p>}
      {!limited && (phone || selection.length > 0) && <div className="shrink-0 border-t border-hairline bg-panel p-2">
        <Tooltip content="Add selected output to the session draft · Enter / Space">
          <Button data-terminal-selection-action className="min-h-11 whitespace-normal" disabled={selection.length === 0 || draftAuthority.status === "absent"} title={draftAuthority.status === "absent" ? draftAuthority.message : undefined} onPointerDown={event => event.preventDefault()} onClick={() => {
            const held = runtime.projections.session(environmentId, sessionId).read().draft ?? "";
            runtime.drafts.set(environmentId, sessionId, `${held}${held.length > 0 ? "\n\n" : ""}${selection}`);
          }}>Add to session</Button>
        </Tooltip>
      </div>}
    </div>
  );
};
