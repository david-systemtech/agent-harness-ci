import type { EventLog } from "../event-log/event-log.js";
import { appendDecided } from "../sessions/companions.js";
import { decideSetBrowser } from "../sessions/decider.js";
import { readSessionState } from "../sessions/session-reads.js";
import type { Reader } from "../sessions/session-tables.js";
import { sessionStream } from "../sessions/streams.js";
import { readChromes } from "./chromes.js";
import type { DrivenChrome } from "./extension-driver.js";

/**
 * The agent's answer to the several-Chromes question (browser spec, "The
 * browser as a session field"; #552): with several of the person's Chromes
 * connected, the plain My Chrome refuses a verb naming them and telling the
 * model to ask the person, whose answer comes back as `browser_open`'s
 * `browser`, the name of one of this environment's paired Chromes. The
 * environment records it on the session as `session.browser.set` chosen by
 * the agent, so the session's next run resolves that Chrome. A session that
 * names a Chrome is never moved by the model: naming another is refused.
 */

export interface ChromeChoiceRequest {
  readonly sessionId: string;
  /** The run whose agent answered, which the event is correlated with. */
  readonly runId: string;
  /** Who appends the event: the run's adapter. */
  readonly actor: string;
  /** The environment whose Chromes the plain My Chrome is. */
  readonly environmentId: string;
  /** The name the agent gave, as the person said it. */
  readonly name: string;
}

/** The Chrome chosen, or the sentence the model reads. */
export type ChromeChoice = { readonly ok: true; readonly chrome: DrivenChrome } | { readonly ok: false; readonly reason: string };

export interface ChromeChoiceOptions {
  readonly log: EventLog;
  readonly environmentId: string;
  /** The environment's name as it is now, which the sentences name. */
  readonly environmentName: () => string;
}

const refused = (reason: string): ChromeChoice => ({ ok: false, reason });

/**
 * Chooses the Chrome named `name` for the session: one of this
 * environment's paired Chromes, its name matched whatever its case. Recorded
 * as chosen by the agent while the session's browser is this environment's
 * plain My Chrome; nothing is recorded when the session names that Chrome
 * already; refused when it names another, or no longer has the plain My
 * Chrome.
 */
export const chooseChrome = (options: ChromeChoiceOptions, request: ChromeChoiceRequest): ChromeChoice => {
  const { log } = options;
  const own = options.environmentId.toLowerCase();
  const env = options.environmentName();
  if (request.environmentId.toLowerCase() !== own) return refused("This environment cannot choose among the Chromes of another environment yet.");
  // The log's query-only read: inside the transaction below it reads that transaction.
  const reader: Reader = { all: (sql, ...params) => log.read(sql, ...params) };
  const paired = readChromes(reader);
  const asked = request.name.trim();
  const [chrome, ...others] = paired.filter((candidate) => candidate.name.toLowerCase() === asked.toLowerCase());
  if (chrome === undefined) {
    if (paired.length === 0) return refused(`No Chrome is paired with ${env}. Ask the person to pair their Chrome in the Browser step of Set up.`);
    return refused(`No Chrome paired with ${env} is named ${asked}: the paired Chromes are ${paired.map((candidate) => candidate.name).join(", ")}. Ask the person which one to use.`);
  }
  if (others.length > 0) return refused(`Several Chromes paired with ${env} are named ${chrome.name}. Ask the person to rename one of them in the Browser step of Set up, then name it.`);
  return log.atomically((tx): ChromeChoice => {
    const state = readSessionState(reader, request.sessionId);
    const field = state?.browser ?? null;
    if (field?.kind !== "chrome" || field.environmentId !== own) {
      return refused("This session no longer uses My Chrome: the person chose another browser for it, which its next run takes.");
    }
    if (field.chromeId === chrome.id) return { ok: true, chrome };
    if (field.chromeId !== null) {
      const current = paired.find((candidate) => candidate.id === field.chromeId)?.name;
      return refused(`This session uses ${current === undefined ? "another Chrome" : `the Chrome ${current}`}, which only the person can change: ask them if this session should use another browser.`);
    }
    const decided = decideSetBrowser(state, { sessionId: request.sessionId, browser: { kind: "chrome", environmentId: own, chromeId: chrome.id }, chosenBy: "agent" });
    if (decided.rejected !== undefined) return refused(decided.rejected.message);
    appendDecided(log, sessionStream(request.sessionId), decided, { tx, actor: request.actor, correlationId: request.runId });
    return { ok: true, chrome };
  });
};
