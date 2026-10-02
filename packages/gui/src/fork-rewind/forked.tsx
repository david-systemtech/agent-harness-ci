import { forkedFrom, oneLine, type ForkedEntry } from "@agent-harness/client-runtime";
import { useMemo, useState, type ReactNode } from "react";
import { Fold } from "../ui/index.js";
import { useOpenInPane } from "../session/pane-line.js";
import { Marked } from "../transcript/find.js";
import { useObservable, useRuntime } from "../window-context.js";
import { useSessionForkRewind } from "./session-fork-rewind.js";

/**
 * A fork's first row (docs/specs/gui.md, "A session pane"; #390's `forked`
 * entry; #403): "Forked from <source title> at <prompt>", which opens the
 * source in the pane. The title and the prompt are read from the source's
 * own projection (`forkedFrom`), which the row follows while it is drawn;
 * the session list's title stands in until the source loads, and "another
 * session" for a title not known. "at <prompt>" is left out for a fork of
 * the whole session and while the source does not show the prompt. It holds
 * nothing of the source's conversation: that is #242's seed.
 */
export const ForkedRow = ({ entry, children }: { readonly entry: ForkedEntry; readonly children?: ReactNode }) => {
  const [expanded, setExpanded] = useState(false);
  const runtime = useRuntime();
  const { environmentId } = useSessionForkRewind();
  const openInPane = useOpenInPane();
  const source = useObservable(useMemo(() => runtime.projections.session(environmentId, entry.fromSessionId), [runtime, environmentId, entry.fromSessionId]));
  const list = useObservable(runtime.projections.sessionList);
  const from = forkedFrom(entry, source);
  const listed = list.rows.find((row) => row.environmentId === environmentId && row.summary.id === entry.fromSessionId.toLowerCase())?.summary.title;
  const title = from.title ?? listed ?? "another session";
  const words = `Forked from ${title}${from.anchor !== null ? ` at ${oneLine(from.anchor, 160)}` : ""}`;
  const link = (
    <button
      type="button"
      {...(entry.history !== undefined && { "aria-label": "Open source session" })}
      onClick={() => openInPane(environmentId, entry.fromSessionId)}
      className="flex min-w-0 items-center gap-1.5 self-start rounded-sm text-left text-[0.85em] text-cyan outline-none hover:underline focus-visible:outline-2 focus-visible:outline-beam"
    >
      <span aria-hidden="true">⑂</span>
      <span className="min-w-0 truncate">
        <Marked text={entry.history === undefined ? words : "Open source"} />
      </span>
    </button>
  );
  if (entry.history === undefined) return link;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Fold summary={<Marked text={words} />} open={expanded} onOpenChange={setExpanded}>
        {children}
      </Fold>
      {link}
    </div>
  );
};
