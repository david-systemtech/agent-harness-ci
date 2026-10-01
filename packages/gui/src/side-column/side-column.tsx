import { directoryOf, outsideWorkspace, typedPath } from "@agent-harness/client-runtime";
import { useMemo, useState } from "react";
import { useSlashCommand } from "../composer/slash-commands.js";
import { BrowserPane } from "../browser/browser-pane.js";
import { useBrowserPanes } from "../browser/browser-panes.js";
import { useGridPaneId } from "../grid/grid.js";
import { PreviewPane } from "../preview/preview-pane.js";
import type { SidePane } from "../presentation.js";
import { usePaneLine } from "../session/pane-line.js";
import { TerminalPane } from "../terminal/terminal-pane.js";
import { useTerminalPanes } from "../terminal/terminal-panes.js";
import { Button, Tooltip } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { useObservable, useRuntime } from "../window-context.js";
import { closePane, hideColumn, showPane, useSideColumn } from "./column.js";
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
 * strip of their names, with a close for the one shown and a way to hide
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

  const { shown } = column;
  if (shown === null) return null;
  return (
    <aside aria-label="Side column" hidden={column.hidden} className="flex w-[38%] max-w-3xl min-w-72 shrink-0 flex-col border-l border-line bg-inset">
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <nav aria-label="Open panes" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {column.open.map((pane) => {
            const capability = capabilityOf(pane);
            const name = (
              <Button
                key={pane}
                aria-pressed={pane === shown}
                aria-disabled={capability.status === "absent" ? true : undefined}
                className={classes("h-7 px-2 text-xs", pane === shown && "bg-wash", capability.status === "absent" && "text-ink-faint")}
                onClick={() => show(pane)}
              >
                {PANES[pane].label}
              </Button>
            );
            return capability.status === "absent" ? (
              <Tooltip key={pane} content={capability.message}>
                {name}
              </Tooltip>
            ) : (
              name
            );
          })}
        </nav>
        <Button aria-label={`Close ${PANES[shown].label}`} className="h-7 w-7 px-0 text-sm text-ink-muted" onClick={() => close(shown)}>
          ×
        </Button>
        <Button aria-label="Hide the side column" className="h-7 w-7 px-0 text-sm text-ink-muted" onClick={() => change((held) => hideColumn(held, true))}>
          »
        </Button>
      </div>
      {column.open.map((pane) => {
        const capability = capabilityOf(pane);
        return (
          <section key={pane} aria-label={PANES[pane].label} hidden={pane !== shown} className="flex min-h-0 flex-1 flex-col">
            {capability.status === "absent" && !PANES[pane].drawnWhileAbsent ? (
              <p className="px-3 py-2 text-sm text-ink-faint">{capability.message}</p>
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
    </aside>
  );
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
      return <PreviewPane environmentId={environmentId} sessionId={sessionId} />;
  }
};
