import { oneLine, sessionTasks, stopCall, subagentRows, type RequestAnswer, type SessionTask } from "@agent-harness/client-runtime";
import { useEffect, useMemo, useState } from "react";
import type { Offer } from "../keys/key-dispatch.js";
import { usePaneLine } from "../session/pane-line.js";
import { useProvider } from "../session/provider.js";
import { VerbButton } from "../session/verb-button.js";
import { TranscriptRowView, type RowFacts } from "../transcript/rows.js";
import { Button, Fold } from "../ui/index.js";
import { useObservable, usePresentation, useRuntime } from "../window-context.js";

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
  if (reading !== null) return <AgentTranscript environmentId={environmentId} sessionId={sessionId} row={reading} back={() => setReading(null)} />;

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

  const task = (row: SessionTask, going: boolean) => (
    <li key={`${row.runId} ${row.task.taskId}`}>
      <article aria-label={`${whoOf(row)}: ${oneLine(row.task.description, 120)}`} className="flex flex-col gap-1 rounded-md border border-hairline px-2.5 py-1.5 text-xs">
        <p className="text-ink">
          <span className="text-cyan">{whoOf(row)}</span>
          {`: ${oneLine(row.task.description, 300)}`}
        </p>
        <div className="flex items-center gap-1">
          <span className={row.task.status === "failed" ? "mr-auto text-signal" : "mr-auto text-ink-muted"}>
            {`${row.task.status}${row.task.error === null ? "" : `: ${oneLine(row.task.error, 200)}`}`}
          </span>
          {row.agentId !== null && (
            <VerbButton does="Shows what this agent did: its own transcript." availability={openOffer} run={() => open(row)}>
              Open
            </VerbButton>
          )}
          {going && (
            <VerbButton does="Stops this task; the run goes on." availability={stopOffer(row)} run={() => stop(row)}>
              {stopAsked.has(row.task.taskId) ? "Stopping…" : "Stop"}
            </VerbButton>
          )}
        </div>
      </article>
    </li>
  );

  if (live.length === 0 && finished.length === 0) return <p className="px-3 py-2 text-sm text-ink-faint">No delegated work in this session.</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
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

/** Nothing arrives while an agent's transcript is read, none of its calls is timed, and nothing in it is forked or rewound: it is read once, as it stood. */
const AS_READ: RowFacts = { arrived: () => false, quietMs: () => 0, verbs: false };

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
  const agentId = row.agentId ?? "";
  useEffect(() => {
    let current = true;
    void runtime.requests.call(environmentId, "sessions.subagentTranscript", { sessionId, agentId }).then((read) => {
      if (current) setAnswer(read);
    });
    return () => {
      current = false;
    };
  }, [runtime, environmentId, sessionId, agentId]);
  const rows = useMemo(() => (answer?.ok === true ? subagentRows(answer.result.messages) : []), [answer]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center px-2 pt-1.5">
        <Button className="h-7 px-2 text-xs" onClick={back}>
          Back to the tasks
        </Button>
      </div>
      <h3 className="shrink-0 px-3 py-1 text-xs text-ink">
        <span className="text-cyan">{whoOf(row)}</span>
        {`: ${oneLine(row.task.description, 300)}`}
      </h3>
      {answer === null ? (
        <p className="px-3 py-1 text-sm text-ink-faint">Reading…</p>
      ) : !answer.ok ? (
        <p className="px-3 py-1 text-sm text-ink-faint">{`Not read: ${answer.error.message}`}</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-1 text-sm text-ink-faint">Nothing is stored for this agent yet.</p>
      ) : (
        <div role="group" aria-label="The agent's transcript" className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2 text-ink" style={{ fontSize: `${String(textSize)}px` }}>
          {rows.map((drawn) => (
            <TranscriptRowView key={drawn.id} row={drawn} facts={AS_READ} />
          ))}
        </div>
      )}
    </div>
  );
};
