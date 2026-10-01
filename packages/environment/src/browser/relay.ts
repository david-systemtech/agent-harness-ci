import { randomUUID } from "node:crypto";
import {
  CLIENT_ANSWER_MAX_BYTES,
  ContractError,
  PageOutcome,
  SESSION_STREAM_KIND,
  invalidParams,
  pageCallDeadlineMs,
  type ClientAnswer,
  type ClientCallPayload,
  type PageCall,
  type PageCallOf,
  type PageDriver,
  type PageResult,
  type PageVerb,
} from "@agent-harness/contracts";
import { formatActor, parseActor, type EventLog, type StreamRef } from "../event-log/event-log.js";
import type { Clock, Timer } from "../serve/clock.js";
import type { MethodHandlers } from "../serve/methods.js";

/**
 * The browser relay's run side (browser spec, "The browser relay"; ADR
 * 0014; #554): a verb on a Chrome paired with another environment than the
 * run's is asked of the client session that started the run, which performs
 * it on its own machine through its local connection to the Chrome's
 * environment (`browser.chromes.perform`) and answers.
 *
 * The run's environment appends `client.call` to its `environment` stream,
 * addressed to the client session that started the session's latest run a
 * client started: the run's own, or, for a run the environment started
 * itself (a run of its queue, a turn the provider opened), the one before it
 * that a client did. When that client session holds no open socket the verb
 * is refused at once naming the client, and nothing is appended. The call
 * carries the verb's arguments and its deadline (the verb's own, as the
 * extension driver waits) and never its answer: `client.answer`, a request
 * that appends nothing, hands the answer to the waiting verb alone, so only
 * the tool's result enters the transcript. An answer is taken only from the
 * addressed client session (any other is `forbidden`, reason `addressed`);
 * an answer for a call unknown, past its deadline or answered already is
 * accepted with `taken: false`; one over 8 MiB is refused, and the verb
 * answers that it was too large. Past the deadline the model reads that the
 * client did not answer, naming it.
 */

/** Who the log says appended a call: the environment's browser. */
const BROWSER_ACTOR = formatActor({ kind: "system", id: "browser" });

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const refusal = (reason: string): PageOutcome => ({ ok: false, reason });

/** A sentence's opening word written as one. */
const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** The Chrome a relayed verb is for, and the session and run whose verb it is. */
export interface RelayedChrome {
  /** The environment the Chrome is paired with: another than the run's. */
  readonly environmentId: string;
  /** The Chrome; null for the plain My Chrome of that environment. */
  readonly chromeId: string | null;
  readonly sessionId: string;
  readonly runId: string;
}

export interface BrowserRelayOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment stream, which `environment.subscribe` follows. */
  readonly stream: StreamRef;
  /** Whether the client session holds an open socket now. */
  readonly connected: (clientSessionId: string) => boolean;
  /** The client session's label, which the sentences name it by. */
  readonly clientLabel: (clientSessionId: string) => string | undefined;
}

export interface BrowserRelay {
  /** The page driver of a Chrome paired with another environment, for one session's run: every verb relayed through its client. */
  driverOf(chrome: RelayedChrome): PageDriver;
  /** `client.answer`. */
  readonly handlers: MethodHandlers;
  /** Ends every verb still waiting with a sentence. */
  close(): void;
}

/** A call waiting for its answer. */
interface Waiting {
  readonly clientSessionId: string;
  /** How the sentences name the client. */
  readonly client: string;
  readonly timer: Timer;
  readonly settle: (outcome: PageOutcome) => void;
}

const NO_CLIENT =
  "No client started a run of this session, so there is no client to drive its Chrome, which is paired with another environment. Ask the person to start this session's run from a client on the Chrome's machine.";

