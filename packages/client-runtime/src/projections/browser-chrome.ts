import { BrowserChromeCall, PageOutcome, type ResponseFrame } from "@agent-harness/contracts";
import type { ConnectionRecord } from "../connections/records.js";
import type { ClientCallHandler } from "./client-calls.js";

/**
 * The browser relay's client half (browser spec, "The browser relay"; ADR
 * 0014; #554): a run on one environment drives a Chrome paired with another
 * through the client that started it. The run's environment addresses a
 * `browser.chrome` call to that client; every client runtime registers this
 * handler, which performs the verb with `browser.chromes.perform` on its
 * local connection to the Chrome's environment (the one the bootstrap grant
 * made, so only a client on the Chrome's machine can) and answers the
 * verb's outcome. What it cannot do it answers as an error, a sentence the
 * run reads: a call past its deadline (on the run environment's clock, as
 * this client reckons it), no local connection to the Chrome's environment,
 * that environment unreachable or refusing the verb.
 */

/** The kind of call a run's environment addresses to this client for a verb on a Chrome paired with its local environment. */
export const BROWSER_CHROME_CALL = "browser.chrome";

export interface BrowserChromeHost {
  /** The connection to an environment, by its id. */
  readonly record: (environmentId: string) => ConnectionRecord | undefined;
  /** A request on the environment's ready socket; rejects when there is none. */
  readonly request: (environmentId: string, method: string, params: Record<string, unknown>) => Promise<ResponseFrame>;
  /** The time on the environment's clock now, as this client reckons it. */
  readonly now: (environmentId: string) => Date;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const browserChromeHandler =
  (host: BrowserChromeHost): ClientCallHandler =>
  async (call) => {
    const asked = BrowserChromeCall.safeParse(call.payload);
    if (!asked.success) throw new Error("The call does not name a Chrome, a page and a verb this client can read.");
    const { environmentId, chromeId, deadline, ...verb } = asked.data;
    if (host.now(call.environmentId).getTime() >= Date.parse(deadline)) throw new Error("The call came after its deadline, so this client did not perform it.");
    const local = host.record(environmentId);
    if (local?.kind !== "local") {
      throw new Error(`This client is not on the machine of the environment the Chrome is paired with (${environmentId}): it holds no local connection to it, so it cannot drive that Chrome.`);
    }
    const name = local.descriptor.name;
    let response: ResponseFrame;
    try {
      response = await host.request(environmentId, "browser.chromes.perform", { chromeId, ...verb });
    } catch (error) {
      throw new Error(`This client could not reach ${name}, the environment the Chrome is paired with: ${messageOf(error)}`, { cause: error });
    }
    if (response.error) throw new Error(`${name}, the environment the Chrome is paired with, refused the verb: ${response.error.message}`);
    const outcome = PageOutcome.safeParse(response.result?.["outcome"]);
    if (!outcome.success) throw new Error(`${name}, the environment the Chrome is paired with, answered something that is not a browser's answer.`);
    return outcome.data;
  };
