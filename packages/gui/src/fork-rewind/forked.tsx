import { forkedFrom, oneLine, type ForkedEntry } from "@agent-harness/client-runtime";
import { useMemo, useState, type ReactNode } from "react";
import { Fold } from "../ui/index.js";
import { useOpenInPane } from "../session/pane-line.js";
import { Marked } from "../transcript/find.js";
import { useFollowed, useObservable, useRuntime } from "../window-context.js";
import { useSessionForkRewind } from "./session-fork-rewind.js";

/**
 * A fork's saved history under one folded row (#242), named by its copied
 * source title and requested anchor. The source link opens the original
 * session when it remains available. Older forks without a seed name it
 * from the source projection and the session list (#390, #403).
 */
export const ForkedRow = ({ entry, children }: { readonly entry: ForkedEntry; readonly children?: ReactNode }) => {
  const [expanded, setExpanded] = useState(false);
  const runtime = useRuntime();
  const { environmentId } = useSessionForkRewind();
  const openInPane = useOpenInPane();
  const source = useFollowed(useMemo(() => entry.history === undefined ? runtime.projections.session(environmentId, entry.fromSessionId) : undefined, [runtime, environmentId, entry.fromSessionId, entry.history]));
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
