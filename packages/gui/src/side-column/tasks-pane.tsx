import { elapsedClock, oneLine, sessionTasks, stopCall, subagentRows, type RequestAnswer, type SessionTask } from "@agent-harness/client-runtime";
import { ArrowLeft, Bot, Check, Clock, Pause, Play, RefreshCw, Square, X } from "lucide-react";
import { useEffect, useMemo, useReducer, useState } from "react";
import type { Offer } from "../keys/key-dispatch.js";
import { usePaneLine } from "../session/pane-line.js";
import { useProvider } from "../session/provider.js";
import { VerbButton } from "../session/verb-button.js";
import { TranscriptRowView, type RowFacts } from "../transcript/rows.js";
import { Button, Fold, Tooltip } from "../ui/index.js";
import { useClock, useObservable, usePresentation, useRuntime } from "../window-context.js";

/**
 * The Tasks pane (docs/specs/gui.md, "The seven panes and the grid"): the
 * session's delegated work (`sessionTasks`, from its runs' ledgers), live on
 * top and finished folded, each newest first. A live task has a stop
 * (`runs.stopTask`), "Stopping…" until it settles; a task that is an agent
 * opens its transcript (`sessions.subagentTranscript`) in the transcript's
 * presentation. Each is dim with the connection's or the adapter's reason
 * when it cannot be done, and a press on it then says why in the pane's line.
 */

export interface TasksPaneProps {
  readonly environmentId: string;
  readonly sessionId: string;
}

const PRESENT: Offer = { status: "present" };
const absent = (message: string): Offer => ({ status: "absent", message });

/** Who does the work: its agent type, else the provider's word for its kind. */
const whoOf = (row: SessionTask) => row.task.subagentType ?? row.task.kind;

export const TasksPane = ({ environmentId, sessionId }: TasksPaneProps) => {
  const runtime = useRuntime();
  // The connections' phases: the stop and the transcripts are asked again whenever one moves.
  useObservable(runtime.projections.environments);
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const provider = useProvider(environmentId, projection);
  const { live, finished } = useMemo(() => sessionTasks(projection), [projection]);
  const [, say] = usePaneLine();
  const [reading, setReading] = useState<SessionTask | null>(null);
  const [stopAsked, askStop] = useState<ReadonlySet<string>>(new Set());
  const [finishedShown, showFinished] = useState(false);
  const clock = useClock();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const ticking = live.length > 0 && reading === null;
  useEffect(() => {
    if (!ticking) return;
    const tick = () => {
      redraw();
      timer = clock.setTimeout(tick, 1000);
    };
    let timer = clock.setTimeout(tick, 1000);
    return () => timer.cancel();
  }, [clock, ticking]);
  if (reading !== null) return <AgentTranscript key={`${environmentId} ${sessionId} ${reading.agentId ?? ""}`} environmentId={environmentId} sessionId={sessionId} row={reading} back={() => setReading(null)} />;

  const stopCapability = runtime.capability(environmentId, "runs.stopTask");
  const stopOffer = (row: SessionTask): Offer => {
    if (stopCapability.status === "absent") return stopCapability;
    if (provider !== undefined && !provider.subagents) return absent(`${provider.displayName} cannot stop delegated work.`);
    return stopAsked.has(row.task.taskId) ? absent("The task is stopping.") : PRESENT;
  };
  const readCapability = runtime.capability(environmentId, "sessions.subagentTranscript");
  const openOffer: Offer =
    readCapability.status === "absent"
      ? readCapability
      : provider !== undefined && !provider.subagentTranscripts
        ? absent(`${provider.displayName} cannot read a subagent's transcript.`)
        : PRESENT;

  const stop = (row: SessionTask) => {
    const offer = stopOffer(row);
    if (offer.status === "absent") return say(`Not stopped: ${offer.message}`);
    const { taskId } = row.task;
    askStop((held) => new Set([...held, taskId]));
    void stopCall(runtime, environmentId, row.runId, taskId).then((refused) => {
      if (refused === undefined) return;
      say(refused);
      askStop((held) => new Set([...held].filter((other) => other !== taskId)));
    });
  };
  const open = (row: SessionTask) => (openOffer.status === "absent" ? say(`Not opened: ${openOffer.message}`) : setReading(row));

  const task = (row: SessionTask, going: boolean) => {
    const StatusIcon = { pending: Clock, running: Play, paused: Pause, completed: Check, failed: X, stopped: X }[row.task.status];
    const elapsed = Math.max(0, (row.task.endedAt === null ? runtime.environmentNow(environmentId).getTime() : Date.parse(row.task.endedAt)) - Date.parse(row.task.startedAt));
    return (
      <li key={`${row.runId} ${row.task.taskId}`}>
        <article aria-label={`${whoOf(row)}: ${oneLine(row.task.description, 120)}`} className={`flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs ${going ? "border-hairline-strong bg-wash-strong" : "border-hairline bg-wash"}`}>
          <p className="font-medium text-ink">
            <span className="text-cyan">{whoOf(row)}</span>
            {`: ${oneLine(row.task.description, 300)}`}
          </p>
          <div className="flex flex-wrap items-center gap-1">
            <span data-task-status className={`mr-auto flex min-w-0 items-center gap-1 text-2xs ${row.task.status === "failed" ? "text-signal" : "text-ink-muted"}`}>
              <StatusIcon aria-hidden="true" className="size-3 shrink-0" />
              {`${row.task.status}${row.task.error === null ? "" : `: ${oneLine(row.task.error, 200)}`}`}
            </span>
            <span aria-label="Elapsed time" className="shrink-0 font-mono text-2xs text-ink-muted">{elapsedClock(elapsed)}</span>
            {row.agentId !== null && (
              <VerbButton does="Shows what this agent did: its own transcript." keys="Enter or Space" availability={openOffer} run={() => open(row)}>
                <Bot aria-hidden="true" />Open
              </VerbButton>
            )}
            {going && (
              <VerbButton does="Stops this task; the run goes on." keys="Enter or Space" availability={stopOffer(row)} run={() => stop(row)}>
                <Square aria-hidden="true" />{stopAsked.has(row.task.taskId) ? "Stopping…" : "Stop"}
              </VerbButton>
            )}
          </div>
        </article>
      </li>
    );
  };

  if (live.length === 0 && finished.length === 0) return <p className="p-1.5 text-sm text-ink-faint">No delegated work in this session.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-1.5">
      {live.length === 0 ? (
        <p className="text-sm text-ink-faint">Nothing is running.</p>
      ) : (
        <ul aria-label="Live work" className="flex flex-col gap-1.5">
          {live.map((row) => task(row, true))}
        </ul>
      )}
      {finished.length > 0 && (
        <Fold open={finishedShown} onOpenChange={showFinished} summary={`${String(finished.length)} finished`}>
          <ul aria-label="Finished work" className="flex flex-col gap-1.5">
            {finished.map((row) => task(row, false))}
          </ul>
        </Fold>
      )}
    </div>
  );
};

