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
 * client did not answer, naming it. A call whose payload holds a value the
 * scrub registry holds is never made: the log's append would write that
 * value as `[redacted]`, so the Chrome would be handed the wrong text, and a
 * secret the environment keeps reaches no client through the log (ADR
 * 0011); the verb is refused with a sentence and nothing is appended (#926).
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

/** The dock and the session run whose client owns it. */
export interface RelayedDock {
  readonly kind: "dock";
  readonly sessionId: string;
  readonly runId: string;
}
type RelayedBrowser = RelayedChrome | RelayedDock;
const isDock = (browser: RelayedBrowser): browser is RelayedDock => "kind" in browser && browser.kind === "dock";

export interface BrowserRelayOptions {
  readonly log: EventLog;
  readonly clock: Clock;
  /** The environment stream, which `environment.subscribe` follows. */
  readonly stream: StreamRef;
  /** Whether the client session holds an open socket now. */
  readonly connected: (clientSessionId: string) => boolean;
  /** The client session's label, which the sentences name it by. */
  readonly clientLabel: (clientSessionId: string) => string | undefined;
  /** A string as the log's append writes it: the scrub registry's registered values replaced (ADR 0011). */
  readonly scrub: (text: string) => string;
}

export interface BrowserRelay {
  /** The page driver of a Chrome paired with another environment, for one session's run: every verb relayed through its client. */
  driverOf(chrome: RelayedBrowser): PageDriver;
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
  readonly dock: boolean;
  readonly timer: Timer;
  readonly settle: (outcome: PageOutcome) => void;
}

const NO_CLIENT =
  "No client started a run of this session, so there is no client to drive its Chrome, which is paired with another environment. Ask the person to start this session's run from a client on the Chrome's machine.";

/** Whether a string anywhere in `value`, an object's keys included, holds a value `scrub` replaces: one the log would not write as it is. */
const holdsScrubbed = (value: unknown, scrub: (text: string) => string): boolean => {
  if (typeof value === "string") return scrub(value) !== value;
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((entry) => holdsScrubbed(entry, scrub));
  return Object.entries(value).some(([key, entry]) => scrub(key) !== key || holdsScrubbed(entry, scrub));
};

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
  const outcomeOf = (client: string, answer: ClientAnswer, dock: boolean): PageOutcome => {
    if (!answer.ok) {
      const message = answer.error?.message.trim() || "it gave no reason.";
      if (answer.error?.code === "unsupported") {
        return refusal(
          `${capitalised(client)} cannot drive ${dock ? "the browser dock" : "a browser"} for a run: ${message} ${dock ? "Ask the person to start this session's runs from a desktop window that can drive its dock." : "Ask the person to start this session's runs from the desktop window or the terminal UI on the Chrome's machine."}`,
        );
      }
      return refusal(`${capitalised(client)} could not drive ${dock ? "the browser dock" : "the Chrome"}: ${message}`);
    }
    const outcome = PageOutcome.safeParse(answer.result);
    return outcome.success ? outcome.data : refusal(`${capitalised(client)} answered with something that is not a browser's answer.`);
  };

  const perform = async (chrome: RelayedBrowser, call: PageCall): Promise<PageOutcome> => {
    if (closed) return refusal("The environment is stopping.");
    let addressee: string | null;
    try {
      addressee = addresseeOf(chrome.sessionId);
    } catch (error) {
      return refusal(`The environment could not read which client started this session's runs: ${messageOf(error)}.`);
    }
    if (addressee === null)
      return refusal(
        isDock(chrome)
          ? "No client started a run of this session, so there is no desktop to drive its browser dock. Ask the person to start this session's run from the desktop window."
          : NO_CLIENT,
      );
    const client = clientNamed(addressee);
    if (!options.connected(addressee)) {
      return refusal(
        `${capitalised(client)} is not connected, so ${isDock(chrome) ? "its browser dock" : "the Chrome on its machine"} cannot be driven. Ask the person to open it, then try again.`,
      );
    }
    const deadlineMs = pageCallDeadlineMs(call.command);
    const callId = randomUUID();
    const verb = {
      pageKey: call.pageKey,
      command: call.command,
      ...(call.allowance !== undefined && { allowance: call.allowance }),
      deadline: new Date(clock.now().getTime() + deadlineMs).toISOString(),
    };
    const payload: ClientCallPayload = isDock(chrome)
      ? {
          callId,
          clientSessionId: addressee,
          kind: "browser.dock",
          payload: verb,
        }
      : {
          callId,
          clientSessionId: addressee,
          kind: "browser.chrome",
          payload: {
            ...verb,
            environmentId: chrome.environmentId,
            chromeId: chrome.chromeId,
          },
        };
    if (holdsScrubbed(payload, options.scrub)) {
      const browser = isDock(chrome) ? "browser dock" : "Chrome";
      const machine = isDock(chrome) ? "desktop" : "Chrome's machine";
      return refusal(
        `What this call would send to the ${browser} holds a secret this environment keeps, such as a key manager's or a forge's credential or a run's token. A verb for this ${browser} goes to ${client} through the environment's log, which never holds such a secret, so nothing was sent and the page is unchanged. Ask the person to enter it on the ${machine} themselves.`,
      );
    }
    return new Promise<PageOutcome>((resolve) => {
      const timer = clock.setTimeout(
        () =>
          settle(
            callId,
            refusal(`${capitalised(client)} did not answer within ${deadlineMs / 1_000} seconds. Try again; if it still does not answer, ask the person to look at that client.`),
          ),
        deadlineMs,
      );
      waiting.set(callId, {
        clientSessionId: addressee,
        client,
        dock: isDock(chrome),
        timer,
        settle: resolve,
      });
      try {
        log.append(options.stream, [{ type: "client.call", payload }], { actor: BROWSER_ACTOR, correlationId: chrome.runId });
      } catch (error) {
        settle(callId, refusal(`The environment could not record the call for ${client}: ${messageOf(error)}.`));
      }
    });
  };

  return {
    driverOf: (chrome) => ({
      kind: isDock(chrome) ? "dock" : "chrome",
      // A call of one verb is a call; the client's answer is JSON off the wire, which the tools check against the verb.
      perform: async <V extends PageVerb>(call: PageCallOf<V>) => (await perform(chrome, call as PageCall)) as PageResult<V>,
    }),
    handlers: {
      "client.answer": (answer, context) => {
        const call = waiting.get(answer.callId);
        if (call !== undefined && call.clientSessionId !== context.clientSession.id) {
          throw new ContractError({
            code: "forbidden",
            message: "Only the client session a call is addressed to may answer it.",
            data: { scope: "runs:drive", reason: "addressed" },
          });
        }
        const carried = answer.ok ? answer.result : answer.error;
        if (Buffer.byteLength(JSON.stringify(carried ?? null), "utf8") > CLIENT_ANSWER_MAX_BYTES) {
          if (call !== undefined) settle(answer.callId, refusal(`${capitalised(call.client)} answered with more than 8 MiB, which the browser relay does not carry.`));
          const message = `An answer carries at most ${CLIENT_ANSWER_MAX_BYTES} bytes of result or error.`;
          throw new ContractError(invalidParams([{ code: "too_big", path: [answer.ok ? "result" : "error"], message }], message));
        }
        if (call === undefined) return { taken: false };
        settle(answer.callId, outcomeOf(call.client, answer, call.dock));
        return { taken: true };
      },
    },
    close() {
      closed = true;
      for (const callId of [...waiting.keys()]) settle(callId, refusal("The environment stopped before the client answered."));
    },
  };
};
