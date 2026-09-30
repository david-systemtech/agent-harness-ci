import { z } from "zod";
import { ChromeId } from "../browser-bridge.js";
import { ChromePairingCode, PairedChrome } from "../browser-chromes.js";
import { BrowserStatus } from "../browser-status.js";
import { commandParams, defineMethod } from "../method.js";
import { Timestamp } from "../primitives.js";

/**
 * The browser's methods (browser spec, "Settings, methods, events and
 * notices"; ADR 0014, ADR 0024), each with one scope. A Chrome the
 * environment does not hold is `not_found` (data `kind: chrome`); every
 * pairing, rename, unpairing, connection, disconnection and version report
 * raises `chrome.updated` on `environment.subscribe`.
 */

/**
 * The extension's folder, its listener and an unpaired connection, which the
 * Browser card and its health check read. A folder found missing is made
 * again before the answer.
 */
export const browserStatus = defineMethod({
  name: "browser.status",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: BrowserStatus,
  errors: [],
});

/**
 * The live pairing code and its expiry, minting one when none is live: a
 * query that mints. One code is live per environment at a time, good for
 * five minutes and one pairing, void after five wrong guesses. The code is
 * never logged.
 */
export const browserPairingCode = defineMethod({
  name: "browser.pairing.code",
  scope: "admin",
  kind: "query",
  params: z.object({}),
  result: z
    .object({
      code: ChromePairingCode,
      expiresAt: Timestamp.meta({ description: "When the code stops pairing, five minutes after it was minted." }),
    })
    .meta({ description: "The live pairing code, to type into the extension's options page, and when it expires." }),
  errors: [],
});

/** The paired Chromes, in the order they paired, each with whether it is connected and outdated. */
export const browserChromesList = defineMethod({
  name: "browser.chromes.list",
  scope: "read",
  kind: "query",
  params: z.object({}),
  result: z.object({ chromes: z.array(PairedChrome).meta({ description: "Every paired Chrome, the first paired first." }) }),
  errors: [],
});

/**
 * Renames a paired Chrome: `chrome.renamed`, then `chrome.updated`. The name
 * is cleaned as a pairing's is (`chromeNameOf`); a name that cleans to the
 * one it has appends nothing.
 */
export const browserChromesRename = defineMethod({
  name: "browser.chromes.rename",
  scope: "admin",
  kind: "command",
  params: commandParams({
    chromeId: ChromeId,
    name: z.string().max(1_000).meta({ description: "The new name, as typed: trimmed, cleaned and cut to 80 characters, A browser when nothing is left." }),
  }),
  result: z.object({ chrome: PairedChrome.meta({ description: "The Chrome as it is now." }) }),
  errors: [],
});

/**
 * Unpairs a Chrome: `chrome.unpaired`, then `chrome.updated`; once it
 * commits the secret is deleted from the vault and a socket the Chrome holds
 * is closed with a refusal, so the extension returns to unpaired.
 */
export const browserChromesUnpair = defineMethod({
  name: "browser.chromes.unpair",
  scope: "admin",
  kind: "command",
  params: commandParams({ chromeId: ChromeId }),
  result: z.object({ chrome: PairedChrome.meta({ description: "The Chrome as it was when it was unpaired." }) }),
  errors: [],
});
