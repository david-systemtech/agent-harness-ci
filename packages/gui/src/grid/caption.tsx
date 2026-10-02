import { workspaceLabel } from "@agent-harness/client-runtime";
import type { Workspace } from "@agent-harness/contracts";
import { useMemo, useState, type ReactNode } from "react";
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
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * A session pane's caption (docs/specs/gui.md, "A session pane"; #407):
 * the session's badge, its title, renamed in place (`sessions.rename`
 * through the outbox, a refusal said on the pane's line), its workspace
 * chip (#421), its pull requests' links (#419), the run info toggle, and
 * close, the one way a pane of the grid is closed. The focused
 * pane's caption is edged in the accent while the grid holds more than one.
 */

export interface CaptionProps {
  /** Whether the pane is the focused one of several: its caption is marked. */
  readonly marked: boolean;
  /** Closes the pane; absent while it is the grid's last. */
  readonly close: (() => void) | undefined;
}

/** The caption's frame: the mark, what it holds, and close at its end. */
const CaptionBar = ({ marked, close, children }: CaptionProps & { readonly children: ReactNode }) => (
  <div className={classes("flex h-8 shrink-0 items-center gap-1.5 border-b-2 px-2 text-sm", marked ? "border-beam" : "border-line")}>
    {children}
    {close !== undefined && (
      <Button
        aria-label="Close the pane"
        title="Close the pane"
        className="h-6 px-1.5 text-xs font-normal text-ink-muted"
        // Closing another pane leaves the focus on the focused one: a press on close does not focus its pane first.
        onPointerDown={(event) => event.stopPropagation()}
        onFocus={(event) => event.stopPropagation()}
        onClick={close}
      >
        ✕
      </Button>
    )}
  </div>
);

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

  const rename = (title: string) => {
    void runtime.commands.dispatch(environmentId, "sessions.rename", { sessionId, title }).then((answer) => {
      if (!answer.ok) say(`${notDone("sessions.rename")}: ${answer.error.message}`);
    });
  };

  return (
    <CaptionBar {...bar}>
      <EnvironmentGlyph view={environment} label={environment?.name ?? THIS_MACHINE} />
      {editing ? (
        <RenameField label={`Rename ${quoted(name)}`} value={name} maxLength={TITLE_MOST} close={() => setEditing(false)} commit={rename} />
      ) : (
        <button
          type="button"
          aria-label={`Rename ${quoted(name)}`}
          title="Rename"
          className="min-w-0 truncate rounded-sm px-1 text-left font-medium text-ink outline-none hover:bg-wash focus-visible:outline-2 focus-visible:outline-beam"
          onClick={() => setEditing(true)}
        >
          {name}
        </button>
      )}
      {summary !== null && <WorkspaceNote workspace={summary.workspace} />}
      <PullRequestLinks pullRequests={summary?.pullRequests ?? []} />
      <RunInfo environmentId={environmentId} sessionId={sessionId} />
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
    <span role="note" aria-label={`Workspace: ${label}`} title={workspace.path} className="min-w-0 shrink truncate text-xs text-ink-muted">
      {label}
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
