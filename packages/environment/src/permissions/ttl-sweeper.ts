import type { PromptAnsweredPayload } from "@agent-harness/contracts";
import type { PromptDecision } from "../adapter/contract.js";
import type { AdapterHost } from "../adapter/host.js";
import { formatActor, type EventLog } from "../event-log/event-log.js";
import type { Clock } from "../serve/clock.js";
import type { Reader } from "../sessions/session-reads.js";
import { sessionStream } from "../sessions/streams.js";
import { autoDenial } from "./broker.js";
import { parkedPrompts, readPromptAt } from "./prompts-store.js";
import { answerEvents } from "./tool-decisions.js";

/**
 * The TTL's sweeper (#131; permissions spec, "Prompts, parked prompts and
 * the TTL"; ADR 0006, ADR 0007): at startup and every 60 seconds on the
 * environment's clock (a chosen default), every parked prompt whose
 * `ttlExpiresAt` has passed is answered `deny` by `{auto: 'ttl'}`, with the
 * message the model reads, and its call's `tool.decision` beside it, each
 * prompt in a transaction of its own. The answer goes the way a person's
 * does (#130): handed to the run that asked when it still waits on it
 * (`live`), through the host once the answer has committed, and the run
 * continues (the deny-and-continue rule, never an interrupt); else kept for
 * the session's next run (`next-run`), whose first message says nobody
 * answered in time, and that run is started at once
 * (`AdapterHost.continueSession`): deny-and-continue means the run
 * continues, and a run whose parked stop took it (half an hour, against a
 * TTL of a day) would otherwise never finish on its own (user story 12). A
 * person's late answer still starts nothing (#130). A deleted session's
 * prompts wait: a restore brings them back, and the next sweep answers them.
 */

/** How often the sweeper looks, in milliseconds. */
export const TTL_SWEEP_INTERVAL_MS = 60_000;

/** What the model reads when its prompt waited past the TTL. */
export const TTL_DENIAL = "Denied: nobody answered within the time allowed. Continue without it and say what you could not do.";

/** What the model reads when its question waited past the TTL. */
export const TTL_ANSWER = "nobody answered in time; proceed with your best judgement";

const SWEEPER_ACTOR = formatActor({ kind: "system", id: "permissions" });

export interface TtlSweeperOptions {
  readonly log: EventLog;
  readonly host: Pick<AdapterHost, "liveRun" | "holdsPrompt" | "deliverAnswer" | "continueSession">;
  readonly clock: Clock;
}

export interface TtlSweeper {
  /** Answers every prompt past its TTL now; returns how many it answered. */
  sweep(): number;
  /** A sweep now, then one every 60 seconds; the answer stops it. */
  start(): () => void;
}

export const createTtlSweeper = ({ log, host, clock }: TtlSweeperOptions): TtlSweeper => {
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };

  /** Answers the prompt `prompt.opened` at `sequence` recorded, if it is still parked; whether it did. */
  const expire = (sequence: number): boolean =>
    log.atomically((tx) => {
      const record = readPromptAt(reader, sequence);
      if (record === null || record.answer !== null) return false;
      const { prompt, runId, promptId, sessionId } = record;
      const message = prompt.kind === "question" ? TTL_ANSWER : TTL_DENIAL;
      // The run that asked still waits on it, or has gone: then the session's next run reads it first (ADR 0007).
      const live = host.liveRun(runId) !== null && host.holdsPrompt(runId, promptId);
      const payload: PromptAnsweredPayload = { ...autoDenial(prompt, "ttl", message), delivery: live ? "live" : "next-run" };
      log.append(sessionStream(sessionId), answerEvents(reader, prompt, payload), { tx, actor: SWEEPER_ACTOR, correlationId: runId });
      if (live) {
        const decision: PromptDecision = { decision: "deny", message };
        tx.afterCommit(() => {
          const failed = (error: unknown): void => console.error(`Handing the TTL's answer to prompt ${promptId} to run ${runId} failed; the log keeps it:`, error);
          try {
            const answering = host.deliverAnswer(runId, promptId, decision);
            if (answering instanceof Promise) answering.catch(failed);
          } catch (error) {
            failed(error);
          }
        });
      } else {
        // Its run has gone: the session's next run starts now, with the answer as its first message.
        tx.afterCommit(() => {
          try {
            host.continueSession(sessionId);
          } catch (error) {
            console.error(`Continuing session ${sessionId} after the TTL answered prompt ${promptId} failed; its next run reads the answer:`, error);
          }
        });
      }
      return true;
    });

  const sweep = (): number => {
    const now = clock.now().getTime();
    let count = 0;
    for (const parked of parkedPrompts(reader)) {
      const expiresAt = parked.prompt.ttlExpiresAt;
      if (expiresAt === null || Date.parse(expiresAt) > now) continue;
      try {
        if (expire(parked.sequence)) count += 1;
      } catch (error) {
        // One prompt's failure keeps no other waiting: the next sweep tries it again.
        console.error(`Answering prompt ${parked.promptId} past its TTL failed; the next sweep tries again:`, error);
      }
    }
    return count;
  };

  return {
    sweep,
    start() {
      try {
        sweep();
      } catch (error) {
        console.error("The TTL's startup sweep failed; the next sweep tries again:", error);
      }
      const timer = clock.setInterval(() => {
        try {
          sweep();
        } catch (error) {
          console.error("The TTL's sweep failed; the next one tries again:", error);
        }
      }, TTL_SWEEP_INTERVAL_MS);
      return () => timer.cancel();
    },
  };
};
