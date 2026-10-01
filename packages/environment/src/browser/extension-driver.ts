import { pageCallDeadlineMs, type PageCall, type PageCallOf, type PageDriver, type PageOutcome, type PageResult, type PageVerb } from "@agent-harness/contracts";
import type { ChromeCallAnswer } from "./listener.js";

/**
 * The extension driver (browser spec, "One page driver for three browsers",
 * "The browser relay" and "The browser as a session field"; ADR 0014;
 * #552): every page-driver verb performed on a paired Chrome over its
 * proved socket, by page key, answered with the extension's value or
 * refusal. The environment drives a Chrome paired with it directly for its
 * own runs, and for a client on its machine through
 * `browser.chromes.perform`.
 *
 * A verb names a Chrome, or none for the plain My Chrome: the one paired
 * Chrome connected now. With none connected the verb answers that the
 * extension only runs while Chrome is open; with several, it is refused
 * naming them and telling the model to ask the person which, whose answer
 * is `browser_open`'s `browser`. What goes wrong is a sentence the model
 * reads, never an exception: a Chrome no longer paired or not connected, one
 * that disconnects during the verb, and one silent past the verb's deadline.
 * A Chrome running another version of the extension than the folder's is
 * driven all the same.
 */

/** A paired Chrome as the driver names it. */
export interface DrivenChrome {
  readonly id: string;
  readonly name: string;
}

export interface ExtensionDriverOptions {
  /** The paired Chromes now, in the order they paired. */
  readonly chromes: () => readonly DrivenChrome[];
  /** Whether the Chrome holds a proved socket now. */
  readonly isConnected: (chromeId: string) => boolean;
  /** Sends a call to the Chrome's proved socket and answers how it ended. */
  readonly call: (chromeId: string, call: PageCall, deadlineMs: number) => Promise<ChromeCallAnswer>;
  /** The environment's name as it is now, which the sentences name. */
  readonly environmentName: () => string;
}

export interface ExtensionDriver {
  /** Performs `call` on the Chrome `chromeId`, or on the plain My Chrome for null. Never rejects. */
  perform(chromeId: string | null, call: PageCall): Promise<PageOutcome>;
  /** The page driver of the Chrome `chromeId`, or of the plain My Chrome for null. */
  driverOf(chromeId: string | null): PageDriver;
}

const refusal = (reason: string): PageOutcome => ({ ok: false, reason });

/** What the model reads where a Chrome is closed: the extension only runs while Chrome is open. */
const CLOSED = "the extension only runs while Chrome is open";

const notConnected = (chrome: DrivenChrome, env: string): string => `The Chrome ${chrome.name} is not connected to ${env}: ${CLOSED}. Ask the person to open it, then try again.`;

export const createExtensionDriver = (options: ExtensionDriverOptions): ExtensionDriver => {
  /** The Chrome a verb goes to, or the sentence why there is none. */
  const target = (chromeId: string | null): DrivenChrome | string => {
    const paired = options.chromes();
    const env = options.environmentName();
    if (chromeId !== null) {
      const chrome = paired.find((candidate) => candidate.id === chromeId.toLowerCase());
      if (chrome === undefined) return `The Chrome this session names is no longer paired with ${env}. Ask the person to choose another browser for this session, or to pair that Chrome again.`;
      if (!options.isConnected(chrome.id)) return notConnected(chrome, env);
      return chrome;
    }
    if (paired.length === 0) return `No Chrome is paired with ${env}. Ask the person to pair their Chrome in the Browser step of Set up, or to choose another browser for this session.`;
    const connected = paired.filter((chrome) => options.isConnected(chrome.id));
    const [only, ...others] = connected;
    if (only === undefined) return `None of the person's Chromes is connected to ${env}: ${CLOSED}. Ask the person to open Chrome, then try again.`;
    if (others.length > 0) {
      return `Several of the person's Chromes are connected to ${env}: ${connected.map((chrome) => chrome.name).join(", ")}. Ask the person which one this session should use, then call browser_open with browser set to its name.`;
    }
    return only;
  };

  const perform = async (chromeId: string | null, call: PageCall): Promise<PageOutcome> => {
    let chrome: DrivenChrome | string;
    try {
      chrome = target(chromeId);
    } catch (error) {
      return refusal(`The environment could not read its paired Chromes: ${error instanceof Error ? error.message : String(error)}.`);
    }
    if (typeof chrome === "string") return refusal(chrome);
    const deadlineMs = pageCallDeadlineMs(call.command);
    const answer = await options.call(chrome.id, call, deadlineMs);
    switch (answer.kind) {
      case "answered":
        return answer.outcome;
      case "not-connected":
        return refusal(notConnected(chrome, options.environmentName()));
      case "disconnected":
        return refusal(`The Chrome ${chrome.name} disconnected before it answered: ${CLOSED}. Ask the person to open it again if it closed, then try again.`);
      case "timed-out":
        return refusal(`The Chrome ${chrome.name} did not answer within ${deadlineMs / 1_000} seconds. Try again; if it still does not answer, ask the person to look at that Chrome.`);
    }
  };

  return {
    perform,
    driverOf: (chromeId) => ({
      kind: "chrome",
      // A call of one verb is a call; the extension's value is JSON off the wire, which the tools check against the verb.
      perform: async <V extends PageVerb>(call: PageCallOf<V>) => (await perform(chromeId, call as PageCall)) as PageResult<V>,
    }),
  };
};
