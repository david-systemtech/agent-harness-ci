import { DIFF_CUT_NOTE, sessionDiffNote, workingTreeNote, type RequestAnswer } from "@agent-harness/client-runtime";
import type { SessionDiffChange } from "@agent-harness/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../ui/index.js";
import { useObservable, useRuntime } from "../window-context.js";
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

interface Read {
  readonly session: RequestAnswer<"diffs.session">;
  readonly tree: RequestAnswer<"diffs.workingTree">;
}

const Cut = () => <p className="text-xs text-amber">{DIFF_CUT_NOTE}</p>;

export const DiffPane = ({ environmentId, sessionId, onScreen }: DiffPaneProps) => {
  const runtime = useRuntime();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const [read, setRead] = useState<Read | null>(null);
  const [reading, setReading] = useState(false);
  // Only the latest read lands: one asked again meanwhile, or the pane gone, leaves an earlier answer unheard.
  const latest = useRef(0);
  const readAgain = useCallback(() => {
    const asked = ++latest.current;
    setReading(true);
    void Promise.all([
      runtime.requests.call(environmentId, "diffs.session", { sessionId }),
      runtime.requests.call(environmentId, "diffs.workingTree", { sessionId }),
    ]).then(([session, tree]) => {
      if (asked !== latest.current) return;
      setRead({ session, tree });
      setReading(false);
    });
  }, [runtime, environmentId, sessionId]);
  useEffect(() => {
    if (onScreen) readAgain();
  }, [onScreen, readAgain]);
  useEffect(
    () => () => {
      latest.current++;
    },
    [],
  );

  /** A call behind a change, in words: its tool, the turn it ran in, and how it ended when it did not end well. */
  const callWords = (change: SessionDiffChange): string => {
    const turn = projection.runs.findIndex((run) => run.runId === change.runId);
    return [change.tool, ...(turn === -1 ? [] : [`turn ${String(turn + 1)}`]), ...(change.status === "ok" ? [] : [change.status])].join(" · ");
  };
  const sessionNote = read === null ? null : sessionDiffNote(read.session);
  const treeNote = read === null ? null : workingTreeNote(read.tree);
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
        {read?.session.ok === true &&
          read.session.result.files.map((file) => (
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
        {read?.session.ok === true && read.session.result.truncated && <Cut />}
      </div>
      <div className="flex flex-col gap-2 px-3 py-2">
        <h3 className="text-xs font-semibold text-ink">The working tree against HEAD</h3>
        {treeNote !== null && <p className="text-sm text-ink-faint">{treeNote}</p>}
        {read?.tree.ok === true && treeNote === null && <DiffView text={read.tree.result.diff} />}
        {read?.tree.ok === true && read.tree.result.repository && read.tree.result.truncated && <Cut />}
      </div>
    </div>
  );
};
