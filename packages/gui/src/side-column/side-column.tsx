import "./side-column.css";
import { AccessUnavailable } from "../connections/limited-access.js";
import { directoryOf, outsideWorkspace, typedPath } from "@agent-harness/client-runtime";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSlashCommand } from "../composer/slash-commands.js";
import { BrowserPane } from "../browser/browser-pane.js";
import { useBrowserPanes } from "../browser/browser-panes.js";
import { useGridPaneId } from "../grid/grid.js";
import { PreviewPane } from "../preview/preview-pane.js";
import type { SidePane } from "../presentation.js";
import { usePaneLine } from "../session/pane-line.js";
import { TerminalPane } from "../terminal/terminal-pane.js";
import { useTerminalPanes } from "../terminal/terminal-panes.js";
import { IconButton } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { useObservable, useRuntime } from "../window-context.js";
import { closePane, hideColumn, showPane, useSideColumn } from "./column.js";
import { DockHeader, DockRail } from "./dock-header.js";
import { DiffPane } from "./diff-pane.js";
import { DocumentsPane } from "./documents-pane.js";
import { FilesPane, WORKSPACE_TOP, type FilesPlace } from "./files-pane.js";
import { PANES, paneCapability } from "./panes.js";
import { TasksPane } from "./tasks-pane.js";

export interface SideColumnViewProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

/**
 * The side column beside a session pane (docs/specs/gui.md, "The seven panes
 * and the grid"): one of the session's open panes at a time, chosen from a
 * rail of icons, with a close for the one shown and a way to hide
 * the column. Which panes are open, the one shown and whether the column is
 * hidden are the session's presentation (`sideColumns`), so opening another
 * session in the pane shows that session's column. A pane that leaves the
 * screen (another chosen, the column hidden) stays drawn, hidden, and comes
 * back as it was; only its close button closes it. A pane whose method the
 * connection cannot call is dim in the strip, and says the capability's line
 * in its place.
 *
 * It wires the slash commands that open its panes, `/terminal`, `/files
 * [path]`, `/diff`, `/documents` (#427) and `/tasks`, for as long as the
 * session is open in the pane. The Terminal pane stays drawn while the connection cannot open a
 * terminal, keeping the one it draws, and its close button closes that
 * terminal too (#409).
 */
