import type { RunEndedPayload } from "@agent-harness/contracts";
import type { EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { providerHeld } from "../runs/run-reads.js";
import { HOST_ACTOR, requeuedEvents } from "./host.js";

/**
 * The startup recovery sweep (claude-adapter spec, "Environment-owned
 * provider processes"; ADR 0007): a run the log holds without an end was
 * cut by the environment stopping (a crash, a kill, an end that could not
 * be appended), and no process is left to finish it. Before the wire opens,
 * each such run ends `interrupted` with cause `restart`, as the adapter
 * host's own end: the messages its provider still held come back to the
 * environment's queue as `message.requeued`, in the end's transaction and
 * just before it (ADR 0022: nothing is lost), and its prompts stay raised,
 * so they are there again for a client to answer (ADR 0007). The bytes of a
 * queued message's attachments were held in memory and are gone: the run
 * that reads the message reads its text alone, and the log keeps the record
 * of what was attached.
 */

/** A run the runs table holds as running. */
interface OpenRun {
  readonly run_id: string;
  readonly session_id: string;
  readonly started_at: string;
}

/**
 * Ends every run the log left without an end; returns their ids, oldest
 * first. A run whose end cannot be appended is logged loudly and left for
 * the next start's sweep; the others are ended regardless.
 */
export const recoverCutRuns = (options: { readonly log: EventLog; readonly clock: Pick<Clock, "now"> }): string[] => {
  const { log, clock } = options;
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const open = reader.all<OpenRun>("SELECT run_id, session_id, started_at FROM runs WHERE state = 'running' ORDER BY started_at, rowid");
  const ended: string[] = [];
  for (const run of open) {
    const payload: RunEndedPayload = {
      runId: run.run_id,
      reason: "interrupted",
      cause: "restart",
      error: null,
      usage: null,
      durationMs: Math.max(0, clock.now().getTime() - Date.parse(run.started_at)),
      turnCount: null,
      resultText: null,
    };
    try {
      log.atomically(() => {
        const held = requeuedEvents(run.run_id, providerHeld(reader, run.session_id, run.run_id));
        log.append(sessionStream(run.session_id), [...held, { type: "run.ended", payload }], { actor: HOST_ACTOR, correlationId: run.run_id });
      });
      ended.push(run.run_id);
    } catch (error) {
      console.error(`THE RECOVERY SWEEP COULD NOT END RUN ${run.run_id} OF SESSION ${run.session_id}; the next start tries again:`, error);
    }
  }
  return ended;
};
