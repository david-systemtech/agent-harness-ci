import { directoryOf, outsideWorkspace, typedPath } from "@agent-harness/client-runtime";
import { useMemo, useState } from "react";
import { useSlashCommand } from "../composer/slash-commands.js";
import type { SidePane } from "../presentation.js";
import { usePaneLine } from "../session/pane-line.js";
import { Button, Tooltip } from "../ui/index.js";
import { classes } from "../ui/classes.js";
import { useObservable, useRuntime } from "../window-context.js";
import { closePane, hideColumn, showPane, useSideColumn } from "./column.js";
import { DiffPane } from "./diff-pane.js";
import { FilesPane, WORKSPACE_TOP, type FilesPlace } from "./files-pane.js";
import { PANES, paneCapability } from "./panes.js";
import { TasksPane } from "./tasks-pane.js";

export interface SideColumnProps {
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
 * It wires the slash commands that open its panes, `/files [path]`, `/diff`
 * and `/tasks`, for as long as the session is open in the pane.
 */
export const SideColumn = ({ environmentId, sessionId }: SideColumnProps) => {
  const runtime = useRuntime();
  // The connections' phases: each pane's capability is asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const [column, change] = useSideColumn({ environmentId, sessionId });
  const [files, goFiles] = useState<FilesPlace>(WORKSPACE_TOP);
  const [, say] = usePaneLine();
  const capabilityOf = (pane: SidePane) => paneCapability(runtime, environmentId, pane);
  const show = (pane: SidePane) => change((held) => showPane(held, pane));

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
        <Button aria-label={`Close ${PANES[shown].label}`} className="h-7 w-7 px-0 text-sm text-ink-muted" onClick={() => change((held) => closePane(held, shown))}>
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
            {capability.status === "absent" ? (
              <p className="px-3 py-2 text-sm text-ink-faint">{capability.message}</p>
            ) : pane === "files" ? (
              <FilesPane environmentId={environmentId} sessionId={sessionId} place={files} go={goFiles} />
            ) : pane === "diff" ? (
              <DiffPane environmentId={environmentId} sessionId={sessionId} onScreen={pane === shown && !column.hidden} />
            ) : (
              <TasksPane environmentId={environmentId} sessionId={sessionId} />
            )}
          </section>
        );
      })}
    </aside>
  );
};