export const SideColumnView = ({ environmentId, sessionId }: SideColumnViewProps) => {
  const runtime = useRuntime();
  // The connections' phases: each pane's capability is asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const [column, change] = useSideColumn({ environmentId, sessionId });
  const [files, goFiles] = useState<FilesPlace>(WORKSPACE_TOP);
  const [, say] = usePaneLine();
  const terminals = useTerminalPanes();
  const browsers = useBrowserPanes();
  const paneId = useGridPaneId();
  const capabilityOf = (pane: SidePane) => paneCapability(runtime, environmentId, pane);
  const show = (pane: SidePane) => change((held) => showPane(held, pane));
  const close = (pane: SidePane) => {
    // Only the pane's close button closes its terminal: hiding it, or the column, leaves the terminal running.
    if (pane === "terminal") terminals.ask({ environmentId, sessionId }, { kind: "close" });
    if (pane === "browser" && paneId) browsers.close(paneId, { environmentId, sessionId });
    change((held) => closePane(held, pane));
  };

  useSlashCommand(
    "terminal",
    () => {
      show("terminal");
      terminals.ask({ environmentId, sessionId }, { kind: "shell", focus: true });
    },
    capabilityOf("terminal"),
  );

  useSlashCommand(
    "files",
    (argument) => {
      if (argument !== "") {
        const path = typedPath(argument, projection.summary?.workspace.path ?? "");
        if (path === null) return say(outsideWorkspace(argument));
        goFiles(path === "" ? WORKSPACE_TOP : { directory: directoryOf(path), file: path });
      }
      show("files");
    },
    capabilityOf("files"),
  );
  useSlashCommand("diff", () => show("diff"), capabilityOf("diff"));
  useSlashCommand("documents", () => show("documents"), capabilityOf("documents"));
  useSlashCommand("tasks", () => show("tasks"), capabilityOf("tasks"));

  const dockId = useId();
  const host = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLElement>(null);
  const reopen = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasVisible = useRef(false);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const owner = host.current?.parentElement;
    if (!owner) return;
    // Runs each time the session arrives in the pane: a session coming back from its hidden Activity keeps its refs, not its effects.
    let arrived = false;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const floats = (entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width) < 900;
      setNarrow(floats);
      // A sheet left open is not put back over the session it would cover (#1903): the session opens with its
      // column hidden, and the edge handle brings back the pane it showed. A wide column is restored as it was.
      if (floats && !arrived) change((held) => (held.hidden ? held : hideColumn(held, true)));
      arrived = true;
    });
    observer.observe(owner);
    return () => observer.disconnect();
  }, [change]);

  const { shown } = column;
  const hide = () => change((held) => hideColumn(held, true));
  const visibleSheet = narrow && shown !== null && !column.hidden;
  useEffect(() => {
    if (visibleSheet) return;
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && !target.closest('[role="menu"], [data-dock-reopen]') && !sheet.current?.contains(target)) opener.current = target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, [visibleSheet]);
  useLayoutEffect(() => {
    if (visibleSheet) {
      const active = document.activeElement;
      if (!wasVisible.current || !sheet.current?.contains(active) || active?.closest("[hidden]")) {
        sheet.current?.querySelector<HTMLButtonElement>('[aria-label="Close side sheet"]')?.focus();
      }
    } else if (wasVisible.current) {
      if (narrow && column.hidden && shown !== null) reopen.current?.focus();
      else if (opener.current?.isConnected) opener.current.focus();
      else host.current?.parentElement?.querySelector<HTMLElement>('[aria-label="Message"]')?.focus();
    }
    wasVisible.current = visibleSheet;
  }, [visibleSheet, narrow, column.hidden, shown]);
  return <div ref={host} className="contents">
    {shown !== null && <>
      {narrow && column.hidden && <IconButton ref={reopen} data-dock-reopen label="Show the side column" keys="Enter / Space"
        onClick={() => change((held) => hideColumn(held, false))}
        className="absolute inset-y-[6px] right-0 z-30 h-auto w-[16px] rounded-l-md border-hairline bg-panel p-0"><ChevronLeft aria-hidden="true" /></IconButton>}
      <aside ref={sheet} role={narrow ? "dialog" : undefined} aria-modal={narrow ? true : undefined} onKeyDown={(event) => {
        if (!narrow) return;
        // Match DialogContent's modal key boundary after pane-local handlers run.
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); hide(); }
        if (event.key !== "Tab" || !sheet.current?.contains(event.target as Node)) return;
        const stops = Array.from(sheet.current.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]'))
          .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[hidden]") && getComputedStyle(element).display !== "none");
        const first = stops[0], last = stops.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }} aria-label="Side column" hidden={column.hidden} data-dock-sheet={narrow ? "" : undefined}
        className={classes("flex min-w-[240px] shrink-0 border-l border-hairline bg-panel", narrow
          ? "absolute inset-y-[6px] right-[6px] z-30 w-[min(480px,85%)] rounded-lg border shadow-xl shadow-scrim/40"
          : "w-[38%] max-w-3xl")}>
        <DockRail dockId={dockId} column={column} capability={capabilityOf} show={show} close={close}
          newTerminal={() => { show("terminal"); terminals.ask({ environmentId, sessionId }, { kind: "new" }); }} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {narrow && <IconButton label="Close side sheet" keys="Enter / Space" onClick={hide}
            className="h-[24px] w-full shrink-0 rounded-none border-b border-hairline p-0"><ChevronRight aria-hidden="true" /></IconButton>}
          {column.open.map((pane) => {
            const capability = capabilityOf(pane);
            return (
              <section key={pane} id={`${dockId}-${pane}`} aria-label={PANES[pane].label} hidden={pane !== shown} className="flex min-h-0 flex-1 flex-col">
                <DockHeader pane={pane} hide={hide} close={() => close(pane)} />
                {capability.status === "absent" && !PANES[pane].drawnWhileAbsent ? (
                  <div className="px-3 py-2"><AccessUnavailable environmentId={environmentId} answer={capability}><p className="text-sm text-ink-faint">{capability.message}</p></AccessUnavailable></div>
                ) : (
                  <PaneBody
                    pane={pane}
                    environmentId={environmentId}
                    sessionId={sessionId}
                    onScreen={pane === shown && !column.hidden}
                    files={files}
                    goFiles={goFiles}
                    source={(path) => {
                      goFiles({ directory: directoryOf(path), file: path });
                      show("files");
                    }}
                  />
                )}
              </section>
            );
          })}
        </div>
      </aside>
    </>}
  </div>;
};

interface PaneBodyProps extends SideColumnViewProps {
  readonly pane: SidePane;
  /** Whether the pane is on screen: shown, in a column that is not hidden. */
  readonly onScreen: boolean;
  /** Where the Files pane is, which the column holds so `/files <path>` and a document's source move it. */
  readonly files: FilesPlace;
  goFiles(place: FilesPlace): void;
  /** Opens a file of the workspace in the Files pane's file view, and shows the pane. */
  source(path: string): void;
}

/** What one pane draws. */
const PaneBody = ({ pane, environmentId, sessionId, onScreen, files, goFiles, source }: PaneBodyProps) => {
  switch (pane) {
    case "terminal":
      return <TerminalPane environmentId={environmentId} sessionId={sessionId} onScreen={onScreen} />;
    case "files":
      return <FilesPane environmentId={environmentId} sessionId={sessionId} place={files} go={goFiles} />;
    case "diff":
      return <DiffPane environmentId={environmentId} sessionId={sessionId} onScreen={onScreen} />;
    case "documents":
      return <DocumentsPane environmentId={environmentId} sessionId={sessionId} source={source} />;
    case "tasks":
      return <TasksPane environmentId={environmentId} sessionId={sessionId} />;
    case "browser":
      return <BrowserPane environmentId={environmentId} sessionId={sessionId} onScreen={onScreen} />;
    case "preview":
      return <PreviewPane environmentId={environmentId} sessionId={sessionId} source={source} />;
  }
};