/**
 * Nothing arrives while an agent's transcript is read, none of its calls is timed, and nothing in it is forked or
 * rewound: each read is a snapshot as it stood. Its documents are the session's, which the session's own transcript draws tiles
 * for.
 */
const AS_READ: RowFacts = { arrived: () => false, quietMs: () => 0, workspace: null, revealed: null, verbs: false };

interface AgentTranscriptProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly row: SessionTask;
  back(): void;
}

/** An agent's own transcript, read through `sessions.subagentTranscript` as it stands when opened, drawn as the transcript's rows. */
const AgentTranscript = ({ environmentId, sessionId, row, back }: AgentTranscriptProps) => {
  const runtime = useRuntime();
  const [textSize] = usePresentation("textSize");
  const [answer, setAnswer] = useState<RequestAnswer<"sessions.subagentTranscript"> | null>(null);
  const [lastRead, setLastRead] = useState<RequestAnswer<"sessions.subagentTranscript"> | null>(null);
  const [revision, readAgain] = useReducer((n: number) => n + 1, 0);
  const agentId = row.agentId ?? "";
  useEffect(() => {
    let current = true;
    void runtime.requests.call(environmentId, "sessions.subagentTranscript", { sessionId, agentId }).then((read) => {
      if (!current) return;
      setAnswer(read);
      if (read.ok) setLastRead(read);
    });
    return () => {
      current = false;
    };
  }, [runtime, environmentId, sessionId, agentId, revision]);
  const rows = useMemo(() => (lastRead?.ok === true ? subagentRows(lastRead.result.messages) : []), [lastRead]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-1 border-b border-hairline px-2 py-1">
        <Tooltip content="Back to the tasks" keys="Enter or Space">
          <Button size="xs" onClick={back}><ArrowLeft aria-hidden="true" />Back to the tasks</Button>
        </Tooltip>
        <Tooltip content="Read the agent transcript again" keys="Enter or Space">
          <Button size="icon-xs" aria-label="Read again" disabled={answer === null} onClick={() => { setAnswer(null); readAgain(); }}><RefreshCw aria-hidden="true" /></Button>
        </Tooltip>
      </div>
      <h3 className="shrink-0 px-3 py-1 text-xs text-ink">
        <span className="text-cyan">{whoOf(row)}</span>
        {`: ${oneLine(row.task.description, 300)}`}
      </h3>
      {answer === null && <p className="px-3 py-1 text-sm text-ink-faint">Reading…</p>}
      {answer?.ok === false && <p className="px-3 py-1 text-sm text-amber">{`Not read: ${answer.error.message}`}</p>}
      {answer?.ok === true && rows.length === 0 && <p className="px-3 py-1 text-sm text-ink-faint">Nothing is stored for this agent yet.</p>}
      {rows.length > 0 && (
        <div role="group" aria-label="The agent's transcript" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2 text-ink" style={{ fontSize: `${String(textSize)}px` }}>
          {rows.map((drawn) => <TranscriptRowView key={drawn.id} row={drawn} facts={AS_READ} />)}
        </div>
      )}
    </div>
  );
};
