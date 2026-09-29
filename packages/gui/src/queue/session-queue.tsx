import { readQueueNow, withdrawQueued, type SessionRunsView, type VerbAvailability } from "@agent-harness/client-runtime";
import { createContext, use, useMemo, useRef, type ReactNode } from "react";
import { usePaneLine } from "../session/pane-line.js";
import { useProvider } from "../session/provider.js";
import { useObservable, useRuntime } from "../window-context.js";

/**
 * A session's queue and its two verbs (docs/specs/gui.md, "A session pane";
 * ADR 0022; #401), for everything in the pane that draws or acts on it: the
 * queued rows in the transcript, the strip over the composer and the
 * composer's keys. The queue and each verb's availability are
 * `projections.runs.session`'s, so the window and the terminal UI say the
 * same (ADR 0004):
 *
 * - **Read now** (`runs.readNow`) reads the whole queue, in order: the live
 *   run is interrupted and the next opens with every queued message, or,
 *   with none live, the run of what the environment holds starts.
 * - **Edit** is a withdraw (`runs.withdraw`): the message is taken back and
 *   its text goes to the session's draft, so into every composer open on the
 *   session. The window's waiting draft is sent first, so an older draft
 *   never lands after the text coming back.
 *
 * A verb the runtime says cannot be used now dispatches nothing and says its
 * reason in the pane's line; a refusal from the environment is one line too,
 * and moves nothing: the message stays wherever the log puts it.
 */
export interface SessionQueue {
  /** The session's run state, its queue in the order sent, each verb and the withdraw target, as the runtime reads them. */
  readonly runs: SessionRunsView;
  /** The session's adapter steers: a message its provider holds is being folded into the running turn. */
  readonly steers: boolean;
  /** Reads the whole queue now. */
  readNow(): void;
  /** Takes the queued message back into the session's draft. */
  withdraw(messageId: string): void;
  /** Takes back the newest message a withdraw can reach (the runtime's `withdrawTarget`), or says why none can be. */
  withdrawNewest(): void;
}

const QueueContext = createContext<SessionQueue | null>(null);

/** Why a verb was not done, in one line: nothing queued is said as it is, any other reason after what was not done. */
const refused = (what: string, verb: Extract<VerbAvailability, { status: "absent" }>): string => (verb.reason === "no_queue" ? verb.message : `${what}: ${verb.message}`);

export interface SessionQueueProps {
  readonly environmentId: string;
  readonly sessionId: string;
  readonly children: ReactNode;
}

/** The session's queue for the pane it holds; the pane's line says what is refused. */
export const SessionQueueProvider = ({ environmentId, sessionId, children }: SessionQueueProps) => {
  const runtime = useRuntime();
  const [, say] = usePaneLine();
  const projection = useObservable(useMemo(() => runtime.projections.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const runs = useObservable(useMemo(() => runtime.projections.runs.session(environmentId, sessionId), [runtime, environmentId, sessionId]));
  const steers = useProvider(environmentId, projection)?.steering === true;
  // The messages this window has asked to take back and not heard about: asking again meanwhile could only be refused.
  const withdrawing = useRef(new Set<string>());
  const sayRefusal = (line: string | undefined) => {
    if (line !== undefined) say(line);
  };
  const queue: SessionQueue = {
    runs,
    steers,
    readNow() {
      const verb = runs.verbs.readNow;
      if (verb.status === "absent") return say(refused("Not read now", verb));
      say(undefined);
      void readQueueNow(runtime, environmentId, sessionId).then(sayRefusal);
    },
    withdraw(messageId) {
      const message = runs.queue.find((queued) => queued.messageId === messageId);
      if (message === undefined || withdrawing.current.has(message.messageId)) return;
      if (message.withdraw.status === "absent") return say(refused("Not withdrawn", message.withdraw));
      withdrawing.current.add(message.messageId);
      say(undefined);
      // What this window typed and has not saved yet goes first, so it never lands over the text coming back.
      runtime.drafts.flush();
      void withdrawQueued(runtime, environmentId, message.messageId)
        .then(sayRefusal)
        .finally(() => withdrawing.current.delete(message.messageId));
    },
    withdrawNewest() {
      const verb = runs.verbs.withdraw;
      if (runs.withdrawTarget !== null) queue.withdraw(runs.withdrawTarget);
      else if (verb.status === "absent") say(refused("Not withdrawn", verb));
    },
  };
  return <QueueContext value={queue}>{children}</QueueContext>;
};

/** The session's queue and its verbs, for a part of the pane that draws or acts on it. */
export const useSessionQueue = (): SessionQueue => {
  const queue = use(QueueContext);
  if (queue === null) throw new Error("A session's queue is read inside its session pane, which holds it.");
  return queue;
};
