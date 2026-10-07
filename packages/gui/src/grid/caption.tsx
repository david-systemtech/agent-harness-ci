import { workspaceLabel, workspaceName } from "@agent-harness/client-runtime";
import type { Workspace } from "@agent-harness/contracts";
import { ChevronRight, Folder, Info, Pencil, X } from "lucide-react";
import { useFirstKey } from "../keys/key-dispatch.js";
import { useGridPaneId, usePaneGrid } from "./grid.js";
import { useMemo, useRef, useState, type ReactNode } from "react";
import { EnvironmentGlyph } from "../connections/environment-badge.js";
import { THIS_MACHINE } from "../connections/words.js";
import type { PaneSession } from "../presentation.js";
import { usePaneLine } from "../session/pane-line.js";
import { PullRequestLinks } from "../session/pull-requests.js";
import { RenameField } from "../sidebar/rename-field.js";
import { TITLE_MOST } from "../sidebar/row.js";
import { notDone, quoted } from "../sidebar/words.js";
import { RunInfo } from "../status/run-info.js";
import { classes } from "../ui/classes.js";
import { IconButton, Tooltip } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * A session pane's caption (docs/specs/gui.md, "A session pane"; #407):
 * the session's badge, its title, renamed in place (`sessions.rename`
 * through the outbox, a refusal said on the pane's line), its workspace
 * chip (#421), its pull requests' links (#419), the run info toggle, and
 * close, the one way a pane of the grid is closed. Captions appear only
 * with several panes; their focused pane uses an accent boundary.
 */

export interface CaptionProps {
  /** Whether the pane is the focused one of several: its caption is marked. */
  readonly marked: boolean;
  /** Closes the pane; absent while it is the grid's last. */
  readonly close: (() => void) | undefined;
}

/** The caption's frame: the mark, what it holds, and close at its end. */
const CaptionBar = ({ marked, close, children }: CaptionProps & { readonly children: ReactNode }) => {
  const id = useGridPaneId();
  const grid = usePaneGrid();
  const pressedControl = useRef(false);
  return (
    <div
      data-pane-caption
      hidden={close === undefined}
      className={classes("h-8 shrink-0 items-center gap-1.5 border-b border-hairline px-2.5 text-sm", close === undefined ? "hidden" : "flex", marked && "bg-wash")}
      draggable={close !== undefined && id !== null}
      onPointerDownCapture={(event) => {
        pressedControl.current = event.target instanceof Element && event.target.closest("button, input, a") !== null;
      }}
      onDragStart={(event) => {
        if (id === null || pressedControl.current || (event.target instanceof Element && event.target.closest("button, input, a") !== null)) return event.preventDefault();
        event.dataTransfer.setData("application/x-agent-harness-pane", id);
        event.dataTransfer.effectAllowed = "move";
        grid.drag(id);
      }}
      onDragEnd={() => grid.drag(null)}
    >
      {children}
      {close !== undefined && (
        <IconButton label="Close the pane" size="icon-xs"
          onPointerDown={(event) => event.stopPropagation()}
          onFocus={(event) => event.stopPropagation()}
          onClick={close}>
          <X aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
};

/** The caption of a pane showing a session. */
export const SessionCaption = ({ session, ...bar }: CaptionProps & { readonly session: PaneSession }) => {
  const { environmentId, sessionId } = session;
  const runtime = useRuntime();
  const environment = useObservable(runtime.projections.environments).find((view) => view.environmentId === environmentId);
  const list = useObservable(runtime.projections.sessionList);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const summary = list.rows.find((row) => row.environmentId === environmentId && row.summary.id === sessionId.toLowerCase())?.summary ?? projection.summary;
  const name = summary?.title ?? "";
  const [, say] = usePaneLine();
  const [editing, setEditing] = useState(false);
  const infoKeys = useFirstKey("app.runInfo.toggle");

  const rename = (title: string) => {
    void runtime.commands.dispatch(environmentId, "sessions.rename", { sessionId, title }).then((answer) => {
      if (!answer.ok) say(`${notDone("sessions.rename")}: ${answer.error.message}`);
    });
  };

  return (
    <CaptionBar {...bar}>
      <EnvironmentGlyph view={environment} label={environment?.name ?? THIS_MACHINE} />
      {summary !== null && <WorkspaceNote workspace={summary.workspace} />}
      <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-ink-faint" />
      {editing ? (
        <RenameField label={`Rename ${quoted(name)}`} value={name} maxLength={TITLE_MOST} close={() => setEditing(false)} commit={rename} />
      ) : (
        <Tooltip content={`Rename “${name}”`}><button
          type="button"
          aria-label={`Rename ${quoted(name)}`}
          className="min-w-0 truncate rounded-sm px-1 text-left font-medium text-ink outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam"
          onClick={() => setEditing(true)}
        >
          <Pencil aria-hidden="true" className="mr-1 inline size-3" />{name}
        </button></Tooltip>
      )}
      <PullRequestLinks pullRequests={summary?.pullRequests ?? []} />
      <span title={["Run info", infoKeys].filter(Boolean).join(" · ")} data-caption-run-info className="relative ml-auto shrink-0 [&>button]:size-6 [&>button]:p-0 [&>button]:text-[0px]">
          <RunInfo environmentId={environmentId} sessionId={sessionId} />
          <Info aria-hidden="true" className="pointer-events-none absolute inset-1 size-4 text-ink-muted" />
      </span>
    </CaptionBar>
  );
};

/**
 * The session's workspace, read-only (workspace-picker spec, "Renderers";
 * #421): its kind, its directory's name and a worktree's branch, as the
 * new-session surface's chip says them, with the path on hover.
 */
const WorkspaceNote = ({ workspace }: { readonly workspace: Workspace }) => {
  const label = workspaceLabel(workspace);
  return (
    <span role="note" aria-label={`Workspace: ${label}`} title={workspace.path} className="flex min-w-0 shrink items-center gap-1 rounded-md bg-wash px-1.5 py-0.5 text-xs text-ink-muted">
      <Folder aria-hidden="true" className="size-3 shrink-0" /><span className="truncate">{workspaceName(workspace)}</span>
      {workspace.kind === "worktree" && <span className="max-w-20 shrink-0 truncate rounded-sm bg-wash-strong px-1 font-mono text-2xs">{workspace.branch}</span>}
    </span>
  );
};

/** The caption of a pane holding the new-session surface (#420). */
export const NewSessionCaption = (bar: CaptionProps) => (
  <CaptionBar {...bar}>
    <span className="mr-auto px-1 font-medium text-ink">New session</span>
  </CaptionBar>
);

/** The caption of a pane showing no session: drawn only while it can be closed. */
export const EmptyCaption = (bar: CaptionProps) =>
  bar.close === undefined ? null : (
    <CaptionBar {...bar}>
      <span className="mr-auto text-ink-faint">No session</span>
    </CaptionBar>
  );