export const createBrowserRelay = (options: BrowserRelayOptions): BrowserRelay => {
  const { log, clock } = options;
  const waiting = new Map<string, Waiting>();
  let closed = false;

  /** The client session that started the session's latest run a client started; null when none did. */
  const addresseeOf = (sessionId: string): string | null => {
    const [row] = log.read<{ actor: string }>(
      "SELECT actor FROM events WHERE stream_kind = ? AND stream_id = ? AND type = 'run.started' AND actor LIKE 'client_session:%' ORDER BY sequence DESC LIMIT 1",
      SESSION_STREAM_KIND,
      sessionId,
    );
    return row === undefined ? null : parseActor(row.actor).id;
  };

  const clientNamed = (clientSessionId: string): string => {
    const label = options.clientLabel(clientSessionId);
    return label === undefined || label === "" ? "the client that started this session's run" : `the client "${label}"`;
  };

  /** Hands the waiting call its outcome; false when it is not waiting. */
  const settle = (callId: string, outcome: PageOutcome): boolean => {
    const call = waiting.get(callId);
    if (call === undefined) return false;
    waiting.delete(callId);
    call.timer.cancel();
    call.settle(outcome);
    return true;
  };

  /** What the model reads of a client's answer. */
  const outcomeOf = (client: string, answer: ClientAnswer): PageOutcome => {
    if (!answer.ok) {
      const message = answer.error?.message.trim() || "it gave no reason.";
      if (answer.error?.code === "unsupported") {
        return refusal(
          `${capitalised(client)} cannot drive a browser for a run: ${message} Ask the person to start this session's runs from the desktop window or the terminal UI on the Chrome's machine.`,
        );
      }
      return refusal(`${capitalised(client)} could not drive the Chrome: ${message}`);
    }
    const outcome = PageOutcome.safeParse(answer.result);
    return outcome.success ? outcome.data : refusal(`${capitalised(client)} answered with something that is not a browser's answer.`);
  };

  const perform = async (chrome: RelayedChrome, call: PageCall): Promise<PageOutcome> => {
    if (closed) return refusal("The environment is stopping.");
    let addressee: string | null;
    try {
      addressee = addresseeOf(chrome.sessionId);
    } catch (error) {
      return refusal(`The environment could not read which client started this session's runs: ${messageOf(error)}.`);
    }
    if (addressee === null) return refusal(NO_CLIENT);
    const client = clientNamed(addressee);
    if (!options.connected(addressee)) {
      return refusal(`${capitalised(client)} is not connected, so the Chrome on its machine cannot be driven. Ask the person to open it, then try again.`);
    }
    const deadlineMs = pageCallDeadlineMs(call.command);
    const callId = randomUUID();
    const payload: ClientCallPayload = {
      callId,
      clientSessionId: addressee,
      kind: "browser.chrome",
      payload: {
        environmentId: chrome.environmentId,
        chromeId: chrome.chromeId,
        pageKey: call.pageKey,
        command: call.command,
        ...(call.allowance !== undefined && { allowance: call.allowance }),
        deadline: new Date(clock.now().getTime() + deadlineMs).toISOString(),
      },
    };
    return new Promise<PageOutcome>((resolve) => {
      const timer = clock.setTimeout(
        () => settle(callId, refusal(`${capitalised(client)} did not answer within ${deadlineMs / 1_000} seconds. Try again; if it still does not answer, ask the person to look at that client.`)),
        deadlineMs,
      );
      waiting.set(callId, { clientSessionId: addressee, client, timer, settle: resolve });
      try {
        log.append(options.stream, [{ type: "client.call", payload }], { actor: BROWSER_ACTOR, correlationId: chrome.runId });
      } catch (error) {
        settle(callId, refusal(`The environment could not record the call for ${client}: ${messageOf(error)}.`));
      }
    });
  };

  return {
    driverOf: (chrome) => ({
      kind: "chrome",
      // A call of one verb is a call; the client's answer is JSON off the wire, which the tools check against the verb.
      perform: async <V extends PageVerb>(call: PageCallOf<V>) => (await perform(chrome, call as PageCall)) as PageResult<V>,
    }),
    handlers: {
      "client.answer": (answer, context) => {
        const call = waiting.get(answer.callId);
        if (call !== undefined && call.clientSessionId !== context.clientSession.id) {
          throw new ContractError({ code: "forbidden", message: "Only the client session a call is addressed to may answer it.", data: { scope: "runs:drive", reason: "addressed" } });
        }
        const carried = answer.ok ? answer.result : answer.error;
        if (Buffer.byteLength(JSON.stringify(carried ?? null), "utf8") > CLIENT_ANSWER_MAX_BYTES) {
          if (call !== undefined) settle(answer.callId, refusal(`${capitalised(call.client)} answered with more than 8 MiB, which the browser relay does not carry.`));
          const message = `An answer carries at most ${CLIENT_ANSWER_MAX_BYTES} bytes of result or error.`;
          throw new ContractError(invalidParams([{ code: "too_big", path: [answer.ok ? "result" : "error"], message }], message));
        }
        if (call === undefined) return { taken: false };
        settle(answer.callId, outcomeOf(call.client, answer));
        return { taken: true };
      },
    },
    close() {
      closed = true;
      for (const callId of [...waiting.keys()]) settle(callId, refusal("The environment stopped before the client answered."));
    },
  };
};
