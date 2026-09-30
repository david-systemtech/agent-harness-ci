import { z } from "zod";
import { ChromeId } from "./browser-bridge.js";
import { EnvironmentId } from "./primitives.js";

/**
 * A session's browser (browser spec, "The browser as a session field"; ADR
 * 0014, ADR 0003): what the session's runs may drive, and who chose it. A
 * leaf module, so the session summary names it without importing the
 * events that record it (`session-browser.ts`), as it names a mode.
 */

/** The kinds of browser a session may choose. */
export const SESSION_BROWSER_KINDS = ["chrome", "headless", "dock", "none"] as const;

/**
 * A browser a session chose: a Chrome paired with an environment (a null
 * `chromeId` is the plain My Chrome, whichever of that environment's Chromes
 * is connected), the run environment's headless browser, the desktop
 * window's browser dock, or none.
 */
export const SessionBrowser = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("chrome"),
        environmentId: EnvironmentId.meta({ description: "The environment the Chrome is paired with." }),
        chromeId: ChromeId.nullable().meta({ description: "The Chrome; null for the plain My Chrome, whichever of that environment's Chromes is connected." }),
      })
      .meta({ description: "A Chrome paired with an environment." }),
    z.object({ kind: z.literal("headless") }).meta({ description: "The headless browser of the environment the run is on." }),
    z.object({ kind: z.literal("dock") }).meta({ description: "The browser dock in the desktop window." }),
    z.object({ kind: z.literal("none") }).meta({ description: "No browser: the run reads the web with web_read alone." }),
  ])
  .meta({ description: "A browser a session chose: a Chrome (a null chromeId the plain My Chrome), headless, the dock, or none." });
export type SessionBrowser = z.infer<typeof SessionBrowser>;

/**
 * Who chose a session's browser: a person (a client's `sessions.setBrowser`
 * or `sessions.create`), the agent answering the several-Chromes question,
 * the reach default of the session's account (`browser.reach`) that a
 * client's `sessions.create` sent, or the completions surface for a session
 * it made (its preset none, or the headless browser a request asked for).
 */
export const BROWSER_CHOOSERS = ["person", "agent", "reach", "completions"] as const;
export const BrowserChooser = z.enum(BROWSER_CHOOSERS).meta({
  description:
    "Who chose a session's browser: person (a client's sessions.setBrowser or sessions.create), agent (the agent answering the several-Chromes question), reach (the account's browser.reach default, sent with sessions.create), or completions (the completions surface for a session it made: none, or headless when the request asked).",
});
export type BrowserChooser = z.infer<typeof BrowserChooser>;
