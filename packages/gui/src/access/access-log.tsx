import { accessEventTimeWords, accessEventWords, clientSessionLabels, readAccessLog, type AccessLogRead, type ClientSessionSummary, type EnvironmentView } from "@agent-harness/client-runtime";
import { useEffect, useMemo, useState } from "react";
import { Part } from "../settings/part.js";
import { Button } from "../ui/index.js";
import { useClock, useRuntime } from "../window-context.js";

/** How many events a page of the log shows. */
const PAGE = 20;

interface AccessLogProps {
  readonly view: EnvironmentView;
  /** The client sessions listed, whose labels name the events' client sessions. */
  readonly sessions: readonly ClientSessionSummary[];
  /** Changes whenever a verb of the pane did something, so the log is read again with it. */
  readonly after: number;
}

/**
 * The access log (ADR 0006; env spec, "Pairing and access"; #417): who was
 * let in and how, and what changed what a client session may do, read whole
 * from `access.log.list` (`readAccessLog`) as the pane opens, after each verb
 * of the pane and on Read again, since no notice a client hears says it
 * grew; shown newest first, twenty to a page, each event in one line.
 */
export const AccessLog = ({ view, sessions, after }: AccessLogProps) => {
  const runtime = useRuntime();
  const clock = useClock();
  const { environmentId } = view;
  const [read, setRead] = useState<AccessLogRead | undefined>(undefined);
  const [page, setPage] = useState(0);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let current = true;
    void readAccessLog(runtime, environmentId).then((answer) => {
      if (!current) return;
      setRead(answer);
      setPage(0);
    });
    return () => {
      current = false;
    };
  }, [runtime, environmentId, after, asked]);

  const events = read?.ok === true ? read.events : [];
  const labelOf = useMemo(() => clientSessionLabels(sessions, events), [sessions, events]);
  const shown = events.slice(page * PAGE, (page + 1) * PAGE);

  return (
    <Part title="Access log">
      {read === undefined ? (
        <p className="text-sm text-ink-faint">Reading the access log…</p>
      ) : !read.ok ? (
        <p className="text-sm text-ink-faint">{read.line}</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-ink-faint">The access log holds nothing yet.</p>
      ) : (
        <>
          <ol aria-label="Access log events" className="flex flex-col gap-1">
            {shown.map((event) => (
              <li key={event.sequence} className="text-sm text-ink">
                <span className="text-ink-faint">{accessEventTimeWords(event, clock.now())}</span> {accessEventWords(event, labelOf)}
              </li>
            ))}
          </ol>
          <div className="flex items-center gap-3">
            <Button disabled={page === 0} onClick={() => setPage((now) => now - 1)}>
              Newer
            </Button>
            <p className="text-xs text-ink-muted">
              {page * PAGE + 1} to {page * PAGE + shown.length} of {events.length}, newest first
            </p>
            <Button disabled={(page + 1) * PAGE >= events.length} onClick={() => setPage((now) => now + 1)}>
              Older
            </Button>
          </div>
        </>
      )}
      <div>
        <Button onClick={() => setAsked((now) => now + 1)}>Read again</Button>
      </div>
    </Part>
  );
};
