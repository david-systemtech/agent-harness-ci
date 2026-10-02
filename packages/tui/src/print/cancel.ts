import type { Observable, Runtime, SessionProjection } from "@agent-harness/client-runtime";
import type { Head } from "./answer.js";

/**
 * SIGINT on a turn sent (docs/specs/switch-over.md L101; ADR 0022): the
 * turn's own message is withdrawn while no run has read it
 * (`runs.withdraw`, its text going to the session's draft), and once a run
 * has, that run alone is interrupted (`runs.interrupt`), never the run it
 * waited behind. A message that started a run says so on the answer's
 * first chunk; which run read a queued one is the session's own stream's
 * to say, as `projections.session` follows it.
 */

/** The run that read `messageId`, as the session's stream has it now; undefined while it waits, or when the stream has not heard of it. */
export const readerOf = (session: SessionProjection, messageId: string): string | undefined => {
  const message = session.items.find((item) => item.kind === "user-message" && item.messageId === messageId);
  return message?.kind === "user-message" && message.delivery !== "queued" ? message.runId : undefined;
};

/** The run that read `messageId`, once the session's stream says which; when `giveUp` settles first, whatever it says then. */
const readerHeard = (session: Observable<SessionProjection>, messageId: string, giveUp: Promise<unknown>): Promise<string | undefined> =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (reader: string | undefined) => {
      settled = true;
      stop();
      resolve(reader);
    };
    // Following never calls back with the value it starts on: the stream's word so far is read once, after.
    const stop = session.subscribe(() => {
      const reader = settled ? undefined : readerOf(session.read(), messageId);
      if (reader !== undefined) finish(reader);
    });
    const now = readerOf(session.read(), messageId);
    if (now !== undefined) finish(now);
    void giveUp.then(() => {
      if (!settled) finish(readerOf(session.read(), messageId));
    });
  });

const interrupt = async (runtime: Runtime, environmentId: string, runId: string): Promise<string> => {
  const answer = await runtime.commands.dispatch(environmentId, "runs.interrupt", { runId });
  if (!answer.ok) return `Interrupted, but run ${runId} was not stopped: ${answer.error.message}`;
  return answer.result?.ended === true ? `Interrupted: run ${runId} had ended already.` : `Interrupted: run ${runId} was stopped.`;
};

/**
 * Takes the turn back: withdraws its message, or interrupts the run that
 * read it. A queued message the withdraw finds read already waits for the
 * session's stream to name its reader, or for the answer to end, which
 * `answered` settles. Answers what was done, in one line.
 */
export const cancelTurn = async (
  runtime: Runtime,
  environmentId: string,
  head: Head,
  session: Observable<SessionProjection>,
  answered: Promise<unknown>,
): Promise<string> => {
  if (head.delivery === "prompt") return interrupt(runtime, environmentId, head.runId);
  const withdrawn = await runtime.commands.dispatch(environmentId, "runs.withdraw", { messageId: head.messageId });
  if (withdrawn.ok) return "Interrupted: the message was withdrawn before any run read it; its text is the session's draft.";
  const reader = await readerHeard(session, head.messageId, answered);
  return reader === undefined ? `Interrupted: ${withdrawn.error.message}` : interrupt(runtime, environmentId, reader);
};
