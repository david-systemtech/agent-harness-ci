import { DIFF_CUT_NOTE, sessionDiffNote, workingTreeNote, type Observable, type RequestFailure } from "@agent-harness/client-runtime";
import type { SessionDiffChange } from "@agent-harness/contracts";
import { useMemo } from "react";
import { Button } from "../ui/index.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";
import { DiffView } from "./diff-view.js";

/**
 * The Diff pane (docs/specs/gui.md, "The seven panes and the grid"): what
 * the session changed, file by file from `diffs.session`, each file with the
 * calls that made its changes, then the working tree against HEAD from
 * `diffs.workingTree`, or why there is none, each in the diff view and
 * saying so when the environment cut it. Both are read each time the pane
 * comes on screen, and again on Read again, since a run moves them.
 */

export interface DiffPaneProps {
  readonly environmentId: string;
  readonly sessionId: string;
  /** Whether the pane is on screen: shown, in a column that is not hidden. */
  readonly onScreen: boolean;
}

/** A visible diff is read anew on following, then follows the runtime's shared invalidations. */
const readOnFollow = <T,>(query: Observable<T>, refresh: () => void): Observable<T> => ({
  read: query.read,
  subscribe(listener) {
    refresh();
    return query.subscribe(listener);
  },
});

const answerOf = <T,>(cached: { readonly result: T | null; readonly error: RequestFailure | null } | undefined) =>
  cached?.error ? { ok: false as const, error: cached.error } : cached?.result ? { ok: true as const, result: cached.result } : null;

const Cut = () => <p className="text-xs text-amber">{DIFF_CUT_NOTE}</p>;

export const DiffPane = ({ environmentId, sessionId, onScreen }: DiffPaneProps) => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const queries = useMemo(() => ({
    session: readOnFollow(runtime.requests.cached(environmentId, "diffs.session", { sessionId }), () => runtime.requests.refresh(environmentId, "diffs.session", { sessionId })),
    tree: readOnFollow(runtime.requests.cached(environmentId, "diffs.workingTree", { sessionId }), () => runtime.requests.refresh(environmentId, "diffs.workingTree", { sessionId })),
  }), [runtime, environmentId, sessionId]);
  const session = useFollowed(onScreen ? queries.session : undefined);
  const tree = useFollowed(onScreen ? queries.tree : undefined);
  const sessionRead = answerOf(session);
  const treeRead = answerOf(tree);
  const reading = session?.loading === true || tree?.loading === true;
  const readAgain = () => {
    runtime.requests.refresh(environmentId, "diffs.session", { sessionId });
    runtime.requests.refresh(environmentId, "diffs.workingTree", { sessionId });
  };

  /** A call behind a change, in words: its tool, the turn it ran in, and how it ended when it did not end well. */
  const callWords = (change: SessionDiffChange): string => {
    const turn = projection.runs.findIndex((run) => run.runId === change.runId);
    return [change.tool, ...(turn === -1 ? [] : [`turn ${String(turn + 1)}`]), ...(change.status === "ok" ? [] : [change.status])].join(" · ");
  };
  const sessionNote = sessionRead === null ? null : sessionDiffNote(sessionRead);
  const treeNote = treeRead === null ? null : workingTreeNote(treeRead);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-1.5">
        {reading && <span className="text-xs text-ink-faint">Reading…</span>}
        <Button className="ml-auto h-7 px-2 text-xs" onClick={readAgain}>
          Read again
        </Button>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2">
        <h3 className="text-xs font-semibold text-ink">What this session changed</h3>
        {sessionNote !== null && <p className="text-sm text-ink-faint">{sessionNote}</p>}
        {sessionRead?.ok === true &&
          sessionRead.result.files.map((file) => (
            <article key={file.path} aria-label={file.path} className="flex flex-col gap-1">
              <h4 className="truncate font-mono text-xs text-ink">{file.path}</h4>
              <ul aria-label="The calls that made it" className="flex flex-wrap gap-x-3 text-xs text-ink-muted">
                {file.changes.map((change) => (
                  <li key={change.toolCallId}>{callWords(change)}</li>
                ))}
              </ul>
              <DiffView text={file.diff} />
            </article>
          ))}
        {sessionRead?.ok === true && sessionRead.result.truncated && <Cut />}
      </div>
      <div className="flex flex-col gap-2 px-3 py-2">
        <h3 className="text-xs font-semibold text-ink">The working tree against HEAD</h3>
        {treeNote !== null && <p className="text-sm text-ink-faint">{treeNote}</p>}
        {treeRead?.ok === true && treeNote === null && <DiffView text={treeRead.result.diff} />}
        {treeRead?.ok === true && treeRead.result.repository && treeRead.result.truncated && <Cut />}
      </div>
    </div>
  );
};
